/** Tests for the scheduler self-evolution mechanism. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkPendingEvolution, applyEvolution, type PendingEvolution, hashContent, readEvolutionState, writeEvolutionState, type EvolutionState, MAX_ATTEMPTS, COOLDOWN_MS } from "./evolution.js";
import { writeFile, mkdir, rm, unlink, access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `evolution-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function validPending(overrides?: Partial<PendingEvolution>): PendingEvolution {
  return {
    timestamp: new Date().toISOString(),
    sessionId: "test-session-1",
    description: "Add logging to tick handler",
    filesChanged: ["infra/scheduler/src/cli.ts"],
    tscPassed: true,
    testsPassed: true,
    experimentId: "scheduler-evolution",
    ...overrides,
  };
}

async function writePending(dir: string, data: PendingEvolution) {
  await writeFile(join(dir, ".pending-evolution.json"), JSON.stringify(data, null, 2));
}

// ── checkPendingEvolution ──

describe("checkPendingEvolution", () => {
  it("returns shouldRestart: false when no pending file exists", async () => {
    const result = await checkPendingEvolution(testDir);
    expect(result).toEqual({ shouldRestart: false });
  });

  it("returns shouldRestart: true for a valid pending evolution", async () => {
    const pending = validPending();
    await writePending(testDir, pending);
    const result = await checkPendingEvolution(testDir);
    expect(result).toEqual({
      shouldRestart: true,
      description: pending.description,
    });
  });

  it("rejects files outside allowed paths", async () => {
    await writePending(testDir, validPending({
      filesChanged: ["infra/scheduler/src/cli.ts", "projects/akari/README.md"],
    }));
    const result = await checkPendingEvolution(testDir);
    expect(result.shouldRestart).toBe(false);
    expect(result.error).toMatch(/outside allowed paths/);
  });

  it("allows .claude/skills/ files", async () => {
    await writePending(testDir, validPending({
      filesChanged: [".claude/skills/orient/SKILL.md"],
    }));
    const result = await checkPendingEvolution(testDir);
    expect(result.shouldRestart).toBe(true);
  });

  it("allows mixed scheduler + skills files", async () => {
    await writePending(testDir, validPending({
      filesChanged: ["infra/scheduler/src/chat/chat.ts", ".claude/skills/develop/SKILL.md"],
    }));
    const result = await checkPendingEvolution(testDir);
    expect(result.shouldRestart).toBe(true);
  });

  it("rejects when tscPassed is false", async () => {
    await writePending(testDir, validPending({ tscPassed: false }));
    const result = await checkPendingEvolution(testDir);
    expect(result.shouldRestart).toBe(false);
    expect(result.error).toMatch(/tsc=false/);
  });

  it("rejects when testsPassed is false", async () => {
    await writePending(testDir, validPending({ testsPassed: false }));
    const result = await checkPendingEvolution(testDir);
    expect(result.shouldRestart).toBe(false);
    expect(result.error).toMatch(/tests=false/);
  });

  it("rejects when experimentId is empty", async () => {
    await writePending(testDir, validPending({ experimentId: "" }));
    const result = await checkPendingEvolution(testDir);
    expect(result.shouldRestart).toBe(false);
    expect(result.error).toMatch(/no experimentId/);
  });

  it("rejects when file is invalid JSON", async () => {
    await writeFile(join(testDir, ".pending-evolution.json"), "not json {{{");
    const result = await checkPendingEvolution(testDir);
    expect(result.shouldRestart).toBe(false);
    expect(result.error).toMatch(/Failed to parse/);
  });

  it("accepts multiple files all under infra/scheduler/src/", async () => {
    await writePending(testDir, validPending({
      filesChanged: [
        "infra/scheduler/src/evolution.ts",
        "infra/scheduler/src/cli.ts",
        "infra/scheduler/src/service.ts",
      ],
    }));
    const result = await checkPendingEvolution(testDir);
    expect(result.shouldRestart).toBe(true);
  });
});

// ── retry tracking ──

/** Write a pending file and return its content hash for state setup. */
async function writePendingAndGetHash(dir: string, overrides?: Partial<PendingEvolution>): Promise<string> {
  const pending = validPending(overrides);
  const content = JSON.stringify(pending, null, 2);
  await writeFile(join(dir, ".pending-evolution.json"), content);
  return hashContent(content);
}

describe("retry tracking", () => {
  it("allows first attempt of a new evolution (no state file)", async () => {
    await writePendingAndGetHash(testDir);
    const result = await checkPendingEvolution(testDir);
    expect(result.shouldRestart).toBe(true);
  });

  it("refuses after MAX_ATTEMPTS of the same evolution", async () => {
    const hash = await writePendingAndGetHash(testDir);

    await writeEvolutionState(testDir, {
      pendingHash: hash,
      attemptCount: MAX_ATTEMPTS,
      lastAttemptAt: new Date().toISOString(),
      lastFailed: true,
    });

    const result = await checkPendingEvolution(testDir);
    expect(result.shouldRestart).toBe(false);
    expect(result.error).toMatch(/exhausted.*3.*attempts/);
    // Pending file should be moved to failed
    await expect(access(join(testDir, ".pending-evolution.json"))).rejects.toThrow();
    await expect(access(join(testDir, ".failed-evolution.json"))).resolves.toBeUndefined();
  });

  it("respects cooldown after failed attempt", async () => {
    const hash = await writePendingAndGetHash(testDir);

    await writeEvolutionState(testDir, {
      pendingHash: hash,
      attemptCount: 1,
      lastAttemptAt: new Date().toISOString(),
      lastFailed: true,
    });

    const result = await checkPendingEvolution(testDir);
    expect(result.shouldRestart).toBe(false);
    expect(result.error).toMatch(/cooldown/);
  });

  it("allows retry after cooldown expires", async () => {
    const hash = await writePendingAndGetHash(testDir);

    await writeEvolutionState(testDir, {
      pendingHash: hash,
      attemptCount: 1,
      lastAttemptAt: new Date(Date.now() - COOLDOWN_MS - 1000).toISOString(),
      lastFailed: true,
    });

    const result = await checkPendingEvolution(testDir);
    expect(result.shouldRestart).toBe(true);
  });

  it("resets attempt count for a different evolution (different content hash)", async () => {
    await writePendingAndGetHash(testDir, { description: "New improvement" });

    // State from a different evolution (different hash)
    await writeEvolutionState(testDir, {
      pendingHash: "different-hash-from-previous-evolution",
      attemptCount: MAX_ATTEMPTS,
      lastAttemptAt: new Date().toISOString(),
      lastFailed: true,
    });

    const result = await checkPendingEvolution(testDir);
    expect(result.shouldRestart).toBe(true);
  });

  it("clears state after max attempts exhaustion", async () => {
    const hash = await writePendingAndGetHash(testDir);

    await writeEvolutionState(testDir, {
      pendingHash: hash,
      attemptCount: MAX_ATTEMPTS,
      lastAttemptAt: new Date().toISOString(),
      lastFailed: true,
    });

    await checkPendingEvolution(testDir);
    // State file should be cleared after exhaustion
    const state = await readEvolutionState(testDir);
    expect(state).toBeNull();
  });
});

// ── applyEvolution ──

// Skip applyEvolution integration tests when invoked recursively by the
// evolution system itself (applyEvolution runs `npx vitest run` which would
// re-enter this file, causing a fork bomb of nested vitest processes).
const isEvolutionApply = process.env.AKARI_EVOLUTION_IN_PROGRESS === "1";

describe.skipIf(isEvolutionApply)("applyEvolution", () => {
  // applyEvolution runs `npx tsc` in the target dir, which only works
  // in the real scheduler directory. We test it against the actual
  // scheduler dir to verify the full build pipeline.

  const schedulerDir = join(import.meta.dirname, "..");

  it("succeeds on the real scheduler directory (no pending file needed)", async () => {
    // applyEvolution runs tsc + vitest + build; it doesn't require .pending-evolution.json
    // to exist for the checks (it only removes it after).
    const result = await applyEvolution(schedulerDir);
    expect(result).toBe(true);
  }, 120_000); // tsc + vitest + build can be slow

  it("removes .pending-evolution.json after successful build", async () => {
    // Write a pending file to the real scheduler dir, then apply
    const pendingPath = join(schedulerDir, ".pending-evolution.json");
    await writeFile(pendingPath, JSON.stringify(validPending()));
    try {
      const result = await applyEvolution(schedulerDir);
      expect(result).toBe(true);
      // File should be removed
      await expect(access(pendingPath)).rejects.toThrow();
    } finally {
      // Cleanup in case test fails before removal
      try { await unlink(pendingPath); } catch { /* already removed */ }
    }
  }, 120_000); // tsc + vitest + build can be slow

  it("renames pending to failed on tsc failure", async () => {
    // Create a minimal dir where tsc will fail (no tsconfig, no valid TS)
    const badDir = join(testDir, "bad-scheduler");
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true },
      include: ["bad.ts"],
    }));
    await writeFile(join(badDir, "bad.ts"), "const x: number = 'not a number';");
    const pendingPath = join(badDir, ".pending-evolution.json");
    const failedPath = join(badDir, ".failed-evolution.json");
    await writeFile(pendingPath, JSON.stringify(validPending()));

    const result = await applyEvolution(badDir);
    expect(result).toBe(false);
    // Pending file should be gone, failed file should exist
    await expect(access(pendingPath)).rejects.toThrow();
    await expect(access(failedPath)).resolves.toBeUndefined();
  }, 30_000);

  it("updates evolution state on build failure", async () => {
    const badDir = join(testDir, "bad-scheduler-state");
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true },
      include: ["bad.ts"],
    }));
    await writeFile(join(badDir, "bad.ts"), "const x: number = 'not a number';");
    await writeFile(join(badDir, ".pending-evolution.json"), JSON.stringify(validPending()));

    await applyEvolution(badDir);

    const state = await readEvolutionState(badDir);
    expect(state).not.toBeNull();
    expect(state!.attemptCount).toBe(1);
    expect(state!.lastFailed).toBe(true);
  }, 30_000);

  it("deletes pending file as fallback when rename target is a directory", async () => {
    const badDir = join(testDir, "rename-fail");
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true },
      include: ["bad.ts"],
    }));
    await writeFile(join(badDir, "bad.ts"), "const x: number = 'not a number';");
    await writeFile(join(badDir, ".pending-evolution.json"), JSON.stringify(validPending()));
    // Create .failed-evolution.json as a directory to make rename fail
    await mkdir(join(badDir, ".failed-evolution.json"), { recursive: true });

    await applyEvolution(badDir);

    // Pending file should be deleted (fallback path)
    await expect(access(join(badDir, ".pending-evolution.json"))).rejects.toThrow();
  }, 30_000);

  it("clears evolution state after successful build", async () => {
    const pendingPath = join(schedulerDir, ".pending-evolution.json");
    await writeFile(pendingPath, JSON.stringify(validPending()));
    // Write state simulating a prior failed attempt
    await writeEvolutionState(schedulerDir, {
      pendingHash: hashContent(JSON.stringify(validPending())),
      attemptCount: 1,
      lastAttemptAt: new Date().toISOString(),
      lastFailed: true,
    });
    try {
      const result = await applyEvolution(schedulerDir);
      expect(result).toBe(true);
      // State should be cleared after success
      const state = await readEvolutionState(schedulerDir);
      expect(state).toBeNull();
    } finally {
      try { await unlink(pendingPath); } catch { /* already removed */ }
    }
  }, 120_000);
});

import { waitForActiveSessions } from "./cli.js";
import { registerSession, unregisterSession, clearAll, listSessions } from "./session.js";

// ── Regression: evolution should not interrupt burst mode ──

describe("evolution-burst guard", () => {
  it("cli.ts guards evolution with burstInProgress check", async () => {
    const cliPath = join(import.meta.dirname, "cli.ts");
    const source = await readFile(cliPath, "utf-8");

    const lines = source.split("\n");
    let hasEvolutionGuardWithBurstCheck = false;

    for (const line of lines) {
      if (line.includes("!evolutionInProgress") && line.includes("burstInProgress")) {
        hasEvolutionGuardWithBurstCheck = true;
        break;
      }
    }

    expect(
      hasEvolutionGuardWithBurstCheck,
      "evolution check should include burstInProgress guard on same line to prevent interrupting burst mode"
    ).toBe(true);
  });

  it("cli.ts guards evolution with skipEvolutionUntil check", async () => {
    const cliPath = join(import.meta.dirname, "cli.ts");
    const source = await readFile(cliPath, "utf-8");

    expect(source).toContain("skipEvolutionUntil");
    // The guard line should include both burstInProgress and skipEvolutionUntil
    const lines = source.split("\n");
    const guardLine = lines.find((l) => l.includes("!evolutionInProgress") && l.includes("skipEvolutionUntil"));
    expect(guardLine, "evolution check should include skipEvolutionUntil guard for crash loop detection").toBeTruthy();
  });
});

// ── Integration: waitForActiveSessions ──

describe("waitForActiveSessions", () => {
  beforeEach(() => {
    clearAll();
  });

  afterEach(() => {
    clearAll();
  });

  it("returns immediately when no active sessions", async () => {
    const start = Date.now();
    await waitForActiveSessions(1000);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it("waits for session to complete before returning", async () => {
    const mockHandle = { pid: 12345, kill: () => {} };
    registerSession("test-session-1", "job-1", "test-job", mockHandle as any);
    
    expect(listSessions().length).toBe(1);
    
    const start = Date.now();
    const waitPromise = waitForActiveSessions(5000);
    
    await new Promise((r) => setTimeout(r, 100));
    expect(listSessions().length).toBe(1);
    
    unregisterSession("test-session-1");
    await waitPromise;
    const elapsed = Date.now() - start;
    
    expect(elapsed).toBeLessThan(2000);
  });

  it("times out and returns even with active sessions", async () => {
    const mockHandle = { pid: 12345, kill: () => {} };
    registerSession("test-session-2", "job-2", "test-job", mockHandle as any);
    
    const start = Date.now();
    await waitForActiveSessions(200);
    const elapsed = Date.now() - start;
    
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(listSessions().length).toBe(1);
  });
});
