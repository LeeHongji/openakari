/** Tests for orient/compound tier decision logic. */

import { describe, it, expect } from "vitest";
import { decideTiers, injectTierDirectives, wasFullOrient } from "./orient-tier.js";

describe("decideTiers", () => {
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const THREE_HOURS = 3 * 60 * 60 * 1000;
  const now = Date.now();

  it("returns full orient and full compound when no prior timestamps", () => {
    const result = decideTiers({ lastFullOrientAt: null, lastFullCompoundAt: null, nowMs: now });
    expect(result.orientTier).toBe("full");
    expect(result.compoundTier).toBe("full");
  });

  it("returns fast orient when last full orient was < 2h ago", () => {
    const result = decideTiers({
      lastFullOrientAt: now - 30 * 60 * 1000, // 30 min ago
      lastFullCompoundAt: null,
      nowMs: now,
    });
    expect(result.orientTier).toBe("fast");
    expect(result.compoundTier).toBe("full");
  });

  it("returns full orient when last full orient was >= 2h ago", () => {
    const result = decideTiers({
      lastFullOrientAt: now - TWO_HOURS - 1,
      lastFullCompoundAt: null,
      nowMs: now,
    });
    expect(result.orientTier).toBe("full");
  });

  it("returns fast compound when last full compound was < 3h ago", () => {
    const result = decideTiers({
      lastFullOrientAt: null,
      lastFullCompoundAt: now - 60 * 60 * 1000, // 1h ago
      nowMs: now,
    });
    expect(result.compoundTier).toBe("fast");
    expect(result.orientTier).toBe("full");
  });

  it("returns full compound when last full compound was >= 3h ago", () => {
    const result = decideTiers({
      lastFullOrientAt: null,
      lastFullCompoundAt: now - THREE_HOURS - 1,
      nowMs: now,
    });
    expect(result.compoundTier).toBe("full");
  });

  it("returns both fast when both timestamps are recent", () => {
    const result = decideTiers({
      lastFullOrientAt: now - 60 * 60 * 1000,
      lastFullCompoundAt: now - 60 * 60 * 1000,
      nowMs: now,
    });
    expect(result.orientTier).toBe("fast");
    expect(result.compoundTier).toBe("fast");
  });

  it("uses boundary correctly — exactly 2h returns full orient", () => {
    const result = decideTiers({
      lastFullOrientAt: now - TWO_HOURS,
      lastFullCompoundAt: null,
      nowMs: now,
    });
    expect(result.orientTier).toBe("full");
  });

  it("uses boundary correctly — exactly 3h returns full compound", () => {
    const result = decideTiers({
      lastFullOrientAt: null,
      lastFullCompoundAt: now - THREE_HOURS,
      nowMs: now,
    });
    expect(result.compoundTier).toBe("full");
  });
});

describe("injectTierDirectives", () => {
  const basePrompt = "You are an autonomous research agent...";

  it("returns original prompt when both are full", () => {
    const result = injectTierDirectives(basePrompt, { orientTier: "full", compoundTier: "full" });
    expect(result).toBe(basePrompt);
  });

  it("prepends fast orient directive", () => {
    const result = injectTierDirectives(basePrompt, { orientTier: "fast", compoundTier: "full" });
    expect(result).toContain("/orient fast");
    expect(result).not.toContain("/compound fast");
    expect(result).toContain(basePrompt);
  });

  it("prepends fast compound directive", () => {
    const result = injectTierDirectives(basePrompt, { orientTier: "full", compoundTier: "fast" });
    expect(result).toContain("/compound fast");
    expect(result).not.toContain("/orient fast");
  });

  it("prepends both directives when both are fast", () => {
    const result = injectTierDirectives(basePrompt, { orientTier: "fast", compoundTier: "fast" });
    expect(result).toContain("/orient fast");
    expect(result).toContain("/compound fast");
    const promptIdx = result.indexOf(basePrompt);
    expect(promptIdx).toBeGreaterThan(0);
  });

  it("directives appear before the main prompt", () => {
    const result = injectTierDirectives(basePrompt, { orientTier: "fast", compoundTier: "fast" });
    const orientIdx = result.indexOf("SCHEDULER DIRECTIVE");
    const promptIdx = result.indexOf(basePrompt);
    expect(orientIdx).toBeLessThan(promptIdx);
  });
});

describe("wasFullOrient", () => {
  it("returns false for null/undefined", () => {
    expect(wasFullOrient(null)).toBe(false);
    expect(wasFullOrient(undefined)).toBe(false);
  });

  it("returns false for low turn count (fast orient)", () => {
    expect(wasFullOrient(3)).toBe(false);
    expect(wasFullOrient(10)).toBe(false);
    expect(wasFullOrient(15)).toBe(false);
    expect(wasFullOrient(16)).toBe(false);
    expect(wasFullOrient(25)).toBe(false);
  });

  it("returns true for high turn count (full orient)", () => {
    expect(wasFullOrient(26)).toBe(true);
    expect(wasFullOrient(35)).toBe(true);
    expect(wasFullOrient(88)).toBe(true);
  });
});
