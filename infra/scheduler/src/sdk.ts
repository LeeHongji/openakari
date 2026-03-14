/** Thin wrapper around `claude -p --output-format stream-json` to share message-drain logic across callers.
 *  Replaces the previous @anthropic-ai/claude-agent-sdk dependency with direct CLI spawning. */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

// ── Local types replacing SDK types ─────────────────────────────────────────

/** Minimal message type compatible with Claude Code stream-json output. */
export interface SDKMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  summary?: string;
  modelUsage?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    costUSD: number;
    contextWindow?: number;
    maxOutputTokens?: number;
  }>;
  [key: string]: unknown;
}

/** Minimal user message type for streamInput. Permissive to allow extra fields. */
export interface SDKUserMessage {
  [key: string]: unknown;
}

/** Handle for a running CLI query — supports interrupt and optional stdin streaming. */
export interface Query {
  /** Async iterator over stream-json messages. */
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage>;
  /** Gracefully interrupt the session. */
  interrupt(): Promise<void>;
  /** Inject user messages via stdin (requires --input-format stream-json). */
  streamInput?(input: AsyncIterable<SDKUserMessage>): Promise<void>;
}

/** Agent definition for --agents JSON flag. */
export interface AgentDefinition {
  description: string;
  prompt: string;
  model?: string;
  tools?: string[];
  skills?: string[];
  maxTurns?: number;
}

/** Hook types for team sessions (simplified local definitions). */
export type HookEvent = "SubagentStart" | "SubagentStop" | "TaskCompleted" | "TeammateIdle";
export interface HookJSONOutput { continue: boolean }
export interface SubagentStartHookInput { agent_id: string; agent_type: string }
export interface SubagentStopHookInput { agent_id: string; agent_type: string }
export interface TaskCompletedHookInput { task_id: string; task_subject: string; teammate_name: string }
export interface TeammateIdleHookInput { teammate_name: string }
export type HookCallback = (input: unknown) => Promise<HookJSONOutput>;
export interface HookCallbackMatcher { hooks: HookCallback[] }

// ── Query options ───────────────────────────────────────────────────────────

export interface QueryOpts {
  prompt: string;
  cwd: string;
  model?: string;
  systemPrompt?: { type: string; preset?: string } | string;
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
  tools?: { type: string; preset?: string };
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  resume?: string;
  settingSources?: string[];
  /** Custom subagents available via the Task tool. */
  agents?: Record<string, AgentDefinition>;
  /** SDK lifecycle hooks (team events — currently not supported in CLI mode). */
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** Extra environment variables to inject. */
  extraEnv?: Record<string, string>;
  onMessage?: (msg: SDKMessage) => void | Promise<void>;
  /** If true, spawn with stdin pipe + --input-format stream-json for interactive multi-turn sessions. */
  interactive?: boolean;
}

export interface QueryResult {
  text: string;
  ok: boolean;
  sessionId?: string;
  costUsd?: number;
  numTurns?: number;
  durationMs: number;
  modelUsage?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    costUSD: number;
    contextWindow?: number;
    maxOutputTokens?: number;
  }>;
  toolCounts?: Record<string, number>;
  orientTurns?: number;
}

export interface SupervisedQuery {
  query: Query;
  result: Promise<QueryResult>;
}

// ── Orient turn tracker ─────────────────────────────────────────────────────

/** Tools that signal the execution phase has started (post-orient). */
const EXECUTION_PHASE_TOOLS = new Set(["Edit", "Write", "TodoWrite"]);

/** Tracks orient turn count from a stream of tool_use events.
 *  Exported for testing — call `onTool()` for each tool_use block in an assistant turn,
 *  and `onNewTurn()` at the start of each assistant message. */
export class OrientTurnTracker {
  private assistantTurnCount = 0;
  private orientStartTurn: number | null = null;
  private _orientTurns: number | undefined;

  /** Call at the start of each assistant message (before processing tool blocks). */
  onNewTurn(): void {
    this.assistantTurnCount++;
  }

  /** Call for each tool_use block in the current assistant message. */
  onTool(name: string, input?: Record<string, unknown>): void {
    // Detect orient start: Skill tool with orient skill name
    if (name === "Skill" && this.orientStartTurn === null) {
      if (input && typeof input.skill === "string" && input.skill.includes("orient")) {
        this.orientStartTurn = this.assistantTurnCount;
      }
    }
    // Detect orient end: first execution-phase tool after orient started
    if (EXECUTION_PHASE_TOOLS.has(name) && this.orientStartTurn !== null && this._orientTurns === undefined) {
      this._orientTurns = this.assistantTurnCount - this.orientStartTurn;
    }
  }

  /** Call when the session ends (result message received). Finalizes if orient started but no execution tool was seen. */
  finalize(): void {
    if (this.orientStartTurn !== null && this._orientTurns === undefined) {
      this._orientTurns = this.assistantTurnCount - this.orientStartTurn;
    }
  }

  /** Returns the computed orient turn count, or undefined if /orient was not detected. */
  get orientTurns(): number | undefined {
    return this._orientTurns;
  }
}

// ── Environment helper ──────────────────────────────────────────────────────

/** Strip CLAUDECODE env var to avoid nested-session guard when spawning from within Claude Code.
 *  Optionally merge extra env vars. */
function cleanEnv(extra?: Record<string, string>): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env["CLAUDECODE"];
  if (extra) Object.assign(env, extra);
  return env;
}

// ── CLI argument builder ────────────────────────────────────────────────────

function buildClaudeArgs(opts: QueryOpts): string[] {
  const args: string[] = ["-p", "--output-format", "stream-json", "--verbose"];

  if (opts.interactive) {
    args.push("--input-format", "stream-json");
    // In interactive mode, do NOT pass --output-format twice, but we need it.
    // The initial prompt will be sent via stdin after spawn, not as positional arg.
  }

  if (opts.model) {
    args.push("--model", opts.model);
  }

  if (opts.permissionMode === "bypassPermissions" || opts.allowDangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  } else if (opts.permissionMode && opts.permissionMode !== "default") {
    args.push("--permission-mode", opts.permissionMode);
  }

  if (opts.maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(opts.maxBudgetUsd));
  }

  if (opts.resume) {
    args.push("--resume", opts.resume);
  }

  if (opts.settingSources && opts.settingSources.length > 0) {
    args.push("--setting-sources", opts.settingSources.join(","));
  }

  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push("--allowed-tools", ...opts.allowedTools);
  }

  if (opts.disallowedTools && opts.disallowedTools.length > 0) {
    args.push("--disallowed-tools", ...opts.disallowedTools);
  }

  if (opts.agents && Object.keys(opts.agents).length > 0) {
    args.push("--agents", JSON.stringify(opts.agents));
  }

  if (typeof opts.systemPrompt === "string") {
    args.push("--system-prompt", opts.systemPrompt);
  }

  // In interactive mode, the initial prompt is sent via stdin — not as positional arg.
  // Otherwise claude -p treats it as a one-shot query and ignores stdin.
  if (!opts.interactive) {
    args.push(opts.prompt);
  }

  return args;
}

// ── Parse stream-json line ──────────────────────────────────────────────────

function parseStreamJsonLine(line: string): SDKMessage | null {
  try {
    const msg = JSON.parse(line) as SDKMessage;
    if (msg && typeof msg.type === "string") return msg;
    return null;
  } catch {
    return null;
  }
}

// ── Core spawning ───────────────────────────────────────────────────────────

function spawnClaudeCli(
  opts: QueryOpts,
  onMessage?: (msg: SDKMessage) => void | Promise<void>,
): { proc: ChildProcess; query: Query; result: Promise<QueryResult> } {
  const start = Date.now();
  const args = buildClaudeArgs(opts);
  const cwd = opts.cwd;

  const claudeBin = process.env.CLAUDE_BIN || "claude";
  console.log(`[claude-cli] Spawning: ${claudeBin} ${args.slice(0, 6).join(" ")} ... (cwd=${cwd})`);

  const interactive = opts.interactive ?? false;

  const proc = spawn(claudeBin, args, {
    cwd,
    stdio: [interactive ? "pipe" : "ignore", "pipe", "pipe"],
    env: cleanEnv(opts.extraEnv) as Record<string, string>,
  });

  // In interactive mode, send the initial prompt via stdin as a stream-json user message
  if (interactive && proc.stdin) {
    const initMsg = JSON.stringify({
      type: "user",
      message: { role: "user", content: opts.prompt },
      parent_tool_use_id: null,
      session_id: "",
    }) + "\n";
    proc.stdin.write(initMsg);
    console.log(`[claude-cli] Sent initial prompt via stdin (${opts.prompt.length} chars)`);
  }

  // Message queue for async iteration
  const messageQueue: SDKMessage[] = [];
  let messageResolve: ((value: IteratorResult<SDKMessage>) => void) | null = null;
  let done = false;

  function enqueueMessage(msg: SDKMessage) {
    if (messageResolve) {
      const resolve = messageResolve;
      messageResolve = null;
      resolve({ value: msg, done: false });
    } else {
      messageQueue.push(msg);
    }
  }

  function finishIterator() {
    done = true;
    if (messageResolve) {
      const resolve = messageResolve;
      messageResolve = null;
      resolve({ value: undefined as unknown as SDKMessage, done: true });
    }
  }

  const query: Query = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKMessage>> {
          if (messageQueue.length > 0) {
            return Promise.resolve({ value: messageQueue.shift()!, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined as unknown as SDKMessage, done: true });
          }
          return new Promise((resolve) => {
            messageResolve = resolve;
          });
        },
      };
    },
    async interrupt() {
      if (!proc.killed) {
        proc.kill("SIGTERM");
        setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
      }
    },
    ...(interactive && proc.stdin ? {
      async streamInput(input: AsyncIterable<SDKUserMessage>) {
        for await (const msg of input) {
          const line = JSON.stringify(msg) + "\n";
          proc.stdin!.write(line);
        }
      },
    } : {}),
  };

  const result = new Promise<QueryResult>((resolve, reject) => {
    let text = "";
    let sessionId: string | undefined;
    let costUsd: number | undefined;
    let numTurns: number | undefined;
    let modelUsage: QueryResult["modelUsage"];
    const toolCounts: Record<string, number> = {};
    const orientTracker = new OrientTurnTracker();
    let stderr = "";

    if (proc.stdout) {
      const rl = createInterface({ input: proc.stdout });
      rl.on("line", async (line) => {
        const msg = parseStreamJsonLine(line);
        if (!msg) return;

        // Enqueue for async iteration
        enqueueMessage(msg);

        // Forward to onMessage callback
        if (onMessage) {
          try { await onMessage(msg); } catch { /* best-effort */ }
        }

        if (msg.type === "system" && msg.subtype === "init") {
          sessionId = msg.session_id;
        }

        if (msg.type === "assistant" && msg.message?.content) {
          orientTracker.onNewTurn();
          for (const block of msg.message.content) {
            if (block.type === "text" && block.text) text = block.text;
            if (block.type === "tool_use" && block.name) {
              toolCounts[block.name] = (toolCounts[block.name] ?? 0) + 1;
              orientTracker.onTool(block.name, block.input);
            }
          }
        }

        if (msg.type === "result") {
          if (msg.result) text = msg.result;
          costUsd = msg.total_cost_usd;
          numTurns = msg.num_turns;
          if (msg.session_id) sessionId = msg.session_id;
          if (msg.modelUsage) modelUsage = msg.modelUsage;
          orientTracker.finalize();
        }
      });
    }

    if (proc.stderr) {
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
    }

    proc.on("error", (err) => {
      finishIterator();
      reject(new Error(`claude CLI failed to start: ${err.message}`));
    });

    proc.on("close", (code) => {
      finishIterator();
      const durationMs = Date.now() - start;
      if (code !== 0 && !text) {
        reject(new Error(
          `claude CLI exited with code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`,
        ));
        return;
      }
      resolve({
        text,
        ok: true,
        sessionId,
        costUsd,
        numTurns,
        durationMs,
        modelUsage,
        toolCounts,
        orientTurns: orientTracker.orientTurns,
      });
    });
  });

  return { proc, query, result };
}

// ── Public API (same interface as before) ───────────────────────────────────

/** Create a query and return the live handle alongside a promise for the eventual result. */
export function runQuerySupervised(opts: QueryOpts): SupervisedQuery {
  const { query: q, result } = spawnClaudeCli(opts, opts.onMessage);
  return { query: q, result };
}

export async function runQuery(opts: QueryOpts): Promise<QueryResult> {
  const { result } = runQuerySupervised(opts);
  return result;
}
