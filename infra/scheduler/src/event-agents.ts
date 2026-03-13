/** Event-triggered agents — system or human-initiated agents that run asynchronously
 *  with progress forwarded to Slack. Shared pattern: build prompt → spawn → forward → complete. */

import { readFile, readdir, stat, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { spawnAgent, AGENT_PROFILES, resolveProfileForBackend, summarizeToolUses, createToolBatchFlusher } from "./agent.js";
import { resolveBackend } from "./backend.js";
import { validateShellCommand, validateCommand, SecurityError } from "./security.js";
import { SHELL_TOOL_NAMES } from "./sleep-guard.js";
import { launchExperiment, trackExperiment } from "./experiments.js";
import { recordInteraction, type InteractionRecord } from "./metrics.js";
import { listSkills, formatSkillList, readSkillContent } from "./skills.js";
import { persistSession, unpersistSession } from "./session-persistence.js";
import { addWatcher } from "./session.js";
import {
  parseQuestionMarker,
  setPendingQuestion,
  type PendingQuestion,
} from "./question-marker.js";

// ── Plan file reader ─────────────────────────────────────────────────────────

const PLAN_MAX_CHARS = 3000;

/** Read the newest plan file from .claude/plans/ in the given repo directory.
 *  Returns file content (truncated to 3000 chars) or null if no plans exist. */
export async function readPlanFile(repoDir: string): Promise<string | null> {
  const plansDir = join(repoDir, ".claude", "plans");
  let entries: string[];
  try {
    entries = await readdir(plansDir);
  } catch {
    return null;
  }

  const mdFiles = entries.filter((f) => f.endsWith(".md"));
  if (mdFiles.length === 0) return null;

  // Find newest by mtime
  let newest = mdFiles[0];
  let newestMtime = 0;
  for (const f of mdFiles) {
    const s = await stat(join(plansDir, f));
    if (s.mtimeMs > newestMtime) {
      newestMtime = s.mtimeMs;
      newest = f;
    }
  }

  let content = await readFile(join(plansDir, newest), "utf-8");
  if (content.length > PLAN_MAX_CHARS) {
    content = content.slice(0, PLAN_MAX_CHARS);
  }
  return content;
}

// ── Shared progress handler ──────────────────────────────────────────────────

interface ProgressHandlerOpts {
  onProgress: (text: string) => Promise<void>;
  label: string;
  /** If true, intercept and block dangerous Bash commands. Default: true. */
  securityCheck?: boolean;
  /** Called when security check blocks a command. */
  onSecurityBlock?: (cmd: string, reason: string) => Promise<void>;
  /** Strip tags from text before forwarding. */
  stripTags?: (text: string) => string;
  /** If true, detect EnterPlanMode/ExitPlanMode tool calls and notify. */
  detectPlanMode?: boolean;
  /** Repo directory — needed to read plan files on ExitPlanMode. */
  repoDir?: string;
  /** Called when ExitPlanMode is detected. Use to auto-approve in headless sessions. */
  onExitPlanMode?: (planText: string | null) => Promise<void>;
  /** If true, detect [QUESTION: ...] markers for human input. */
  detectQuestions?: boolean;
  /** Called when a question marker is detected. Receives thread key and parsed question. */
  onQuestionDetected?: (threadKey: string, question: PendingQuestion) => Promise<void>;
  /** Thread key for storing pending questions. */
  threadKey?: string;
}

/** Build a reusable onMessage handler that debounces tool summaries and forwards
 *  assistant text to the provided callback. Optionally intercepts dangerous Bash commands. */
export function buildProgressHandler(opts: ProgressHandlerOpts) {
  const flusher = createToolBatchFlusher((line) => opts.onProgress(line), 2000);
  const doSecurity = opts.securityCheck ?? true;

  const handler = async (msg: Record<string, unknown>) => {
    const type = msg.type as string;
    console.log(`[${opts.label}] message: type=${type}`);

    // Security interception
    if (doSecurity && type === "assistant") {
      const content = msg.message as { content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }> } | undefined;
      if (content?.content) {
        for (const block of content.content) {
          if (block.type === "tool_use" && SHELL_TOOL_NAMES.has(block.name ?? "") && block.input?.command) {
            try { validateShellCommand(String(block.input.command)); }
            catch (err) {
              const reason = err instanceof SecurityError ? err.message : "dangerous command";
              console.error(`[security] ${opts.label} blocked: ${reason}`);
              await opts.onSecurityBlock?.(String(block.input.command), reason);
            }
          }
        }
      }
    }

    if (type === "tool_use_summary") {
      const summary = msg.summary as string | undefined;
      if (summary) flusher.push(summary);
      return;
    }

    if (type === "assistant") {
      await flusher.flush();

      const content = msg.message as { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> } | undefined;
      if (!content?.content) return;
      const blocks = content.content;

      // Plan mode detection: notify on EnterPlanMode/ExitPlanMode tool calls
      if (opts.detectPlanMode) {
        for (const block of blocks) {
          if (block.type === "tool_use" && block.name === "EnterPlanMode") {
            await opts.onProgress(":clipboard: *Entering plan mode — exploring before making changes…*");
          }
          if (block.type === "tool_use" && block.name === "ExitPlanMode") {
            const planText = opts.repoDir ? await readPlanFile(opts.repoDir) : null;
            if (planText) {
              await opts.onProgress(`:page_facing_up: *Plan:*\n\n${planText}`);
            }
            await opts.onProgress(":arrow_forward: *Exiting plan mode — proceeding with implementation…*");
            // Auto-approve callback for headless sessions
            if (opts.onExitPlanMode) {
              await opts.onExitPlanMode(planText);
            }
          }
        }
      }

      for (const block of blocks) {
        if (block.type === "text" && block.text?.trim()) {
          const text = opts.stripTags ? opts.stripTags(block.text) : block.text.trim();

          // Question marker detection for human input during sessions
          if (opts.detectQuestions && text) {
            const parsed = parseQuestionMarker(text);
            if (parsed && opts.threadKey && opts.onQuestionDetected) {
              console.log(`[${opts.label}] Question marker detected: ${parsed.questionId}`);
              await opts.onQuestionDetected(opts.threadKey, {
                questionId: parsed.questionId,
                skillName: parsed.skillName ?? "unknown",
                mode: parsed.mode,
                questions: parsed.questions,
                partialState: parsed.partialState ?? {},
                askedAt: Date.now(),
              });
            }
          }

          if (text) await opts.onProgress(text);
          return;
        }
      }

      const summaries = summarizeToolUses(blocks);
      if (summaries.length > 0) {
        await opts.onProgress(`:gear: ${summaries.join(", ")}`);
      }
    }
  };

  return { handler, flusher };
}

// ── Interaction logging helper ──────────────────────────────────────────────

function logInteraction(
  action: string,
  args: Record<string, unknown>,
  threadKey: string,
  result: "ok" | "error",
  detail?: string,
  extras?: Partial<Pick<InteractionRecord, "intentFulfilled" | "intentType" | "turnsBeforeAction" | "userCorrected">>,
): Promise<void> {
  return recordInteraction({
    timestamp: new Date().toISOString(),
    action,
    args,
    source: "chat_agent",
    threadKey,
    result,
    detail,
    ...extras,
  }).catch((err) => {
    console.error(`[event-agents] Failed to log interaction: ${err}`);
  });
}

// ── Experiment validation ─────────────────────────────────────────────────────

const execFileAsync = promisify(execFile);

const VALIDATOR_SCRIPT = new URL(
  "../../experiment-validator/validate.py",
  import.meta.url,
).pathname;

export interface ValidateExperimentOpts {
  /** If true, skip repo-wide checks (cross-refs, literature, approvals, etc.).
   *  Used by autofix to prevent unrelated repo issues from blocking experiment relaunches. */
  experimentOnly?: boolean;
}

/** Run the experiment validator on a directory. Returns { ok, output }. */
export async function validateExperimentDir(
  experimentDir: string,
  opts?: ValidateExperimentOpts,
): Promise<{ ok: boolean; output: string }> {
  const args = opts?.experimentOnly
    ? [VALIDATOR_SCRIPT, "--experiment-only", experimentDir]
    : [VALIDATOR_SCRIPT, experimentDir];
  try {
    const { stdout } = await execFileAsync("python3", args, {
      timeout: 15_000,
    });
    return { ok: true, output: stdout.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    const output = (e.stdout ?? "").trim() || (e.stderr ?? "").trim() || "validation failed";
    return { ok: false, output };
  }
}

// ── Auto-fix for failed experiments ──────────────────────────────────────────

/** Extract structured Diagnosis + Action sections from autofix response.
 *  Falls back to truncating the raw response to 500 chars, preferring the last paragraph. */
function extractAutofixSummary(response: string): string {
  const diagMatch = response.match(/## Diagnosis\s*\n([\s\S]*?)(?=\n## |\n\[AUTOFIX:|$)/);
  const actionMatch = response.match(/## Action\s*\n([\s\S]*?)(?=\n## |\n\[AUTOFIX:|$)/);

  if (diagMatch || actionMatch) {
    const parts: string[] = [];
    if (diagMatch) parts.push(`*Diagnosis:* ${diagMatch[1].trim()}`);
    if (actionMatch) parts.push(`*Action:* ${actionMatch[1].trim()}`);
    return parts.join("\n");
  }

  // Fallback: prefer the last paragraph, truncate to 500 chars
  const paragraphs = response.split(/\n{2,}/).filter((p) => p.trim());
  const lastParagraph = paragraphs[paragraphs.length - 1] ?? response;
  return lastParagraph.length > 500 ? lastParagraph.slice(-500) : lastParagraph;
}

/** Track retry counts to prevent infinite fix loops. Key: "project/expId" */
const autoFixRetries = new Map<string, number>();
const MAX_AUTO_FIX_RETRIES = 8;

/** Track currently running autofix agents to prevent concurrent runs for the same experiment. */
const autoFixRunning = new Set<string>();

export interface AutoFixOpts {
  project: string;
  expId: string;
  experimentDir: string;
  error: string;
  logTail: string;
  repoDir: string;
  /** Callback to post messages (e.g. to a Slack DM). */
  onMessage: (text: string) => Promise<void>;
}

/** Spawn a diagnostic agent to investigate and fix a failed experiment.
 *  If the agent fixes the issue and the validator passes, re-launches automatically. */
export async function autoFixExperiment(opts: AutoFixOpts): Promise<void> {
  const key = `${opts.project}/${opts.expId}`;

  // Debounce: skip if an autofix agent is already running for this experiment
  if (autoFixRunning.has(key)) {
    console.log(`[autofix] Already running for ${key}, skipping duplicate trigger.`);
    return;
  }

  const retries = autoFixRetries.get(key) ?? 0;

  if (retries >= MAX_AUTO_FIX_RETRIES) {
    console.log(`[autofix] Max retries (${MAX_AUTO_FIX_RETRIES}) reached for ${key}, skipping.`);
    await opts.onMessage(`:no_entry: Auto-fix skipped for *${key}* — max retries (${MAX_AUTO_FIX_RETRIES}) reached. Please investigate manually.`);
    autoFixRetries.delete(key);
    return;
  }

  autoFixRetries.set(key, retries + 1);
  autoFixRunning.add(key);
  console.log(`[autofix] Starting diagnostic for ${key} (attempt ${retries + 1}/${MAX_AUTO_FIX_RETRIES})`);
  await opts.onMessage(`:wrench: *Auto-diagnosing failed experiment:* ${key}...`);

  // Read experiment files for context
  let experimentMd = "";
  let progressJson = "";
  let configContent = "";
  try {
    experimentMd = await readFile(join(opts.experimentDir, "EXPERIMENT.md"), "utf-8");
    if (experimentMd.length > 3000) experimentMd = experimentMd.slice(0, 3000) + "\n...(truncated)";
  } catch { /* missing */ }
  try {
    progressJson = await readFile(join(opts.experimentDir, "progress.json"), "utf-8");
  } catch { /* missing */ }
  try {
    // Try common config file names
    const entries = await readdir(opts.experimentDir);
    const configFile = entries.find((f) => f.match(/^config\.(yaml|yml|json|toml)$/));
    if (configFile) {
      configContent = await readFile(join(opts.experimentDir, configFile), "utf-8");
      if (configContent.length > 2000) configContent = configContent.slice(0, 2000) + "\n...(truncated)";
    }
  } catch { /* missing */ }

  const diagnosticPrompt = [
    `You are Akari's experiment diagnostic agent. An experiment just failed and you need to investigate and fix the issue.`,
    ``,
    `## Failed experiment`,
    `- Project: ${opts.project}`,
    `- Experiment: ${opts.expId}`,
    `- Directory: ${opts.experimentDir}`,
    `- Error: ${opts.error}`,
    ``,
    `## Log tail`,
    `\`\`\``,
    opts.logTail || "(no log available)",
    `\`\`\``,
    ``,
    progressJson ? `## progress.json\n\`\`\`json\n${progressJson}\n\`\`\`` : "",
    experimentMd ? `## EXPERIMENT.md\n${experimentMd}` : "",
    configContent ? `## Config\n\`\`\`\n${configContent}\n\`\`\`` : "",
    ``,
    `## Instructions`,
    `1. Read the error and log to diagnose the root cause.`,
    `2. Use your tools to investigate further if needed.`,
    `3. If you can fix the issue (e.g. bad config, wrong paths, missing fields, syntax errors), fix it using Edit.`,
    `4. Structure your final response with these sections:`,
    `   ## Diagnosis`,
    `   <1-3 sentences: what went wrong and why>`,
    `   ## Action`,
    `   <what you changed, or why human intervention is needed>`,
    `5. End your response with exactly one of:`,
    `   - \`[AUTOFIX:fixed]\` — if you made changes that should resolve the issue`,
    `   - \`[AUTOFIX:unfixable]\` — if the issue requires human intervention (explain why)`,
    ``,
    `Diagnose and fix the failed experiment. Be concise — focus on the fix, not lengthy analysis.`,
  ].filter(Boolean).join("\n");

  const { handler, flusher } = buildProgressHandler({
    onProgress: opts.onMessage,
    label: "autofix",
    securityCheck: true,
    onSecurityBlock: async (cmd, reason) => {
      console.error(`[security] Autofix blocked: ${reason} — "${cmd.slice(0, 100)}"`);
    },
  });

  const { result } = spawnAgent({
    profile: AGENT_PROFILES.autofix,
    prompt: diagnosticPrompt,
    cwd: opts.repoDir,
    onMessage: handler,
  });

  try {
    const agentResult = await result;
    await flusher.flush();
    const response = agentResult.text || "No diagnostic output.";

    // Parse result tag
    const fixed = /\[AUTOFIX:fixed\]/.test(response);
    const cleanResponse = response.replace(/\[AUTOFIX:\w+\]/, "").trim();

    if (fixed) {
      // Validate the experiment after fix — use experimentOnly to skip repo-wide checks
      // so unrelated broken links don't block relaunches (see diagnosis-autofix-relaunch-failures)
      const validation = await validateExperimentDir(opts.experimentDir, { experimentOnly: true });
      if (validation.ok) {
        // Read the original command and launch config from progress.json to re-launch.
        // Must recover ALL mandatory flags (command, max_retries, watch_csv, total)
        // or the runner exits with code 4 (missing mandatory flags for --detach).
        let command: string[] | null = null;
        let maxRetries: number | undefined;
        let watchCsv: string | undefined;
        let total: number | undefined;
        try {
          const raw = await readFile(join(opts.experimentDir, "progress.json"), "utf-8");
          const progress = JSON.parse(raw);
          command = progress.command ?? null;
          maxRetries = progress.max_retries ?? undefined;
          watchCsv = progress.watch_csv ?? undefined;
          total = progress.total ?? undefined;
        } catch { /* no command to recover */ }

        // Derive projectDir from experiment path: projects/<project>/experiments/<id>
        // The project directory is two levels up from the experiment directory.
        const projectDir = join(opts.experimentDir, "..", "..");

        if (command && command.length > 0) {
          try {
            validateCommand(command, { allowShells: true });
            const { pid } = await launchExperiment({
              experimentDir: opts.experimentDir,
              command,
              maxRetries,
              projectDir,
              watchCsv,
              total,
            });
            trackExperiment(opts.experimentDir, opts.project, opts.expId);
            await opts.onMessage(
              `:wrench: *Auto-fix complete for ${key}:*\n${cleanResponse}\n\n` +
              `:white_check_mark: Validation passed. Re-launched (PID ${pid}).`,
            );
            await logInteraction("autofix", { project: opts.project, id: opts.expId, action: "fixed_and_relaunched" }, "autofix", "ok", `PID ${pid}`);
            return;
          } catch (err) {
            await opts.onMessage(
              `:wrench: *Auto-fix for ${key}:*\n${cleanResponse}\n\n` +
              `:warning: Fix applied and validated, but re-launch failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            await logInteraction("autofix", { project: opts.project, id: opts.expId, action: "fixed_relaunch_failed" }, "autofix", "error", String(err));
            return;
          }
        } else {
          await opts.onMessage(
            `:wrench: *Auto-fix for ${key}:*\n${cleanResponse}\n\n` +
            `:white_check_mark: Fix applied and validated. No original command found in progress.json — re-launch manually.`,
          );
          await logInteraction("autofix", { project: opts.project, id: opts.expId, action: "fixed_no_command" }, "autofix", "ok");
          return;
        }
      } else {
        await opts.onMessage(
          `:wrench: *Auto-fix for ${key}:*\n${cleanResponse}\n\n` +
          `:x: Validation still fails after fix:\n\`\`\`\n${validation.output.slice(0, 800)}\n\`\`\``,
        );
        await logInteraction("autofix", { project: opts.project, id: opts.expId, action: "fixed_validation_failed" }, "autofix", "error", validation.output.slice(0, 200));
        return;
      }
    }

    // Check if the agent exhausted its turn limit.
    const turnsUsed = agentResult.numTurns;
    const maxTurns = AGENT_PROFILES.autofix.maxTurns ?? 32;
    const exhaustedTurns = turnsUsed >= maxTurns;

    if (exhaustedTurns) {
      await opts.onMessage(
        `:rotating_light: *Auto-fix for ${key} — turn limit exhausted (${turnsUsed}/${maxTurns})*\n` +
        `The agent used all available turns without resolving the issue. Manual investigation required.\n` +
        `Error was: \`${opts.error}\``,
      );
      await logInteraction("autofix", { project: opts.project, id: opts.expId, action: "turns_exhausted" }, "autofix", "error", `exhausted ${turnsUsed}/${maxTurns} turns`);
    } else {
      // Unfixable or no tag — extract structured sections for a cleaner report.
      const summary = extractAutofixSummary(cleanResponse);
      await opts.onMessage(`:wrench: *Auto-fix for ${key}:*\n${summary}`);
      await logInteraction("autofix", { project: opts.project, id: opts.expId, action: "unfixable" }, "autofix", "ok", summary.slice(0, 200));
    }
  } catch (err) {
    console.error(`[autofix] Error for ${key}:`, err);
    await opts.onMessage(`:warning: Auto-fix agent failed for *${key}*: ${err instanceof Error ? err.message : String(err)}`);
    await logInteraction("autofix", { project: opts.project, id: opts.expId, action: "agent_error" }, "autofix", "error", String(err));
  } finally {
    autoFixRunning.delete(key);
  }
}

// ── Deep work escalation ─────────────────────────────────────────────────────

interface DeepWorkCallbacks {
  onProgress: (text: string) => Promise<void>;
  onComplete: (text: string) => Promise<void>;
}

const MAX_THREAD_CONTEXT_CHARS = 12_000;

/** Build the prompt for a deep work session. Extracted for testability.
 *  @param threadContext Optional Slack thread history from prior sessions in the
 *    same thread. Enables context inheritance across multiple deep work sessions.
 *  @param skillContent If provided, embeds the skill instructions directly in the
 *    prompt instead of requiring the Skill tool. This ensures skills work on all
 *    backends (including opencode/GLM-5-FP8 which may not support the Skill tool). */
export function buildDeepWorkPrompt(
  task: string,
  skillList: string,
  threadContext?: string,
  skillContent?: string | null,
): string {
  const skillMatch = task.match(/^Run\s+\/(\S+)/i);
  const skillName = skillMatch?.[1];

  // If skill content is provided, embed it directly instead of requiring Skill tool
  const skillSection = skillContent && skillName
    ? [
        "",
        `## Skill Instructions: /${skillName}`,
        "",
        "The skill instructions are embedded below. Follow them exactly — do NOT invoke the Skill tool. Work through each step of the skill workflow.",
        "",
        "---",
        skillContent,
        "---",
        "",
        "## Human Input During Session",
        "",
        "When you need human input (e.g., interview questions, confirmations):",
        "1. Format your questions using the `[QUESTION: <id>]...[/QUESTION]` marker",
        "2. Include metadata: `skill=\"<name>\" mode=\"<mode>\"`",
        "3. End your response with `[ACTION:await_response context=\"<what you're waiting for>\"]`",
        "4. The session will end and a new session will continue when the human replies",
        "",
      ].join("\n")
    : skillMatch
      ? `\nMANDATORY: The task specifies skill /${skillMatch[1]}. You MUST invoke it using the Skill tool (e.g., Skill name="${skillMatch[1]}") as your FIRST action. Follow the skill's instructions exactly — do not skip steps or substitute your own approach.\n`
      : "";

  const parts: string[] = [];

  parts.push(
    `You are an autonomous research agent starting a deep work session.`,
    `Your cwd is the akari repo root. Follow CLAUDE.md conventions.`,
    `You have access to all project skills: ${skillList}. Use them when relevant to the task.`,
    ``,
    `## Planning`,
    `For non-trivial tasks, use EnterPlanMode to explore the codebase and design an approach before making changes. Use ExitPlanMode when your plan is ready — the plan will be posted to the Slack thread for visibility. You may then proceed with implementation without waiting for approval.`,
    ``,
    `## Session discipline`,
    `Do NOT run /orient. This is a task-specific deep work session triggered by a user request, not a scheduled autonomous work cycle. The CLAUDE.md rule "every autonomous session begins with /orient" does not apply here. Begin working on the task immediately.`,
    ``,
    `**Approval gates:** Because a human explicitly requested this task, \`[approval-needed]\` tags do NOT block you. The user's request constitutes implicit approval. Execute the work as described. Only true safety gates (e.g., "do not push to remote") still apply.`,
    ``,
    `CRITICAL: Never produce a text-only message announcing your next action (e.g., "Let me write the plan now"). Always include the tool call in the same turn as your narration. If your turn contains only text and no tool calls, the SDK will treat it as your final answer and terminate the session immediately. Your work will be lost.`,
    ``,
    `## Task`,
    task,
    skillSection,
    `IMPORTANT: The task above is your ONLY objective. Do not perform actions beyond the task scope — do not launch experiments, approve items, push to remote, or modify infrastructure unless the task explicitly asks for it. If the task is to run a skill (e.g. /slack-diagnosis), run that skill and report findings. Do not substitute a different action.`,
    ``,
    `## Fleet workers`,
    `akari runs a fleet of GLM-5 workers that automatically pick up tasks tagged \`[fleet-eligible]\` from TASKS.md every 30 seconds. When you create new tasks during this session:`,
    `- Tag mechanical, well-scoped subtasks as \`[fleet-eligible]\` — fleet workers will execute them within 30s of your commit.`,
    `- Tag tasks requiring deep reasoning, multi-file synthesis, or convention evolution as \`[requires-opus]\`.`,
    `- Prefer creating fleet-eligible subtasks over doing mechanical work yourself — you are an expensive Opus session; fleet workers are zero-cost.`,
    `- After creating tasks and committing, the fleet handles execution. You do not need to wait for or supervise fleet workers.`,
    ``,
    `## Committing work`,
    `Before finishing, commit any new or modified files (research artifacts, diagnosis files, literature notes, experiment designs, skill updates) with a descriptive message. Committing research artifacts is routine and expected — it preserves knowledge produced during the session. Do NOT push to remote; pushing is handled at the session lifecycle level.`,
  );

  if (threadContext && threadContext.trim().length > 0) {
    let ctx = threadContext.trim();
    if (ctx.length > MAX_THREAD_CONTEXT_CHARS) {
      ctx = ctx.slice(-MAX_THREAD_CONTEXT_CHARS);
    }
    parts.push(
      ``,
      `## Previous thread context`,
      `This deep work session is part of an ongoing Slack thread. Below is the history of prior messages and sessions in this thread. Use this to understand what has already been done, what decisions were made, and what the user's broader intent is. Do NOT repeat work that was already completed.`,
      ``,
      ctx,
    );
  }

  parts.push(
    ``,
    `Work autonomously. When done, write a concise summary of what you accomplished.`,
  );

  return parts.join("\n");
}

/** Resolve the deep work profile with backend-specific overrides applied.
 *  Exported for testing. See diagnosis-deep-work-timeout-loop-2026-02-28. */
export function resolveDeepWorkProfile(backendName: string) {
  return resolveProfileForBackend(AGENT_PROFILES.deepWork, backendName);
}

// ── Post-session file verification ────────────────────────────────────────────

/** Regex to detect file paths in text that end with .md and have at least one directory separator.
 *  Matches patterns like: reports/foo.md, projects/akari/README.md, docs/guide.md
 *  Excludes paths in node_modules or other irrelevant directories. */
const FILE_PATH_PATTERN = /\b([a-zA-Z0-9_\-./]+\/[a-zA-Z0-9_\-./]+\.md)\b/g;

/** Directories to exclude from file verification (not user-written files). */
const EXCLUDED_DIRS = ["node_modules", ".git", "dist", "build", "coverage"];

/** Extract file paths from text that look like markdown files.
 *  Returns unique, deduplicated paths. */
export function extractFilePaths(text: string): string[] {
  const matches = text.match(FILE_PATH_PATTERN) ?? [];
  const unique = new Set(matches);
  
  return Array.from(unique).filter((path) => {
    const lower = path.toLowerCase();
    return !EXCLUDED_DIRS.some((dir) => lower.includes(`/${dir}/`) || lower.startsWith(`${dir}/`));
  });
}

/** Verify that file paths mentioned in text actually exist on disk.
 *  Returns array of paths that do NOT exist. */
export async function findMissingFiles(paths: string[], repoDir: string): Promise<string[]> {
  const missing: string[] = [];
  
  for (const path of paths) {
    const fullPath = join(repoDir, path);
    try {
      await access(fullPath);
    } catch {
      missing.push(path);
    }
  }
  
  return missing;
}

/** Base directory for persisted session files (.scheduler/ at repo root). */
const PERSIST_BASE_DIR = new URL("../../../.scheduler", import.meta.url).pathname;

/** Spawn an opus agent session for tasks that exceed chat scope.
 *  Progress is forwarded to the caller; completion posts a summary.
 *  @param threadContext Optional Slack thread history for context inheritance.
 *  Returns the sessionId. */
export async function spawnDeepWork(
  task: string,
  repoDir: string,
  callbacks: DeepWorkCallbacks,
  threadKey: string,
  threadContext?: string,
): Promise<string> {
  // Dynamic skill enumeration — no more hardcoded list
  const skills = await listSkills(repoDir);
  const skillList = formatSkillList(skills);

  // Detect skill invocation and read skill content to embed in prompt
  // This ensures skills work on all backends (including opencode/GLM-5-FP8
  // which may not support the Skill tool)
  const skillMatch = task.match(/^Run\s+\/(\S+)/i);
  const skillName = skillMatch?.[1];
  const skillContent = skillName
    ? await readSkillContent(repoDir, skillName)
    : null;

  const prompt = buildDeepWorkPrompt(task, skillList, threadContext, skillContent);

  // Mutable ref for the session handle — populated after spawnAgent() returns.
  // The onExitPlanMode callback captures this ref to inject approval messages.
  let handleRef: { streamInput?: (input: AsyncIterable<import("./sdk.js").SDKUserMessage>) => Promise<void>; sessionId?: string } | null = null;

  const { handler, flusher } = buildProgressHandler({
    onProgress: callbacks.onProgress,
    label: "deep-work",
    securityCheck: true,
    onSecurityBlock: async (_cmd, reason) => {
      await callbacks.onProgress(`:lock: *Command blocked:* ${reason}`);
    },
    detectPlanMode: true,
    repoDir,
    onExitPlanMode: async (_planText) => {
      // Auto-approve plan mode in headless sessions by injecting a synthetic
      // user approval message via streamInput. This unblocks the SDK which is
      // waiting for user interaction after ExitPlanMode.
      if (!handleRef?.streamInput) {
        console.error("[deep-work] Cannot auto-approve plan: no streamInput available");
        return;
      }
      console.log("[deep-work] Auto-approving plan mode via streamInput");
      try {
        await handleRef.streamInput(
          (async function* () {
            yield {
              type: "user" as const,
              message: { role: "user" as const, content: "Approved. Proceed with implementation." },
              parent_tool_use_id: null,
              session_id: handleRef?.sessionId ?? "",
            };
          })(),
        );
      } catch (err) {
        console.error(`[deep-work] Plan auto-approval streamInput failed: ${err}`);
      }
    },
    detectQuestions: true,
    threadKey,
    onQuestionDetected: async (key, question) => {
      console.log(`[deep-work] Storing pending question for thread ${key}`);
      setPendingQuestion(key, question);
    },
  });

  // Apply backend-specific profile overrides (e.g. tighter limits for opencode).
  // Without this, opencode deep work sessions use the default 20-min/256-turn
  // limits instead of the intended 15-min/128-turn limits.
  // See diagnosis-deep-work-timeout-loop-2026-02-28.
  const backend = resolveBackend();
  const profile = resolveDeepWorkProfile(backend.name);

  const { sessionId, handle, result } = spawnAgent({
    profile,
    prompt,
    cwd: repoDir,
    onMessage: handler,
  });

  // Register watcher BEFORE any messages can be processed.
  // This fixes the race condition where messages were buffered before
  // addWatcher was called in chat.ts.
  addWatcher(sessionId, threadKey);

  // Populate the handle ref so the onExitPlanMode callback can use streamInput
  handleRef = { streamInput: handle.streamInput?.bind(handle), sessionId };

  // Persist session metadata to disk BEFORE the .then() — survives pm2 restart
  await persistSession(
    { sessionId, task, threadKey, startedAtMs: Date.now() },
    PERSIST_BASE_DIR,
  ).catch((err) => {
    console.error(`[deep-work] Failed to persist session ${sessionId}: ${err}`);
  });

  result.then(async (r) => {
    await unpersistSession(sessionId, PERSIST_BASE_DIR).catch(() => {});
    await flusher.flush();
    const summary = r.text.length > 1500 ? r.text.slice(-1500) : r.text;
    
    const filePaths = extractFilePaths(summary);
    const missingFiles = await findMissingFiles(filePaths, repoDir);
    
    let finalSummary = summary;
    if (missingFiles.length > 0) {
      const warning = `\n\n:warning: *Note: the session mentioned writing files that were not found on disk (${missingFiles.join(", ")}). The output may be incomplete.*`;
      finalSummary = summary + warning;
    }
    
    const emoji = r.timedOut ? ":hourglass:" : ":white_check_mark:";
    await callbacks.onComplete(
      `${emoji} *Deep work complete* (${Math.round(r.durationMs / 1000)}s, ${r.numTurns} turns, $${r.costUsd.toFixed(2)})\n${finalSummary}`,
    );
    await logInteraction("deep_work", { task: task.slice(0, 200) }, threadKey, "ok", undefined, { intentFulfilled: "fulfilled", intentType: "other" });
  }).catch(async (err) => {
    await unpersistSession(sessionId, PERSIST_BASE_DIR).catch(() => {});
    await callbacks.onComplete(`:x: Deep work failed: ${err instanceof Error ? err.message : String(err)}`);
    await logInteraction("deep_work", { task: task.slice(0, 200) }, threadKey, "error", String(err), { intentFulfilled: "failed", intentType: "other" });
  });

  console.log(`[deep-work] Session spawned: ${sessionId}`);
  return sessionId;
}
