/** Self-evolution loop — detect, verify, build, and apply scheduler changes made by agent sessions. */

import { readFile, rename, unlink, access, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { createHash } from "node:crypto";

const exec = promisify(execFile);

const PENDING_FILE = ".pending-evolution.json";
const FAILED_FILE = ".failed-evolution.json";
const STATE_FILE = ".evolution-state.json";

/** Max times the same evolution (by content hash) will be attempted before giving up. */
export const MAX_ATTEMPTS = 3;
/** Cooldown after a failed attempt before retrying (5 minutes). */
export const COOLDOWN_MS = 5 * 60 * 1000;

export interface PendingEvolution {
  timestamp: string;
  sessionId: string;
  description: string;
  filesChanged: string[];
  tscPassed: boolean;
  testsPassed: boolean;
  experimentId: string;
}

export interface EvolutionState {
  /** Hash of the pending evolution file content (to detect new vs. same evolution) */
  pendingHash: string;
  /** Number of times this specific evolution has been attempted */
  attemptCount: number;
  /** ISO timestamp of last attempt */
  lastAttemptAt: string;
  /** Whether the last attempt failed */
  lastFailed: boolean;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export async function readEvolutionState(schedulerDir: string): Promise<EvolutionState | null> {
  try {
    const raw = await readFile(join(schedulerDir, STATE_FILE), "utf-8");
    return JSON.parse(raw) as EvolutionState;
  } catch {
    return null;
  }
}

export async function writeEvolutionState(schedulerDir: string, state: EvolutionState): Promise<void> {
  await writeFile(join(schedulerDir, STATE_FILE), JSON.stringify(state, null, 2));
}

async function clearEvolutionState(schedulerDir: string): Promise<void> {
  try { await unlink(join(schedulerDir, STATE_FILE)); } catch { /* best effort */ }
}

/** Move pending → failed with fallback deletion if rename fails. */
async function movePendingToFailed(pendingPath: string, failedPath: string): Promise<void> {
  const renamed = await rename(pendingPath, failedPath).then(() => true).catch(() => false);
  if (!renamed) {
    console.warn(`[evolution] rename to ${FAILED_FILE} failed, deleting pending file as fallback`);
    await unlink(pendingPath).catch((err) => {
      console.error(`[evolution] CRITICAL: could not rename or delete ${PENDING_FILE}: ${err}`);
    });
  }
}

/**
 * Check if a pending evolution exists and is valid.
 * Called on each scheduler tick.
 */
export async function checkPendingEvolution(
  schedulerDir: string,
): Promise<{ shouldRestart: boolean; description?: string; error?: string }> {
  const pendingPath = join(schedulerDir, PENDING_FILE);
  const failedPath = join(schedulerDir, FAILED_FILE);

  // Check if file exists
  try {
    await access(pendingPath);
  } catch {
    return { shouldRestart: false };
  }

  let pending: PendingEvolution;
  let raw: string;
  try {
    raw = await readFile(pendingPath, "utf-8");
    pending = JSON.parse(raw) as PendingEvolution;
  } catch (err) {
    return {
      shouldRestart: false,
      error: `Failed to parse ${PENDING_FILE}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Validate: all changed files must be under allowed paths
  const ALLOWED_EVOLUTION_PATHS = [
    "infra/scheduler/src/",
    ".claude/skills/",
  ];
  const invalidFiles = pending.filesChanged.filter(
    (f) => !ALLOWED_EVOLUTION_PATHS.some((prefix) => f.startsWith(prefix)),
  );
  if (invalidFiles.length > 0) {
    return {
      shouldRestart: false,
      error: `Evolution rejected: files outside allowed paths (${ALLOWED_EVOLUTION_PATHS.join(", ")}): ${invalidFiles.join(", ")}`,
    };
  }

  // Validate: agent must have reported tsc + tests passing
  if (!pending.tscPassed || !pending.testsPassed) {
    return {
      shouldRestart: false,
      error: `Evolution rejected: agent reported tsc=${pending.tscPassed} tests=${pending.testsPassed}`,
    };
  }

  // Validate: experiment record must exist
  if (!pending.experimentId) {
    return {
      shouldRestart: false,
      error: "Evolution rejected: no experimentId provided",
    };
  }

  // Retry tracking: check if this evolution has been attempted too many times
  const contentHash = hashContent(raw);
  const state = await readEvolutionState(schedulerDir);

  if (state && state.pendingHash === contentHash) {
    // Same evolution as a previous attempt
    if (state.attemptCount >= MAX_ATTEMPTS) {
      console.error(`[evolution] Max attempts (${MAX_ATTEMPTS}) reached for "${pending.description}", moving to failed`);
      await movePendingToFailed(pendingPath, failedPath);
      await clearEvolutionState(schedulerDir);
      return {
        shouldRestart: false,
        error: `Evolution exhausted ${MAX_ATTEMPTS} attempts, moved to ${FAILED_FILE}`,
      };
    }

    if (state.lastFailed) {
      const elapsed = Date.now() - new Date(state.lastAttemptAt).getTime();
      if (elapsed < COOLDOWN_MS) {
        const remainingSec = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
        return {
          shouldRestart: false,
          error: `Evolution cooldown: ${remainingSec}s remaining after failed attempt ${state.attemptCount}/${MAX_ATTEMPTS}`,
        };
      }
    }
  }

  return {
    shouldRestart: true,
    description: pending.description,
  };
}

/**
 * Apply a pending evolution: run tsc, tests, and build (redundant safety), then signal restart.
 * Returns true if all checks passed and restart should proceed.
 */
export async function applyEvolution(
  schedulerDir: string,
): Promise<boolean> {
  const pendingPath = join(schedulerDir, PENDING_FILE);
  const failedPath = join(schedulerDir, FAILED_FILE);

  // Track this attempt in state file (if pending file exists)
  let contentHash: string | null = null;
  let attemptCount = 1;
  try {
    const raw = await readFile(pendingPath, "utf-8");
    contentHash = hashContent(raw);

    const prevState = await readEvolutionState(schedulerDir);
    attemptCount = (prevState && prevState.pendingHash === contentHash)
      ? prevState.attemptCount + 1
      : 1;

    await writeEvolutionState(schedulerDir, {
      pendingHash: contentHash,
      attemptCount,
      lastAttemptAt: new Date().toISOString(),
      lastFailed: false,
    });
  } catch {
    // Pending file doesn't exist — skip state tracking, still run build checks
  }

  /** Record failure in state file (only when tracking a real pending evolution). */
  const recordFailure = async () => {
    if (contentHash) {
      await writeEvolutionState(schedulerDir, {
        pendingHash: contentHash, attemptCount, lastAttemptAt: new Date().toISOString(), lastFailed: true,
      });
    }
  };

  // Redundant type check (agent already ran this)
  try {
    await exec("npx", ["tsc", "--noEmit"], { cwd: schedulerDir, timeout: 60_000 });
  } catch (err) {
    console.error(`[evolution] tsc --noEmit failed:`, err instanceof Error ? err.message : err);
    await movePendingToFailed(pendingPath, failedPath);
    await recordFailure();
    return false;
  }

  // Redundant test execution (agent already ran tests, but verify).
  // Exclude evolution.test.ts to prevent recursive vitest invocation:
  // that test calls applyEvolution() which would spawn another vitest run.
  try {
    await exec("npx", ["vitest", "run", "--exclude", "**/evolution.test.ts", "--exclude", "dist/**", "--exclude", "node_modules/**"], {
      cwd: schedulerDir,
      timeout: 120_000,
      env: { ...process.env, AKARI_EVOLUTION_IN_PROGRESS: "1" },
    });
  } catch (err) {
    console.error(`[evolution] Tests failed:`, err instanceof Error ? err.message : err);
    await movePendingToFailed(pendingPath, failedPath);
    await recordFailure();
    return false;
  }

  // Full build
  try {
    await exec("npx", ["tsc"], { cwd: schedulerDir, timeout: 60_000 });
  } catch (err) {
    console.error(`[evolution] tsc build failed:`, err instanceof Error ? err.message : err);
    await movePendingToFailed(pendingPath, failedPath);
    await recordFailure();
    return false;
  }

  // Remove pending file to prevent re-applying on restart
  try {
    await unlink(pendingPath);
  } catch { /* best effort */ }

  // Clear evolution state — successful evolution needs no tracking
  if (contentHash) {
    await clearEvolutionState(schedulerDir);
  }

  return true;
}
