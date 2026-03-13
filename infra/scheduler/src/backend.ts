/** Agent backend abstraction. Supports Claude Code CLI, Cursor Agent CLI, and opencode CLI with automatic fallback chain: Claude → Cursor → opencode. */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import {
  runQuery as claudeRunQuery,
  runQuerySupervised as claudeRunQuerySupervised,
  type QueryOpts,
  type QueryResult,
  type SDKMessage,
  type SDKUserMessage,
} from "./sdk.js";
import { getBackendPreference } from "./backend-preference.js";
import { getSessionCostFromDb } from "./opencode-db.js";

// ── Interfaces ───────────────────────────────────────────────────────────────

/** Handle for supervising a running session (watch / ask / stop). */
export interface SessionHandle {
  /** Gracefully interrupt the session. */
  interrupt(): Promise<void>;
  /** Inject a human message into the session. Only supported by Claude backend. */
  streamInput?(input: AsyncIterable<SDKUserMessage>): Promise<void>;
  /** Backend that produced this handle. */
  readonly backend: "claude" | "cursor" | "opencode";
}

/** Common options for running a query through any backend. */
export interface BackendQueryOpts extends QueryOpts {
  /** For Cursor: prepend this to the prompt since CLI has no system prompt flag. */
  systemPromptText?: string;
}

export interface SupervisedResult {
  handle: SessionHandle;
  result: Promise<QueryResult>;
}

export interface AgentBackend {
  readonly name: "claude" | "cursor" | "opencode";
  runQuery(opts: BackendQueryOpts): Promise<QueryResult>;
  runSupervised(opts: BackendQueryOpts): SupervisedResult;
}

// ── Claude Backend (SDK) ─────────────────────────────────────────────────────

class ClaudeBackend implements AgentBackend {
  readonly name = "claude" as const;

  async runQuery(opts: BackendQueryOpts): Promise<QueryResult> {
    return claudeRunQuery(opts);
  }

  runSupervised(opts: BackendQueryOpts): SupervisedResult {
    const supervised = claudeRunQuerySupervised(opts);
    const handle: SessionHandle = {
      backend: "claude",
      interrupt: () => supervised.query.interrupt(),
      streamInput: supervised.query.streamInput ? (input) => supervised.query.streamInput!(input) : undefined,
    };
    return { handle, result: supervised.result };
  }
}

// ── Cursor Backend (CLI) ─────────────────────────────────────────────────────

const CURSOR_DEFAULT_MODEL = "opus-4.6-thinking";

/** Map Claude-compatible short model names to Cursor-specific model IDs.
 *  Profiles use Claude-compatible names (e.g. "opus"); the Cursor backend
 *  translates them here so both backends work from the same profile. */
const CURSOR_MODEL_MAP: Record<string, string> = {
  opus: "opus-4.6-thinking",
};

/** Parse a line of Cursor stream-json output into an SDKMessage-compatible shape. */
export function parseCursorMessage(line: string): SDKMessage | null {
  try {
    const msg = JSON.parse(line);

    // system init
    if (msg.type === "system" && msg.subtype === "init") {
      return msg as SDKMessage;
    }

    // assistant text
    if (msg.type === "assistant" && msg.message?.content) {
      return msg as SDKMessage;
    }

    // result
    if (msg.type === "result") {
      return {
        type: "result",
        subtype: msg.subtype,
        duration_ms: msg.duration_ms,
        is_error: msg.is_error ?? false,
        result: msg.result ?? "",
        session_id: msg.session_id ?? "",
        // Cursor doesn't report cost or turns
        total_cost_usd: 0,
        num_turns: 0,
      } as unknown as SDKMessage;
    }

    // tool_call — summarize as tool_use_summary for watchers
    // Cursor format: tool_call.{globToolCall,readToolCall,shellToolCall,fileEditToolCall,grepToolCall,...}
    if (msg.type === "tool_call" && msg.subtype === "started") {
      const tc = msg.tool_call ?? {};
      let summary = "";
      if (tc.shellToolCall) {
        summary = `Shell \`${(tc.shellToolCall.args?.command ?? "").slice(0, 80)}\``;
      } else if (tc.readToolCall) {
        summary = `Read \`${tc.readToolCall.args?.path ?? "?"}\``;
      } else if (tc.globToolCall) {
        summary = `Glob \`${tc.globToolCall.args?.globPattern ?? "?"}\``;
      } else if (tc.grepToolCall) {
        summary = `Grep \`${tc.grepToolCall.args?.pattern ?? "?"}\``;
      } else if (tc.fileEditToolCall) {
        summary = `Edit \`${tc.fileEditToolCall.args?.filePath ?? tc.fileEditToolCall.args?.path ?? "?"}\``;
      } else if (tc.writeToolCall) {
        summary = `Write \`${tc.writeToolCall.args?.filePath ?? tc.writeToolCall.args?.path ?? "?"}\``;
      } else {
        // Unknown tool — try to extract a name from the keys
        const keys = Object.keys(tc).filter(k => k.endsWith("ToolCall"));
        summary = keys.length > 0 ? keys[0].replace("ToolCall", "") : "tool";
      }
      return { type: "tool_use_summary", summary } as unknown as SDKMessage;
    }

    // tool_call.completed — emit for stall guard to clear timer (ADR R1)
    if (msg.type === "tool_call" && msg.subtype === "completed") {
      return { type: "tool_call_completed" } as unknown as SDKMessage;
    }

    return null;
  } catch {
    return null;
  }
}

class CursorBackend implements AgentBackend {
  readonly name = "cursor" as const;

  private buildPrompt(opts: BackendQueryOpts): string {
    if (opts.systemPromptText) {
      return `<system_instructions>\n${opts.systemPromptText}\n</system_instructions>\n\n${opts.prompt}`;
    }
    return opts.prompt;
  }

  private buildArgs(opts: BackendQueryOpts): string[] {
    const rawModel = opts.model ?? CURSOR_DEFAULT_MODEL;
    const model = CURSOR_MODEL_MAP[rawModel] ?? rawModel;
    const prompt = this.buildPrompt(opts);
    return [
      "-p",
      "--output-format", "stream-json",
      "--yolo", "--trust",
      "--workspace", opts.cwd,
      "--model", model,
      prompt,
    ];
  }

  private spawnAgent(
    opts: BackendQueryOpts,
    onMessage?: (msg: SDKMessage) => void | Promise<void>,
  ): { proc: ChildProcess; result: Promise<QueryResult> } {
    const start = Date.now();
    const args = this.buildArgs(opts);
    const cwd = opts.cwd;

    console.log(`[cursor] Spawning: agent ${args.slice(0, 6).join(" ")} ... (cwd=${cwd})`);

    const proc = spawn("agent", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const result = new Promise<QueryResult>((resolve, reject) => {
      let text = "";
      let sessionId: string | undefined;
      let numTurns = 0;
      let isError = false;
      let stderr = "";

      if (proc.stdout) {
        const rl = createInterface({ input: proc.stdout });
        rl.on("line", async (line) => {
          const msg = parseCursorMessage(line);
          if (!msg) return;

          if (onMessage) {
            try { await onMessage(msg); } catch { /* best-effort */ }
          }

          if (msg.type === "system" && "subtype" in msg && (msg as Record<string, unknown>).subtype === "init") {
            sessionId = (msg as Record<string, unknown>).session_id as string;
          }

          if (msg.type === "assistant") {
            numTurns++;
            const content = (msg as Record<string, unknown>).message as { content?: Array<{ type: string; text?: string }> } | undefined;
            if (content?.content) {
              for (const block of content.content) {
                if (block.type === "text" && block.text) text = block.text;
              }
            }
          }

          if (msg.type === "result") {
            const r = msg as unknown as { result?: string; is_error?: boolean; session_id?: string };
            if (r.result) text = r.result;
            if (r.is_error) isError = true;
            if (r.session_id) sessionId = r.session_id;
          }
        });
      }

      if (proc.stderr) {
        proc.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
      }

      proc.on("error", (err) => {
        reject(new Error(`Cursor agent failed to start: ${err.message}`));
      });

      proc.on("close", (code) => {
        const durationMs = Date.now() - start;
        if (code !== 0 && !text) {
          reject(new Error(
            `Cursor agent exited with code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`,
          ));
          return;
        }
        resolve({
          text,
          ok: !isError,
          sessionId,
          costUsd: undefined,
          numTurns,
          durationMs,
        });
      });
    });

    return { proc, result };
  }

  async runQuery(opts: BackendQueryOpts): Promise<QueryResult> {
    const { result } = this.spawnAgent(opts, opts.onMessage);
    return result;
  }

  runSupervised(opts: BackendQueryOpts): SupervisedResult {
    const { proc, result } = this.spawnAgent(opts, opts.onMessage);

    const handle: SessionHandle = {
      backend: "cursor",
      interrupt: async () => {
        if (!proc.killed) {
          proc.kill("SIGTERM");
          // Give it a moment, then force kill
          setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
        }
      },
      // streamInput not supported for Cursor
    };

    return { handle, result };
  }
}

// ── opencode Backend (CLI) ─────────────────────────────────────────────────────

/** opencode backend always uses the locally-hosted GLM5 model. */
const OPENCODE_MODEL = "glm5/zai-org/GLM-5-FP8";

/** Parse a line of opencode stream-json output into an SDKMessage-compatible shape.
 *  opencode --format json outputs NDJSON with types: error, assistant, result, etc. */
export function parseOpenCodeMessage(line: string): SDKMessage | null {
  try {
    const msg = JSON.parse(line);

    // error
    if (msg.type === "error") {
      const errMsg = msg.error?.data?.message ?? msg.error?.name ?? "Unknown error";
      return {
        type: "result",
        subtype: "error",
        is_error: true,
        result: errMsg,
        session_id: msg.sessionID ?? "",
        total_cost_usd: 0,
        num_turns: 0,
        duration_ms: 0,
      } as unknown as SDKMessage;
    }

    // text — final output text from opencode
    if (msg.type === "text" && msg.part?.text) {
      return {
        type: "assistant",
        message: {
          content: [{ type: "text", text: msg.part.text }],
        },
      } as unknown as SDKMessage;
    }

    // assistant text
    if (msg.type === "assistant" && msg.message?.content) {
      return msg as SDKMessage;
    }

    // result
    if (msg.type === "result") {
      return {
        type: "result",
        subtype: msg.subtype,
        duration_ms: msg.duration_ms ?? 0,
        is_error: msg.is_error ?? false,
        result: msg.result ?? "",
        session_id: msg.session_id ?? msg.sessionID ?? "",
        total_cost_usd: msg.total_cost_usd ?? 0,
        num_turns: msg.num_turns ?? 0,
      } as unknown as SDKMessage;
    }

    // tool_use — opencode format: part.tool + part.state.input
    if (msg.type === "tool_use") {
      const toolName = msg.part?.tool ?? msg.name ?? "tool";
      const input = msg.part?.state?.input as Record<string, unknown> | undefined;
      let detail = "";
      if (input) {
        if (input["command"]) {
          const cmd = String(input["command"]);
          detail = ` \`${cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd}\``;
        } else if (input["file_path"]) {
          detail = ` ${input["file_path"]}`;
        } else if (input["path"]) {
          detail = ` ${input["path"]}`;
        } else if (input["pattern"]) {
          detail = ` ${input["pattern"]}`;
        } else if (input["url"]) {
          detail = ` ${input["url"]}`;
        }
      }
      const summary = `${toolName}${detail}`;
      return { type: "tool_use_summary", summary } as unknown as SDKMessage;
    }

    return null;
  } catch {
    return null;
  }
}

class OpenCodeBackend implements AgentBackend {
  readonly name = "opencode" as const;

  private buildPrompt(opts: BackendQueryOpts): string {
    if (opts.systemPromptText) {
      return `<system_instructions>\n${opts.systemPromptText}\n</system_instructions>\n\n${opts.prompt}`;
    }
    return opts.prompt;
  }

  private buildArgs(opts: BackendQueryOpts): string[] {
    // opencode backend always uses GLM5, ignoring job-level model config
    const prompt = this.buildPrompt(opts);
    return [
      "run",
      "--format", "json",
      "--dir", opts.cwd,
      "--model", OPENCODE_MODEL,
      "--title", "fleet",
      prompt,
    ];
  }

  private spawnAgent(
    opts: BackendQueryOpts,
    onMessage?: (msg: SDKMessage) => void | Promise<void>,
  ): { proc: ChildProcess; result: Promise<QueryResult> } {
    const start = Date.now();
    const args = this.buildArgs(opts);
    const cwd = opts.cwd;

    console.log(`[opencode] Spawning: opencode ${args.slice(0, 6).join(" ")} ... (cwd=${cwd})`);

    const opencodeBin = process.env.OPENCODE_BIN || "/home/user/.opencode/bin/opencode";
    const proc = spawn(opencodeBin, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCODE_PERMISSION: '{"*":"allow"}',
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "gc.auto",
        GIT_CONFIG_VALUE_0: "0",
      },
    });

    const result = new Promise<QueryResult>((resolve, reject) => {
      let text = "";
      let sessionId: string | undefined;
      let numTurns = 0;
      let isError = false;
      let costUsd: number | undefined;
      let stderr = "";

      if (proc.stdout) {
        const rl = createInterface({ input: proc.stdout });
        rl.on("line", async (line) => {
          const msg = parseOpenCodeMessage(line);
          if (!msg) return;

          if (onMessage) {
            try { await onMessage(msg); } catch { /* best-effort */ }
          }

          if (msg.type === "result") {
            const r = msg as unknown as {
              result?: string;
              is_error?: boolean;
              session_id?: string;
              total_cost_usd?: number;
              num_turns?: number;
            };
            if (r.result) text = r.result;
            if (r.is_error) isError = true;
            if (r.session_id) sessionId = r.session_id;
            if (r.total_cost_usd !== undefined) costUsd = r.total_cost_usd;
            if (r.num_turns !== undefined) numTurns = r.num_turns;
          }

          if (msg.type === "assistant") {
            numTurns++;
            const content = (msg as Record<string, unknown>).message as { content?: Array<{ type: string; text?: string }> } | undefined;
            if (content?.content) {
              for (const block of content.content) {
                if (block.type === "text" && block.text) text = block.text;
              }
            }
          }
        });
      }

      if (proc.stderr) {
        proc.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
      }

      proc.on("error", (err) => {
        reject(new Error(`opencode failed to start: ${err.message}`));
      });

      proc.on("close", (code) => {
        const durationMs = Date.now() - start;
        if (code !== 0 && !text) {
          reject(new Error(
            `opencode exited with code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`,
          ));
          return;
        }
        if ((costUsd === undefined || costUsd === 0) && sessionId) {
          const dbCost = getSessionCostFromDb(sessionId, "glm5/zai-org/GLM-5-FP8");
          if (dbCost !== null && dbCost > 0) {
            costUsd = dbCost;
          }
        }
        resolve({
          text,
          ok: !isError,
          sessionId,
          costUsd,
          numTurns,
          durationMs,
        });
      });
    });

    return { proc, result };
  }

  async runQuery(opts: BackendQueryOpts): Promise<QueryResult> {
    const { result } = this.spawnAgent(opts, opts.onMessage);
    return result;
  }

  runSupervised(opts: BackendQueryOpts): SupervisedResult {
    const { proc, result } = this.spawnAgent(opts, opts.onMessage);

    const handle: SessionHandle = {
      backend: "opencode",
      interrupt: async () => {
        if (!proc.killed) {
          proc.kill("SIGTERM");
          setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
        }
      },
    };

    return { handle, result };
  }
}

// ── Fallback detection ───────────────────────────────────────────────────────

/** Strict rate-limit check: matches known API rate-limit / usage-limit error patterns. */
export function isRateLimitError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /rate.?limit|overloaded|usage.?limit|too many requests|429|quota|capacity/.test(msg);
}

/** Billing error check: matches Cursor billing issues (unpaid invoice, payment required). */
export function isBillingError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /unpaid invoice|payment required|billing|subscription|insufficient credit/.test(msg);
}

/** Broad fallback check for "auto" mode: falls back on rate limits AND process-level failures
 *  (exit code errors, connection failures, billing errors) that likely indicate the backend
 *  is unavailable or misconfigured. */
function shouldFallback(err: unknown): boolean {
  if (isRateLimitError(err)) return true;
  if (isBillingError(err)) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /exited with code|econnrefused|econnreset|etimedout|process .* exit|spawn .* enoent/.test(msg);
}

// ── Backend resolution ───────────────────────────────────────────────────────

export type BackendPreference = "claude" | "cursor" | "opencode" | "auto";

/** Returns the configured default backend preference.
 *  Precedence: persisted preference > AGENT_BACKEND env var > "auto".
 *  Reads process.env at call time so .env loading in cli.ts takes effect. */
export function getDefaultBackend(): BackendPreference {
  const persisted = getBackendPreference();
  if (persisted) return persisted;
  return (process.env["AGENT_BACKEND"] as BackendPreference) ?? "auto";
}

const claudeBackend = new ClaudeBackend();
const cursorBackend = new CursorBackend();
const opencodeBackend = new OpenCodeBackend();

/** Wraps a primary backend with automatic fallback on rate-limit errors.
 *  Supports multi-tier fallback via chaining FallbackBackend instances. */
class FallbackBackend implements AgentBackend {
  readonly name: "claude" | "cursor" | "opencode";

  constructor(
    private primary: AgentBackend,
    private fallback: AgentBackend,
  ) {
    this.name = primary.name;
  }

  async runQuery(opts: BackendQueryOpts): Promise<QueryResult> {
    try {
      return await this.primary.runQuery(opts);
    } catch (err) {
      if (shouldFallback(err)) {
        console.log(`[backend] ${this.primary.name} failed (${err instanceof Error ? err.message : err}), falling back to ${this.fallback.name}`);
        return this.fallback.runQuery(opts);
      }
      throw err;
    }
  }

  runSupervised(opts: BackendQueryOpts): SupervisedResult {
    const primary = this.primary.runSupervised(opts);

    const wrappedResult = primary.result.catch((err) => {
      if (shouldFallback(err)) {
        console.log(`[backend] ${this.primary.name} failed (supervised: ${err instanceof Error ? err.message : err}), falling back to ${this.fallback.name}`);
        const fallbackRun = this.fallback.runSupervised(opts);
        return fallbackRun.result;
      }
      throw err;
    });

    return { handle: primary.handle, result: wrappedResult };
  }
}

/** Get the appropriate backend for the given preference.
 *  Auto mode uses fallback chain: Claude → Cursor → opencode */
export function resolveBackend(preference?: BackendPreference): AgentBackend {
  const pref = preference ?? getDefaultBackend();
  switch (pref) {
    case "claude":
      return claudeBackend;
    case "cursor":
      return cursorBackend;
    case "opencode":
      return opencodeBackend;
    case "auto":
      // 3-tier fallback: Claude → Cursor → opencode
      return new FallbackBackend(
        claudeBackend,
        new FallbackBackend(cursorBackend, opencodeBackend),
      );
  }
}

/** Get a specific backend by name (no fallback wrapping). */
export function getBackend(name: "claude" | "cursor" | "opencode"): AgentBackend {
  switch (name) {
    case "claude":
      return claudeBackend;
    case "cursor":
      return cursorBackend;
    case "opencode":
      return opencodeBackend;
  }
}

/** Get the effective backend name for skill gating purposes.
 *  For explicit preferences, returns the name.
 *  For "auto", returns "claude" (first in fallback chain, most capable). */
export function getEffectiveBackendName(preference?: BackendPreference): "claude" | "cursor" | "opencode" {
  const pref = preference ?? "auto";
  switch (pref) {
    case "claude":
    case "cursor":
    case "opencode":
      return pref;
    case "auto":
      // Auto mode tries Claude first, so gate as if Claude is available
      return "claude";
  }
}
