/** Determines orient and compound tiering based on scheduler-tracked timestamps. */

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

/** Full orient produces 18-24 turns; fast orient produces 13-21 turns.
 *  Previous threshold of 15 misclassified 3/4 fast sessions as full.
 *  See diagnosis: projects/akari/diagnosis/orient-overhead-persistent.md (RC3). */
const FAST_ORIENT_TURNS_THRESHOLD = 25;

export interface TierSignals {
  lastFullOrientAt: number | null;
  lastFullCompoundAt: number | null;
  nowMs?: number;
}

export interface TierDecision {
  orientTier: "fast" | "full";
  compoundTier: "fast" | "full";
}

export function decideTiers(signals: TierSignals): TierDecision {
  const now = signals.nowMs ?? Date.now();

  const orientTier =
    signals.lastFullOrientAt !== null && now - signals.lastFullOrientAt < TWO_HOURS_MS
      ? "fast"
      : "full";

  const compoundTier =
    signals.lastFullCompoundAt !== null && now - signals.lastFullCompoundAt < THREE_HOURS_MS
      ? "fast"
      : "full";

  return { orientTier, compoundTier };
}

/**
 * Injects orient and compound tier directives into the session prompt.
 * Prepends tier instructions so the agent reads them before the main prompt.
 */
export function injectTierDirectives(prompt: string, decision: TierDecision): string {
  const directives: string[] = [];

  if (decision.orientTier === "fast") {
    directives.push(
      "SCHEDULER DIRECTIVE: A full /orient ran recently (<2h ago). Use `/orient fast` for this session.",
    );
  }

  if (decision.compoundTier === "fast") {
    directives.push(
      "SCHEDULER DIRECTIVE: A full /compound ran recently (<3h ago). Use `/compound fast` for this session.",
    );
  }

  if (directives.length === 0) return prompt;
  return directives.join("\n") + "\n\n" + prompt;
}

/**
 * Determines whether a session ran full orient based on orient turn count.
 * Fast orient produces ~2-10 turns; full orient produces 12+ turns.
 */
export function wasFullOrient(orientTurns: number | undefined | null): boolean {
  if (orientTurns == null) return false;
  return orientTurns > FAST_ORIENT_TURNS_THRESHOLD;
}
