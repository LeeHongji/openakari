#!/usr/bin/env node
/** CLI for the akari scheduler. Manages cron jobs and runs the scheduler daemon. */

import { readFileSync, writeFileSync, accessSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkForExistingInstance,
  acquireLock,
  releaseLock,
  getSchedulerLockfilePath,
} from "./instance-guard.js";

// Load environment variables from two layers:
//   1. infra/.env        — common vars shared across all akari infra (Databricks, AWS, etc.)
//   2. infra/scheduler/.env — scheduler-specific vars (Slack tokens, agent backend, etc.)
// Scheduler-specific vars override common vars; neither overrides real system env vars.
const __dirname = dirname(fileURLToPath(import.meta.url));
const systemEnvKeys = new Set(Object.keys(process.env));

/** Parse a .env file and apply its values to process.env, skipping keys already in system env. */
function loadEnvFile(path: string): void {
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!systemEnvKeys.has(key)) {
        process.env[key] = val;
      }
    }
  } catch {
    // .env files are optional
  }
}

/** Parse .env content and merge into target object, overwriting existing keys.
 *  Used by the restart handler to build a fresh environment for pm2 --update-env,
 *  bypassing PM2's cached environment. */
export function mergeEnvContent(target: Record<string, string>, content: string): void {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    target[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
}

loadEnvFile(resolve(__dirname, "../..", ".env"));  // infra/.env (common)
loadEnvFile(resolve(__dirname, "..", ".env"));     // infra/scheduler/.env (scheduler-specific)

import { JobStore } from "./store.js";
import { SchedulerService } from "./service.js";
import { executeJob } from "./executor.js";
import { getPendingApprovals } from "./notify.js";
import * as slack from "./slack.js";
import { clearAll as clearSessions, listSessions } from "./session.js";
import { readPersistedSessions, clearPersistedSessions } from "./session-persistence.js";
import { checkBudget } from "./budget-gate.js";
import { runBurst } from "./burst.js";
import { diagnoseSession } from "./session-autofix.js";
import { verifySession, countKnowledgeOutput, countCrossProjectMetrics, countQualityAuditMetrics, getHeadCommit, formatVerification } from "./verify.js";
import { recordMetrics, generateRunId, type SessionMetrics } from "./metrics.js";
import { checkPendingEvolution, applyEvolution } from "./evolution.js";
import { PushQueue } from "./push-queue.js";
import { startApiServer, stopApiServer } from "./api/server.js";
import { rebaseAndPush } from "./rebase-push.js";
import { runScheduledReport, shouldRunReport } from "./report/scheduled.js";
import { runHealthWatchdog, formatHealthReport } from "./health-watchdog.js";
import { runInteractionAudit, formatInteractionReport } from "./interaction-audit.js";
import { runAnomalyDetection, formatAnomalyReport } from "./anomaly-detection.js";
import { runWarningEscalation, formatEscalationReport } from "./warning-escalation.js";
import { createHealthTasks } from "./health-tasks.js";
import { triggerAutoDiagnosis } from "./auto-diagnose.js";
import { runBranchCleanup, formatCleanupReport } from "./branch-cleanup.js";
import { runRecurringTasks } from "./recurring-tasks.js";
import type { Schedule, JobCreate } from "./types.js";
import { listExperiments } from "./experiments.js";
import { wasFullOrient } from "./orient-tier.js";
import { getUnifiedStatus, formatUnifiedStatus, type StatusSession, type StatusExperiment, type StatusJob } from "./status.js";
import { getExecutableBursts, markBurstExecuted } from "./approval-burst.js";

const HELP = `
akari — Cron scheduler for autonomous agent sessions

Commands:
  start                     Run the scheduler daemon (foreground)
  add <options>             Add a new scheduled job
  list                      List all jobs
  remove <id>               Remove a job
  run <id>                  Run a job immediately
  enable <id>               Enable a disabled job
  disable <id>              Disable a job
  status                    Show unified status (sessions, experiments, jobs)
  heartbeat                 Check APPROVAL_QUEUE.md and notify if items pending
  watchdog                  Run session health checks and notify on anomalies
  check-health              Ping scheduler API and alert if unresponsive (external monitoring)
  audit-interactions        Run interaction quality audit and notify on anomalies
  detect-anomalies          Run statistical outlier detection on session metrics
  escalate-warnings         Detect recurring verification warnings across sessions
  burst <options>           Run sessions in a rapid loop until a stop condition
  cleanup-branches          Delete old session-work-session-* branches from remote

Watchdog options:
  --limit <N>               Analyze last N sessions (default: 20)
  --notify                  Send Slack DM if issues found

Audit-interactions options:
  --since <ISO>             Only analyze interactions after this timestamp
  --notify                  Send Slack DM if issues found

Burst options:
  --job <name>              Job name to run (required)
  --max-sessions <N>        Maximum number of sessions (default: 10)
  --max-cost <C>            Maximum cumulative cost in USD (default: 50)
  --autofix                 Enable session autofix (diagnose and retry on failure)
  --autofix-retries <N>     Maximum autofix attempts per burst (default: 3)

Cleanup-branches options:
  --keep-days <N>           Keep unmerged branches from last N days (default: 7)
  --dry-run                 Show what would be deleted without deleting
  --notify                  Send Slack DM with results

Check-health options:
  --url <url>               Scheduler API URL (default: http://localhost:8420)
  --timeout <ms>            Request timeout in ms (default: 5000)
  --state-file <path>       State file for tracking consecutive failures (default: /tmp/akari-health-state.json)
  --notify                  Send Slack DM on failure/recovery

Add options:
  --name <name>             Job name (required)
  --cron <expr>             Cron expression, e.g. "0 * * * *" (required unless --every)
  --every <ms>              Interval in milliseconds (alternative to --cron)
  --tz <timezone>           IANA timezone for cron (default: UTC)
  --message <msg>           Prompt message for agent session (required)
  --model <model>           Model name (e.g. opus, sonnet)
  --cwd <dir>               Working directory for agent session
  --backend <backend>       Agent backend: claude, cursor, or auto (default: auto)
`.trim();

function fail(msg: string): never {
  console.error(msg);
  return process.exit(1) as never;
}

function requireArg(val: string | undefined, label: string): string {
  if (!val) return fail(`Error: ${label} required.`);
  return val;
}

/** Wait for active sessions to complete before restarting.
 *  Polls every second with a 5-minute timeout.
 *  Exported for integration testing. */
export async function waitForActiveSessions(timeoutMs = 300_000): Promise<void> {
  const startTime = Date.now();
  const pollIntervalMs = 1000;

  while (Date.now() - startTime < timeoutMs) {
    const activeSessions = listSessions();

    if (activeSessions.length === 0) {
      console.log(`[evolution] All sessions complete, proceeding with restart.`);
      return;
    }

    console.log(`[evolution] Waiting for ${activeSessions.length} session(s) to complete...`);
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  console.warn(`[evolution] Timeout waiting for sessions, proceeding with restart anyway.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(HELP);
    return;
  }

  if (cmd === "start") {
    await cmdStart();
  } else if (cmd === "add") {
    await cmdAdd(args.slice(1));
  } else if (cmd === "list") {
    await cmdList();
  } else if (cmd === "remove") {
    await cmdRemove(requireArg(args[1], "job ID"));
  } else if (cmd === "run") {
    await cmdRun(requireArg(args[1], "job ID"));
  } else if (cmd === "enable") {
    await cmdSetEnabled(requireArg(args[1], "job ID"), true);
  } else if (cmd === "disable") {
    await cmdSetEnabled(requireArg(args[1], "job ID"), false);
  } else if (cmd === "status") {
    await cmdStatus();
  } else if (cmd === "heartbeat") {
    await cmdHeartbeat();
  } else if (cmd === "watchdog") {
    await cmdWatchdog(args.slice(1));
  } else if (cmd === "check-health") {
    await cmdCheckHealth(args.slice(1));
  } else if (cmd === "audit-interactions") {
    await cmdAuditInteractions(args.slice(1));
  } else if (cmd === "detect-anomalies") {
    await cmdDetectAnomalies(args.slice(1));
  } else if (cmd === "escalate-warnings") {
    await cmdEscalateWarnings(args.slice(1));
  } else if (cmd === "burst") {
    await cmdBurst(args.slice(1));
  } else if (cmd === "cleanup-branches") {
    await cmdCleanupBranches(args.slice(1));
  } else {
    console.error(`Unknown command: ${cmd}\n`);
    console.log(HELP);
    process.exit(1);
  }
}

async function cmdStart(): Promise<void> {
  clearSessions();

  const schedulerDir = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const persistBaseDir = new URL("../../../.scheduler", import.meta.url).pathname;

  // Duplicate instance guard: refuse to start if another scheduler is running
  const lockfilePath = getSchedulerLockfilePath(persistBaseDir);
  const instanceCheck = checkForExistingInstance(lockfilePath);
  if (!instanceCheck.canStart) {
    console.error(`[startup] ${instanceCheck.message}`);
    process.exit(1);
  }
  console.log(`[startup] ${instanceCheck.message}`);
  acquireLock(lockfilePath);

  // Track HEAD before each job for verification
  const headBeforeMap = new Map<string, string | null>();

  let evolutionInProgress = false;
  let burstInProgress = false;

  // Startup: warn about stale failed evolution artifacts
  try {
    accessSync(join(schedulerDir, ".failed-evolution.json"));
    console.warn(`[evolution] WARNING: .failed-evolution.json exists — a previous evolution attempt failed. Check the file for details.`);
  } catch { /* no failed evolution, normal */ }

  // Startup crash detection: if we restarted very recently, skip evolution checks
  // for a cooldown period to break potential crash loops from broken compiled JS.
  const STARTUP_COOLDOWN_MS = 30_000;
  const startupTimePath = join(schedulerDir, ".last-startup-ms");
  let skipEvolutionUntil = 0;
  try {
    const lastStartupStr = readFileSync(startupTimePath, "utf-8");
    const lastStartupMs = parseInt(lastStartupStr, 10);
    const timeSinceLastStartup = Date.now() - lastStartupMs;
    if (timeSinceLastStartup < STARTUP_COOLDOWN_MS) {
      console.warn(`[evolution] Process restarted ${timeSinceLastStartup}ms after last startup — possible crash loop. Skipping evolution checks for ${STARTUP_COOLDOWN_MS / 1000}s.`);
      skipEvolutionUntil = Date.now() + STARTUP_COOLDOWN_MS;
    }
  } catch { /* first startup or file missing */ }
  writeFileSync(startupTimePath, String(Date.now()));

  const pushQueue = new PushQueue();
  console.log(`[startup] Push queue initialized`);

  const repoRootForService = schedulerDir.replace(/\/infra\/scheduler$/, "");

  const service = new SchedulerService({
    repoDir: repoRootForService,
    isPushQueueBusy: () => pushQueue.isProcessing(),
    onBeforeRun: async (job) => {
      // Budget gate
      const gate = await checkBudget(job);
      if (!gate.allowed) {
        console.log(`[budget-gate] Blocking job ${job.name}: ${gate.reason}`);
        await slack.notifyBudgetBlocked(job.name, gate.reason ?? "budget exhausted");
        return false;
      }

      // Record HEAD before session for verification diff
      const cwd = job.payload.cwd ?? process.cwd();
      const head = await getHeadCommit(cwd);
      headBeforeMap.set(job.id, head);

      return true;
    },

    onAfterRun: async (job, result) => {
      const dir = job.payload.cwd ?? process.cwd();
      const headBeforeRaw = headBeforeMap.get(job.id) ?? null;
      headBeforeMap.delete(job.id);

      // Use post-auto-commit HEAD as the baseline for attribution. This ensures
      // orphaned files from prior sessions (auto-committed before this session)
      // are not credited to this session's knowledge metrics.
      const headBefore = result.headAfterAutoCommit ?? headBeforeRaw;

      // Post-session verification
      const verification = await verifySession(dir, headBefore, result.costUsd, result.numTurns, result.durationMs, undefined, result.sleepViolation, result.stallViolation).catch((err) => {
        console.error(`[verify] Error: ${err}`);
        return null;
      });

      // Knowledge output counting
      const knowledge = await countKnowledgeOutput(dir, headBefore).catch((err) => {
        console.error(`[verify] Knowledge counting error: ${err}`);
        return null;
      });

      // Cross-project utilization tracking
      const crossProject = await countCrossProjectMetrics(dir, headBefore).catch((err) => {
        console.error(`[verify] Cross-project metrics error: ${err}`);
        return null;
      });

      // Quality audit coverage tracking
      const qualityAudit = await countQualityAuditMetrics(dir, headBefore).catch((err) => {
        console.error(`[verify] Quality audit metrics error: ${err}`);
        return null;
      });

      // Budget gate result (already computed in onBeforeRun, reconstruct for metrics)
      const budgetGate = await checkBudget(job).catch(() => null);

      // Record structured metrics
      const runId = generateRunId(job.id);
      const metrics: SessionMetrics = {
        timestamp: new Date().toISOString(),
        jobName: job.name,
        runId,
        triggerSource: result.triggerSource,
        backend: (result.backend ?? "claude") as "claude" | "cursor" | "opencode",
        durationMs: result.durationMs,
        costUsd: result.costUsd ?? null,
        numTurns: result.numTurns ?? null,
        timedOut: result.timedOut ?? false,
        ok: result.ok,
        error: result.error,
        verification: verification ? {
          uncommittedFiles: verification.uncommittedFiles.length,
          orphanedFiles: verification.orphanedFiles.length,
          hasLogEntry: verification.hasLogEntry,
          hasCommit: verification.hasCommit,
          hasCompleteFooter: verification.hasCompleteFooter,
          ledgerConsistent: verification.ledgerConsistent,
          filesChanged: verification.filesChanged,
          commitCount: verification.commitCount,
          agentCommitCount: verification.agentCommitCount,
          warningCount: verification.warnings.length,
          l2ViolationCount: verification.l2ViolationCount,
          l2ChecksPerformed: verification.l2ChecksPerformed,
          stallViolationCommand: verification.stallViolationCommand,
        } : null,
        knowledge,
        budgetGate: budgetGate ? { allowed: budgetGate.allowed, reason: budgetGate.reason } : null,
        modelUsage: result.modelUsage ?? null,
        toolCounts: result.toolCounts ?? null,
        orientTurns: result.orientTurns ?? null,
        crossProject: crossProject ?? null,
        qualityAudit: qualityAudit ?? null,
        injectedOrientTier: result.injectedOrientTier ?? null,
        injectedCompoundTier: result.injectedCompoundTier ?? null,
        injectedRole: result.injectedRole ?? null,
        pushQueueResult: result.pushQueueResult,
      };
      await recordMetrics(metrics).catch((err) => {
        console.error(`[metrics] Failed to record: ${err}`);
      });

      // Log verification warnings
      if (verification) {
        const warningText = formatVerification(verification);
        if (warningText) {
          console.log(`[verify] Warnings for ${job.name}:\n${warningText}`);
        }
      }

      // Update orient/compound tier timestamps (ADR 0030)
      if (result.ok) {
        const tierPatch: Record<string, unknown> = {};
        if (result.ranFullOrient) {
          tierPatch.lastFullOrientAt = Date.now();
          console.log(`[orient-tier] Full orient detected (${result.orientTurns} turns) — updating lastFullOrientAt`);
        }
        if (result.injectedCompoundTier === "full" && !result.timedOut) {
          tierPatch.lastFullCompoundAt = Date.now();
        }
        if (Object.keys(tierPatch).length > 0) {
          const store = service.getStore();
          await store.updateState(job.id, tierPatch as any);
        }
      }

      // Check approvals
      const approvals = await getPendingApprovals(dir);
      if (approvals.length > 0) {
        console.log(`[${new Date().toISOString()}] ${approvals.length} pending approval(s) in APPROVAL_QUEUE.md`);
        for (const a of approvals) {
          console.log(`  - ${a.title} (${a.project}) [${a.type}]`);
        }
      }
    },

    onTick: async (dueCount) => {
      // Check for pending self-evolution (skip if already applying or burst running
      // — prevents overlapping ticks from spawning concurrent evolution attempts,
      // and prevents interrupting active burst sessions)
      if (!evolutionInProgress && !burstInProgress && Date.now() >= skipEvolutionUntil) {
        const evo = await checkPendingEvolution(schedulerDir).catch(() => ({
          shouldRestart: false as const,
        }));
        if (evo.shouldRestart && !service.isDraining()) {
          console.log(`[evolution] Pending evolution detected: ${evo.description}`);
          console.log(`[evolution] Starting drain before applying evolution...`);
          evolutionInProgress = true;
          try {
            const ok = await applyEvolution(schedulerDir);
            if (ok) {
              console.log(`[evolution] Build succeeded, draining before restart...`);
              await slack.notifyEvolution(evo.description ?? "scheduler self-evolution");
              await service.startDrain();
              // Wait for active sessions and living messages before exiting
              await waitForActiveSessions();
              process.exit(0); // pm2 restarts
            } else {
              console.error(`[evolution] Build failed, skipping restart`);
            }
          } finally {
            evolutionInProgress = false;
          }
        } else if ("error" in evo && evo.error) {
          console.log(`[evolution] Check: ${evo.error}`);
        }
      }

      // Burst-after-approval: check for approved burst requests on every tick
      if (!burstInProgress && !service.isDraining()) {
        const monitorDir = schedulerDir.replace(/\/infra\/scheduler$/, "");
        getExecutableBursts(monitorDir).then(async (bursts) => {
          if (bursts.length === 0 || burstInProgress) return;
          const burst = bursts[0];
          const store = service.getStore();
          await store.load();
          const job = store.list().find((j) => j.name === burst.job);
          if (!job) {
            console.log(`[approval-burst] Job "${burst.job}" not found, skipping burst`);
            await markBurstExecuted(monitorDir, burst);
            return;
          }

          burstInProgress = true;
          console.log(`[approval-burst] Executing approved burst: job="${burst.job}", max-sessions=${burst.maxSessions}, max-cost=$${burst.maxCost}`);
          await slack.dm(
            `:rocket: *Burst mode triggered by approval:*\n` +
            `Job: ${burst.job}, Sessions: ${burst.maxSessions}, Cost cap: $${burst.maxCost}` +
            (burst.autofix ? `, Autofix: on (${burst.autofixRetries} retries)` : ""),
          );

          try {
            const repoDir = job.payload.cwd ?? monitorDir;
            const burstResult = await runBurst({
              job,
              maxSessions: burst.maxSessions,
              maxCost: burst.maxCost,
              execute: executeJob,
              onSessionComplete: (num, sessionResult, totalCost) => {
                const status = sessionResult.ok ? "ok" : "error";
                const cost = sessionResult.costUsd?.toFixed(2) ?? "n/a";
                console.log(`[approval-burst] Session ${num} complete: ${status}, cost=$${cost}, cumulative=$${totalCost.toFixed(2)}`);
              },
              ...(burst.autofix ? {
                autofix: {
                  maxRetries: burst.autofixRetries,
                  diagnose: (diagOpts) => diagnoseSession({ ...diagOpts, repoDir }),
                  repoDir,
                },
              } : {}),
            });

            await markBurstExecuted(monitorDir, burst);
            const summary =
              `:checkered_flag: *Burst complete:*\n` +
              `Sessions: ${burstResult.sessionsRun}, Cost: $${burstResult.totalCost.toFixed(2)}, ` +
              `Duration: ${Math.round(burstResult.totalDurationMs / 1000)}s, Stop reason: ${burstResult.stopReason}` +
              (burstResult.autofixAttempts > 0 ? `, Autofix attempts: ${burstResult.autofixAttempts}` : "");
            await slack.dm(summary);
            console.log(`[approval-burst] Burst finished: ${burstResult.stopReason}`);
          } catch (err) {
            console.error(`[approval-burst] Burst failed:`, err);
            await slack.dm(`:x: *Burst failed:* ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            burstInProgress = false;
          }
        }).catch((err) => {
          console.error(`[approval-burst] Error checking bursts: ${err}`);
        });
      }

      // Scheduled reports (checked every tick, fires on matching cron)
      const dailyCron = process.env.REPORT_DAILY_CRON;
      const weeklyCron = process.env.REPORT_WEEKLY_CRON;
      const now = new Date();
      if (dailyCron && shouldRunReport(dailyCron, now)) {
        runScheduledReport("operational", schedulerDir.replace(/\/infra\/scheduler$/, ""), slack.dmBlocks).catch(
          (err) => console.error(`[scheduled-report] Daily failed: ${err}`),
        );
      }
      if (weeklyCron && shouldRunReport(weeklyCron, now)) {
        runScheduledReport("research", schedulerDir.replace(/\/infra\/scheduler$/, ""), slack.dmBlocks).catch(
          (err) => console.error(`[scheduled-report] Weekly failed: ${err}`),
        );
      }

      // Scheduled branch cleanup (weekly, default Monday 00:00 UTC)
      const branchCleanupCron = process.env.BRANCH_CLEANUP_CRON || "Mon 00:00";
      if (shouldRunReport(branchCleanupCron, now)) {
        console.log("[branch-cleanup] Running scheduled branch cleanup...");
        const repoDir = schedulerDir.replace(/\/infra\/scheduler$/, "");
        runBranchCleanup(repoDir, { keepDays: 7, dryRun: false })
          .then((result) => {
            if (result.deleted.length > 0) {
              console.log(`[branch-cleanup] Deleted ${result.deleted.length} branch(es)`);
            } else {
              console.log("[branch-cleanup] No branches to delete");
            }
          })
          .catch((err) => console.error(`[branch-cleanup] Failed: ${err}`));
      }

      // Proactive recurring task generation (weekly, default Sunday 00:00 UTC)
      // Generates maintenance tasks when fleet supply is low
      const recurringCron = process.env.RECURRING_TASKS_CRON || "Sun 00:00";
      if (shouldRunReport(recurringCron, now)) {
        console.log("[recurring-tasks] Running scheduled recurring task generation...");
        const repoDir = schedulerDir.replace(/\/infra\/scheduler$/, "");
        runRecurringTasks({ cwd: repoDir })
          .then((result) => {
            if (result.injected > 0) {
              console.log(`[recurring-tasks] ${result.reason}, injected ${result.injected} task(s)`);
            } else {
              console.log(`[recurring-tasks] ${result.reason}`);
            }
          })
          .catch((err) => console.error(`[recurring-tasks] Failed: ${err}`));
      }

      // Health monitoring — runs every 6 hours (at 0, 6, 12, 18 UTC on minute 0)
      // All three systems (watchdog, anomaly, escalation) run in parallel.
      // After all complete, combined signals are evaluated for auto-diagnosis.
      const monitoringRepoDir = schedulerDir.replace(/\/infra\/scheduler$/, "");
      if (now.getUTCMinutes() === 0 && now.getUTCHours() % 6 === 0) {
        const healthPromise = runHealthWatchdog({ limit: 20, repoDir: monitoringRepoDir })
          .then(({ checks }) => {
            if (checks.length > 0) {
              const { summary, details } = formatHealthReport(checks);
              console.log(`[health-watchdog] ${checks.length} issue(s) detected`);
              slack.dm(summary).then((ts) => {
                if (ts) slack.dmThread(ts, details);
              }).catch((err) =>
                console.error(`[health-watchdog] Slack notification failed: ${err}`),
              );
              createHealthTasks({ repoDir: monitoringRepoDir, healthChecks: checks }).then((n) => {
                if (n > 0) console.log(`[health-tasks] ${n} task(s) created from health watchdog`);
              }).catch((err) => console.error(`[health-tasks] Error: ${err}`));
            } else {
              console.log(`[health-watchdog] All clear`);
            }
            return checks;
          })
          .catch((err) => { console.error(`[health-watchdog] Error: ${err}`); return []; });

        const anomalyPromise = runAnomalyDetection({ limit: 20 })
          .then(({ anomalies }) => {
            if (anomalies.length > 0) {
              const { summary, details } = formatAnomalyReport(anomalies);
              console.log(`[anomaly-detection] ${anomalies.length} outlier(s) detected`);
              slack.dm(summary).then((ts) => {
                if (ts) slack.dmThread(ts, details);
              }).catch((err) =>
                console.error(`[anomaly-detection] Slack notification failed: ${err}`),
              );
              createHealthTasks({ repoDir: monitoringRepoDir, anomalies }).then((n) => {
                if (n > 0) console.log(`[health-tasks] ${n} task(s) created from anomaly detection`);
              }).catch((err) => console.error(`[health-tasks] Error: ${err}`));
            } else {
              console.log(`[anomaly-detection] All clear`);
            }
            return anomalies;
          })
          .catch((err) => { console.error(`[anomaly-detection] Error: ${err}`); return []; });

        const escalationPromise = runWarningEscalation({ limit: 20 })
          .then(({ escalations }) => {
            if (escalations.length > 0) {
              const { summary, details } = formatEscalationReport(escalations);
              console.log(`[warning-escalation] ${escalations.length} recurring warning(s) detected`);
              slack.dm(summary).then((ts) => {
                if (ts) slack.dmThread(ts, details);
              }).catch((err) =>
                console.error(`[warning-escalation] Slack notification failed: ${err}`),
              );
              createHealthTasks({ repoDir: monitoringRepoDir, escalations }).then((n) => {
                if (n > 0) console.log(`[health-tasks] ${n} task(s) created from warning escalation`);
              }).catch((err) => console.error(`[health-tasks] Error: ${err}`));
            } else {
              console.log(`[warning-escalation] All clear`);
            }
            return escalations;
          })
          .catch((err) => { console.error(`[warning-escalation] Error: ${err}`); return []; });

        // After all monitoring completes, evaluate for auto-diagnosis
        Promise.all([healthPromise, anomalyPromise, escalationPromise])
          .then(async ([healthChecks, anomalies, escalations]) => {
            const sessionId = await triggerAutoDiagnosis({
              healthChecks,
              anomalies,
              escalations,
              repoDir: monitoringRepoDir,
            });
            if (sessionId) {
              console.log(`[auto-diagnose] Diagnosis session started: ${sessionId}`);
            }
          })
          .catch((err) => console.error(`[auto-diagnose] Error: ${err}`));
      }

      // Interaction quality audit — runs every 12 hours (at 3, 15 UTC on minute 0)
      // Offset from watchdog to spread load.
      if (now.getUTCMinutes() === 0 && (now.getUTCHours() === 3 || now.getUTCHours() === 15)) {
        // Analyze last 24h of interactions
        const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
        runInteractionAudit({ since: since24h })
          .then(({ checks, stats }) => {
            if (checks.length > 0) {
              const { summary, details } = formatInteractionReport(checks, stats);
              console.log(`[interaction-audit] ${checks.length} issue(s) detected`);
              slack.dm(summary).then((ts) => {
                if (ts) slack.dmThread(ts, details);
              }).catch((err) =>
                console.error(`[interaction-audit] Slack notification failed: ${err}`),
              );
              createHealthTasks({ repoDir: monitoringRepoDir, interactionChecks: checks }).then((n) => {
                if (n > 0) console.log(`[health-tasks] ${n} task(s) created from interaction audit`);
              }).catch((err) => console.error(`[health-tasks] Error: ${err}`));
            } else {
              console.log(`[interaction-audit] All clear (${stats.totalRecords} interactions, ${stats.fulfillmentRate}% fulfilled)`);
            }
          })
          .catch((err) => console.error(`[interaction-audit] Error: ${err}`));
      }
    },
  });
  await service.start();

  // Start Slack bot alongside scheduler.
  // Derive repoDir: prefer any job's cwd, fall back to repo root (3 levels up from dist/cli.js).
  const store = service.getStore();
  const anyJob = store.list().find((j) => j.payload.cwd);
  const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
  const repoDir = anyJob?.payload.cwd ?? repoRoot;
  console.log(`[startup] repoDir=${repoDir} (from ${anyJob ? "job config" : "computed repo root"})`);
  await slack.startSlackBot({ repoDir, store });

  await startApiServer({
    repoDir,
    getStatus: async () => {
      const sessions: StatusSession[] = listSessions().map((s) => ({
        id: s.id,
        jobName: s.jobName,
        startedAtMs: s.startedAtMs,
        elapsedMs: Date.now() - s.startedAtMs,
        costUsd: s.costUsd,
        numTurns: s.numTurns,
        lastActivity: s.lastActivity,
      }));

      const experiments: StatusExperiment[] = (await listExperiments(repoDir)).map((e) => {
        const startedAt = e.startedAtMs ? new Date(e.startedAtMs).toISOString() : null;
        const elapsedMs = e.startedAtMs ? Date.now() - e.startedAtMs : null;
        return {
          project: e.project,
          id: e.id,
          status: e.progress?.status ?? e.mdStatus ?? "unknown",
          startedAt,
          elapsedMs,
          progress: e.progress?.pct,
          message: e.progress?.message,
        };
      });

      const jobs: StatusJob[] = store.list().map((j) => ({
        id: j.id,
        name: j.name,
        enabled: j.enabled,
        schedule: j.schedule.kind === "cron" ? j.schedule.expr : `every ${j.schedule.everyMs}ms`,
        nextRunAtMs: j.state.nextRunAtMs,
        lastStatus: j.state.lastStatus,
        lastRunAtMs: j.state.lastRunAtMs,
        runCount: j.state.runCount,
      }));

      return getUnifiedStatus({ sessions, experiments, jobs });
    },
    pushQueue,
    executePush: async (req) => {
      const result = await rebaseAndPush(req.cwd, req.sessionId);
      return { ...result, sessionId: req.sessionId, waitMs: 0, queueDepth: 0 };
    },
    port: parseInt(process.env["SCHEDULER_PORT"] ?? "8420", 10),
  });

  // Recover interrupted deep work sessions from previous run
  try {
    const stale = await readPersistedSessions(persistBaseDir);
    if (stale.length > 0) {
      console.log(`[startup] Found ${stale.length} interrupted deep work session(s)`);
      for (const s of stale) {
        const [, threadTs] = s.threadKey.split(":");
        const msg = `:warning: *Deep work session interrupted by restart.*\nTask: ${s.task}\nCheck recent git log for committed work.`;
        if (threadTs) {
          await slack.dmThread(threadTs, msg);
        } else {
          await slack.dm(msg);
        }
        console.log(`[startup] Notified thread ${s.threadKey} about interrupted session ${s.sessionId}`);
      }
      await clearPersistedSessions(persistBaseDir);
    }
  } catch (err) {
    console.error(`[startup] Failed to recover persisted sessions: ${err}`);
  }

  const shutdown = async (signal: string) => {
    console.log(`[shutdown] Received ${signal}, starting graceful drain...`);
    await service.startDrain();
    service.stop();
    await stopApiServer();
    await slack.stopSlackBot();
    releaseLock(lockfilePath);
    process.exit(0);
  };
  process.on("SIGINT", () => { shutdown("SIGINT"); });
  process.on("SIGTERM", () => { shutdown("SIGTERM"); });

  // Keep alive
  await new Promise(() => {});
}

async function cmdAdd(args: string[]): Promise<void> {
  const opts = parseFlags(args);
  const name = opts["name"];
  const message = opts["message"];

  if (!name || !message) {
    return fail("Error: --name and --message are required.");
  }

  let schedule: Schedule;
  if (opts["cron"]) {
    schedule = { kind: "cron", expr: opts["cron"], tz: opts["tz"] ?? "UTC" };
  } else if (opts["every"]) {
    schedule = { kind: "every", everyMs: parseInt(opts["every"], 10) };
  } else {
    return fail("Error: --cron or --every is required.");
  }

  const backendOpt = opts["backend"] as "claude" | "cursor" | "opencode" | "auto" | undefined;
  if (backendOpt && !["claude", "cursor", "opencode", "auto"].includes(backendOpt)) {
    return fail("Error: --backend must be claude, cursor, opencode, or auto.");
  }

  const input: JobCreate = {
    name,
    schedule,
    payload: {
      message,
      model: opts["model"],
      cwd: opts["cwd"],
      backend: backendOpt,
    },
  };

  const store = new JobStore();
  await store.load();
  const job = await store.add(input);

  console.log(`Job added: ${job.name} (${job.id})`);
  if (job.state.nextRunAtMs) {
    console.log(`Next run: ${new Date(job.state.nextRunAtMs).toISOString()}`);
  }
}

async function cmdList(): Promise<void> {
  const store = new JobStore();
  await store.load();
  const jobs = store.list();

  if (jobs.length === 0) {
    console.log("No jobs configured.");
    return;
  }

  for (const job of jobs) {
    const enabled = job.enabled ? "enabled" : "disabled";
    const scheduleStr =
      job.schedule.kind === "cron"
        ? `cron: ${job.schedule.expr} (${job.schedule.tz ?? "UTC"})`
        : `every: ${job.schedule.everyMs}ms`;
    const nextRun = job.state.nextRunAtMs
      ? new Date(job.state.nextRunAtMs).toISOString()
      : "none";
    const lastStatus = job.state.lastStatus ?? "never run";

    console.log(`${job.id}  ${job.name}  [${enabled}]`);
    console.log(`  Schedule: ${scheduleStr}`);
    console.log(`  Next run: ${nextRun}`);
    console.log(`  Last: ${lastStatus} (${job.state.runCount} runs)`);
    console.log(`  Message: ${job.payload.message.slice(0, 80)}...`);
    console.log();
  }
}

async function cmdRemove(id: string): Promise<void> {
  const store = new JobStore();
  await store.load();
  const removed = await store.remove(id);
  console.log(removed ? `Job ${id} removed.` : `Job ${id} not found.`);
}

async function cmdRun(id: string): Promise<void> {
  const store = new JobStore();
  await store.load();
  const job = store.get(id);
  if (!job) return fail(`Job ${id} not found.`);

  // Start Slack bot so session notifications work for manual runs too
  const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
  const repoDir = job.payload.cwd ?? repoRoot;
  if (slack.isConfigured()) {
    await slack.startSlackBot({ repoDir, store });
    console.log(`[run] Slack bot connected for notifications.`);
  }

  console.log(`Running job: ${job.name} (${job.id})...`);
  const result = await executeJob(job, "manual");
  console.log(
    `\nResult: ${result.ok ? "ok" : "error"} (${Math.round(result.durationMs / 1000)}s)`,
  );
  if (result.error) {
    console.log(`Error: ${result.error}`);
  }
  if (result.logFile) {
    console.log(`Log: ${result.logFile}`);
  }

  await store.updateState(id, {
    lastRunAtMs: Date.now(),
    lastStatus: result.ok ? "ok" : "error",
    lastError: result.error ?? null,
    lastDurationMs: result.durationMs,
    runCount: job.state.runCount + 1,
  });

  await slack.stopSlackBot();
}

async function cmdSetEnabled(id: string, enabled: boolean): Promise<void> {
  const store = new JobStore();
  await store.load();
  await store.setEnabled(id, enabled);
  console.log(`Job ${id} ${enabled ? "enabled" : "disabled"}.`);
}

async function cmdStatus(): Promise<void> {
  const store = new JobStore();
  await store.load();

  const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");

  // Gather sessions (in-memory — only populated when scheduler is running)
  const sessions: StatusSession[] = listSessions().map((s) => ({
    id: s.id,
    jobName: s.jobName,
    startedAtMs: s.startedAtMs,
    elapsedMs: s.elapsedMs,
    costUsd: s.costUsd,
    numTurns: s.numTurns,
    lastActivity: s.lastActivity,
  }));

  // Gather experiments from disk
  const allExperiments = await listExperiments(repoRoot);
  const now = Date.now();
  const experiments: StatusExperiment[] = allExperiments.map((e) => {
    const startedAt = e.progress?.started_at;
    const elapsedMs = startedAt ? now - new Date(startedAt).getTime() : undefined;
    return {
      project: e.project,
      id: e.id,
      status: e.progress?.status ?? e.mdStatus ?? "unknown",
      startedAt,
      elapsedMs,
      progress: e.progress?.pct,
      message: e.progress?.message,
    };
  });

  // Gather jobs
  const jobs: StatusJob[] = store.list().map((j) => ({
    id: j.id,
    name: j.name,
    enabled: j.enabled,
    schedule: j.schedule.kind === "cron" ? j.schedule.expr : `every ${j.schedule.everyMs}ms`,
    nextRunAtMs: j.state.nextRunAtMs,
    lastStatus: j.state.lastStatus,
    lastRunAtMs: j.state.lastRunAtMs,
    runCount: j.state.runCount,
  }));

  const status = getUnifiedStatus({ sessions, experiments, jobs });
  console.log(formatUnifiedStatus(status));
}

async function cmdHeartbeat(): Promise<void> {
  // Default to repo root (two levels up from infra/scheduler)
  const repoDir = new URL("../../..", import.meta.url).pathname;
  const approvals = await getPendingApprovals(repoDir);

  if (approvals.length === 0) {
    console.log("No pending approvals.");
  } else {
    console.log(`${approvals.length} pending approval(s):`);
    for (const a of approvals) {
      console.log(`  - [${a.date}] ${a.title} (${a.project}) [${a.type}]`);
    }
    await slack.notifyPendingApprovals(repoDir);
    console.log("Slack notification sent (if configured).");
  }

  // Check for approved burst requests
  const bursts = await getExecutableBursts(repoDir);
  if (bursts.length > 0) {
    console.log(`\n${bursts.length} approved burst(s) ready for execution:`);
    for (const b of bursts) {
      console.log(`  - [${b.date}] ${b.title}: job=${b.job}, max-sessions=${b.maxSessions}, max-cost=$${b.maxCost}${b.autofix ? " (autofix)" : ""}`);
    }
    console.log("Burst(s) will auto-launch on next scheduler tick.");
  }
}

async function cmdWatchdog(args: string[]): Promise<void> {
  const opts = parseFlags(args);
  const limit = parseInt(opts["limit"] ?? "20", 10);
  const notify = args.includes("--notify");

  const { checks, sessionsAnalyzed } = await runHealthWatchdog({ limit });
  const { summary, details } = formatHealthReport(checks);

  console.log(`Analyzed ${sessionsAnalyzed} sessions.`);
  console.log(details);

  if (checks.length > 0 && notify && slack.isConfigured()) {
    const ts = await slack.dm(summary);
    if (ts) await slack.dmThread(ts, details);
    console.log("Slack notification sent.");
  }
}

async function cmdDetectAnomalies(args: string[]): Promise<void> {
  const opts = parseFlags(args);
  const limit = parseInt(opts["limit"] ?? "20", 10);
  const notify = args.includes("--notify");

  const { anomalies, sessionsAnalyzed } = await runAnomalyDetection({ limit });
  const { summary, details } = formatAnomalyReport(anomalies);

  console.log(`Analyzed ${sessionsAnalyzed} sessions.`);
  console.log(details);

  if (anomalies.length > 0 && notify && slack.isConfigured()) {
    const ts = await slack.dm(summary);
    if (ts) await slack.dmThread(ts, details);
    console.log("Slack notification sent.");
  }
}

async function cmdEscalateWarnings(args: string[]): Promise<void> {
  const opts = parseFlags(args);
  const limit = parseInt(opts["limit"] ?? "20", 10);
  const notify = args.includes("--notify");

  const { escalations, sessionsAnalyzed } = await runWarningEscalation({ limit });
  const { summary, details } = formatEscalationReport(escalations);

  console.log(`Analyzed ${sessionsAnalyzed} sessions.`);
  console.log(details);

  if (escalations.length > 0 && notify && slack.isConfigured()) {
    const ts = await slack.dm(summary);
    if (ts) await slack.dmThread(ts, details);
    console.log("Slack notification sent.");
  }
}

async function cmdAuditInteractions(args: string[]): Promise<void> {
  const opts = parseFlags(args);
  const since = opts["since"];
  const notify = args.includes("--notify");

  const { checks, stats } = await runInteractionAudit({ since });
  const { summary, details } = formatInteractionReport(checks, stats);

  console.log(`Analyzed ${stats.totalRecords} interactions.`);
  console.log(details);

  if (checks.length > 0 && notify && slack.isConfigured()) {
    const ts = await slack.dm(summary);
    if (ts) await slack.dmThread(ts, details);
    console.log("Slack notification sent.");
  }
}

interface HealthCheckState {
  consecutiveFailures: number;
  lastFailureTime: string | null;
  lastSuccessTime: string | null;
  alertSent: boolean;
}

async function cmdCheckHealth(args: string[]): Promise<void> {
  const opts = parseFlags(args);
  const url = opts["url"] ?? "http://localhost:8420";
  const timeout = parseInt(opts["timeout"] ?? "5000", 10);
  const stateFile = opts["state-file"] ?? "/tmp/akari-health-state.json";
  const notify = args.includes("--notify");

  const result = await runHealthCheck({ url, timeout, stateFile, notify });

  if (!result.healthy && result.consecutiveFailures >= 2) {
    process.exit(1);
  }
}

export interface HealthCheckResult {
  healthy: boolean;
  consecutiveFailures: number;
  errorMessage: string | null;
  alertSent: boolean;
  recoverySent: boolean;
}

export interface HealthCheckOptions {
  url: string;
  timeout: number;
  stateFile: string;
  notify: boolean;
  fetchImpl?: typeof fetch;
  slackImpl?: typeof slack;
}

export async function runHealthCheck(opts: HealthCheckOptions): Promise<HealthCheckResult> {
  const { url, timeout, stateFile, notify, fetchImpl = fetch, slackImpl = slack } = opts;
  const statusUrl = `${url}/api/status`;
  const now = new Date().toISOString();

  let state: HealthCheckState = {
    consecutiveFailures: 0,
    lastFailureTime: null,
    lastSuccessTime: null,
    alertSent: false,
  };

  try {
    const raw = readFileSync(stateFile, "utf-8");
    state = JSON.parse(raw);
  } catch {
    // State file doesn't exist or invalid, use defaults
  }

  let isHealthy = false;
  let errorMessage: string | null = null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetchImpl(statusUrl, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      isHealthy = true;
    } else {
      errorMessage = `HTTP ${response.status} ${response.statusText}`;
    }
  } catch (err) {
    if (err instanceof Error) {
      if (err.name === "AbortError") {
        errorMessage = `Timeout after ${timeout}ms`;
      } else {
        errorMessage = err.message;
      }
    } else {
      errorMessage = String(err);
    }
  }

  let alertSent = false;
  let recoverySent = false;

  if (isHealthy) {
    const wasDown = state.consecutiveFailures > 0;
    state = {
      consecutiveFailures: 0,
      lastFailureTime: state.lastFailureTime,
      lastSuccessTime: now,
      alertSent: false,
    };

    console.log(`[health] OK — scheduler responding at ${url}`);

    if (wasDown && notify && slackImpl.isConfigured()) {
      const downtime = state.lastFailureTime
        ? Math.round((new Date(now).getTime() - new Date(state.lastFailureTime).getTime()) / 1000 / 60)
        : 0;
      const msg = `:white_check_mark: *Scheduler recovered*\n` +
        `URL: ${url}\n` +
        `Downtime: ~${downtime} minutes\n` +
        `Recovered at: ${now}`;
      await slackImpl.dm(msg);
      console.log("[health] Recovery notification sent to Slack");
      recoverySent = true;
    }
  } else {
    state.consecutiveFailures++;
    state.lastFailureTime = now;

    console.error(`[health] FAIL (${state.consecutiveFailures} consecutive) — ${errorMessage}`);

    if (state.consecutiveFailures >= 2 && !state.alertSent && notify && slackImpl.isConfigured()) {
      state.alertSent = true;
      alertSent = true;
      const msg = `:rotating_light: *Scheduler health check failed*\n` +
        `URL: ${statusUrl}\n` +
        `Error: ${errorMessage}\n` +
        `Consecutive failures: ${state.consecutiveFailures}\n` +
        `Time: ${now}\n\n` +
        `_Run \`pm2 logs akari\` or check \`systemctl status akari\` for details._`;
      await slackImpl.dm(msg);
      console.log("[health] Alert sent to Slack");
    }
  }

  try {
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[health] Failed to write state file: ${err}`);
  }

  return {
    healthy: isHealthy,
    consecutiveFailures: state.consecutiveFailures,
    errorMessage,
    alertSent,
    recoverySent,
  };
}

async function cmdBurst(args: string[]): Promise<void> {
  const opts = parseFlags(args);
  const jobName = opts["job"];
  if (!jobName) return fail("Error: --job <name> is required for burst mode.");

  const maxSessions = parseInt(opts["max-sessions"] ?? "10", 10);
  const maxCost = parseFloat(opts["max-cost"] ?? "50");
  const autofixEnabled = args.includes("--autofix");
  const autofixRetries = parseInt(opts["autofix-retries"] ?? "3", 10);

  if (isNaN(maxSessions) || maxSessions < 0) return fail("Error: --max-sessions must be a non-negative integer.");
  if (isNaN(maxCost) || maxCost < 0) return fail("Error: --max-cost must be a non-negative number.");

  const store = new JobStore();
  await store.load();
  const job = store.list().find((j) => j.name === jobName);
  if (!job) return fail(`Error: no job with name "${jobName}" found.`);

  // Start Slack bot so session notifications work
  const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
  const repoDir = job.payload.cwd ?? repoRoot;
  if (slack.isConfigured()) {
    await slack.startSlackBot({ repoDir, store });
    console.log(`[burst] Slack bot connected for notifications.`);
  }

  const autofixLabel = autofixEnabled ? `, autofix=on (max ${autofixRetries} retries)` : "";
  console.log(`[burst] Starting burst mode: job="${job.name}", max-sessions=${maxSessions}, max-cost=$${maxCost}${autofixLabel}`);

  const result = await runBurst({
    job,
    maxSessions,
    maxCost,
    execute: executeJob,
    onSessionComplete: (num, sessionResult, totalCost) => {
      const status = sessionResult.ok ? "ok" : "error";
      const cost = sessionResult.costUsd?.toFixed(2) ?? "n/a";
      console.log(`[burst] Session ${num} complete: ${status}, cost=$${cost}, cumulative=$${totalCost.toFixed(2)}`);
    },
    ...(autofixEnabled ? {
      autofix: {
        maxRetries: autofixRetries,
        diagnose: (diagOpts) => diagnoseSession({ ...diagOpts, repoDir }),
        repoDir,
      },
      onAutofix: (attempt, fixResult) => {
        console.log(`[burst] Autofix attempt ${attempt}: verdict=${fixResult.verdict}, cost=$${fixResult.costUsd.toFixed(2)}`);
        console.log(`[burst] ${fixResult.summary.slice(0, 200)}`);
      },
    } : {}),
  });

  console.log(`\n[burst] Burst complete.`);
  console.log(`  Sessions run: ${result.sessionsRun}`);
  console.log(`  Total cost: $${result.totalCost.toFixed(2)}`);
  console.log(`  Total duration: ${Math.round(result.totalDurationMs / 1000)}s`);
  console.log(`  Stop reason: ${result.stopReason}`);
  if (result.autofixAttempts > 0) {
    console.log(`  Autofix attempts: ${result.autofixAttempts}`);
  }

  await slack.stopSlackBot();
}

async function cmdCleanupBranches(args: string[]): Promise<void> {
  const opts = parseFlags(args);
  const keepDays = parseInt(opts["keep-days"] ?? "7", 10);
  const dryRun = args.includes("--dry-run");
  const notify = args.includes("--notify");

  if (isNaN(keepDays) || keepDays < 0) return fail("Error: --keep-days must be a non-negative integer.");

  const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
  
  console.log(`[branch-cleanup] Running cleanup: keepDays=${keepDays}, dryRun=${dryRun}`);
  
  const result = await runBranchCleanup(repoRoot, { keepDays, dryRun });
  const report = formatCleanupReport(result);

  console.log(report);

  if (notify && slack.isConfigured()) {
    await slack.dm(report);
    console.log("Slack notification sent.");
  }
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return flags;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
