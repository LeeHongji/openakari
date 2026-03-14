/** Natural language chat interface for Akari Slack bot.
 *  Agent queries are fire-and-forget: spawn, return immediately, post results via callbacks.
 *  No persistent connection or timeout needed — sessions are registered and interruptible. */

import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionHandle } from "../backend.js";
import { spawnAgent, AGENT_PROFILES, summarizeToolUses, createToolBatchFlusher, type AgentResult } from "../agent.js";
import { SHELL_TOOL_NAMES } from "../sleep-guard.js";
import { executeJob } from "../executor.js";
import type { FleetScheduler } from "../fleet-scheduler.js";
import {
  getPendingApprovals,
  resolveApproval,
  readBudgetStatus,
} from "../notify.js";
import type { JobStore } from "../store.js";
import {
  listSessions,
  unregisterSession,
  getSession,
  addWatcher,
  getRecentMessages,
  findSessionByWatcher,
} from "../session.js";
import {
  launchExperiment,
  stopExperiment,
  trackExperiment,
} from "../experiments.js";
import {
  validateShellCommand,
  validatePathSegment,
  validateCommand,
  SecurityError,
} from "../security.js";
import { recordInteraction } from "../metrics.js";
import { detectEvidenceGrading } from "../interaction-audit.js";
import { validateExperimentDir, spawnDeepWork } from "../event-agents.js";
import { listSkills, detectSkillInvocation, canRunSkill, isFleetEligibleSkill, type SkillInfo } from "../skills.js";
import { getBackendPreference } from "../backend-preference.js";
import { getEffectiveBackendName } from "../backend.js";
import {
  type PendingAction,
  type ParsedAction,
  findActionTag,
  findAllActionTags,
  stripActionTags,
  eagerlySetPendingAction,
  buildConfirmPrompt,
  isChatModeAction,
} from "../action-tags.js";
import { gatherChatContext } from "./chat-context.js";
import { buildChatPrompt, buildChatModePrompt } from "./chat-prompt.js";
import type { ChannelMode } from "../channel-mode.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

interface ConversationState {
  messages: ChatMessage[];
  pendingAction: PendingAction | null;
  /** Temporarily holds a pendingAction while a clarifying question is answered.
   *  Restored after the chat agent responds if no new pendingAction was set. */
  suspendedAction: PendingAction | null;
  lastActivityMs: number;
  /** Session ID of an in-flight chat query, if any. */
  activeSessionId: string | null;
  /** Monotonic counter incremented on each spawnChatAsync. Used as stale-completion guard. */
  generation: number;
  /** True if the last chat session timed out without producing a substantive response. */
  lastTimedOut: boolean;
  /** The user's original message from the timed-out session, for deep work escalation context. */
  lastTimedOutMessage: string | null;
  /** Context from a deep work session that ended with await_response, waiting for human input.
   *  When set, the next user message will spawn a new deep work session with this context. */
  pendingQuestion: string | null;
  /** Active interview state — set when an interview-mode skill is invoked. The chat agent
   *  conducts the interview over multiple turns, then delegates to deep work with full context. */
  activeInterview: {
    skillName: string;
    args: string;
    interviewPrompt: string;
  } | null;
}

/** Callbacks the caller provides so the async agent can post to the Slack thread.
 *  onComplete receives null when dedup has already posted the text via onProgress. */
export interface ChatCallbacks {
  onProgress: (text: string) => Promise<void>;
  onComplete: (text: string | null) => Promise<void>;
}

// ── Per-conversation mutex ────────────────────────────────────────────────────

/** Simple promise-based lock to prevent interleaved async operations on the same conversation. */
class ConversationLock {
  private locks = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    // Wait for any existing lock on this key
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(key, promise);
    return () => {
      this.locks.delete(key);
      release();
    };
  }
}

const conversationLock = new ConversationLock();

/** Module-level store reference, set on first processMessage call. */
let chatStoreRef: JobStore | null = null;

/** Module-level fleet scheduler reference, set on first processMessage call. */
let chatFleetSchedulerRef: FleetScheduler | null = null;

/** Tools that chat agent is not allowed to use — intercepted and escalated to deep work. */
const CHAT_BLOCKED_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

// ── Conversation buffer ──────────────────────────────────────────────────────

const conversations = new Map<string, ConversationState>();

const MAX_TURNS = 20;
const MAX_CHARS = 30_000;
const TTL_MS = 30 * 60 * 1000; // 30 minutes

function getConversation(channelId: string): ConversationState {
  const existing = conversations.get(channelId);
  if (existing && Date.now() - existing.lastActivityMs < TTL_MS) {
    return existing;
  }
  const fresh: ConversationState = {
    messages: [],
    pendingAction: null,
    suspendedAction: null,
    lastActivityMs: Date.now(),
    activeSessionId: null,
    generation: 0,
    lastTimedOut: false,
    lastTimedOutMessage: null,
    pendingQuestion: null,
    activeInterview: null,
  };
  conversations.set(channelId, fresh);
  return fresh;
}

function addMessage(conv: ConversationState, role: "user" | "assistant", content: string): void {
  conv.messages.push({ role, content, timestamp: Date.now() });
  conv.lastActivityMs = Date.now();

  // Trim to max turns (pairs)
  while (conv.messages.length > MAX_TURNS * 2) {
    conv.messages.splice(0, 2);
  }

  // Trim to max chars
  let total = conv.messages.reduce((sum, m) => sum + m.content.length, 0);
  while (total > MAX_CHARS && conv.messages.length > 2) {
    total -= conv.messages[0].content.length;
    total -= conv.messages[1]?.content.length ?? 0;
    conv.messages.splice(0, 2);
  }
}

/** Clear conversation history for a channel. */
export function clearConversation(channelId: string): void {
  conversations.delete(channelId);
}

/** Test-only: get or create conversation state for a channel. */
export function _getConversationForTest(channelId: string): ConversationState {
  return getConversation(channelId);
}

/** Wrap onComplete callback to detect await_response tags and store pendingQuestion.
 *  When a deep work session ends with [ACTION:await_response context="..."], the
 *  context is stored so the next user message can spawn a continuation session. */
function wrapOnCompleteForAwaitResponse(
  onComplete: ChatCallbacks["onComplete"],
  conv: ConversationState,
): ChatCallbacks["onComplete"] {
  return async (text: string | null) => {
    if (text) {
      const parsed = findActionTag(text);
      if (parsed?.kind === "await_response") {
        const context = parsed.params.context;
        if (context) {
          conv.pendingQuestion = context;
          console.log(`[chat] Deep work ended with await_response, context: "${context.slice(0, 100)}"`);
        }
      }
    }
    await onComplete(text);
  };
}

// ── Pending action persistence ──────────────────────────────────────────────

interface PersistedConversation {
  pendingAction: PendingAction;
  recentMessages: ChatMessage[];
  savedAtMs: number;
}

const PENDING_ACTIONS_PATH = new URL(
  "../../../.scheduler/pending-actions.json",
  import.meta.url,
).pathname;

/** Persist conversations that have a pendingAction to disk. Fire-and-forget. */
function savePendingActions(): void {
  const entries: Record<string, PersistedConversation> = {};
  for (const [key, conv] of conversations) {
    if (conv.pendingAction) {
      entries[key] = {
        pendingAction: conv.pendingAction,
        recentMessages: conv.messages.slice(-4),
        savedAtMs: Date.now(),
      };
    }
  }

  const data = JSON.stringify(entries, null, 2);
  const tmpPath = PENDING_ACTIONS_PATH + ".tmp";
  mkdir(dirname(PENDING_ACTIONS_PATH), { recursive: true })
    .then(() => writeFile(tmpPath, data, "utf-8"))
    .then(() => rename(tmpPath, PENDING_ACTIONS_PATH))
    .catch((err) => console.error(`[chat] Failed to save pending actions: ${err}`));
}

/** Restore conversations with pending actions from disk. Call at startup. */
export async function loadPendingActions(): Promise<void> {
  try {
    const raw = await readFile(PENDING_ACTIONS_PATH, "utf-8");
    const entries = JSON.parse(raw) as Record<string, PersistedConversation>;
    const now = Date.now();
    let restored = 0;

    for (const [key, persisted] of Object.entries(entries)) {
      if (now - persisted.savedAtMs > TTL_MS) continue; // expired
      const conv = getConversation(key);
      conv.pendingAction = persisted.pendingAction;
      conv.messages = persisted.recentMessages;
      conv.lastActivityMs = persisted.savedAtMs;
      restored++;
    }

    if (restored > 0) {
      console.log(`[chat] Restored ${restored} pending action(s) from disk`);
    }
  } catch {
    // No file or parse error — normal on first run
  }
}

// Context gathering extracted to chat-context.ts
// Prompt building extracted to chat-prompt.ts

// Prompt building extracted to chat-prompt.ts

// ── Agent query (async, fire-and-forget) ─────────────────────────────────────

/** Build the onMessage handler that forwards progress to Slack.
 *  Debounces tool_use_summary events to avoid flooding the thread.
 *  Also intercepts dangerous Bash commands and interrupts the session.
 *  Eagerly parses action tags during streaming so pendingAction is set
 *  before the agent session completes — prevents race conditions where
 *  the user replies "yes" before the completion handler runs. */
function buildChatMessageHandler(
  callbacks: ChatCallbacks,
  handleRef: { handle: SessionHandle | null },
  state: { lastProgressText: string; skillIntercepted: boolean; allText: string },
  repoDir: string,
  convKey: string,
  conv: ConversationState,
  threadContext?: string,
) {
  const flusher = createToolBatchFlusher((line) => callbacks.onProgress(line));

  return async (msg: Record<string, unknown>) => {
    const type = msg.type as string;
    console.log(`[chat] message: type=${type}${type === "assistant" ? `, blocks=${msg.message ? ((msg.message as { content?: unknown[] })?.content?.length ?? 0) : 0}` : ""}`);

    // Security: intercept Bash tool_use blocks and block dangerous commands
    if (type === "assistant") {
      const content = msg.message as { content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }> } | undefined;
      if (content?.content) {
        for (const block of content.content) {
          if (block.type === "tool_use" && SHELL_TOOL_NAMES.has(block.name ?? "") && block.input?.command) {
            const cmd = String(block.input.command);
            try {
              validateShellCommand(cmd);
            } catch (err) {
              const reason = err instanceof SecurityError ? err.message : "dangerous command";
              console.error(`[security] Chat agent blocked: ${reason} — "${cmd.slice(0, 100)}"`);
              await callbacks.onComplete(`:lock: *Command blocked:* ${reason}\nThe command \`${cmd.slice(0, 80)}\` was prevented from executing.`);
              try { handleRef.handle?.interrupt(); } catch { /* best-effort */ }
              return;
            }
          }

          // Skills: intercept and delegate to deep work (coordinator is chat-only guidance)
          if (block.type === "tool_use" && block.name === "Skill" && block.input?.skill) {
            const skillName = String(block.input.skill);
            if (skillName !== "coordinator") {
              state.skillIntercepted = true;
              const skillArgs = block.input.args ? ` ${String(block.input.args)}` : "";
              const taskDesc = `Run /${skillName}${skillArgs}`;
              console.log(`[chat] Skill /${skillName} intercepted → deep work`);
              await callbacks.onProgress(`:flashlight: *Starting deep work for /${skillName}...*`);
              const deepSessionId = await spawnDeepWork(taskDesc, repoDir, {
                onProgress: callbacks.onProgress,
                onComplete: wrapOnCompleteForAwaitResponse(callbacks.onComplete, conv),
              }, convKey, threadContext);
              logInteraction("deep_work", { task: taskDesc }, convKey, "ok", `skill-escalation:${skillName}`).catch(() => {});
              try { handleRef.handle?.interrupt(); } catch { /* best-effort */ }
              return;
            }
          }

          // Write tools: intercept and delegate to deep work (chat is read-only)
          if (block.type === "tool_use" && CHAT_BLOCKED_TOOLS.has(block.name ?? "")) {
            state.skillIntercepted = true;
            const lastUserMsg = [...conv.messages].reverse().find(m => m.role === "user")?.content ?? "Complete the requested task";
            const taskDesc = lastUserMsg;
            console.log(`[chat] Write tool ${block.name} intercepted → deep work`);
            await callbacks.onProgress(`:flashlight: *This needs code changes — starting deep work…*`);
            const deepSessionId = await spawnDeepWork(taskDesc, repoDir, {
              onProgress: callbacks.onProgress,
              onComplete: wrapOnCompleteForAwaitResponse(callbacks.onComplete, conv),
            }, convKey, threadContext);
            logInteraction("deep_work", { task: taskDesc.slice(0,  200) }, convKey, "ok", `write-escalation:${block.name}`).catch(() => {});
            try { handleRef.handle?.interrupt(); } catch { /* best-effort */ }
            return;
          }
        }
      }
    }

    // Handle tool_use_summary messages — debounce into batches
    if (type === "tool_use_summary") {
      const summary = msg.summary as string | undefined;
      if (summary) flusher.push(summary);
      return;
    }

    // On assistant turn: flush any pending tool batch, then post text
    if (type === "assistant") {
      await flusher.flush();

      const content = msg.message as { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> } | undefined;
      if (!content?.content) return;
      const blocks = content.content;

      // Post explanatory text from the assistant
      for (const block of blocks) {
        if (block.type === "text" && block.text?.trim()) {
          state.lastProgressText = block.text;
          state.allText += (state.allText ? "\n" : "") + block.text;

          // Eagerly parse action tags during streaming so pendingAction is set
          // immediately — before the agent session completes. This prevents the
          // race condition where the user replies "yes" before handleAgentResponseInner
          // runs (see diagnosis-yes-confirmation-race-2026-02-17.md).
          const parsed = findActionTag(block.text);
          if (parsed && !conv.pendingAction) {
            const ea = eagerlySetPendingAction(parsed);
            if (ea) {
              conv.pendingAction = ea;
              savePendingActions();
              console.log(`[chat] Eagerly set pendingAction: ${ea.kind} for ${convKey}`);
            }
          }

          const userVisible = stripActionTags(block.text);
          if (userVisible) {
            await callbacks.onProgress(userVisible);
          }
          return;
        }
      }

      // No text but has tool_use blocks — summarize them
      const summaries = summarizeToolUses(blocks);
      if (summaries.length > 0) {
        await callbacks.onProgress(`:gear: ${summaries.join(", ")}`);
      }
      return;
    }
  };
}

/** Spawn an agent query async. Registers a session so it's visible and stoppable.
 *  Results are delivered via callbacks — this function returns immediately.
 *  Returns null if the agent cannot be spawned (e.g., scheduler is draining). */
function spawnChatAsync(
  prompt: string,
  repoDir: string,
  conv: ConversationState,
  convKey: string,
  callbacks: ChatCallbacks,
  threadContext?: string,
  channelMode: ChannelMode = "dev",
  fleetScheduler?: FleetScheduler,
): string | null {
  // Increment generation counter for stale-completion guard
  conv.generation++;
  const spawnGeneration = conv.generation;

  // Mutable references shared between the onMessage handler and the completion handler
  const handleRef: { handle: SessionHandle | null } = { handle: null };
  const progressState = { lastProgressText: "", skillIntercepted: false, allText: "" };

  // In chat mode, block write tools and skill/deep-work escalation entirely
  const chatModeInterceptor = channelMode === "chat"
    ? buildChatModeInterceptor(callbacks, handleRef, progressState)
    : undefined;

  let sessionId: string;
  let handle: SessionHandle;
  let result: Promise<AgentResult>;
  try {
    ({ sessionId, handle, result } = spawnAgent({
      profile: AGENT_PROFILES.chat,
      prompt,
      cwd: repoDir,
      disallowedTools: channelMode === "chat" ? ["Edit", "Write", "NotebookEdit", "Bash"] : undefined,
      onMessage: chatModeInterceptor ?? buildChatMessageHandler(callbacks, handleRef, progressState, repoDir, convKey, conv, threadContext),
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[chat] Failed to spawn agent for ${convKey}: ${msg}`);
    callbacks.onComplete(`:warning: The scheduler is restarting — please try again in a moment.`).catch(() => {});
    return null;
  }

  handleRef.handle = handle;
  conv.activeSessionId = sessionId;

  // Handle completion in the background
  result.then(async (agentResult) => {
    // Skill-intercept guard: deep work was spawned, it handles completion
    if (progressState.skillIntercepted) {
      conv.activeSessionId = null;
      console.log(`[chat] Skill intercepted [${sessionId}], deep work handles completion`);
      return;
    }
    // Stale-completion guard: if a newer agent was spawned, skip state mutation
    if (conv.generation !== spawnGeneration) {
      console.log(`[chat] Stale completion [${sessionId}] gen=${spawnGeneration} (current=${conv.generation}), skipping`);
      return;
    }
    conv.activeSessionId = null;

    // Track timeout state for auto-escalation on "continue"
    if (agentResult.timedOut) {
      conv.lastTimedOut = true;
      // Preserve the user's original question from this conversation
      const lastUserMsg = conv.messages.filter(m => m.role === "user").at(-1);
      conv.lastTimedOutMessage = lastUserMsg?.content ?? null;
    } else {
      conv.lastTimedOut = false;
      conv.lastTimedOutMessage = null;
    }

    const rawResponse = agentResult.text || "Sorry, I couldn't produce a response.";
    // If the last text block (rawResponse) doesn't contain an action tag but earlier
    // text blocks did, use the streaming-detected tag as a fallback. This handles
    // the case where the LLM produces an action tag in an intermediate text block
    // and then continues writing.
    let fallbackAction: ParsedAction | undefined;
    if (!findActionTag(rawResponse) && progressState.allText) {
      const fromAll = findActionTag(progressState.allText);
      if (fromAll) {
        fallbackAction = fromAll;
        console.log(`[chat] Action tag found in accumulated text but not in last text block: ${fromAll.kind}`);
      }
    }
    await handleAgentResponseInner(rawResponse, conv, repoDir, callbacks, progressState.lastProgressText, convKey, threadContext, channelMode, fallbackAction);

    // Restore suspended action after answering a clarifying question.
    // If the LLM's response set a new pendingAction (via action tag), the new one wins.
    if (conv.suspendedAction && !conv.pendingAction) {
      conv.pendingAction = conv.suspendedAction;
      conv.suspendedAction = null;
      savePendingActions();
      const confirmPrompt = buildConfirmPrompt(conv.pendingAction);
      console.log(`[chat] Restored suspendedAction (${conv.pendingAction.kind}), re-prompting confirmation`);
      await callbacks.onProgress(confirmPrompt);
    } else {
      conv.suspendedAction = null;
    }
  }).catch(async (err) => {
    // Skill-intercept guard
    if (progressState.skillIntercepted) {
      conv.activeSessionId = null;
      return;
    }
    console.error(`[chat] Error [${sessionId}] gen=${spawnGeneration}:`, err);

    // Stale-completion guard
    if (conv.generation !== spawnGeneration) {
      console.log(`[chat] Stale error [${sessionId}] gen=${spawnGeneration} (current=${conv.generation}), skipping`);
      return;
    }
    conv.activeSessionId = null;

    const text = `Sorry, I hit an error: ${err instanceof Error ? err.message : String(err)}`;
    addMessage(conv, "assistant", text);
    await callbacks.onComplete(text);

    // Restore suspended action even on error — user still needs to confirm/cancel
    if (conv.suspendedAction && !conv.pendingAction) {
      conv.pendingAction = conv.suspendedAction;
      conv.suspendedAction = null;
      savePendingActions();
      const confirmPrompt = buildConfirmPrompt(conv.pendingAction);
      await callbacks.onProgress(confirmPrompt);
    } else {
      conv.suspendedAction = null;
    }
  });

  return sessionId;
}

/** Build a simplified onMessage handler for chat-mode channels.
 *  Blocks dangerous tool calls and skill escalation — only read tools are allowed.
 *  Tracks lastProgressText and accumulated text so the completion handler can
 *  properly dedup and detect action tags in intermediate text blocks. */
function buildChatModeInterceptor(
  callbacks: ChatCallbacks,
  handleRef: { handle: SessionHandle | null },
  state: { lastProgressText: string; skillIntercepted: boolean; allText: string },
) {
  const flusher = createToolBatchFlusher((line) => callbacks.onProgress(line));

  return async (msg: Record<string, unknown>) => {
    const type = msg.type as string;

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

      for (const block of blocks) {
        if (block.type === "text" && block.text?.trim()) {
          state.lastProgressText = block.text;
          state.allText += (state.allText ? "\n" : "") + block.text;
          const userVisible = stripActionTags(block.text);
          if (userVisible) {
            await callbacks.onProgress(userVisible);
          }
          return;
        }
      }

      const summaries = summarizeToolUses(blocks);
      if (summaries.length > 0) {
        await callbacks.onProgress(`:gear: ${summaries.join(", ")}`);
      }
    }
  };
}


// Action tag parsing, stripping, eager action setting, and confirmation prompts
// extracted to action-tags.ts

/** Process the agent's response: parse action tags, update conversation, call onComplete.
 *  lastProgressText is used to deduplicate: if the final answer was already posted as a
 *  progress message (common with Cursor backend where text and tools are separate events),
 *  we skip re-posting it. */
async function handleAgentResponseInner(
  rawResponse: string,
  conv: ConversationState,
  repoDir: string,
  callbacks: ChatCallbacks,
  lastProgressText?: string,
  convKey?: string,
  threadContext?: string,
  channelMode: ChannelMode = "dev",
  fallbackAction?: ParsedAction,
): Promise<void> {
  const parsed = findActionTag(rawResponse) ?? fallbackAction ?? null;

  if (parsed) {
    // In chat mode, block all actions except chat-mode-safe ones
    if (channelMode === "chat" && !isChatModeAction(parsed.kind)) {
      const cleanText = stripActionTags(rawResponse);
      const text = cleanText + "\n\n_This channel is in chat mode — I can't perform that action here. Try a dev-mode channel or DM instead!_ ☺️";
      addMessage(conv, "assistant", text);
      await callbacks.onComplete(text);
      return;
    }

    // Handle chat-mode-specific actions (suggest_task, note_question)
    // Processes ALL matching tags in the response, not just the first.
    if (parsed.kind === "suggest_task" || parsed.kind === "note_question") {
      const allChatActions = findAllActionTags(rawResponse).filter(
        t => t.kind === "suggest_task" || t.kind === "note_question",
      );
      const cleanText = stripActionTags(rawResponse);
      const threadKey = convKey ?? "unknown";
      await handleChatModeActions(allChatActions.length > 0 ? allChatActions : [parsed], cleanText, conv, repoDir, callbacks, threadKey);
      return;
    }

    let cleanText = rawResponse.replace(parsed.tag, "").trim();
    const threadKey = convKey ?? "unknown";

    // If pendingAction was already eagerly set during streaming (by buildChatMessageHandler),
    // the agent's text was posted via onProgress. We still need to send the confirmation
    // prompt so the user knows to reply "yes".
    if (conv.pendingAction && (
      parsed.kind === "launch_experiment" ||
      parsed.kind === "run_job" ||
      parsed.kind === "approve" ||
      parsed.kind === "deny"
    )) {
      console.log(`[chat] pendingAction already set (eager), posting confirmation prompt`);
      addMessage(conv, "assistant", cleanText);
      const confirmPrompt = buildConfirmPrompt(conv.pendingAction);
      await callbacks.onComplete(confirmPrompt);
      return;
    }

    // ── Approval actions (require confirmation) ──
    if (parsed.kind === "approve" || parsed.kind === "deny") {
      const itemIndex = parseInt(parsed.params.item, 10) - 1;
      const notes = parsed.params.notes || undefined;
      const approvals = await getPendingApprovals(repoDir);

      if (itemIndex < 0 || itemIndex >= approvals.length) {
        const text = cleanText + "\n\n:warning: _Couldn't find that approval item._";
        addMessage(conv, "assistant", text);
        await callbacks.onComplete(text);
        return;
      }

      conv.pendingAction = { kind: parsed.kind as "approve" | "deny", itemIndex, notes };
      savePendingActions();
      const item = approvals[itemIndex];
      const verb = parsed.kind === "approve" ? "approve" : "deny";
      const text =
        cleanText +
        `\n\n:point_right: _Confirm: reply *yes* to ${verb} "${item.title}"${notes ? ` with notes: "${notes}"` : ""}, or *no* to cancel._`;
      addMessage(conv, "assistant", text);
      await callbacks.onComplete(text);
      return;
    }

    // ── Stop session (immediate) ──
    if (parsed.kind === "stop_session") {
      const sessionId = parsed.params.id;
      const session = getSession(sessionId);
      let resultText: string;
      const extras: InteractionExtras = {
        turnsBeforeAction: countUserTurns(conv),
        userCorrected: detectCorrection(conv),
        intentType: "session",
      };

      if (!session) {
        resultText = cleanText + `\n\n:warning: Session \`${sessionId}\` not found.`;
        await logInteraction("stop_session", { id: sessionId }, threadKey, "error", "session not found", { ...extras, intentFulfilled: "failed" });
      } else {
        try {
          await session.handle.interrupt();
          resultText = cleanText + `\n\n:octagonal_sign: Interrupt sent to session \`${sessionId}\`.`;
          await logInteraction("stop_session", { id: sessionId }, threadKey, "ok", undefined, { ...extras, intentFulfilled: "fulfilled" });
        } catch (err) {
          resultText = cleanText + `\n\n:warning: Failed to interrupt: ${err instanceof Error ? err.message : String(err)}`;
          await logInteraction("stop_session", { id: sessionId }, threadKey, "error", String(err), { ...extras, intentFulfilled: "failed" });
        }
      }

      addMessage(conv, "assistant", resultText);
      await callbacks.onComplete(resultText);
      return;
    }

    // ── Ask session (immediate) ──
    if (parsed.kind === "ask_session") {
      const sessionId = parsed.params.id;
      const question = parsed.params.message;
      const session = getSession(sessionId);
      let resultText: string;

      const askExtras: InteractionExtras = {
        turnsBeforeAction: countUserTurns(conv),
        userCorrected: detectCorrection(conv),
        intentType: "session",
      };

      if (!session) {
        resultText = cleanText + `\n\n:warning: Session \`${sessionId}\` not found.`;
        await logInteraction("ask_session", { id: sessionId, message: question }, threadKey, "error", "session not found", { ...askExtras, intentFulfilled: "failed" });
      } else if (!session.handle.streamInput) {
        resultText = cleanText + `\n\n:warning: Session \`${sessionId}\` (${session.handle.backend}) doesn't support message injection.`;
        await logInteraction("ask_session", { id: sessionId, message: question }, threadKey, "error", "backend unsupported", { ...askExtras, intentFulfilled: "failed" });
      } else {
        try {
          const framedContent = [
            "[HUMAN SUPERVISOR MESSAGE]",
            question,
            "",
            "Please answer this briefly and then continue your current work.",
          ].join("\n");

          await session.handle.streamInput(
            (async function* () {
              yield {
                type: "user" as const,
                message: { role: "user" as const, content: framedContent },
                parent_tool_use_id: null,
                session_id: session.sessionId ?? "",
              };
            })(),
          );
          resultText = cleanText + `\n\n:mega: Message sent to session \`${sessionId}\`.`;
          await logInteraction("ask_session", { id: sessionId, message: question }, threadKey, "ok", undefined, { ...askExtras, intentFulfilled: "fulfilled" });
        } catch (err) {
          resultText = cleanText + `\n\n:warning: Failed to send message: ${err instanceof Error ? err.message : String(err)}`;
          await logInteraction("ask_session", { id: sessionId, message: question }, threadKey, "error", String(err), { ...askExtras, intentFulfilled: "failed" });
        }
      }

      addMessage(conv, "assistant", resultText);
      await callbacks.onComplete(resultText);
      return;
    }

    // ── Watch session (immediate) ──
    if (parsed.kind === "watch_session") {
      const sessionId = parsed.params.id;
      const session = getSession(sessionId);
      let resultText: string;

      const watchExtras: InteractionExtras = {
        turnsBeforeAction: countUserTurns(conv),
        userCorrected: detectCorrection(conv),
        intentType: "session",
      };

      if (!session) {
        resultText = cleanText + `\n\n:warning: Session \`${sessionId}\` not found.`;
        await logInteraction("watch_session", { id: sessionId }, threadKey, "error", "session not found", { ...watchExtras, intentFulfilled: "failed" });
      } else {
        // Add watcher using the thread key (channel:threadTs)
        addWatcher(sessionId, threadKey);
        const recent = getRecentMessages(sessionId, 5);
        if (recent.length > 0) {
          let context = `\n\n:eyes: *Watching session \`${sessionId}\`* (${session.jobName})\n_Recent activity:_\n`;
          for (const m of recent) {
            context += `> ${m.text.split("\n")[0]}\n`;
          }
          resultText = cleanText + context;
        } else {
          resultText = cleanText + `\n\n:eyes: *Watching session \`${sessionId}\`* (${session.jobName}). Updates will appear here.`;
        }
        await logInteraction("watch_session", { id: sessionId }, threadKey, "ok", undefined, { ...watchExtras, intentFulfilled: "fulfilled" });
      }

      addMessage(conv, "assistant", resultText);
      await callbacks.onComplete(resultText);
      return;
    }

    // ── Stop experiment (immediate) ──
    if (parsed.kind === "stop_experiment") {
      const { project, id: expId } = parsed.params;
      let resultText: string;

      const stopExpExtras: InteractionExtras = {
        turnsBeforeAction: countUserTurns(conv),
        userCorrected: detectCorrection(conv),
        intentType: "experiment",
      };

      try {
        validatePathSegment(project, "project");
        validatePathSegment(expId, "experiment ID");
      } catch (err) {
        if (err instanceof SecurityError) {
          resultText = cleanText + `\n\n:lock: ${err.message}`;
          await logInteraction("stop_experiment", { project, id: expId }, threadKey, "error", err.message, { ...stopExpExtras, intentFulfilled: "failed" });
          addMessage(conv, "assistant", resultText);
          await callbacks.onComplete(resultText);
          return;
        }
        throw err;
      }

      const dir = `${repoDir}/projects/${project}/experiments/${expId}`;
      const stopped = await stopExperiment(dir);
      if (stopped) {
        resultText = cleanText + `\n\n:octagonal_sign: Sent SIGTERM to *${project}/${expId}*.`;
        await logInteraction("stop_experiment", { project, id: expId }, threadKey, "ok", undefined, { ...stopExpExtras, intentFulfilled: "fulfilled" });
      } else {
        resultText = cleanText + `\n\n:warning: Could not stop *${project}/${expId}* — not running or no PID.`;
        await logInteraction("stop_experiment", { project, id: expId }, threadKey, "error", "not running or no PID", { ...stopExpExtras, intentFulfilled: "failed" });
      }

      addMessage(conv, "assistant", resultText);
      await callbacks.onComplete(resultText);
      return;
    }

    // ── Launch experiment (requires confirmation) ──
    if (parsed.kind === "launch_experiment") {
      const { project, id: expId, command } = parsed.params;
      if (!command) {
        const text = cleanText + "\n\n:warning: No command provided for experiment launch.";
        addMessage(conv, "assistant", text);
        await callbacks.onComplete(text);
        return;
      }

      try {
        validatePathSegment(project, "project");
        validatePathSegment(expId, "experiment ID");
      } catch (err) {
        if (err instanceof SecurityError) {
          const text = cleanText + `\n\n:lock: ${err.message}`;
          addMessage(conv, "assistant", text);
          await callbacks.onComplete(text);
          return;
        }
        throw err;
      }

      // Auto-correct command: if run.sh exists and the agent proposed something else, use run.sh
      const dir = `${repoDir}/projects/${project}/experiments/${expId}`;
      let correctedCommand = command;
      try {
        await stat(join(dir, "run.sh"));
        const isPlainRunSh = /^(bash\s+)?\.?\/?\s*run\.sh(\s|$)/.test(command.trim());
        if (!isPlainRunSh) {
          correctedCommand = "bash run.sh";
          console.log(`[chat] Auto-corrected command for ${project}/${expId}: "${command}" → "${correctedCommand}"`);
        }
      } catch {
        // No run.sh — use agent's command as-is
      }

      // Validate experiment before offering confirmation
      const validation = await validateExperimentDir(dir);
      if (!validation.ok) {
        const truncated = validation.output.length > 1500
          ? validation.output.slice(0, 1500) + "\n...(truncated)"
          : validation.output;
        const text = cleanText + `\n\n:x: *Experiment validation failed — fix before launching:*\n\`\`\`\n${truncated}\n\`\`\``;
        await logInteraction("launch_experiment", { project, id: expId, command: correctedCommand }, threadKey, "error", "validation failed", {
          turnsBeforeAction: countUserTurns(conv),
          userCorrected: detectCorrection(conv),
          intentType: "experiment",
          intentFulfilled: "failed",
        });
        addMessage(conv, "assistant", text);
        await callbacks.onComplete(text);
        return;
      }

      // Budget hard gate: block launch if project budget is exceeded or deadline passed
      const projectDir = join(repoDir, "projects", project);
      const budgetStatus = await readBudgetStatus(projectDir);
      if (budgetStatus) {
        const exceeded = budgetStatus.resources.filter((r) => r.pct >= 100);
        const deadlinePassed = budgetStatus.hoursToDeadline !== undefined && budgetStatus.hoursToDeadline <= 0;
        if (exceeded.length > 0 || deadlinePassed) {
          const reasons: string[] = [];
          for (const r of exceeded) reasons.push(`${r.resource}: ${r.consumed}/${r.limit} ${r.unit} (${r.pct}%)`);
          if (deadlinePassed) reasons.push(`deadline passed (${budgetStatus.deadline})`);
          const text = cleanText + `\n\n:no_entry: *Budget exceeded — cannot launch experiment:*\n${reasons.join("\n")}\n_Request a budget increase via APPROVAL_QUEUE.md._`;
          await logInteraction("launch_experiment", { project, id: expId, command: correctedCommand }, threadKey, "error", "budget exceeded", {
            turnsBeforeAction: countUserTurns(conv),
            userCorrected: detectCorrection(conv),
            intentType: "experiment",
            intentFulfilled: "failed",
          });
          addMessage(conv, "assistant", text);
          await callbacks.onComplete(text);
          return;
        }
        // Near-budget warning: append to confirmation message
        const nearBudget = budgetStatus.resources.filter((r) => r.pct >= 80);
        const deadlineSoon = budgetStatus.hoursToDeadline !== undefined && budgetStatus.hoursToDeadline <= 72;
        if (nearBudget.length > 0 || deadlineSoon) {
          const warnings: string[] = [];
          for (const r of nearBudget) warnings.push(`${r.resource}: ${r.pct}%`);
          if (deadlineSoon) warnings.push(`deadline in ${budgetStatus.hoursToDeadline}h`);
          cleanText += `\n:warning: *Budget warning:* ${warnings.join(", ")}`;
        }
      }

      conv.pendingAction = { kind: "launch_experiment", project, expId, command: correctedCommand };
      savePendingActions();
      const correctionNote = correctedCommand !== command
        ? `\n:pencil2: _Auto-corrected command from \`${command}\` to \`${correctedCommand}\` (run.sh found)._`
        : "";
      const text =
        cleanText +
        correctionNote +
        `\n\n:white_check_mark: Validation passed.\n:point_right: _Confirm: reply *yes* to launch experiment *${project}/${expId}* with command \`${correctedCommand}\`, or *no* to cancel._`;
      addMessage(conv, "assistant", text);
      await callbacks.onComplete(text);
      return;
    }

    // ── Run job (requires confirmation) ──
    if (parsed.kind === "run_job") {
      const jobIdOrName = parsed.params.id;
      if (!chatStoreRef) {
        const text = cleanText + "\n\n:warning: Job store not available.";
        addMessage(conv, "assistant", text);
        await callbacks.onComplete(text);
        return;
      }
      await chatStoreRef.load();
      const jobs = chatStoreRef.list();
      const job = jobs.find((j) => j.id === jobIdOrName || j.name === jobIdOrName);
      if (!job) {
        const text = cleanText + `\n\n:warning: Job \`${jobIdOrName}\` not found.`;
        addMessage(conv, "assistant", text);
        await callbacks.onComplete(text);
        return;
      }

      // Check if already running
      const activeSessions = listSessions();
      const running = activeSessions.find((s) => s.jobId === job.id);
      if (running) {
        const elapsed = Math.round(running.elapsedMs / 1000);
        const text = cleanText + `\n\n:warning: Job *${job.name}* already has a running session (\`${running.id}\`, ${elapsed}s elapsed).`;
        addMessage(conv, "assistant", text);
        await callbacks.onComplete(text);
        return;
      }

      conv.pendingAction = { kind: "run_job", jobId: job.id };
      savePendingActions();
      const text =
        cleanText +
        `\n\n:point_right: _Confirm: reply *yes* to run job *${job.name}* now, or *no* to cancel._`;
      addMessage(conv, "assistant", text);
      await callbacks.onComplete(text);
      return;
    }

    // ── Generate report (immediate — no confirmation) ──
    if (parsed.kind === "generate_report") {
      const reportType = parsed.params.type as "operational" | "research" | "project" | "experiment-comparison";
      const project = parsed.params.project || undefined;
      const from = parsed.params.from || undefined;
      const to = parsed.params.to || undefined;

      addMessage(conv, "assistant", cleanText);
      await callbacks.onProgress(`:bar_chart: _Generating ${reportType} report..._`);

      try {
        const { gatherReportData } = await import("../report/aggregator.js");
        const { renderOperationalSlack, renderResearchSlack, renderProjectSlack, renderExperimentComparisonSlack } = await import("../report/render-slack.js");

        const data = await gatherReportData(repoDir, from, to);
        let blocks: Record<string, unknown>[];

        switch (reportType) {
          case "operational":
            blocks = renderOperationalSlack(data);
            break;
          case "research":
            blocks = renderResearchSlack(data);
            break;
          case "project":
            blocks = renderProjectSlack(data, project);
            break;
          case "experiment-comparison":
            blocks = renderExperimentComparisonSlack(data);
            break;
          default:
            blocks = renderOperationalSlack(data);
        }

        // Post as Block Kit via a special prefix the Slack layer can detect
        const blocksJson = JSON.stringify(blocks);
        await callbacks.onComplete(`__BLOCKS__${blocksJson}`);
      } catch (err) {
        const errMsg = `:warning: Report generation failed: ${err instanceof Error ? err.message : String(err)}`;
        await callbacks.onComplete(errMsg);
      }

      await logInteraction("generate_report", { type: reportType, project: project ?? "" }, threadKey, "ok", undefined, {
        turnsBeforeAction: countUserTurns(conv),
        userCorrected: detectCorrection(conv),
        intentType: "status",
        intentFulfilled: "fulfilled",
      });
      return;
    }

    // ── Send files (immediate — no confirmation) ──
    if (parsed.kind === "send_files") {
      const pathsStr = parsed.params.paths;
      const caption = parsed.params.caption || undefined;

      addMessage(conv, "assistant", cleanText);
      await callbacks.onProgress(`:file_folder: _Uploading files..._`);

      try {
        const { readFile: readFileAsync } = await import("node:fs/promises");
        const { basename, resolve } = await import("node:path");
        const { channelFiles, dmFiles } = await import("../slack.js");

        const paths = pathsStr.split(",").map((p: string) => p.trim()).filter(Boolean);
        const files: Array<{ buffer: Buffer; filename: string; title: string }> = [];

        for (const p of paths) {
          const absPath = resolve(repoDir, p);
          try {
            const buf = await readFileAsync(absPath);
            const fname = basename(absPath);
            files.push({
              buffer: buf,
              filename: fname,
              title: fname,
            });
          } catch (readErr) {
            console.error(`[chat] Failed to read file ${absPath}: ${readErr}`);
          }
        }

        if (files.length === 0) {
          await callbacks.onComplete(cleanText + "\n\n:warning: No files found at the specified paths.");
          return;
        }

        const threadTsParts = threadKey.split(":");
        const channelId = threadTsParts[0];
        const threadTs = threadTsParts.length >= 2 ? threadTsParts.slice(1).join(":") : undefined;

        let result;
        if (channelId && threadTs) {
          result = await channelFiles(channelId, files, { threadTs, initialComment: caption });
        } else if (channelId) {
          result = await channelFiles(channelId, files, { initialComment: caption });
        } else {
          result = await dmFiles(files, caption);
        }

        if (result.ok) {
          const text = cleanText || `:white_check_mark: Uploaded ${result.count} file(s) to Slack.`;
          await callbacks.onComplete(text);
        } else {
          await callbacks.onComplete(cleanText + `\n\n:warning: File upload failed: ${result.error}`);
        }
      } catch (err) {
        const errMsg = `:warning: File upload failed: ${err instanceof Error ? err.message : String(err)}`;
        await callbacks.onComplete(cleanText + "\n\n" + errMsg);
      }

      await logInteraction("send_files", { paths: pathsStr, caption: caption ?? "" }, threadKey, "ok", undefined, {
        turnsBeforeAction: countUserTurns(conv),
        userCorrected: detectCorrection(conv),
        intentType: "other",
        intentFulfilled: "fulfilled",
      });
      return;
    }

    // ── Run burst (requires confirmation) ──
    if (parsed.kind === "run_burst") {
      const jobName = parsed.params.job;
      const maxSessions = parseInt(parsed.params.max_sessions || "10", 10);
      const maxCost = parseFloat(parsed.params.max_cost || "20");
      const autofix = parsed.params.autofix !== "false";

      if (!jobName) {
        const text = cleanText + "\n\n:warning: No job name provided for burst mode.";
        addMessage(conv, "assistant", text);
        await callbacks.onComplete(text);
        return;
      }

      conv.pendingAction = {
        kind: "run_burst",
        jobId: jobName,
        maxSessions,
        maxCost,
        autofix,
      };
      savePendingActions();
      const text =
        cleanText +
        `\n\n:point_right: _Confirm: reply *yes* to create burst request for *${jobName}* (${maxSessions} sessions, $${maxCost} cap${autofix ? ", autofix on" : ""}), or *no* to cancel._`;
      addMessage(conv, "assistant", text);
      await callbacks.onComplete(text);
      return;
    }

    // ── Deep work (immediate — no confirmation) ──
    if (parsed.kind === "deep_work") {
      const taskDesc = parsed.params.task;
      if (!taskDesc) {
        const text = cleanText + "\n\n:warning: No task description provided for deep work.";
        addMessage(conv, "assistant", text);
        await callbacks.onComplete(text);
        return;
      }

      addMessage(conv, "assistant", cleanText);

      // Clear interview state when deep work is spawned (interview complete)
      if (conv.activeInterview) {
        console.log(`[chat] Interview for /${conv.activeInterview.skillName} complete — delegating to deep work`);
        conv.activeInterview = null;
      }

      const deepSessionId = await spawnDeepWork(taskDesc, repoDir, {
        onProgress: callbacks.onProgress,
        onComplete: wrapOnCompleteForAwaitResponse(callbacks.onComplete, conv),
      }, threadKey, threadContext);

      await logInteraction("deep_work", { task: taskDesc.slice(0, 200) }, threadKey, "ok", undefined, {
        turnsBeforeAction: countUserTurns(conv),
        userCorrected: detectCorrection(conv),
        intentType: "other",
      });

      // Post a brief status and let living message handle updates
      await callbacks.onComplete(`:rocket: _Deep work session started._`);
      return;
    }

    // ── Create task (immediate — fleet worker picks it up) ──
    // Processes ALL create_task tags in the response, not just the first.
    if (parsed.kind === "create_task") {
      const allCreateTasks = findAllActionTags(rawResponse).filter(t => t.kind === "create_task");
      const allCleanText = stripActionTags(rawResponse);

      const validTasks: Array<{ project: string; taskText: string; done_when: string }> = [];
      for (const tag of allCreateTasks) {
        const { project, task: taskText, done_when } = tag.params;
        if (!project || !taskText || !done_when) continue;
        try {
          validatePathSegment(project, "project");
        } catch (err) {
          if (err instanceof SecurityError) continue;
          throw err;
        }
        validTasks.push({ project, taskText, done_when });
      }

      if (validTasks.length === 0) {
        const text = allCleanText + "\n\n:warning: Missing required fields. Need project, task, and done_when.";
        addMessage(conv, "assistant", text);
        await callbacks.onComplete(text);
        return;
      }

      const byProject = new Map<string, typeof validTasks>();
      for (const task of validTasks) {
        const list = byProject.get(task.project) ?? [];
        list.push(task);
        byProject.set(task.project, list);
      }

      const createdProjects: string[] = [];
      const errors: string[] = [];
      const date = new Date().toISOString().slice(0, 10);

      for (const [project, tasks] of byProject) {
        const tasksPath = join(repoDir, "projects", project, "TASKS.md");
        try {
          let existing = "";
          try {
            existing = await readFile(tasksPath, "utf-8");
          } catch {
            existing = `# ${project} — Next actions\n\n`;
          }

          let newContent = "";
          for (const task of tasks) {
            newContent += `\n- [ ] ${task.taskText} [fleet-eligible]\n  Why: Created from Slack (${date})\n  Done when: ${task.done_when}\n`;
          }
          const updated = existing.trimEnd() + "\n" + newContent;

          const tmpPath = tasksPath + ".tmp";
          await mkdir(dirname(tasksPath), { recursive: true });
          await writeFile(tmpPath, updated, "utf-8");
          await rename(tmpPath, tasksPath);

          createdProjects.push(project);
        } catch (err) {
          errors.push(`${project}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const totalCreated = validTasks.filter(t => createdProjects.includes(t.project)).length;
      let statusText: string;
      if (totalCreated > 0 && errors.length === 0) {
        const projectList = createdProjects.map(p => `*${p}/TASKS.md*`).join(", ");
        statusText = allCleanText + `\n\n:ship: Created ${totalCreated} task(s) in ${projectList} with \`[fleet-eligible]\` tag. Fleet workers will pick them up within ~30 seconds.`;
      } else if (totalCreated > 0) {
        statusText = allCleanText + `\n\n:ship: Created ${totalCreated} task(s), but ${errors.length} failed: ${errors.join("; ")}`;
      } else {
        statusText = allCleanText + `\n\n:warning: Failed to create tasks: ${errors.join("; ")}`;
      }
      addMessage(conv, "assistant", statusText);
      await callbacks.onComplete(statusText);

      for (const task of validTasks) {
        const ok = createdProjects.includes(task.project);
        await logInteraction("create_task", { project: task.project, task: task.taskText.slice(0, 200) }, threadKey, ok ? "ok" : "error", undefined, {
          turnsBeforeAction: countUserTurns(conv),
          userCorrected: detectCorrection(conv),
          intentType: "other",
          intentFulfilled: ok ? "fulfilled" : "failed",
        });
      }
      return;
    }

    // ── Restart (immediate — no confirmation) ──
    if (parsed.kind === "fleet_control" && parsed.params.op === "status") {
      const fleet = chatFleetSchedulerRef;
      const statusText = fleet
        ? `:ship: *Fleet status:* ${fleet.isEnabled() ? "enabled" : "disabled"}, ` +
          `${fleet.getActiveWorkers().length} active worker(s)`
        : `:ship: *Fleet status:* not available (fleet scheduler not initialized)`;
      const text = cleanText + `\n\n${statusText}`;
      addMessage(conv, "assistant", text);
      await callbacks.onComplete(text);
      await logInteraction("fleet_control", { op: "status" }, convKey ?? "unknown", "ok", undefined, {
        turnsBeforeAction: countUserTurns(conv),
        userCorrected: false,
        intentType: "other",
        intentFulfilled: "fulfilled",
      });
      return;
    }

    if (parsed.kind === "restart") {
      addMessage(conv, "assistant", cleanText);
      await callbacks.onProgress(`:arrows_counterclockwise: _Initiating graceful restart..._`);

      try {
        const response = await fetch("http://localhost:8420/api/restart", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({})) as { error?: string };
          const errMsg = errData.error || `HTTP ${response.status}`;
          const text = cleanText + `\n\n:warning: Restart failed: ${errMsg}`;
          await callbacks.onComplete(text);
          await logInteraction("restart", {}, threadKey, "error", errMsg, {
            turnsBeforeAction: countUserTurns(conv),
            userCorrected: detectCorrection(conv),
            intentType: "other",
            intentFulfilled: "failed",
          });
          return;
        }

        await logInteraction("restart", {}, threadKey, "ok", undefined, {
          turnsBeforeAction: countUserTurns(conv),
          userCorrected: detectCorrection(conv),
          intentType: "other",
          intentFulfilled: "fulfilled",
        });

        // Note: the scheduler will restart after draining, so this message
        // may not be delivered. But we try anyway.
        await callbacks.onComplete(cleanText + `\n\n:arrows_counterclockwise: _Graceful restart initiated. Draining active sessions before restart..._`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const text = cleanText + `\n\n:warning: Restart failed: ${errMsg}`;
        await callbacks.onComplete(text);
        await logInteraction("restart", {}, threadKey, "error", errMsg, {
          turnsBeforeAction: countUserTurns(conv),
          userCorrected: detectCorrection(conv),
          intentType: "other",
          intentFulfilled: "failed",
        });
      }
      return;
    }
  }

  // No action tag — plain text response.
  // Strip any action-tag-like patterns as a safety net: if the LLM produced a
  // tag that findActionTag couldn't parse (malformed), stripActionTags will
  // remove it so users never see raw [ACTION:...] strings in Slack.
  const cleanText = stripActionTags(rawResponse);

  // Deep-work intent fallback: if the LLM promised to launch deep work but forgot
  // the action tag, auto-spawn deep work using the last user message as the task.
  // This is a code-level safety net for a recurring LLM compliance failure — see
  // diagnosis-deep-work-launch-loop-production-404-2026-03-04.md (3 incidents).
  if (channelMode !== "chat" && /(?:launch|start|kick off|spawn|beginning|launching)\s+(?:a\s+)?deep\s*work/i.test(cleanText)) {
    console.log(`[chat] Deep-work intent fallback: response mentions launching deep work but no action tag found`);
    const lastUserMsg = [...conv.messages].reverse().find((m) => m.role === "user");
    const fallbackTask = lastUserMsg
      ? `User request (auto-recovered — chat agent failed to emit action tag): ${lastUserMsg.content.slice(0, 500)}`
      : "Deep work requested but no task description available";
    const threadKey = convKey ?? "unknown";

    addMessage(conv, "assistant", cleanText);
    const deepSessionId = await spawnDeepWork(fallbackTask, repoDir, {
      onProgress: callbacks.onProgress,
      onComplete: wrapOnCompleteForAwaitResponse(callbacks.onComplete, conv),
    }, threadKey, threadContext);

    await logInteraction("deep_work", { task: fallbackTask.slice(0, 200) }, threadKey, "ok", "intent-fallback", {
      turnsBeforeAction: countUserTurns(conv),
      userCorrected: detectCorrection(conv),
      intentType: "other",
    });

    await callbacks.onComplete(`:rocket: _Deep work session started._ (auto-recovered)`);
    return;
  }

  addMessage(conv, "assistant", cleanText);

  // Log evidence grading for chat-mode responses
  if (channelMode === "chat") {
    const threadKey = convKey ?? "unknown";
    logInteraction("chat_response", {}, threadKey, "ok", undefined, {
      evidenceGraded: detectEvidenceGrading(cleanText),
      isChatMode: true,
    }).catch(() => {});
  }

  // Deduplicate: if the final answer was already posted as a progress message
  // (common when text and tools arrive as separate events), skip re-posting.
  // Compare stripped versions so ACTION tags don't defeat dedup.
  if (lastProgressText) {
    const normResult = stripActionTags(cleanText).replace(/\s+/g, " ");
    const normProgress = stripActionTags(lastProgressText).replace(/\s+/g, " ");
    if (normResult === normProgress || normResult.startsWith(normProgress) || normProgress.startsWith(normResult)) {
      console.log(`[chat] Dedup: final text matches last progress message, skipping re-post`);
      await callbacks.onComplete(null);
      return;
    }
    console.log(`[chat] Dedup failed: result(${normResult.length} chars) vs progress(${normProgress.length} chars)`);
  }

  await callbacks.onComplete(cleanText);
}

// ── Chat-mode action handlers ────────────────────────────────────────────────

const SUGGESTIONS_FILENAME = "intake.md";

/** Handle chat-mode-only actions: suggest_task and note_question.
 *  Processes ALL matching tags in the response, batching writes per project.
 *  These append to a suggestions file in the project directory (not directly to TASKS.md). */
async function handleChatModeActions(
  actions: ParsedAction[],
  cleanText: string,
  conv: ConversationState,
  repoDir: string,
  callbacks: ChatCallbacks,
  threadKey: string,
): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);

  // Validate and group actions by project
  interface ChatActionEntry {
    parsed: ParsedAction;
    entry: string;
    logAction: string;
  }
  const byProject = new Map<string, ChatActionEntry[]>();
  const invalidProjects: string[] = [];

  for (const parsed of actions) {
    const project = parsed.params.project;
    try {
      validatePathSegment(project, "project");
    } catch (err) {
      if (err instanceof SecurityError) {
        invalidProjects.push(project);
        continue;
      }
      throw err;
    }

    let entry: string;
    let logAction: string;
    if (parsed.kind === "suggest_task") {
      entry = `- [ ] ${parsed.params.task}\n  Source: chat-mode suggestion (${date})\n`;
      logAction = "suggest_task";
    } else {
      entry = `- ${parsed.params.question}\n  Source: chat-mode question (${date})\n`;
      logAction = "note_question";
    }

    const list = byProject.get(project) ?? [];
    list.push({ parsed, entry, logAction });
    byProject.set(project, list);
  }

  if (byProject.size === 0) {
    const text = cleanText + `\n\n:lock: Invalid project name(s): ${invalidProjects.join(", ")}`;
    addMessage(conv, "assistant", text);
    await callbacks.onComplete(text);
    return;
  }

  let totalRecorded = 0;
  const errors: string[] = [];

  for (const [project, entries] of byProject) {
    const projectDir = join(repoDir, "projects", project);
    const suggestionsPath = join(projectDir, SUGGESTIONS_FILENAME);

    try {
      let existing = "";
      try {
        existing = await readFile(suggestionsPath, "utf-8");
      } catch {
        existing = `# Suggestion Intake\n\nAll chat-mode Slack suggestions are recorded here for triage.\n\n`;
      }

      let newContent = "";
      for (const { entry } of entries) {
        newContent += entry;
      }
      const updated = existing.trimEnd() + "\n" + newContent;
      const tmpPath = suggestionsPath + ".tmp";
      await mkdir(dirname(suggestionsPath), { recursive: true });
      await writeFile(tmpPath, updated, "utf-8");
      await rename(tmpPath, suggestionsPath);

      totalRecorded += entries.length;
      for (const { parsed, logAction } of entries) {
        await logInteraction(logAction, { project, ...parsed.params }, threadKey, "ok");
      }
    } catch (err) {
      errors.push(`${project}: ${err instanceof Error ? err.message : String(err)}`);
      for (const { parsed, logAction } of entries) {
        await logInteraction(logAction, { project, ...parsed.params }, threadKey, "error", String(err));
      }
    }
  }

  let statusText: string;
  if (totalRecorded > 0 && errors.length === 0) {
    const noun = totalRecorded === 1 ? "item" : "items";
    statusText = cleanText + `\n\n:memo: Noted! Recorded ${totalRecorded} ${noun} for triage.`;
  } else if (totalRecorded > 0) {
    statusText = cleanText + `\n\n:memo: Recorded ${totalRecorded} item(s), but ${errors.length} failed: ${errors.join("; ")}`;
  } else {
    statusText = cleanText + `\n\n:warning: Failed to save: ${errors.join("; ")}`;
  }
  addMessage(conv, "assistant", statusText);
  await callbacks.onComplete(statusText);
}

/** Count user messages in a conversation. */
function countUserTurns(conv: ConversationState): number {
  return conv.messages.filter((m) => m.role === "user").length;
}

/** Detect if user had to rephrase: two consecutive user messages with no assistant between. */
function detectCorrection(conv: ConversationState): boolean {
  const msgs = conv.messages;
  for (let i = 1; i < msgs.length; i++) {
    if (msgs[i].role === "user" && msgs[i - 1].role === "user") return true;
  }
  return false;
}

/** Detect burst mode requests like "run burst mode on akari-work-cycle".
 *  Returns { job, maxSessions, maxCost, autofix } if matched, null otherwise.
 *  Uses two patterns to avoid false-positives on declarative statements
 *  (e.g., "burst mode run is now approved"). */
export function detectBurstRequest(message: string): { job: string; maxSessions: number; maxCost: number; autofix: boolean } | null {
  const lower = message.toLowerCase().trim();

  // Pattern 1: command verb + [akari] burst [mode] [on/for <rest>]
  const verbMatch = lower.match(
    /^(?:run|start|activate|launch|trigger|do)\s+(?:akari\s+)?burst\s*(?:mode)?(?:\s+(?:on|for)\s+(?:the\s+)?)?(.+)?/s,
  );

  // Pattern 2: bare "burst [mode]" — only valid if followed by "on/for <job>" or nothing
  const bareMatch = !verbMatch && lower.match(
    /^(?:akari\s+)?burst\s*(?:mode)?(?:\s+(?:on|for)\s+(?:the\s+)?(.+))?$/s,
  );

  const match = verbMatch || bareMatch;
  if (!match) return null;

  let rest = (match[1] ?? "").trim();
  rest = rest.replace(/^(?:on|for)\s+(?:the\s+)?/i, "");
  const jobMatch = rest.match(/(?:^|\s)(?:job\s*[:=]?\s*)?([a-z][a-z0-9_-]*)/i);
  const jobName = jobMatch?.[1] || "akari-work-cycle";

  const sessionsMatch = rest.match(/(?:sessions?\s*[:=]?\s*)(\d+)/i);
  const costMatch = rest.match(/(?:cost\s*[:=]?\s*\$?)(\d+(?:\.\d+)?)/i);

  return {
    job: jobName,
    maxSessions: sessionsMatch ? parseInt(sessionsMatch[1], 10) : 10,
    maxCost: costMatch ? parseFloat(costMatch[1]) : 20,
    autofix: !rest.includes("no autofix"),
  };
}

/** Detect fleet control requests like "activate fleet", "enable fleet workers", "fleet status".
 *  Returns { op, size } if matched, null otherwise. */
export function detectFleetRequest(message: string): { op: "enable" | "disable" | "status" | "resize"; size?: number } | null {
  const lower = message.toLowerCase().trim();

  // Status queries
  if (/^(?:fleet\s+status|show\s+fleet|fleet\s+info|how\s+(?:is|are)\s+(?:the\s+)?fleet)/.test(lower)) {
    return { op: "status" };
  }

  // Disable patterns
  if (/^(?:(?:stop|disable|deactivate|kill|turn\s+off|shut\s*down)\s+(?:the\s+)?fleet|fleet\s+(?:off|stop|disable))/.test(lower)) {
    return { op: "disable" };
  }

  // Enable/activate patterns (must come after disable to avoid "stop fleet" matching)
  const enableMatch = lower.match(
    /^(?:(?:activate|enable|start|launch|dispatch|turn\s+on)\s+(?:the\s+)?(?:fleet|glm\s*[-\s]?5?\s*(?:fleet|workers|agents))|(?:fleet|glm\s*[-\s]?5?\s*(?:workers|agents))\s+(?:on|start|enable|activate))(?:\s+.*)?/,
  );
  if (enableMatch) {
    const sizeMatch = lower.match(/(?:size|n|count|workers?)\s*[:=]?\s*(\d+)/);
    return { op: "enable", size: sizeMatch ? parseInt(sizeMatch[1], 10) : undefined };
  }

  // Resize patterns (includes natural-language synonyms like "reduce fleet to 2")
  const resizeMatch = lower.match(
    /^(?:(?:resize|scale|set|reduce|decrease|lower|shrink|change|adjust|limit|cap)\s+(?:the\s+)?fleet\s+(?:size\s+)?(?:to\s+)?(\d+)|fleet\s+(?:size|workers?)\s*[:=]?\s*(\d+))/,
  );
  if (resizeMatch) {
    const size = parseInt(resizeMatch[1] ?? resizeMatch[2], 10);
    return { op: "resize", size };
  }

  return null;
}

/** Detect explicit deep work requests like "enter deep work and review this conclusion".
 *  Returns the task description if matched, null otherwise.
 *  Patterns: "enter deep work [task]", "start deep work [task]", "deep work: [task]",
 *  "launch deep work [task]", "do deep work [task]". */
export function detectDeepWorkRequest(message: string): string | null {
  const lower = message.toLowerCase().trim();
  // Match "enter/start/launch/do deep work" or "deep work:" at the start
  const prefixMatch = lower.match(/^(?:(?:enter|start|launch|do|begin|run)\s+)?deep\s*work[:\s]+(.+)/s);
  if (prefixMatch) {
    const task = prefixMatch[1].replace(/^(?:and|to|for)\s+/i, "").trim();
    return task || message;
  }
  // Match "enter/start deep work" without task (use full message as context)
  if (/^(?:enter|start|launch|begin|run)\s+deep\s*work\.?$/i.test(lower)) {
    return message;
  }
  return null;
}

/** Detect "continue" / "go on" messages that should auto-escalate to deep work
 *  after a previous chat session timed out. Returns true if the message is a
 *  continuation request (short, imperative, no new question content). */
export function detectContinueRequest(message: string): boolean {
  const lower = message.toLowerCase().trim().replace(/[.!?]+$/, "");
  const continuePatterns = [
    "continue",
    "go on",
    "keep going",
    "carry on",
    "please continue",
    "pls continue",
    "finish",
    "finish it",
    "yes continue",
    "yes go on",
    "more",
    "tell me more",
    "and",
    "go ahead",
  ];
  return continuePatterns.includes(lower);
}

const POSITIVE_CONFIRMATIONS = ["yes", "y", "confirm", "approve", "do it", "go ahead", "proceed", "sure", "ok", "okay"];
const NEGATIVE_CONFIRMATIONS = ["no", "n", "cancel"];

/** Detect confirmation response. Returns "positive" for confirmations,
 *  "negative" for cancellations, or null if neither. */
export function detectConfirmation(message: string): "positive" | "negative" | null {
  const lower = message.toLowerCase().trim();
  if (POSITIVE_CONFIRMATIONS.includes(lower)) return "positive";
  if (NEGATIVE_CONFIRMATIONS.includes(lower)) return "negative";
  return null;
}

/** Map action name to intent type. */
function inferIntentType(action: string): "status" | "approval" | "experiment" | "session" | "job" | "other" {
  if (action === "approve" || action === "deny") return "approval";
  if (action === "stop_session" || action === "ask_session" || action === "watch_session") return "session";
  if (action === "launch_experiment" || action === "stop_experiment") return "experiment";
  if (action === "run_job") return "job";
  return "other";
}

interface InteractionExtras {
  turnsBeforeAction?: number;
  userCorrected?: boolean;
  intentFulfilled?: "fulfilled" | "partial" | "failed" | "abandoned";
  intentType?: "status" | "approval" | "experiment" | "session" | "job" | "other";
  evidenceGraded?: boolean;
  isChatMode?: boolean;
}

/** Helper to log an interaction record. Fire-and-forget. */
function logInteraction(
  action: string,
  args: Record<string, unknown>,
  threadKey: string,
  result: "ok" | "error",
  detail?: string,
  extras?: InteractionExtras,
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
    console.error(`[chat] Failed to log interaction: ${err}`);
  });
}

// ── Main entry ───────────────────────────────────────────────────────────────

/** Process a natural language message.
 *  Returns { text } for synchronous responses (confirmations).
 *  Returns { sessionId } for async agent queries — results arrive via callbacks.
 *  Acquires per-conversation lock to prevent interleaved async operations. */
export interface ProcessMessageOpts {
  /** Full Slack thread history (all messages including bot-posted progress, notifications, etc.).
   *  Provided by the Slack layer when the user replies in an existing thread. */
  threadMessages?: string;
  /** Channel interaction mode. "dev" = full access (default), "chat" = read-only Q&A. */
  channelMode?: ChannelMode;
  /** Display name of the message sender (for multi-user channels). */
  senderName?: string;
  /** Team associated with this channel for audience-adaptive communication. */
  team?: "art" | "product" | "engineering" | "research";
  /** Fleet scheduler instance for fleet_control actions. */
  fleetScheduler?: FleetScheduler;
}

export async function processMessage(
  message: string,
  channelId: string,
  repoDir: string,
  store: JobStore,
  callbacks: ChatCallbacks,
  opts?: ProcessMessageOpts,
): Promise<{ text: string } | { sessionId: string } | null> {
  const release = await conversationLock.acquire(channelId);
  try {
    return await processMessageInner(message, channelId, repoDir, store, callbacks, opts);
  } finally {
    release();
  }
}

async function processMessageInner(
  message: string,
  channelId: string,
  repoDir: string,
  store: JobStore,
  callbacks: ChatCallbacks,
  opts?: ProcessMessageOpts,
): Promise<{ text: string } | { sessionId: string } | null> {
  chatStoreRef = store;
  chatFleetSchedulerRef = opts?.fleetScheduler ?? null;
  const mode = opts?.channelMode ?? "dev";
  console.log(`[chat] Message received (${mode}): ${channelId} — "${message.slice(0, 120)}"`);
  const conv = getConversation(channelId);

  // If there's already an agent running for this conversation, interrupt it
  if (conv.activeSessionId) {
    const existing = getSession(conv.activeSessionId);
    if (existing) {
      console.log(`[chat] Interrupting previous session ${conv.activeSessionId} for new message`);
      try { await existing.handle.interrupt(); } catch {}
      unregisterSession(conv.activeSessionId);
    }
    conv.activeSessionId = null;
  }

  // Handle pending confirmation (synchronous — no agent needed)
  if (conv.pendingAction) {
    const confirmation = detectConfirmation(message);
    if (confirmation === "positive") {
      return handleConfirmation(conv, repoDir, true, channelId, callbacks, opts?.fleetScheduler);
    }
    if (confirmation === "negative") {
      return handleConfirmation(conv, repoDir, false, channelId, callbacks, opts?.fleetScheduler);
    }
    // Not a confirmation — suspend the action while we answer the clarifying question.
    // The action will be restored and re-prompted after the chat agent responds.
    conv.suspendedAction = conv.pendingAction;
    conv.pendingAction = null;
    savePendingActions();
    console.log(`[chat] Suspended pendingAction (${conv.suspendedAction.kind}) for clarifying question: "${message.slice(0, 80)}"`);
  }

  // Forward to active deep work session if one exists for this thread (dev mode only)
  if (mode === "dev") {
    const activeSession = findSessionByWatcher(channelId);
    if (activeSession?.handle.streamInput && activeSession.handle.backend === "claude") {
      addMessage(conv, "user", message);
      const framedContent = `[HUMAN SUPERVISOR MESSAGE]\n${message}\n\nPlease consider this and continue your work.`;
      try {
        await activeSession.handle.streamInput(
          (async function* () {
            yield {
              type: "user" as const,
              message: { role: "user" as const, content: framedContent },
              parent_tool_use_id: null,
              session_id: activeSession.sessionId ?? "",
            };
          })(),
        );
        const ack = `:mega: Message forwarded to active session \`${activeSession.id}\`.`;
        addMessage(conv, "assistant", ack);
        return { text: ack };
      } catch (err) {
        console.error(`[chat] streamInput failed: ${err}`);
        // Fall through to normal processing
      }
    }
  }

  // Gather context and enumerate skills
  const [context, skills] = await Promise.all([
    gatherChatContext(repoDir, store, message),
    mode === "dev" ? listSkills(repoDir) : Promise.resolve([] as SkillInfo[]),
  ]);

  // Handle pending question from a previous deep work session that ended with await_response
  if (mode === "dev" && conv.pendingQuestion) {
    const questionContext = conv.pendingQuestion;
    conv.pendingQuestion = null; // Clear before spawning to prevent loops
    addMessage(conv, "user", message);

    const ack = `:speech_balloon: Continuing with your response…`;
    addMessage(conv, "assistant", ack);
    await callbacks.onProgress(ack);

    const task = `The previous session ended waiting for human input with context: "${questionContext}".

The human has now responded with: "${message}"

Continue the work from where it left off. Use the thread context to understand what was being done before.`;

    const deepSessionId = await spawnDeepWork(task, repoDir, {
      onProgress: callbacks.onProgress,
      onComplete: wrapOnCompleteForAwaitResponse(callbacks.onComplete, conv),
    }, channelId, opts?.threadMessages);

    await logInteraction("deep_work_continuation", { context: questionContext.slice(0, 100), answer: message.slice(0, 100) }, channelId, "ok", undefined, {
      turnsBeforeAction: countUserTurns(conv),
      userCorrected: false,
      intentType: "other",
    });

    return { sessionId: deepSessionId };
  }

  // Dev-mode-only code-level detections (burst, deep work, skills)
  if (mode === "dev") {
    // Code-level burst detection: if the user explicitly asks for "burst mode",
    // bypass the chat agent and set up the burst action directly.
    const burstMatch = detectBurstRequest(message);
    if (burstMatch) {
      addMessage(conv, "user", message);
      conv.pendingAction = {
        kind: "run_burst",
        jobId: burstMatch.job,
        maxSessions: burstMatch.maxSessions,
        maxCost: burstMatch.maxCost,
        autofix: burstMatch.autofix,
      };
      savePendingActions();
      const text =
        `:zap: *Burst mode detected!*\n` +
        `Job: *${burstMatch.job}*, Sessions: ${burstMatch.maxSessions}, Cost cap: $${burstMatch.maxCost}${burstMatch.autofix ? ", Autofix: on" : ""}\n` +
        `:point_right: _Reply *yes* to create the burst request, or *no* to cancel._`;
      addMessage(conv, "assistant", text);
      return { text };
    }

    // Code-level fleet detection: if the user asks about fleet workers,
    // bypass the chat agent to prevent misrouting to burst mode.
    const fleetMatch = detectFleetRequest(message);
    if (fleetMatch) {
      addMessage(conv, "user", message);
      if (fleetMatch.op === "status") {
        // Status is immediate — no confirmation needed
        const fleet = opts?.fleetScheduler;
        const statusText = fleet
          ? `:ship: *Fleet status:* ${fleet.isEnabled() ? "enabled" : "disabled"}, ` +
            `${fleet.getActiveWorkers().length} active worker(s), ` +
            `config: maxWorkers=${fleet.getStatusSnapshot().maxWorkers}`
          : `:ship: *Fleet status:* not available (fleet scheduler not initialized)`;
        addMessage(conv, "assistant", statusText);
        return { text: statusText };
      }
      // Enable/disable/resize require confirmation
      const defaultSize = fleetMatch.size ?? 2;
      conv.pendingAction = {
        kind: "fleet_control",
        fleetOp: fleetMatch.op,
        fleetSize: fleetMatch.op === "disable" ? 0 : defaultSize,
      };
      savePendingActions();
      const opDesc = fleetMatch.op === "enable"
        ? `Enable fleet workers (size=${defaultSize}, Fast Model on opencode)`
        : fleetMatch.op === "disable"
          ? `Disable fleet workers (running workers will finish)`
          : `Resize fleet to ${defaultSize} workers`;
      const text =
        `:ship: *Fleet control detected!*\n` +
        `${opDesc}\n` +
        `:point_right: _Reply *yes* to confirm, or *no* to cancel._`;
      addMessage(conv, "assistant", text);
      return { text };
    }

    // Code-level deep work detection
    const deepWorkMatch = detectDeepWorkRequest(message);
    if (deepWorkMatch) {
      addMessage(conv, "user", message);
      const ack = `:rocket: Starting deep work session…`;
      addMessage(conv, "assistant", ack);
      await callbacks.onProgress(ack);

      const deepSessionId = await spawnDeepWork(deepWorkMatch, repoDir, {
        onProgress: callbacks.onProgress,
        onComplete: wrapOnCompleteForAwaitResponse(callbacks.onComplete, conv),
      }, channelId, opts?.threadMessages);

      await logInteraction("deep_work", { task: deepWorkMatch.slice(0, 200) }, channelId, "ok", undefined, {
        turnsBeforeAction: countUserTurns(conv),
        userCorrected: false,
        intentType: "other",
      });

      return { sessionId: deepSessionId };
    }

    // Auto-escalate "continue" after a timed-out chat session
    if (conv.lastTimedOut && detectContinueRequest(message)) {
      const originalQuestion = conv.lastTimedOutMessage ?? "the user's previous question";
      const task = `The user asked: "${originalQuestion}" — the chat agent timed out before completing an answer. Please provide a thorough answer.`;
      addMessage(conv, "user", message);
      conv.lastTimedOut = false;
      conv.lastTimedOutMessage = null;

      const ack = `:hourglass_flowing_sand: Previous response timed out — escalating to deep work for a thorough answer…`;
      addMessage(conv, "assistant", ack);
      await callbacks.onProgress(ack);

      const deepSessionId = await spawnDeepWork(task, repoDir, {
        onProgress: callbacks.onProgress,
        onComplete: wrapOnCompleteForAwaitResponse(callbacks.onComplete, conv),
      }, channelId, opts?.threadMessages);

      await logInteraction("deep_work", { task: task.slice(0, 200) }, channelId, "ok", undefined, {
        turnsBeforeAction: countUserTurns(conv),
        userCorrected: false,
        intentType: "other",
      });

      return { sessionId: deepSessionId };
    }

    // Code-level skill detection
    const skillMatch = detectSkillInvocation(message, skills);
    if (skillMatch) {
      const matchedSkill = skills.find(s => s.name === skillMatch.skillName);

      // Gate skills that exceed backend capability
      const preference = await getBackendPreference();
      const backendName = getEffectiveBackendName(preference ?? undefined);
      const gateResult = canRunSkill(matchedSkill!, backendName);
      if (!gateResult.canRun) {
        addMessage(conv, "user", message);
        const rejection = `:warning: ${gateResult.reason}. Available skills: ${skills.filter(s => canRunSkill(s, backendName).canRun).map(s => "/" + s.name).join(", ")}`;
        addMessage(conv, "assistant", rejection);
        await callbacks.onProgress(rejection);
        return { text: rejection };
      }

      // Interview skills: set interview state and fall through to chat path
      if (matchedSkill?.interview && matchedSkill.interviewPrompt) {
        addMessage(conv, "user", message);
        conv.activeInterview = {
          skillName: skillMatch.skillName,
          args: skillMatch.taskDescription,
          interviewPrompt: matchedSkill.interviewPrompt,
        };
        // Fall through to normal chat path — buildChatPrompt will inject interview instructions
      } else if (isFleetEligibleSkill(matchedSkill!)) {
        // Fleet-eligible skill: fall through to chat agent for routing decision.
        // The chat agent will choose between create_task ($0 fleet) and deep_work ($3 Opus)
        // based on the request complexity. See ADR 0046.
        addMessage(conv, "user", message);
        // Fall through — chat agent handles routing via action tags
      } else {
        // Non-interview, non-fleet skill: direct deep work escalation
        addMessage(conv, "user", message);
        const ack = `:zap: Routing to deep work: \`/${skillMatch.skillName}\``;
        addMessage(conv, "assistant", ack);
        await callbacks.onProgress(ack);

        const deepSessionId = await spawnDeepWork(skillMatch.taskDescription, repoDir, {
          onProgress: callbacks.onProgress,
          onComplete: wrapOnCompleteForAwaitResponse(callbacks.onComplete, conv),
        }, channelId, opts?.threadMessages);

        await logInteraction("deep_work", { task: skillMatch.taskDescription.slice(0, 200) }, channelId, "ok", undefined, {
          turnsBeforeAction: countUserTurns(conv),
          userCorrected: false,
          intentType: "other",
        });

        return { sessionId: deepSessionId };
      }
    }
  }

  // Clear timeout state when a new non-continue message arrives
  conv.lastTimedOut = false;
  conv.lastTimedOutMessage = null;

  addMessage(conv, "user", message);

  // Build prompt based on channel mode
  const historyForPrompt = conv.messages.slice(0, -1); // exclude current message
  const interviewContext = conv.activeInterview ?? undefined;
  const prompt = mode === "chat"
    ? buildChatModePrompt(context, historyForPrompt, message, opts?.senderName, opts?.threadMessages, opts?.team)
    : buildChatPrompt(context, historyForPrompt, message, opts?.threadMessages, skills, opts?.senderName, opts?.team, interviewContext);

  // Fire-and-forget: spawn agent async, return sessionId
  const sessionId = spawnChatAsync(prompt, repoDir, conv, channelId, callbacks, opts?.threadMessages, mode, opts?.fleetScheduler);
  if (!sessionId) return null;
  return { sessionId };
}

async function handleConfirmation(
  conv: ConversationState,
  repoDir: string,
  confirmed: boolean,
  convKey?: string,
  callbacks?: ChatCallbacks,
  fleetScheduler?: FleetScheduler,
): Promise<{ text: string } | { sessionId: string }> {
  const action = conv.pendingAction!;
  conv.pendingAction = null;
  conv.suspendedAction = null; // Clear any suspended action on confirmation
  savePendingActions();
  const threadKey = convKey ?? "unknown";

  if (!confirmed) {
    const text = ":x: Cancelled.";
    addMessage(conv, "user", "no");
    addMessage(conv, "assistant", text);
    return { text };
  }

  // ── Approve/Deny confirmation ──
  if (action.kind === "approve" || action.kind === "deny") {
    const approvals = await getPendingApprovals(repoDir);
    if (action.itemIndex === undefined || action.itemIndex >= approvals.length) {
      const text = ":warning: Approval list changed since confirmation was requested. Please try again.";
      addMessage(conv, "user", "yes");
      addMessage(conv, "assistant", text);
      return { text };
    }

    const item = approvals[action.itemIndex];
    const decision = action.kind === "approve" ? "approved" : "denied";
    await resolveApproval(repoDir, item, decision, action.notes);

    const emoji = action.kind === "approve" ? ":white_check_mark:" : ":no_entry_sign:";
    const remaining = approvals.length - 1;
    const text = `${emoji} ${decision.charAt(0).toUpperCase() + decision.slice(1)}: *${item.title}*${action.notes ? `\nNotes: ${action.notes}` : ""}\n${remaining} item(s) remaining.`;
    addMessage(conv, "user", "yes");
    addMessage(conv, "assistant", text);

    const approvalExtras: InteractionExtras = {
      turnsBeforeAction: countUserTurns(conv),
      userCorrected: detectCorrection(conv),
      intentType: "approval",
      intentFulfilled: "fulfilled",
    };
    await logInteraction(action.kind, { item: (action.itemIndex ?? 0) + 1, notes: action.notes }, threadKey, "ok", item.title, approvalExtras);
    return { text };
  }

  // ── Launch experiment confirmation ──
  if (action.kind === "launch_experiment") {
    const { project, expId, command } = action;
    if (!project || !expId || !command) {
      const text = ":warning: Missing experiment parameters.";
      addMessage(conv, "user", "yes");
      addMessage(conv, "assistant", text);
      return { text };
    }

    const commandParts = command.split(/\s+/);
    try {
      validateCommand(commandParts, { allowShells: true });
    } catch (err) {
      if (err instanceof SecurityError) {
        const text = `:lock: ${err.message}`;
        addMessage(conv, "user", "yes");
        addMessage(conv, "assistant", text);
        return { text };
      }
      throw err;
    }

    const launchExtras: InteractionExtras = {
      turnsBeforeAction: countUserTurns(conv),
      userCorrected: detectCorrection(conv),
      intentType: "experiment",
    };

    const dir = `${repoDir}/projects/${project}/experiments/${expId}`;
    const projectDir = join(repoDir, "projects", project);

    // Discover watchCsv/total from previous progress.json if available
    let watchCsv: string | undefined;
    let total: number | undefined;
    try {
      const prevProgress = JSON.parse(await readFile(join(dir, "progress.json"), "utf-8"));
      if (prevProgress.watch_csv) watchCsv = prevProgress.watch_csv;
      if (prevProgress.total) total = prevProgress.total;
    } catch {
      // No previous progress.json — watchCsv/total stay undefined
    }

    try {
      const { pid } = await launchExperiment({
        experimentDir: dir,
        command: commandParts,
        projectDir,
        maxRetries: 3,
        watchCsv,
        total,
      });
      trackExperiment(dir, project, expId);
      const text = `:rocket: Launched *${project}/${expId}* (PID ${pid})\nCommand: \`${command}\``;
      addMessage(conv, "user", "yes");
      addMessage(conv, "assistant", text);
      await logInteraction("launch_experiment", { project, id: expId, command }, threadKey, "ok", `PID ${pid}`, { ...launchExtras, intentFulfilled: "fulfilled" });
      return { text };
    } catch (err) {
      const text = `:x: Failed to launch: ${err instanceof Error ? err.message : String(err)}`;
      addMessage(conv, "user", "yes");
      addMessage(conv, "assistant", text);
      await logInteraction("launch_experiment", { project, id: expId, command }, threadKey, "error", String(err), { ...launchExtras, intentFulfilled: "failed" });
      return { text };
    }
  }

  // ── Run burst confirmation ──
  if (action.kind === "run_burst") {
    if (!action.jobId) {
      const text = ":warning: Missing job name for burst.";
      addMessage(conv, "user", "yes");
      addMessage(conv, "assistant", text);
      return { text };
    }

    const today = new Date().toISOString().slice(0, 10);
    const maxSessions = action.maxSessions ?? 10;
    const maxCost = action.maxCost ?? 20;
    const autofix = action.autofix ?? true;

    const burstEntry = [
      `### ${today} — Burst mode: ${action.jobId}`,
      `Project: akari`,
      `Type: burst`,
      `Request: Run a burst of autonomous sessions on the ${action.jobId} job.`,
      `Context: User requested burst mode via Slack chat.`,
      `Job: ${action.jobId}`,
      `Max-sessions: ${maxSessions}`,
      `Max-cost: ${maxCost}`,
      `Autofix: ${autofix}`,
      ``,
    ].join("\n");

    try {
      const queuePath = join(repoDir, "APPROVAL_QUEUE.md");
      const queueContent = await readFile(queuePath, "utf-8");
      const withEntry = queueContent.replace(
        "## Pending\n",
        `## Pending\n\n${burstEntry}`,
      );
      const updatedContent = withEntry.replace(/\n\*No pending items\.\*\n?/, "\n");
      await writeFile(queuePath, updatedContent, "utf-8");

      const text = `:rocket: Burst request created for *${action.jobId}*!\n` +
        `Sessions: ${maxSessions}, Cost cap: $${maxCost}${autofix ? ", Autofix: on" : ""}\n` +
        `_Approve it to launch the burst automatically._`;
      addMessage(conv, "user", "yes");
      addMessage(conv, "assistant", text);

      await logInteraction("run_burst", {
        job: action.jobId,
        maxSessions,
        maxCost,
        autofix,
      }, threadKey, "ok", undefined, {
        turnsBeforeAction: countUserTurns(conv),
        userCorrected: detectCorrection(conv),
        intentType: "job",
        intentFulfilled: "fulfilled",
      });
      return { text };
    } catch (err) {
      const text = `:x: Failed to create burst request: ${err instanceof Error ? err.message : String(err)}`;
      addMessage(conv, "user", "yes");
      addMessage(conv, "assistant", text);
      await logInteraction("run_burst", { job: action.jobId }, threadKey, "error", String(err), {
        turnsBeforeAction: countUserTurns(conv),
        userCorrected: detectCorrection(conv),
        intentType: "job",
        intentFulfilled: "failed",
      });
      return { text };
    }
  }

  // ── Fleet control confirmation ──
  if (action.kind === "fleet_control") {
    if (!fleetScheduler) {
      const text = ":warning: Fleet scheduler is not available.";
      addMessage(conv, "user", "yes");
      addMessage(conv, "assistant", text);
      return { text };
    }

    const op = action.fleetOp ?? "enable";
    const size = action.fleetSize ?? 2;

    if (op === "disable") {
      fleetScheduler.updateConfig({ maxWorkers: 0 });
      const text = `:ship: Fleet workers disabled. Running workers will complete their current tasks.`;
      addMessage(conv, "user", "yes");
      addMessage(conv, "assistant", text);
      await logInteraction("fleet_control", { op: "disable" }, threadKey, "ok", undefined, {
        turnsBeforeAction: countUserTurns(conv),
        userCorrected: false,
        intentType: "other",
        intentFulfilled: "fulfilled",
      });
      return { text };
    }

    // enable or resize
    fleetScheduler.updateConfig({ maxWorkers: size });
    const text = `:ship: Fleet ${op === "resize" ? "resized" : "enabled"}! maxWorkers=${size} (Fast Model on opencode)\n` +
      `Workers will pick up \`[fleet-eligible]\` tasks on the next refill cycle (~30s).`;
    addMessage(conv, "user", "yes");
    addMessage(conv, "assistant", text);
    await logInteraction("fleet_control", { op, size }, threadKey, "ok", undefined, {
      turnsBeforeAction: countUserTurns(conv),
      userCorrected: false,
      intentType: "other",
      intentFulfilled: "fulfilled",
    });
    return { text };
  }

  // ── Run job confirmation ──
  if (action.kind === "run_job") {
    if (!action.jobId || !chatStoreRef) {
      const text = ":warning: Missing job reference.";
      addMessage(conv, "user", "yes");
      addMessage(conv, "assistant", text);
      return { text };
    }

    await chatStoreRef.load();
    const job = chatStoreRef.get(action.jobId);
    if (!job) {
      const text = `:warning: Job \`${action.jobId}\` no longer exists.`;
      addMessage(conv, "user", "yes");
      addMessage(conv, "assistant", text);
      return { text };
    }

    // Check if already running
    const activeSessions = listSessions();
    const running = activeSessions.find((s) => s.jobId === job.id);
    if (running) {
      const elapsed = Math.round(running.elapsedMs / 1000);
      const text = `:warning: Job *${job.name}* already has a running session (\`${running.id}\`, ${elapsed}s elapsed). Cancel and try again later.`;
      addMessage(conv, "user", "yes");
      addMessage(conv, "assistant", text);
      return { text };
    }

    const text = `:rocket: Starting job *${job.name}* — session notifications will follow.`;
    addMessage(conv, "user", "yes");
    addMessage(conv, "assistant", text);

    // Fire-and-forget: run in background, update state when done
    const store = chatStoreRef;
    const jobId = job.id;
    const jobName = job.name;
    const runCount = job.state.runCount;
    executeJob(job, "slack").then(async (result) => {
      await store.load();
      await store.updateState(jobId, {
        lastRunAtMs: Date.now(),
        lastStatus: result.ok ? "ok" : "error",
        lastError: result.error ?? null,
        lastDurationMs: result.durationMs,
        runCount: runCount + 1,
      });
      console.log(`[chat] Job ${jobName} completed: ${result.ok ? "ok" : "error"} (${Math.round(result.durationMs / 1000)}s)`);
    }).catch((err) => {
      console.error(`[chat] Run job error for ${jobName}:`, err);
    });

    await logInteraction("run_job", { id: jobId, name: jobName }, threadKey, "ok", undefined, {
      turnsBeforeAction: countUserTurns(conv),
      userCorrected: detectCorrection(conv),
      intentType: "job",
      intentFulfilled: "fulfilled",
    });
    return { text };
  }

  // Fallback (should not reach here)
  const text = ":warning: Unknown action type.";
  addMessage(conv, "user", "yes");
  addMessage(conv, "assistant", text);
  return { text };
}
