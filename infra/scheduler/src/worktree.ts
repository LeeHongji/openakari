/** Git worktree management for safe, isolated self-modification.
 *  All evolution work happens in a worktree — never in-place on the main branch.
 *  Validated changes are reviewed by a human via Slack before merging. */

import { readFile, writeFile, mkdir, unlink, access, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";

const exec = promisify(execFile);

// ── Types ────────────────────────────────────────────────────────────────────

export interface WorktreeInfo {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch name (e.g., evo/fix-stall-guard). */
  branch: string;
  /** Timestamp when the worktree was created. */
  createdAt: number;
  /** Human-readable description of the evolution. */
  description: string;
  /** Current status in the review pipeline. */
  status: "active" | "validated" | "pending-review" | "approved" | "rejected";
  /** Task description that was given to the evolution agent. */
  task: string;
  /** Thread key (channel:ts) where the review message was posted. */
  threadKey?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface DiffSummary {
  /** Short human-readable summary of changes. */
  summary: string;
  /** Full diff output. */
  fullDiff: string;
  /** List of changed files. */
  files: string[];
}

// ── State file ───────────────────────────────────────────────────────────────

const STATE_DIR = ".scheduler";
const EVOLUTION_STATE_FILE = "evolution-worktree.json";

/** Persist worktree state to disk so it survives scheduler restarts. */
export async function saveWorktreeState(
  repoDir: string,
  info: WorktreeInfo | null,
): Promise<void> {
  const stateDir = join(repoDir, STATE_DIR);
  const statePath = join(stateDir, EVOLUTION_STATE_FILE);

  if (!info) {
    try { await unlink(statePath); } catch { /* ok if missing */ }
    return;
  }

  await mkdir(stateDir, { recursive: true });
  await writeFile(statePath, JSON.stringify(info, null, 2), "utf-8");
}

/** Load worktree state from disk. Returns null if no active evolution. */
export async function loadWorktreeState(
  repoDir: string,
): Promise<WorktreeInfo | null> {
  const statePath = join(repoDir, STATE_DIR, EVOLUTION_STATE_FILE);
  try {
    const raw = await readFile(statePath, "utf-8");
    return JSON.parse(raw) as WorktreeInfo;
  } catch {
    return null;
  }
}

// ── Worktree operations ──────────────────────────────────────────────────────

/** Sanitize a description into a branch-safe string. */
function toBranchName(description: string): string {
  return "evo/" + description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

/** Create a new git worktree for evolution work.
 *  Only one active evolution worktree is allowed at a time.
 *  @throws if a worktree already exists (single-active constraint). */
export async function createWorktree(
  repoDir: string,
  description: string,
  task: string,
): Promise<WorktreeInfo> {
  // Check for existing active evolution
  const existing = await loadWorktreeState(repoDir);
  if (existing && existing.status !== "approved" && existing.status !== "rejected") {
    throw new Error(
      `An evolution worktree is already active: "${existing.description}" (${existing.status}). ` +
      `Approve or reject it before starting a new one.`,
    );
  }

  const branch = toBranchName(description);
  const worktreePath = join(repoDir, ".worktrees", `evo-${Date.now()}`);

  // Create parent directory
  await mkdir(dirname(worktreePath), { recursive: true });

  // Create worktree with a new branch from HEAD
  try {
    await exec("git", ["worktree", "add", "-b", branch, worktreePath], {
      cwd: repoDir,
      timeout: 30_000,
    });
  } catch (err) {
    // Branch may already exist from a previous attempt — try without -b
    try {
      await exec("git", ["branch", "-D", branch], { cwd: repoDir, timeout: 10_000 });
    } catch { /* ok */ }
    await exec("git", ["worktree", "add", "-b", branch, worktreePath], {
      cwd: repoDir,
      timeout: 30_000,
    });
  }

  const info: WorktreeInfo = {
    path: worktreePath,
    branch,
    createdAt: Date.now(),
    description,
    status: "active",
    task,
  };

  await saveWorktreeState(repoDir, info);
  console.log(`[worktree] Created: ${worktreePath} (branch: ${branch})`);
  return info;
}

/** Run validation checks in the worktree directory.
 *  Checks: tsc --noEmit, vitest run, sensitive file scan. */
export async function validateWorktree(
  info: WorktreeInfo,
  schedulerDir: string,
): Promise<ValidationResult> {
  const errors: string[] = [];
  const worktreeSchedulerDir = join(info.path, "infra", "scheduler");

  // Determine if scheduler code was modified (needs tsc + vitest)
  let hasSchedulerChanges = false;
  try {
    const { stdout } = await exec("git", ["diff", "--name-only", "main...HEAD"], {
      cwd: info.path,
      timeout: 10_000,
    });
    hasSchedulerChanges = stdout.split("\n").some((f) => f.startsWith("infra/scheduler/src/"));
  } catch {
    hasSchedulerChanges = true; // assume yes on error
  }

  // TypeScript type check (only if scheduler code changed)
  if (hasSchedulerChanges) {
    try {
      await exec("npx", ["tsc", "--noEmit"], {
        cwd: worktreeSchedulerDir,
        timeout: 60_000,
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      errors.push(`tsc --noEmit failed: ${(e.stderr ?? e.stdout ?? "").slice(0, 500)}`);
    }

    // Test suite
    try {
      await exec("npx", ["vitest", "run", "--exclude", "**/evolution.test.ts", "--exclude", "dist/**", "--exclude", "node_modules/**"], {
        cwd: worktreeSchedulerDir,
        timeout: 120_000,
        env: { ...process.env, AKARI_EVOLUTION_IN_PROGRESS: "1" },
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      errors.push(`Tests failed: ${(e.stderr ?? e.stdout ?? "").slice(0, 500)}`);
    }
  } else {
    console.log(`[worktree] No scheduler code changes — skipping tsc and vitest`);
  }

  // Security: check for sensitive file modifications
  const sensitivePatterns = [".env", "credentials", "secret", "private_key"];
  try {
    const { stdout } = await exec("git", ["diff", "--name-only", "main...HEAD"], {
      cwd: info.path,
      timeout: 10_000,
    });
    const files = stdout.trim().split("\n").filter(Boolean);
    for (const file of files) {
      const lower = file.toLowerCase();
      if (sensitivePatterns.some((p) => lower.includes(p))) {
        errors.push(`Sensitive file modified: ${file}`);
      }
    }
  } catch (err) {
    errors.push(`Could not check modified files: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { ok: errors.length === 0, errors };
}

/** Get a diff summary from the worktree branch vs main. */
export async function getWorktreeDiff(
  info: WorktreeInfo,
): Promise<DiffSummary> {
  // Get changed files
  let files: string[] = [];
  try {
    const { stdout } = await exec("git", ["diff", "--name-only", "main...HEAD"], {
      cwd: info.path,
      timeout: 10_000,
    });
    files = stdout.trim().split("\n").filter(Boolean);
  } catch { /* empty */ }

  // Get full diff (truncated)
  let fullDiff = "";
  try {
    const { stdout } = await exec("git", ["diff", "--stat", "main...HEAD"], {
      cwd: info.path,
      timeout: 10_000,
    });
    fullDiff = stdout;
  } catch { /* empty */ }

  // Get diff summary (stat)
  let summary = `${files.length} file(s) changed`;
  try {
    const { stdout } = await exec("git", ["diff", "--shortstat", "main...HEAD"], {
      cwd: info.path,
      timeout: 10_000,
    });
    if (stdout.trim()) summary = stdout.trim();
  } catch { /* use default */ }

  return { summary, fullDiff, files };
}

/** Merge the worktree branch into main and clean up. */
export async function mergeWorktree(
  repoDir: string,
  info: WorktreeInfo,
): Promise<{ ok: boolean; error?: string }> {
  try {
    // Pull latest main before merging to avoid conflicts from concurrent pushes
    try {
      await exec("git", ["pull", "--rebase", "--autostash", "origin", "main"], {
        cwd: repoDir,
        timeout: 30_000,
      });
    } catch {
      // Pull failure is non-fatal — proceed with merge on current state
      console.warn("[worktree] Pre-merge pull failed, proceeding with local state");
    }

    // Merge into main
    await exec("git", ["merge", "--no-ff", "-m", `feat(evolution): ${info.description}`, info.branch], {
      cwd: repoDir,
      timeout: 30_000,
    });

    // Clean up worktree and branch
    await removeWorktree(repoDir, info);

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Remove a worktree and its branch. Safe to call multiple times. */
export async function removeWorktree(
  repoDir: string,
  info: WorktreeInfo,
): Promise<void> {
  // Remove worktree
  try {
    await exec("git", ["worktree", "remove", "--force", info.path], {
      cwd: repoDir,
      timeout: 15_000,
    });
  } catch {
    // Fallback: remove directory directly
    try {
      await rm(info.path, { recursive: true, force: true });
      // Prune stale worktree entries
      await exec("git", ["worktree", "prune"], { cwd: repoDir, timeout: 10_000 });
    } catch { /* best effort */ }
  }

  // Delete branch
  try {
    await exec("git", ["branch", "-D", info.branch], {
      cwd: repoDir,
      timeout: 10_000,
    });
  } catch { /* branch may not exist */ }

  // Clear state file
  await saveWorktreeState(repoDir, null);
  console.log(`[worktree] Removed: ${info.path} (branch: ${info.branch})`);
}
