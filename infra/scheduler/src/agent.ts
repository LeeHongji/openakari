/** Unified agent spawning — single entry point for all agent sessions (work, chat, autofix, team). */

import { resolveBackend, type BackendQueryOpts, type SessionHandle, type BackendPreference } from "./backend.js";
import type { QueryOpts } from "./sdk.js";
import {
  registerSession,
  unregisterSession,
  bufferMessage,
  summarizeMessage,
  updateSessionStats,
  incrementSessionTurns,
} from "./session.js";
import { isDraining } from "./drain-state.js";
import { checkMessageForSleepViolation } from "./sleep-guard.js";
import { checkMessageForPm2Violation } from "./security.js";
import { StallGuard, extractShellCommands } from "./stall-guard.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentProfile {
  model: string;
  maxTurns?: number;        // undefined = unlimited (SDK default)
  maxDurationMs: number;
  label: string;            // for logging: "work-session", "chat", "autofix"
}

export const AGENT_PROFILES = {
  workSession: { model: "opus", maxDurationMs: 1_800_000, label: "work-session" },
  teamWorkSession: { model: "opus", maxTurns: 256, maxDurationMs: 7_200_000, label: "team-work-session" },
  // Read env var lazily (not at import time) so .env loading in cli.ts takes effect
  chat: { get model() { return process.env["SLACK_CHAT_MODEL"] ?? "sonnet"; }, maxTurns: 16, maxDurationMs: 120_000, label: "chat" },
  autofix: { model: "opus", maxTurns: 32, maxDurationMs: 600_000, label: "autofix" },
  deepWork: { model: "opus", maxTurns: 256, maxDurationMs: 3_600_000, label: "deep-work" },
  skillCycle: { model: "sonnet", maxTurns: 48, maxDurationMs: 900_000, label: "skill-cycle" },
  fleetWorker: { model: "opus", maxTurns: 64, maxDurationMs: 900_000, label: "fleet-worker" },
} as const satisfies Record<string, AgentProfile>;

// ── Backend-specific profile overrides ──────────────────────────────────────
// Weaker backends (e.g. opencode/GLM-5) need tighter limits to prevent
// convention non-compliance cascades. See feedback-frequent-human-interventions-root-cause-2026-02-27.

type ProfileOverrides = Partial<Pick<AgentProfile, "maxTurns" | "maxDurationMs">>;

export const BACKEND_PROFILE_OVERRIDES: Record<string, Record<string, ProfileOverrides>> = {
  opencode: {
    "work-session":      { maxTurns: 64,  maxDurationMs: 900_000 },   // 15 min (was 30 min unlimited turns)
    "deep-work":         { maxTurns: 256, maxDurationMs: 3_600_000 }, // 60 min
    "skill-cycle":       { maxTurns: 64,  maxDurationMs: 600_000 },   // 10 min (was 15 min 48 turns)
    "team-work-session": { maxTurns: 128, maxDurationMs: 3_600_000 }, // 60 min (was 120 min 256 turns)
    "fleet-worker":      { maxTurns: 64,  maxDurationMs: 900_000 },   // 15 min (fleet workers, ADR 0042-v2)
  },
};

/** Apply backend-specific overrides to a resolved profile.
 *  Returns a new profile object — the original is not mutated. */
export function resolveProfileForBackend(
  profile: AgentProfile,
  backendName: string,
): AgentProfile {
  const overrides = BACKEND_PROFILE_OVERRIDES[backendName]?.[profile.label];
  if (!overrides) return profile;
  return { ...profile, ...overrides };
}

export interface SpawnAgentOpts {
  profile: AgentProfile;
  prompt: string;
  cwd: string;
  backend?: BackendPreference;
  jobId?: string;
  jobName?: string;
  /** Pre-generated session ID. If omitted, one is generated from profile label + timestamp. */
  sessionId?: string;
  /** Custom subagents available via the Task tool (from buildTeamAgents). */
  agents?: QueryOpts["agents"];
  /** SDK lifecycle hooks for team events (from buildTeamHooks). */
  hooks?: QueryOpts["hooks"];
  /** Tools the agent is not allowed to use (e.g. EnterPlanMode in headless sessions). */
  disallowedTools?: string[];
  /** Extra environment variables to inject (e.g. experimental feature flags for Agent Teams). */
  extraEnv?: Record<string, string>;
  /** Claude session ID to resume (--resume flag). Enables multi-turn within same conversation. */
  resume?: string;
  onMessage?: (msg: Record<string, unknown>) => void | Promise<void>;
}

export interface AgentResult {
  text: string;
  costUsd: number;
  numTurns: number;
  durationMs: number;
  timedOut: boolean;
  /** Claude CLI session ID — use with --resume for multi-turn. */
  claudeSessionId?: string;
  /** Per-model token usage and cost breakdown from the SDK. */
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number; contextWindow?: number; maxOutputTokens?: number }>;
  /** Per-tool invocation counts (e.g. { Read: 15, Bash: 5, Edit: 3 }). */
  toolCounts?: Record<string, number>;
  /** Number of assistant turns consumed by the /orient skill. Null if orient was not detected. */
  orientTurns?: number;
  /** Set when the session was terminated due to a sleep >30s violation. Contains the violating command. */
  sleepViolation?: string;
  /** Set when the session was terminated due to a pm2 stop/delete command. Contains the violating command. */
  pm2Violation?: string;
  /** Set when the session was terminated due to a shell tool call running >120s. Contains the stalled command. */
  stallViolation?: string;
}

/** Generate a session ID from a profile label. Exported so callers
 *  can pre-generate the ID before building the prompt. */
export function generateSessionId(label: string): string {
  return `${label}-${Date.now().toString(36)}`;
}

// ── Shared utilities ─────────────────────────────────────────────────────────

/** Map tool_use blocks to short human-readable descriptions. */
export function summarizeToolUses(
  blocks: Array<{ type: string; name?: string; input?: Record<string, unknown> }>,
): string[] {
  return blocks
    .filter((b) => b.type === "tool_use")
    .map((t) => {
      const inp = t.input ?? {};
      if (t.name === "Read" || t.name === "Edit" || t.name === "Write") return `${t.name} \`${inp.file_path ?? "?"}\``;
      if (t.name === "Glob") return `Glob \`${inp.pattern ?? "?"}\``;
      if (t.name === "Grep") return `Grep \`${inp.pattern ?? "?"}\``;
      if (t.name === "Bash" || t.name === "Shell" || t.name === "bash") return `${t.name} \`${String(inp.command ?? "").slice(0, 60)}\``;
      return t.name ?? "tool";
    });
}

/** Debounce tool_use_summary events into batches, flushing after a quiet period. */
export function createToolBatchFlusher(
  callback: (summaryLine: string) => Promise<void>,
  debounceMs = 1500,
): { push: (summary: string) => void; flush: () => Promise<void> } {
  let batch: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = async () => {
    timer = null;
    if (batch.length === 0) return;
    const items = batch.splice(0);
    await callback(`:gear: ${items.join(", ")}`);
  };

  return {
    push(summary: string) {
      batch.push(summary);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    },
    flush: async () => {
      if (timer) { clearTimeout(timer); timer = null; }
      await flush();
    },
  };
}

// ── spawnAgent ───────────────────────────────────────────────────────────────

export function spawnAgent(opts: SpawnAgentOpts): {
  sessionId: string;
  handle: SessionHandle;
  result: Promise<AgentResult>;
} {
  if (isDraining()) {
    throw new Error("Cannot spawn agent: scheduler is draining for restart");
  }

  const sessionId = opts.sessionId ?? `${opts.profile.label}-${Date.now().toString(36)}`;
  const backend = resolveBackend(opts.backend);

  console.log(`[agent] Spawning [${sessionId}]: backend=${backend.name}, model=${opts.profile.model}, maxTurns=${opts.profile.maxTurns ?? "unlimited"}, prompt="${opts.prompt.slice(0, 80)}..."`);

  const queryOpts: BackendQueryOpts = {
    prompt: opts.prompt,
    cwd: opts.cwd,
    model: opts.profile.model,
    systemPrompt: { type: "preset", preset: "claude_code" },
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    tools: { type: "preset", preset: "claude_code" },
    settingSources: ["project"],
    maxTurns: opts.profile.maxTurns,
    disallowedTools: opts.disallowedTools,
    agents: opts.agents,
    hooks: opts.hooks,
    extraEnv: opts.extraEnv,
    resume: opts.resume,
    onMessage: async (msg) => {
      // Forward to caller's handler
      await opts.onMessage?.(msg as Record<string, unknown>);

      // Track turns incrementally so the count is accurate even for backends
      // (like Cursor) that don't report num_turns in their result message.
      if (msg.type === "assistant") {
        incrementSessionTurns(sessionId);
      }

      // L0 sleep guard: check for sleep >30s in Bash tool_use blocks
      if (!sleepViolation) {
        const violation = checkMessageForSleepViolation(msg);
        if (violation) {
          sleepViolation = violation.command;
          console.log(`[agent] SLEEP VIOLATION [${sessionId}]: sleep ${violation.seconds}s detected in command: ${violation.command.slice(0, 100)}`);
          console.log(`[agent] Terminating session [${sessionId}] — "never sleep >30 seconds" (ADR 0017, L0 enforcement)`);
          handle.interrupt().catch(() => {});
        }
      }

      // L0 pm2 guard: check for pm2 stop/delete in Bash tool_use blocks
      if (!pm2Violation) {
        const violation = checkMessageForPm2Violation(msg);
        if (violation) {
          pm2Violation = violation;
          console.log(`[agent] PM2 VIOLATION [${sessionId}]: pm2 stop/delete detected in command: ${violation.slice(0, 100)}`);
          console.log(`[agent] Terminating session [${sessionId}] — pm2 stop/delete would kill the scheduler (L0 enforcement)`);
          handle.interrupt().catch(() => {});
        }
      }

      // L0 stall guard: track shell tool call wall-clock duration.
      // Clear timer on tool_call_completed (tool finished), assistant (next turn), or result (session end).
      // tool_use_summary for non-shell tools does NOT clear the timer — parallel
      // tool calls (e.g. Shell + Read in same turn) would otherwise reset it.
      if (!stallViolation) {
        const shellCmd = extractShellCommands(msg as Record<string, unknown>);
        if (shellCmd) {
          stallGuard.onShellToolUse(shellCmd);
        } else if ((msg as { type?: string }).type === "tool_call_completed" ||
                   (msg as { type?: string }).type === "assistant" ||
                   (msg as { type?: string }).type === "result") {
          stallGuard.onActivity();
        }
      }

      // Update session stats from result messages (before buffering, so watch
      // forwarder sees accurate cost/turns when finalizing living messages).
      // numTurns=0 is treated as "not reported" and preserves the incremental count.
      if (msg.type === "result") {
        updateSessionStats(sessionId, msg.total_cost_usd ?? 0, msg.num_turns ?? 0);
      }

      // Buffer summarized messages for session watchers
      const summary = summarizeMessage(msg);
      if (summary) bufferMessage(sessionId, summary);
    },
  };

  const supervised = backend.runSupervised(queryOpts);
  const handle = supervised.handle;

  // Register session for visibility and supervision
  registerSession(sessionId, opts.jobId ?? opts.profile.label, opts.jobName ?? opts.profile.label, handle);

  // Duration timeout
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.log(`[agent] Session [${sessionId}] timed out after ${opts.profile.maxDurationMs}ms, sending interrupt`);
    handle.interrupt().catch(() => {});
  }, opts.profile.maxDurationMs);

  // L0 sleep guard — terminate sessions that attempt sleep >30s (ADR 0017)
  let sleepViolation: string | undefined;
  // L0 pm2 guard — terminate sessions that attempt pm2 stop/delete (ADR 0027)
  let pm2Violation: string | undefined;
  // L0 stall guard — terminate sessions with shell tool calls running >120s
  let stallViolation: string | undefined;
  const stallGuard = new StallGuard({
    onStall: (commands) => {
      stallViolation = commands;
      console.log(`[agent] WALL-CLOCK STALL [${sessionId}]: Shell tool call running >120s: ${commands.slice(0, 200)}`);
      console.log(`[agent] Terminating session [${sessionId}] — wall-clock stall detection (L0 enforcement, ADR 0017)`);
      handle.interrupt().catch(() => {});
    },
  });

  const result = supervised.result
    .then((r): AgentResult => {
      clearTimeout(timer);
      unregisterSession(sessionId);
      console.log(`[agent] Complete [${sessionId}]: ${r.text.length} chars, ${r.numTurns ?? "?"} turns, ${r.durationMs}ms, $${r.costUsd?.toFixed(4) ?? "n/a"}`);
      stallGuard.dispose();
      return {
        text: r.text,
        costUsd: r.costUsd ?? 0,
        numTurns: r.numTurns ?? 0,
        durationMs: r.durationMs,
        timedOut,
        claudeSessionId: r.sessionId,
        modelUsage: r.modelUsage,
        toolCounts: r.toolCounts,
        orientTurns: r.orientTurns,
        sleepViolation,
        pm2Violation,
        stallViolation,
      };
    })
    .catch((err): Promise<AgentResult> => {
      clearTimeout(timer);
      stallGuard.dispose();
      unregisterSession(sessionId);
      throw err;
    });

  return { sessionId, handle, result };
}
