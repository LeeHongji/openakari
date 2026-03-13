/** In-memory registry of active agent sessions for supervision via Slack. */

import type { SDKMessage } from "./sdk.js";
import type { SessionHandle } from "./backend.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface BufferedMessage {
  timestamp: number;
  text: string;
  kind: "assistant" | "tool" | "system" | "result";
}

export interface ActiveSession {
  id: string;
  jobId: string;
  jobName: string;
  sessionId: string | null;
  startedAtMs: number;
  handle: SessionHandle;
  messages: BufferedMessage[];
  watchers: Set<string>;
  costUsd: number;
  numTurns: number;
}

export interface SessionInfo {
  id: string;
  jobId: string;
  jobName: string;
  sessionId: string | null;
  startedAtMs: number;
  elapsedMs: number;
  messageCount: number;
  costUsd: number;
  numTurns: number;
  lastActivity: string;
}

type WatchCallback = (sessionId: string, msg: BufferedMessage) => void;

// ── State ────────────────────────────────────────────────────────────────────

const sessions = new Map<string, ActiveSession>();
const MAX_BUFFER = 200;
let watchCallback: WatchCallback | null = null;

// ── Public API ───────────────────────────────────────────────────────────────

export function registerSession(
  id: string,
  jobId: string,
  jobName: string,
  sessionHandle: SessionHandle,
): ActiveSession {
  const session: ActiveSession = {
    id,
    jobId,
    jobName,
    sessionId: null,
    startedAtMs: Date.now(),
    handle: sessionHandle,
    messages: [],
    watchers: new Set(),
    costUsd: 0,
    numTurns: 0,
  };
  sessions.set(id, session);
  return session;
}

export function unregisterSession(id: string): void {
  sessions.delete(id);
}

export function getSession(id: string): ActiveSession | undefined {
  return sessions.get(id);
}

export function listSessions(): SessionInfo[] {
  const now = Date.now();
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    jobId: s.jobId,
    jobName: s.jobName,
    sessionId: s.sessionId,
    startedAtMs: s.startedAtMs,
    elapsedMs: now - s.startedAtMs,
    messageCount: s.messages.length,
    costUsd: s.costUsd,
    numTurns: s.numTurns,
    lastActivity: s.messages.length > 0
      ? s.messages[s.messages.length - 1].text
      : "(starting...)",
  }));
}

/** Update session cost and turn count (called when a result message is received).
 *  When numTurns is 0 (e.g., Cursor backend doesn't report turns), the existing
 *  incrementally-tracked count is preserved. */
export function updateSessionStats(id: string, costUsd: number, numTurns: number): void {
  const session = sessions.get(id);
  if (!session) return;
  session.costUsd = costUsd;
  if (numTurns > 0) {
    session.numTurns = numTurns;
  }
}

/** Increment the turn count by one (called on each assistant message). */
export function incrementSessionTurns(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.numTurns++;
}

export function bufferMessage(id: string, msg: BufferedMessage): void {
  const session = sessions.get(id);
  if (!session) return;

  session.messages.push(msg);
  if (session.messages.length > MAX_BUFFER) {
    session.messages.splice(0, session.messages.length - MAX_BUFFER);
  }

  if (session.watchers.size > 0 && watchCallback) {
    watchCallback(id, msg);
  }
}

export function getRecentMessages(id: string, count = 10): BufferedMessage[] {
  const session = sessions.get(id);
  if (!session) return [];
  return session.messages.slice(-count);
}

export function addWatcher(id: string, threadTs: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  session.watchers.add(threadTs);
  return true;
}

export function removeWatcher(id: string, threadTs: string): void {
  const session = sessions.get(id);
  if (session) session.watchers.delete(threadTs);
}

export function setWatchCallback(cb: WatchCallback): void {
  watchCallback = cb;
}

export function findSessionByWatcher(watcherKey: string): ActiveSession | undefined {
  for (const session of sessions.values()) {
    if (session.watchers.has(watcherKey)) return session;
  }
  return undefined;
}

export function clearAll(): void {
  sessions.clear();
  watchCallback = null;
}

// ── Message summarization ────────────────────────────────────────────────────

export function summarizeMessage(msg: SDKMessage): BufferedMessage | null {
  const now = Date.now();

  if (msg.type === "assistant" && msg.message?.content) {
    const parts: string[] = [];
    for (const block of msg.message.content) {
      if (block.type === "text" && block.text) {
        // Truncate long text
        const text = block.text.length > 300
          ? block.text.slice(0, 300) + "..."
          : block.text;
        parts.push(text);
      } else if (block.type === "tool_use") {
        const input = block.input as Record<string, unknown>;
        let detail = "";
        if (block.name === "Read" && input["file_path"]) {
          detail = ` ${input["file_path"]}`;
        } else if (block.name === "Write" && input["file_path"]) {
          detail = ` ${input["file_path"]}`;
        } else if (block.name === "Edit" && input["file_path"]) {
          detail = ` ${input["file_path"]}`;
        } else if ((block.name === "Bash" || block.name === "Shell" || block.name === "bash") && input["command"]) {
          const cmd = String(input["command"]);
          detail = ` \`${cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd}\``;
        } else if (block.name === "Glob" && input["pattern"]) {
          detail = ` ${input["pattern"]}`;
        } else if (block.name === "Grep" && input["pattern"]) {
          detail = ` ${input["pattern"]}`;
        }
        parts.push(`[tool: ${block.name}${detail}]`);
      }
    }
    if (parts.length === 0) return null;
    return { timestamp: now, text: parts.join("\n"), kind: "assistant" };
  }

  if (msg.type === "tool_use_summary") {
    return { timestamp: now, text: msg.summary ?? "", kind: "tool" };
  }

  if (msg.type === "result") {
    const cost = msg.total_cost_usd ?? 0;
    const turns = msg.num_turns;
    const status = msg.is_error ? "error" : "success";
    const result = "result" in msg && msg.result ? msg.result : "";
    const text = `[${status}] ${turns} turns, $${cost.toFixed(4)}${result ? ` — ${result.slice(0, 200)}` : ""}`;
    return { timestamp: now, text, kind: "result" };
  }

  if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
    return { timestamp: now, text: "[session initialized]", kind: "system" };
  }

  return null;
}
