/** Slack Bot for Akari scheduler — DM-focused Socket Mode implementation.
 *  Supports DM conversations with the designated user (mentor).
 *  Gracefully degrades to no-op when env vars are missing. */

import { App, LogLevel } from "@slack/bolt";
import type { Job } from "./types.js";
import type { ExecutionResult } from "./executor.js";
import {
  getPendingApprovals,
  buildSessionBlocks,
  buildApprovalBlocks,
  readAllBudgetStatuses,
  getSessionCommitSummary,
  type ApprovalItem,
} from "./notify.js";
import { EXCLUDED_PROJECTS } from "./constants.js";
import { processMessage, clearConversation, type ProcessMessageOpts } from "./chat/chat.js";
import type { JobStore } from "./store.js";
import { getSession, addWatcher } from "./session.js";
import { getDefaultBackend } from "./backend.js";
import type { FileUpload, UploadResult } from "./slack-files.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type AkariCommandInput = { text: string; userId: string; channelId: string };
export type AkariCommandResult = { ok: boolean; text: string; response?: string };

// ── Module state ─────────────────────────────────────────────────────────────

let app: App | null = null;
let userId: string | null = null;
let botUserId: string | null = null;
let repoDir: string | null = null;
let storeRef: JobStore | null = null;
let dmChannelId: string | null = null;

// ── Env helpers ──────────────────────────────────────────────────────────────

function getSlackEnv() {
  return {
    botToken: process.env["SLACK_BOT_TOKEN"],
    appToken: process.env["SLACK_APP_TOKEN"],
    userId: process.env["SLACK_USER_ID"],
  };
}

export function isConfigured(): boolean {
  const env = getSlackEnv();
  return !!(env.botToken && env.appToken && env.userId);
}

export function setBotUserId(id: string | null): void {
  botUserId = id;
}

// ── DM channel resolution ────────────────────────────────────────────────────

async function getDmChannel(): Promise<string | null> {
  if (dmChannelId) return dmChannelId;
  if (!app || !userId) return null;
  try {
    const result = await app.client.conversations.open({ users: userId });
    dmChannelId = result.channel?.id ?? null;
  } catch (err) {
    console.error(`[slack] Failed to open DM channel: ${err}`);
  }
  return dmChannelId;
}

// ── Display name resolution ──────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveDisplayNameFromUser(user: any): string | undefined {
  if (!user) return undefined;
  const displayName = user.profile?.display_name?.trim();
  if (displayName) return displayName;
  if (user.real_name) return user.real_name;
  return user.name || undefined;
}

export async function resolveDisplayName(uid: string): Promise<string> {
  if (!app) return uid;
  try {
    const info = await app.client.users.info({ user: uid });
    return resolveDisplayNameFromUser(info.user) ?? uid;
  } catch {
    return uid;
  }
}

/** Resolve display names for thread messages. Returns a Map<userId, displayName>. */
async function resolveThreadUserNames(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
): Promise<Map<string, string>> {
  const userIds = new Set<string>();
  for (const msg of messages) {
    if (!msg.bot_id && msg.user) {
      userIds.add(msg.user as string);
    }
  }

  const names = new Map<string, string>();
  const lookups = [...userIds].map(async (uid) => {
    try {
      const info = await client.users.info({ user: uid });
      const name = resolveDisplayNameFromUser(info.user);
      if (name) names.set(uid, name);
    } catch {
      // Non-critical
    }
  });
  await Promise.all(lookups);
  return names;
}

// ── Message posting ──────────────────────────────────────────────────────────

export async function dm(text: string): Promise<string | undefined> {
  const channel = await getDmChannel();
  if (!app || !channel) return undefined;
  try {
    const result = await app.client.chat.postMessage({ channel, text });
    return result.ts;
  } catch (err) {
    console.error(`[slack] DM failed: ${err}`);
    return undefined;
  }
}

export async function dmThread(threadTs: string, text: string): Promise<void> {
  const channel = await getDmChannel();
  if (!app || !channel) return;
  try {
    await app.client.chat.postMessage({ channel, text, thread_ts: threadTs });
  } catch (err) {
    console.error(`[slack] DM thread reply failed: ${err}`);
  }
}

export async function dmBlocks(blocks: unknown[], fallbackText: string): Promise<void> {
  const channel = await getDmChannel();
  if (!app || !channel) return;
  try {
    await app.client.chat.postMessage({
      channel,
      blocks: blocks as never[],
      text: fallbackText,
    });
  } catch (err) {
    console.error(`[slack] DM failed: ${err}`);
  }
}

export async function dmFiles(
  _files: FileUpload[],
  _initialComment?: string,
): Promise<UploadResult> {
  // File uploads not implemented in v1
  return { ok: false, count: 0, error: "File uploads not implemented" };
}

export async function dmThreadFiles(
  _threadTs: string,
  _files: FileUpload[],
  _initialComment?: string,
): Promise<UploadResult> {
  // File uploads not implemented in v1
  return { ok: false, count: 0, error: "File uploads not implemented" };
}

export async function channelFiles(
  _channel: string,
  _files: FileUpload[],
  _opts?: { threadTs?: string; initialComment?: string },
): Promise<UploadResult> {
  // File uploads not implemented in v1
  return { ok: false, count: 0, error: "File uploads not implemented" };
}

// ── Thread message formatting ────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function formatThreadMessages(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[],
  humanUserId?: string,
  userNames?: Map<string, string>,
): string {
  const lines: string[] = [];

  for (const msg of messages) {
    const text = (msg.text ?? "").trim();
    if (!text) continue;

    const ts = msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString().slice(11, 19) : "??:??";
    const isBot = !!msg.bot_id;
    const msgUser: string | undefined = msg.user;
    let sender: string;
    if (isBot) {
      sender = "Bot";
    } else if (msgUser && userNames?.has(msgUser)) {
      sender = userNames.get(msgUser)!;
    } else if (msgUser && msgUser === humanUserId) {
      sender = "User";
    } else {
      sender = "User";
    }

    const truncated = text.length > 1000 ? text.slice(0, 1000) + "..." : text;
    lines.push(`[${ts}] ${sender}: ${truncated}`);
  }

  return lines.join("\n");
}

// ── Startup / shutdown ───────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SayFn = (msg: any) => Promise<any>;

async function respondHelp(say: SayFn): Promise<void> {
  await say(
    `:bulb: *Akari scheduler*\n\n` +
    `Talk to me naturally — I can help with projects, experiments, approvals, sessions, and system status.\n\n` +
    `*Examples:*\n` +
    `"What's the status?" — system overview\n` +
    `"Show me pending approvals" — approval queue\n` +
    `"Approve item 1" — approve with confirmation\n` +
    `"Stop the running session" — interrupt a session\n` +
    `"开始深度工作：检查项目状态" — start deep work\n\n` +
    `\`clear\` — reset conversation history\n` +
    `\`help\` — this message`,
  );
}

export function startupMessage(opts: { totalJobs: number; enabledJobs: number; nextRun: string; backend: string }): string {
  return (
    `:rocket: *Akari scheduler started*\n` +
    `Backend: ${opts.backend}\n` +
    `Jobs: ${opts.totalJobs} total, ${opts.enabledJobs} enabled\n` +
    `Next run: ${opts.nextRun}`
  );
}

export function gracefulRestartMessage(runningSessions: number, backend?: string): string {
  const detail = runningSessions > 0
    ? `Draining ${runningSessions} running session(s) before exit.`
    : `No sessions running — restarting immediately.`;
  const backendLine = backend ? `\nBackend: ${backend}` : "";
  return `:arrows_counterclockwise: *Graceful restart requested*\n${detail}${backendLine}`;
}

export async function startSlackBot(opts: {
  repoDir: string;
  store: JobStore;
}): Promise<void> {
  const env = getSlackEnv();
  if (!env.botToken || !env.appToken || !env.userId) {
    console.log("[slack] Not configured (need SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_USER_ID). Skipping.");
    return;
  }

  userId = env.userId;
  repoDir = opts.repoDir;
  storeRef = opts.store;

  app = new App({
    token: env.botToken,
    appToken: env.appToken,
    socketMode: true,
    logLevel: LogLevel.WARN,
  });

  // Handle DM messages
  app.message(async ({ message, say, client }) => {
    if (message.subtype || !("text" in message)) return;
    const raw = message.text?.trim() ?? "";
    const text = raw.toLowerCase();
    const msgTs = (message as { ts: string }).ts;
    const msgChannel = (message as { channel: string }).channel;
    const msgUser = (message as { user?: string }).user;
    const channelType = (message as { channel_type?: string }).channel_type;

    // Only handle DMs from the designated user
    const isDm = channelType === "im";
    if (!isDm) return;
    if (!msgUser || msgUser !== userId) {
      console.log(`[slack] Ignoring DM from non-designated user: ${msgUser}`);
      return;
    }

    const threadTs = (message as { thread_ts?: string }).thread_ts ?? msgTs;
    const convKey = `${msgChannel}:${threadTs}`;

    // React with lightbulb to acknowledge receipt
    try {
      await client.reactions.add({ channel: msgChannel, timestamp: msgTs, name: "bulb" });
    } catch { /* missing reactions:write scope — non-critical */ }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reply: SayFn = (msg: any) => {
      if (typeof msg === "string") {
        if (msg.startsWith("__BLOCKS__")) {
          try {
            const blocks = JSON.parse(msg.slice("__BLOCKS__".length));
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return say({ blocks, text: "Report generated", thread_ts: threadTs } as any);
          } catch { /* fall through to plain text */ }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return say({ text: msg, thread_ts: threadTs } as any);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return say({ ...msg, thread_ts: threadTs } as any);
    };

    // Simple commands
    if (text === "help" || text === "h" || text === "?") {
      await respondHelp(reply);
      try { await client.reactions.remove({ channel: msgChannel, timestamp: msgTs, name: "bulb" }); } catch {}
      return;
    }

    if (text === "clear" || text === "reset") {
      clearConversation(convKey);
      await reply(":wastebasket: Conversation cleared.");
      try { await client.reactions.remove({ channel: msgChannel, timestamp: msgTs, name: "bulb" }); } catch {}
      return;
    }

    // Route through chat agent
    if (!repoDir || !storeRef) {
      await respondHelp(reply);
      try { await client.reactions.remove({ channel: msgChannel, timestamp: msgTs, name: "bulb" }); } catch {}
      return;
    }

    // Fetch thread history for existing threads
    const processOpts: ProcessMessageOpts = {
      channelMode: "dev",
    };
    if (threadTs !== msgTs) {
      try {
        const replies = await client.conversations.replies({
          channel: msgChannel,
          ts: threadTs,
          limit: 100,
        });
        if (replies.messages && replies.messages.length > 1) {
          const threadUserNames2 = await resolveThreadUserNames(replies.messages, client);
          processOpts.threadMessages = formatThreadMessages(replies.messages, userId ?? undefined, threadUserNames2);
        }
      } catch (err) {
        console.error(`[slack] Failed to fetch thread replies: ${err}`);
      }
    }

    // Post processing indicator
    let processingTs: string | undefined;
    try {
      const processingResult = await client.chat.postMessage({
        channel: msgChannel,
        thread_ts: threadTs,
        text: ":hourglass_flowing_sand: _Processing…_",
      });
      processingTs = processingResult.ts ?? undefined;
    } catch { /* non-critical */ }

    let processingCleared = false;
    const clearProcessingIndicator = async (replacementText?: string) => {
      if (processingCleared || !processingTs) return;
      processingCleared = true;
      try {
        if (replacementText) {
          await client.chat.update({ channel: msgChannel, ts: processingTs, text: replacementText });
        } else {
          await client.chat.delete({ channel: msgChannel, ts: processingTs });
        }
      } catch { /* graceful degradation */ }
      processingTs = undefined;
    };

    let thinkingTs: string | undefined;
    const removeBulb = async () => {
      try { await client.reactions.remove({ channel: msgChannel, timestamp: msgTs, name: "bulb" }); } catch {}
    };

    const syncResult = await processMessage(raw, convKey, repoDir, storeRef, {
      onProgress: async (progressText) => {
        // First output: replace the processing indicator
        if (!processingCleared && processingTs) {
          const replacedTs = processingTs;
          await clearProcessingIndicator(progressText);
          thinkingTs = replacedTs;
          return;
        }

        // Subsequent outputs: post as new message
        const posted = await reply(progressText);
        thinkingTs = (posted as { ts?: string })?.ts;
      },
      onComplete: async (completionText) => {
        await clearProcessingIndicator();
        if (completionText) {
          await reply(completionText);
        }
        await removeBulb();
      },
    }, processOpts);

    // Sync response (confirmations) — post immediately
    if (syncResult && "text" in syncResult) {
      await clearProcessingIndicator();
      await reply(syncResult.text);
      await removeBulb();
    }
  });

  await app.start();

  // Resolve bot's own user ID
  try {
    const auth = await app.client.auth.test();
    botUserId = (auth.user_id as string) ?? null;
    console.log(`[slack] Bot user ID: ${botUserId}`);
  } catch (err) {
    console.error(`[slack] Failed to resolve bot user ID: ${err}`);
  }

  console.log("[slack] Bot connected via Socket Mode");
}

export async function stopSlackBot(): Promise<void> {
  if (app) {
    try {
      await app.stop();
    } catch (err) {
      console.error(`[slack] Error stopping bot: ${err}`);
    }
    app = null;
  }
}

// ── Notifications ────────────────────────────────────────────────────────────

export async function notifyBotStarted(): Promise<void> {
  if (!storeRef) return;
  await storeRef.load();
  const jobs = storeRef.list();
  const enabled = jobs.filter((j) => j.enabled);
  const nextMs = storeRef.getNextWakeMs();
  const nextStr = nextMs ? new Date(nextMs).toISOString() : "none";

  await dm(startupMessage({
    totalJobs: jobs.length,
    enabledJobs: enabled.length,
    nextRun: nextStr,
    backend: getDefaultBackend(),
  }));
}

export async function notifySessionStarted(
  jobName: string,
  runId: string,
): Promise<{ channel: string; threadTs: string } | null> {
  const channel = await getDmChannel();
  if (!app || !channel) return null;
  try {
    const result = await app.client.chat.postMessage({
      channel,
      text: `:arrow_forward: *Session started:* ${jobName} (\`${runId}\`)`,
    });
    const ts = result.ts;
    if (!ts) return null;
    addWatcher(runId, `${channel}:${ts}`);
    return { channel, threadTs: ts };
  } catch (err) {
    console.error(`[slack] Session start DM failed: ${err}`);
    return null;
  }
}

export async function notifySessionComplete(
  job: Job,
  result: ExecutionResult,
  approvals: ApprovalItem[],
  threadTs?: string,
): Promise<void> {
  const dir = job.payload.cwd ?? process.cwd();
  const [allBudgets, commitSummary] = await Promise.all([
    readAllBudgetStatuses(dir, EXCLUDED_PROJECTS).catch(() => [] as { project: string; status: ReturnType<Awaited<ReturnType<typeof readAllBudgetStatuses>>[0]["status"] extends infer S ? () => S : never> }[]),
    result.ok ? getSessionCommitSummary(dir, result.durationMs) : null,
  ]);

  const alertBudget = (allBudgets as Awaited<ReturnType<typeof readAllBudgetStatuses>>).find(
    (b) => b.status.resources.some((r) => r.pct >= 90) ||
           (b.status.hoursToDeadline !== undefined && b.status.hoursToDeadline <= 24),
  ) ?? (allBudgets as Awaited<ReturnType<typeof readAllBudgetStatuses>>)[0] ?? null;
  const blocks = buildSessionBlocks(job, result, approvals, alertBudget?.status, alertBudget?.project, commitSummary);
  const fallback = `Akari session ${result.ok ? "completed" : "failed"}: ${job.name}`;

  if (threadTs) {
    const channel = await getDmChannel();
    if (!app || !channel) return;
    try {
      await app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        blocks: blocks as never[],
        text: fallback,
      });
    } catch (err) {
      console.error(`[slack] DM failed: ${err}`);
    }
  } else {
    await dmBlocks(blocks, fallback);
  }
}

export async function notifyPendingApprovals(dir: string): Promise<void> {
  const approvals = await getPendingApprovals(dir);
  if (approvals.length === 0) return;
  const blocks = buildApprovalBlocks(approvals);
  await dmBlocks(blocks, `${approvals.length} pending approval(s)`);
}

export async function notifyBudgetBlocked(jobName: string, reason: string): Promise<void> {
  await dm(`:no_entry: *Budget gate blocked session:* ${jobName}\n${reason}`);
}

export async function notifyEvolution(description: string): Promise<void> {
  await dm(`:dna: *Scheduler self-evolution applied:*\n${description}\nRestarting...`);
}

export async function notifyGracefulRestart(runningSessions: number): Promise<void> {
  await dm(gracefulRestartMessage(runningSessions, getDefaultBackend()));
}

// ── Slash command handler ────────────────────────────────────────────────────

export async function handleAkariCommand(input: AkariCommandInput): Promise<AkariCommandResult> {
  const args = input.text.trim().split(/\s+/);
  const subcommand = args[0]?.toLowerCase();

  if (!subcommand || subcommand === "help") {
    return {
      ok: true,
      text: `:bulb: */akari* commands:\n` +
        `• \`/akari status\` — current system status\n` +
        `• \`/akari help\` — this message`,
      response: "help",
    };
  }

  return { ok: false, text: `Unknown command: ${subcommand}. Try \`/akari help\`.`, response: "unknown" };
}

export async function handleBotChannelJoin(): Promise<void> {
  // Channel mode not implemented in v1 — no-op
}

// ── Fleet notifications (no-op stubs) ────────────────────────────────────────

export async function notifyFleetCompletion(): Promise<void> {}
export async function notifyFleetEscalation(): Promise<void> {}
export async function notifyFleetDrain(): Promise<void> {}
export async function notifyFleetStarvation(): Promise<void> {}
export async function notifyFleetLowUtilization(): Promise<void> {}
export async function notifyFleetStatus(): Promise<void> {}
