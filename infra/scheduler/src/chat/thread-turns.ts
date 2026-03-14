/** Per-channel max-turns limits and per-thread bot reply counting.
 *  Limits are set via `/akari max-turns N` and stored in-memory. */

const maxTurnsPerChannel = new Map<string, number>();

const botReplyCount = new Map<string, number>();

/** Set the max-turns limit for a channel. All threads in the channel share this limit. */
export function setMaxTurns(channelId: string, limit: number): void {
  if (limit <= 0) {
    maxTurnsPerChannel.delete(channelId);
    return;
  }
  maxTurnsPerChannel.set(channelId, limit);
}

/** Get the max-turns limit for a channel, or null if no limit is set. */
export function getMaxTurns(channelId: string): number | null {
  return maxTurnsPerChannel.get(channelId) ?? null;
}

/** Remove the max-turns limit for a channel. Returns true if a limit existed. */
export function removeMaxTurns(channelId: string): boolean {
  return maxTurnsPerChannel.delete(channelId);
}

/** Increment the bot reply count for a thread. Returns the new count. */
export function incrementBotReply(convKey: string): number {
  const current = botReplyCount.get(convKey) ?? 0;
  const next = current + 1;
  botReplyCount.set(convKey, next);
  return next;
}

/** Get the current bot reply count for a thread. */
export function getBotReplyCount(convKey: string): number {
  return botReplyCount.get(convKey) ?? 0;
}

/** Check whether a thread has reached its channel's turn limit.
 *  channelId is the bare channel ID; convKey is `channel:threadTs`. */
export function isThreadAtLimit(channelId: string, convKey: string): boolean {
  const limit = maxTurnsPerChannel.get(channelId);
  if (limit === undefined) return false;
  const count = botReplyCount.get(convKey) ?? 0;
  return count >= limit;
}

/** Build the limit-reached message for a thread.
 *  Returns null if no limit is configured. */
export function getThreadLimitMessage(channelId: string): string | null {
  const limit = maxTurnsPerChannel.get(channelId);
  if (limit === undefined) return null;
  return `Reached the ${limit}-turn limit for this thread.`;
}

/** Reset all state — for testing only. */
export function clearAllThreadTurns(): void {
  maxTurnsPerChannel.clear();
  botReplyCount.clear();
}
