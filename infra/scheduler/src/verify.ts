/** Post-session verification — git-observed checks for SOP adherence and knowledge output counting. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeMetrics, CrossProjectMetrics, QualityAuditMetrics } from "./metrics.js";
import { detectSleepViolation } from "./sleep-guard.js";

const exec = promisify(execFile);

/** Matches any README.md under projects/ (including subdirectories). */
export const PROJECT_README_RE = /^projects\/[^/]+\/.*README\.md$/;

/** Matches EXPERIMENT.md files under projects/&#42;/experiments/&#42;/ */
export const EXPERIMENT_MD_RE = new RegExp(
  "^projects/[^/]+/experiments/[^/]+/EXPERIMENT\\.md$",
);

/** Matches diagnosis files under projects/&#42;/diagnosis/diagnosis-*.md */
export const DIAGNOSIS_MD_RE = new RegExp(
  "^projects/[^/]+/diagnosis/diagnosis-[^/]+\\.md$",
);

/** Matches postmortem files under projects/&#42;/postmortem/postmortem-*.md */
export const POSTMORTEM_MD_RE = new RegExp(
  "^projects/[^/]+/postmortem/postmortem-[^/]+\\.md$",
);

/** Matches architecture files under projects/&#42;/architecture/architecture-*.md */
export const ARCHITECTURE_MD_RE = new RegExp(
  "^projects/[^/]+/architecture/architecture-[^/]+\\.md$",
);

/** Matches synthesis files under projects/&#42;/analysis/&#42;-synthesis-*.md or &#42;synthesis&#42;.md */
export const SYNTHESIS_MD_RE = new RegExp(
  "^projects/[^/]+/analysis/[^/]*synthesis[^/]*\\.md$",
);

/**
 * Parse YAML frontmatter from EXPERIMENT.md content.
 * Returns the parsed frontmatter as a key-value map, or null if no valid frontmatter.
 */
export function parseExperimentFrontmatter(content: string): Map<string, string> | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n?---/);
  if (!frontmatterMatch) return null;

  const fields = new Map<string, string>();
  for (const line of frontmatterMatch[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fields.set(key, value);
  }
  return fields;
}

/**
 * Check if an EXPERIMENT.md has consumes_resources: true in frontmatter.
 * Returns true if the file exists and has consumes_resources: true, false otherwise.
 */
export async function checkConsumesResources(cwd: string, filePath: string): Promise<boolean> {
  try {
    const content = await readFile(join(cwd, filePath), "utf-8");
    const frontmatter = parseExperimentFrontmatter(content);
    if (!frontmatter) return false;
    const value = frontmatter.get("consumes_resources");
    return value === "true";
  } catch {
    return false;
  }
}

/**
 * Check if an experiment directory has a run.sh script.
 */
async function hasRunScript(cwd: string, experimentDir: string): Promise<boolean> {
  try {
    await stat(join(cwd, experimentDir, "run.sh"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if an experiment is registered with the scheduler (has progress.json with valid status).
 */
async function isSchedulerRegistered(cwd: string, experimentDir: string): Promise<boolean> {
  try {
    const content = await readFile(join(cwd, experimentDir, "progress.json"), "utf-8");
    const data = JSON.parse(content);
    return data.status === "running" || data.status === "retrying" || data.status === "completed";
  } catch {
    return false;
  }
}

/**
 * Get the status field from an EXPERIMENT.md frontmatter.
 * Returns the status value if present, or null if not found or file doesn't exist.
 */
export async function getExperimentStatus(cwd: string, filePath: string): Promise<string | null> {
  try {
    const content = await readFile(join(cwd, filePath), "utf-8");
    const frontmatter = parseExperimentFrontmatter(content);
    if (!frontmatter) return null;
    return frontmatter.get("status") || null;
  } catch {
    return null;
  }
}

/**
 * Check if an EXPERIMENT.md contains an explicit fire-and-forget waiver comment.
 * Waiver format: <!-- consumes-resources-waiver: <reason> -->
 * This allows zero-duration or non-detachable resource-consuming experiments to opt out
 * of the run.sh / scheduler registration requirement with documented justification.
 * Pure function — no I/O.
 */
export function hasConsumesResourcesWaiver(content: string): boolean {
  return /<!--\s*consumes-resources-waiver:\s*\S.+\s*-->/.test(content);
}

// ── Orphaned file classification ──────────────────────────────────────────

/** File extensions that represent work artifacts (not binary/generated output). */
const WORK_EXTENSIONS = /\.(md|yaml|yml|py|ts|js|json|toml|bib|txt|csv|sh)$/;

/** Paths that are always expected (never orphaned), regardless of content. */
const ALWAYS_EXPECTED_PATTERNS = [
  /^node_modules\//,
  /\/node_modules\//,
  /\.failed-evolution\.json$/,
  /\.evolution-state\.json$/,
  /\.last-startup-ms$/,
  /\/renders\//,
  /^\.scheduler\/jobs\.json$/,
  /^modules\//,
];

/**
 * Classify git status --porcelain lines into orphaned work vs expected untracked files.
 * Pure function — no I/O.
 *
 * Orphaned work = files from previous sessions that should have been committed.
 * Expected = dependency dirs, active experiment output, render artifacts, binary files.
 *
 * @param lines - git status --porcelain output lines (e.g. "?? node_modules/", " M file.txt")
 * @param activeExperimentDirs - experiment directories with running experiments (relative paths)
 */
export function classifyUncommittedFiles(
  lines: string[],
  activeExperimentDirs: string[] = [],
): { orphaned: string[]; expected: string[] } {
  const orphaned: string[] = [];
  const expected: string[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    // Parse git status format: XY <path> or XY <path> -> <path>
    const statusCode = line.slice(0, 2);
    const filePath = line.slice(3).trim().split(" -> ").pop()!;

    // Modified/staged tracked files — check expected patterns and active experiment dirs
    if (statusCode !== "??") {
      if (
        ALWAYS_EXPECTED_PATTERNS.some((re) => re.test(filePath)) ||
        activeExperimentDirs.some((dir) => filePath.startsWith(dir + "/"))
      ) {
        expected.push(line);
      } else {
        orphaned.push(line);
      }
      continue;
    }

    // Untracked files: classify by path patterns
    if (ALWAYS_EXPECTED_PATTERNS.some((re) => re.test(filePath))) {
      expected.push(line);
      continue;
    }

    // Files inside active experiment directories are expected output
    if (activeExperimentDirs.some((dir) => filePath.startsWith(dir + "/"))) {
      expected.push(line);
      continue;
    }

    // Files inside experiment directories that are NOT active are orphaned
    if (/\/experiments\/[^/]+\//.test(filePath) || /\/experiments\/[^/]+\/$/.test(filePath)) {
      orphaned.push(line);
      continue;
    }

    // Untracked files with work-artifact extensions are orphaned
    if (WORK_EXTENSIONS.test(filePath)) {
      orphaned.push(line);
      continue;
    }

    // Everything else (binary files, directories without work extensions) is expected
    expected.push(line);
  }

  return { orphaned, expected };
}

export interface VerificationResult {
  uncommittedFiles: string[];
  orphanedFiles: string[];
  hasLogEntry: boolean;
  hasCommit: boolean;
  hasCompleteFooter: boolean;
  ledgerConsistent: boolean;
  filesChanged: number;
  commitCount: number;
  /** Commits made by the agent (excludes scheduler auto-commits). */
  agentCommitCount: number;
  warnings: string[];
  /** True if resource-consuming experiment was created without run.sh or scheduler registration. */
  fireAndForgetViolation: boolean;
  /** True if session ended with uncommitted files (L0 enforcement per CLAUDE.md). */
  uncommittedFilesViolation: boolean;
  /** True if consumes_resources experiment was modified without ledger entry (L0 enforcement). */
  ledgerViolation: boolean;
  /** True if [in-progress: YYYY-MM-DD] tag older than 7 days found (L0 enforcement). */
  staleInProgressTagViolation: boolean;
  /** True if [blocked-by: ... (YYYY-MM-DD)] tag older than 7 days found (L0 enforcement). */
  staleBlockedByTagViolation: boolean;
  /** True if [blocked-by: <desc>] tag references a task that is [x] completed (L0 enforcement). */
  completedBlockerViolation: boolean;
  /** True if session had zero turns but long duration (>60s) — indicates LLM call failure (L0 enforcement). */
  zeroTurnDurationViolation: boolean;
  /** True if a completed EXPERIMENT.md has numerical claims in Findings without provenance (L0 enforcement). */
  findingsProvenanceViolation: boolean;
  /** True if a new experiment script uses LLM/VLM APIs without model selection rationale (L0 enforcement). */
  modelSelectionRationaleViolation: boolean;
  /** True if session made commits but no project README log entry was detected (L0 enforcement). */
  missingLogEntryViolation: boolean;
  /** True if a new literature note lacks a Verified: field (L0 enforcement). */
  literatureVerificationViolation: boolean;
  /** True if a bash command with sleep >30s was detected in session tool-call logs (L0 enforcement, ADR 0017). */
  sleepViolation: boolean;
  /** True if a shell tool call ran >120s wall-clock time (L0 enforcement, ADR 0017). */
  stallViolation: boolean;
  /** The command string that caused the stall violation, if any. */
  stallViolationCommand?: string;
  /** True if session modified UI files (template/CSS/JS) without committing screenshot artifacts (L0 enforcement, ADR 0057). */
  visualArtifactViolation: boolean;
  /** True if session wrote actionable implications in EXPERIMENT.md Findings without modifying any TASKS.md (L0 enforcement, ADR 0060). */
  actionableImplicationViolation: boolean;
  /** Number of L2 convention violations detected. */
  l2ViolationCount: number;
  /** Number of L2 convention checks that were performed (applicable checks only). */
  l2ChecksPerformed: number;
}

/** Patterns that identify L2 convention violations in warning messages.
 * Note: Fire-and-forget violations are L0-enforced (not L2) — they are NOT in this list.
 * L0 warnings are counted separately from L2 violations.
 */
const L2_VIOLATION_PATTERNS = [
  /Model provenance missing:/,
  /Backend provenance missing:/,
  /Model line missing in body:/,
  /Partial completion ban violation:/,
  /Potential false task completion \(D1\):/,
  /Incremental commit violation:/,
  /Orphaned approval-needed tag:/,
  /Denied approval still tagged:/,
  /Stale approval tag:/,
  /Blocked-by external tag without evidence:/,
];

/** Classify a warning as an L2 convention violation. Returns true if it's an L2 violation. */
export function isL2Violation(warning: string): boolean {
  return L2_VIOLATION_PATTERNS.some((pattern) => pattern.test(warning));
}

/** Extract [blocked-by: external:] tags from a TASKS.md diff.
 * Returns array of {blockerDesc, projectName} for newly added tags.
 */
export function extractBlockedByExternalTags(
  diff: string,
): Array<{ blockerDesc: string; projectName: string }> {
  const blockers: Array<{ blockerDesc: string; projectName: string }> = [];
  if (!diff) return blockers;

  const externalBlockerRegex = /^\+\s*-\s*\[x?\]?\s*.*\[blocked-by:\s*external:\s*([^\]]+)\]/gm;
  const addedLines = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  const diffText = addedLines.join("\n");

  let match;
  while ((match = externalBlockerRegex.exec(diffText)) !== null) {
    const blockerDesc = match[1].trim();
    const projectMatch = diff.match(/projects\/([^/]+)\//);
    const projectName = projectMatch ? projectMatch[1] : "unknown";
    blockers.push({ blockerDesc, projectName });
  }

  return blockers;
}

/** Check if a project has evidence for an external blocker (diagnosis or failed experiment). */
function hasEvidenceForExternalBlocker(projectName: string, cwd: string): boolean {
  const diagnosisDir = join(cwd, "projects", projectName, "diagnosis");
  if (existsSync(diagnosisDir) && readdirSync(diagnosisDir).length > 0) {
    return true;
  }

  const experimentsDir = join(cwd, "projects", projectName, "experiments");
  if (existsSync(experimentsDir)) {
    const expDirs = readdirSync(experimentsDir);
    for (const expDir of expDirs) {
      const expPath = join(experimentsDir, expDir, "EXPERIMENT.md");
      if (existsSync(expPath)) {
        const content = readFileSync(expPath, "utf-8");
        if (content.includes("status: failed") || content.includes("status: abandoned")) {
          return true;
        }
      }
    }
  }

  return false;
}

/** Check for [blocked-by: external:] tags without supporting evidence.
 * Per CLAUDE.md and ADR 0040, external blockers must be accompanied by:
 * - A diagnosis file in projects/<project>/diagnosis/, OR
 * - An EXPERIMENT.md with status: failed documenting the external block, OR
 * - An execution log or error output referenced in the task
 */
async function checkBlockedByExternalTags(
  cwd: string,
  headBefore: string | null,
): Promise<Array<{ detail: string }>> {
  const warnings: Array<{ detail: string }> = [];
  if (!headBefore) return warnings;

  try {
    const { stdout: tasksDiff } = await exec(
      "git",
      ["diff", "--unified=0", headBefore, "HEAD", "--", "projects/*/TASKS.md"],
      { cwd },
    );
    if (!tasksDiff) return warnings;

    const blockers = extractBlockedByExternalTags(tasksDiff);
    for (const { blockerDesc, projectName } of blockers) {
      if (!hasEvidenceForExternalBlocker(projectName, cwd)) {
        warnings.push({
          detail: `'${blockerDesc}' in ${projectName}/TASKS.md has no diagnosis file or failed experiment`,
        });
      }
    }
  } catch {
    // Best effort — don't fail verification if git/fs operations error
  }

  return warnings;
}

/** Run git commands to verify session SOP adherence. */
export async function verifySession(
  cwd: string,
  headBefore: string | null,
  costUsd?: number,
  numTurns?: number | null,
  durationMs?: number | null,
  bashCommands?: string[],
  sleepViolationCommand?: string,
  stallViolationCommand?: string,
): Promise<VerificationResult> {
  const warnings: string[] = [];
  let l2ChecksPerformed = 0;

  // 1. Uncommitted files — classify into orphaned work vs expected untracked
  // L0 enforcement: uncommitted files are a verification failure (per CLAUDE.md)
  let uncommittedFiles: string[] = [];
  let orphanedFiles: string[] = [];
  let uncommittedFilesViolation = false;
  try {
    const { stdout } = await exec("git", ["status", "--porcelain"], { cwd });
    uncommittedFiles = stdout
      .split("\n")
      .filter((l) => l.trim());

    // Find active experiment directories (those with running progress.json)
    const activeExpDirs = await findActiveExperimentDirs(cwd);
    const classified = classifyUncommittedFiles(uncommittedFiles, activeExpDirs);
    orphanedFiles = classified.orphaned;

    if (uncommittedFiles.length > 0) {
      uncommittedFilesViolation = true;
      warnings.push(`${uncommittedFiles.length} uncommitted file(s) — L0 violation: sessions must commit all work before ending`);
    }
    if (orphanedFiles.length > 0) {
      warnings.push(`${orphanedFiles.length} orphaned file(s) from previous sessions`);
    }
  } catch { /* git not available */ }

  // 1b. Zero-turn session with long duration — L0 enforcement
  // Sessions with numTurns=0 and duration>60s indicate LLM call failure (no work done).
  // This catches sessions where the agent started but never made any LLM calls.
  const zeroTurnDurationViolation = checkZeroTurnDurationViolation(numTurns, durationMs);
  if (zeroTurnDurationViolation) {
    warnings.push(
      `Zero-turn session violation (L0): Session ran for ${Math.round((durationMs ?? 0) / 1000)}s with 0 turns. This indicates the LLM was never invoked — session should be marked as failed.`,
    );
  }

  // 1c. Sleep >30s violation — L0 enforcement (ADR 0017)
  // Post-session check for sleep commands in bash tool calls.
  // This is a second layer of enforcement after the real-time sleep guard.
  let sleepViolation = false;

  // Check sleepViolationCommand first (from AgentResult.sleepViolation detected at runtime)
  if (sleepViolationCommand) {
    sleepViolation = true;
    const seconds = detectSleepViolation(sleepViolationCommand);
    warnings.push(
      `Sleep violation (L0): Bash command contains sleep ${seconds ?? ">30"}s (>30s limit). Per ADR 0017, sessions must never sleep more than 30 seconds. Command: ${sleepViolationCommand.slice(0, 100)}`,
    );
  }

  // Also check bashCommands array (for callers that pass raw commands)
  if (!sleepViolation && bashCommands && bashCommands.length > 0) {
    for (const cmd of bashCommands) {
      const seconds = detectSleepViolation(cmd);
      if (seconds !== null) {
        sleepViolation = true;
        warnings.push(
          `Sleep violation (L0): Bash command contains sleep ${seconds}s (>30s limit). Per ADR 0017, sessions must never sleep more than 30 seconds. Command: ${cmd.slice(0, 100)}`,
        );
        break;
      }
    }
  }

  // 1d. Wall-clock stall violation — L0 enforcement (ADR 0017)
  // Detected at runtime by stall-guard.ts when a shell tool call blocks >120s.
  let stallViolation = false;
  let stallViolationCommandStr: string | undefined;
  if (stallViolationCommand) {
    stallViolation = true;
    stallViolationCommandStr = stallViolationCommand;
    warnings.push(
      `Stall violation (L0): Shell tool call ran >120s wall-clock time. Per ADR 0017, long-running processes must use fire-and-forget submission. Command: ${stallViolationCommand.slice(0, 100)}`,
    );
  }

  // 2. Did agent commit? Compare HEAD before/after
  let hasCommit = false;
  let headAfter: string | null = null;
  try {
    const { stdout } = await exec("git", ["log", "-1", "--format=%H"], { cwd });
    headAfter = stdout.trim();
    hasCommit = headBefore !== null && headAfter !== headBefore;
  } catch { /* git not available */ }

  // 3. Files changed and commit count (from diff against pre-session HEAD)
  let filesChanged = 0;
  let commitCount = 0;
  let agentCommitCount = 0;
  if (hasCommit && headBefore) {
    try {
      const { stdout } = await exec(
        "git", ["diff", "--stat", headBefore, "HEAD"],
        { cwd },
      );
      // Last line of --stat is summary like " 5 files changed, ..."
      const statLine = stdout.trim().split("\n").pop() ?? "";
      const m = statLine.match(/(\d+) files? changed/);
      if (m) filesChanged = parseInt(m[1], 10);
    } catch { /* best effort */ }

    try {
      const { stdout } = await exec(
        "git", ["rev-list", "--count", `${headBefore}..HEAD`],
        { cwd },
      );
      commitCount = parseInt(stdout.trim(), 10) || 0;
    } catch { /* best effort */ }

    // Count agent commits (exclude scheduler auto-commits)
    try {
      const { stdout } = await exec(
        "git", ["log", "--oneline", `${headBefore}..HEAD`],
        { cwd },
      );
      const allCommits = stdout.trim().split("\n").filter(l => l.trim());
      agentCommitCount = allCommits.filter(l => !l.includes("[scheduler] auto-commit")).length;
    } catch { /* best effort */ }
  }

  // 4. Log entry check — was a project README modified?
  let hasLogEntry = false;
  if (hasCommit && headBefore) {
    try {
      const { stdout } = await exec(
        "git", ["diff", "--name-only", headBefore, "HEAD"],
        { cwd },
      );
      hasLogEntry = stdout.split("\n").some((f) =>
        PROJECT_README_RE.test(f.trim()),
      );
    } catch { /* best effort */ }
  }
  if (!hasLogEntry && hasCommit) {
    warnings.push("Missing log entry violation (L0): Session made commits but no project README log entry detected. Per CLAUDE.md, every session must append a log entry to a project README.");
  }

  // 5. Session summary footer completeness — check modified READMEs for required fields
  let hasCompleteFooter = false;
  if (hasLogEntry && headBefore) {
    try {
      const { stdout } = await exec(
        "git", ["diff", "--name-only", headBefore, "HEAD"],
        { cwd },
      );
      const readmes = stdout.split("\n").filter((f) =>
        PROJECT_README_RE.test(f.trim()),
      );
      for (const readme of readmes) {
        try {
          const content = await readFile(join(cwd, readme.trim()), "utf-8");
          const missing = validateSessionFooter(content);
          if (missing === null) continue; // no footer in this file
          if (missing.length === 0) {
            hasCompleteFooter = true;
          } else {
            warnings.push(
              `Incomplete session footer in ${readme.trim()}: missing ${missing.join(", ")}`,
            );
          }
        } catch { /* file read error */ }
      }
    } catch { /* best effort */ }

    if (!hasCompleteFooter && hasLogEntry) {
      warnings.push("No complete session summary footer found in any modified README");
    }
  }

  // 6. Ledger consistency — L0 enforcement for consumes_resources experiments
  // Check if: (a) costUsd > 0 AND touched budget project, OR
  //           (b) modified EXPERIMENT.md with consumes_resources: true
  // In either case, require a ledger entry for the project.
  let ledgerConsistent = true;
  let ledgerViolation = false;
  const touchedProjects = new Set<string>();

  // Determine which budget-tracked projects were touched
  if (hasCommit && headBefore) {
    try {
      const { stdout: budgetFiles } = await exec(
        "git", ["ls-files", "projects/*/budget.yaml"],
        { cwd },
      );
      const budgetProjects = budgetFiles.split("\n")
        .filter((f) => f.trim())
        .map((f) => f.replace("/budget.yaml", "").replace("projects/", ""));

      const { stdout: changedFiles } = await exec(
        "git", ["diff", "--name-only", headBefore, "HEAD"],
        { cwd },
      );

      for (const f of changedFiles.split("\n")) {
        const file = f.trim();
        for (const proj of budgetProjects) {
          if (file.startsWith(`projects/${proj}/`)) {
            touchedProjects.add(proj);
          }
        }
      }
    } catch { /* best effort */ }
  }

  // Check for consumes_resources experiments in touched projects
  const resourceProjects = new Set<string>();
  if (hasCommit && headBefore) {
    try {
      const { stdout } = await exec(
        "git", ["diff", "--name-only", headBefore, "HEAD"],
        { cwd },
      );
      const experimentFiles = stdout.split("\n").filter((f) =>
        EXPERIMENT_MD_RE.test(f.trim()),
      );

      for (const expFile of experimentFiles) {
        const filePath = expFile.trim();
        const consumes = await checkConsumesResources(cwd, filePath);
        if (consumes) {
          // Extract project name from path: projects/<project>/experiments/...
          const match = filePath.match(/^projects\/([^/]+)\//);
          if (match) {
            resourceProjects.add(match[1]);
          }
        }
      }
    } catch { /* best effort */ }
  }

  // Merge: require ledger for any touched budget project OR resource-consuming experiment project
  const projectsRequiringLedger = new Set([...touchedProjects, ...resourceProjects]);

  if (projectsRequiringLedger.size > 0) {
    const today = new Date().toISOString().slice(0, 10);
    let foundTodayEntry = false;
    try {
      const { stdout: changedFiles } = await exec(
        "git", ["diff", "--name-only", headBefore ?? "HEAD~1", "HEAD"],
        { cwd },
      );
      foundTodayEntry = changedFiles.split("\n").some((f) =>
        f.trim().endsWith("ledger.yaml"),
      );
    } catch { /* best effort */ }

    if (!foundTodayEntry) {
      try {
        const { stdout: files } = await exec(
          "git", ["ls-files", "projects/*/ledger.yaml"],
          { cwd },
        );
        for (const file of files.split("\n").filter((f) => f.trim())) {
          try {
            const content = await readFile(join(cwd, file.trim()), "utf-8");
            if (content.includes(today)) {
              foundTodayEntry = true;
              break;
            }
          } catch { /* skip */ }
        }
      } catch { /* best effort */ }
    }

    ledgerConsistent = foundTodayEntry;
    if (!ledgerConsistent) {
      ledgerViolation = true;
      const projectList = [...projectsRequiringLedger].join(", ");
      warnings.push(
        `Ledger violation: Resource-consuming work on project(s) ${projectList} but no ledger entry found for today. Per CLAUDE.md, budget.yaml projects require ledger entries for all resource-consuming experiments.`,
      );
    }
  }

  // 7. Fire-and-forget compliance check (ADR 0017) — L0 enforcement
  // Detect EXPERIMENT.md with consumes_resources: true that lack run.sh, scheduler registration,
  // or explicit waiver comment. This is an L0 (code-enforced) check, not an L2 convention.
  let fireAndForgetViolation = false;
  if (hasCommit && headBefore) {
    try {
      const { stdout } = await exec(
        "git", ["diff", "--name-only", headBefore, "HEAD"],
        { cwd },
      );
      const experimentFiles = stdout.split("\n").filter((f) =>
        EXPERIMENT_MD_RE.test(f.trim()),
      );

      for (const expFile of experimentFiles) {
        const filePath = expFile.trim();
        const consumes = await checkConsumesResources(cwd, filePath);
        if (!consumes) continue;

        // Check for waiver comment in EXPERIMENT.md content
        let hasWaiver = false;
        try {
          const content = await readFile(join(cwd, filePath), "utf-8");
          hasWaiver = hasConsumesResourcesWaiver(content);
        } catch { /* file read error */ }

        if (hasWaiver) continue;

        const experimentDir = filePath.replace("/EXPERIMENT.md", "");
        const hasRun = await hasRunScript(cwd, experimentDir);
        const isRegistered = await isSchedulerRegistered(cwd, experimentDir);
        const status = await getExperimentStatus(cwd, filePath);

        if (status === "running") {
          if (!isRegistered) {
            fireAndForgetViolation = true;
            warnings.push(
              `Fire-and-forget violation: ${filePath} has status: running and consumes_resources: true but no progress.json. Per ADR 0017, running experiments must be registered with scheduler (have progress.json). run.sh alone is not sufficient for running experiments.`,
            );
          }
        } else {
          if (!hasRun && !isRegistered) {
            fireAndForgetViolation = true;
            warnings.push(
              `Fire-and-forget violation: ${filePath} has consumes_resources: true but no run.sh, no scheduler registration, and no waiver comment. Per ADR 0017, resource-consuming experiments must be launched via experiment runner with --detach and registered with scheduler, or include <!-- consumes-resources-waiver: reason --> if exempted.`,
            );
          }
        }
      }
    } catch { /* best effort */ }
  }

  // 7b. Missing log entry — L0 enforcement (promoted from untracked warning)
  let missingLogEntryViolation = false;
  if (!hasLogEntry && hasCommit) {
    missingLogEntryViolation = true;
  }

  // 8. Tier 1 convention checks (L2→L0 promotion)
  let modelSelectionRationaleViolation = false;
  let literatureVerificationViolation = false;
  if (hasCommit && headBefore) {
    try {
      const { stdout: diffOutput } = await exec(
        "git", ["diff", "-U0", headBefore, "HEAD"],
        { cwd, maxBuffer: 1024 * 1024 },
      );

      // 8a. Partial completion ban — detect [x] (partial) in TASKS.md
      l2ChecksPerformed++; // L2 check: partial completion ban
      const partialViolations = checkPartialCompletionBan(diffOutput);
      for (const v of partialViolations) {
        warnings.push(v);
      }

      // 8c. Literature URL verification — check new literature notes for Verified field
      const { stdout: changedOutput } = await exec(
        "git", ["diff", "--name-only", headBefore, "HEAD"],
        { cwd },
      );
      const changedFilesList = changedOutput.split("\n").filter((f) => f.trim());

      // 8ab. D1 false task completion — detect [x] with docs-only commits
      l2ChecksPerformed++;
      const d1Violations = checkFalseTaskCompletion(diffOutput, changedFilesList);
      for (const v of d1Violations) {
        warnings.push(v);
      }

      // Find new files (did not exist before session)
      const newFilesList: string[] = [];
      for (const file of changedFilesList) {
        try {
          await exec("git", ["cat-file", "-e", `${headBefore}:${file}`], { cwd });
        } catch {
          newFilesList.push(file);
        }
      }

      for (const file of newFilesList) {
        if (file.includes("/literature/") && file.endsWith(".md")) {
          try {
            const content = await readFile(join(cwd, file.trim()), "utf-8");
            if (!checkLiteratureVerified(content)) {
              literatureVerificationViolation = true;
              warnings.push(
                `Literature verification violation (L0): ${file} is a new literature note without a Verified: field. Per CLAUDE.md, literature notes must include "Verified: YYYY-MM-DD" or "Verified: false".`,
              );
            }
          } catch { /* file read error */ }
        }
      }

      // 8d. Model selection rationale — L0 enforcement (promoted from L2)
      for (const file of newFilesList) {
        if (!EXPERIMENT_MD_RE.test(file) && /^projects\/[^/]+\/experiments\/[^/]+\/.*\.(py|ts|js)$/.test(file)) {
          const expDir = file.replace(/\/[^/]+$/, "");
          const expMdPath = `${expDir}/EXPERIMENT.md`;
          try {
            const scriptContent = await readFile(join(cwd, file.trim()), "utf-8");
            const expContent = await readFile(join(cwd, expMdPath), "utf-8");
            if (!checkModelSelectionRationale(scriptContent, expContent)) {
              modelSelectionRationaleViolation = true;
              warnings.push(
                `Model selection rationale violation (L0): ${file} uses LLM/VLM APIs but ${expMdPath} Config section does not document model selection rationale. Per CLAUDE.md, consult docs/model-capability-limits.md and document the choice.`,
              );
            }
          } catch { /* file read error or no EXPERIMENT.md */ }
        }
      }

      // 8e. Model/backend provenance — check changed EXPERIMENT.md files (ADR 0043)
      for (const file of changedFilesList) {
        if (EXPERIMENT_MD_RE.test(file.trim())) {
          l2ChecksPerformed++; // L2 check: model/backend provenance
          try {
            const content = await readFile(join(cwd, file.trim()), "utf-8");
            const result = checkModelBackendProvenance(content);
            if (result) {
              if (result.missingModel) {
                warnings.push(
                  `Model provenance missing: ${file.trim()} is completed with consumes_resources: true but has no 'model' field in frontmatter. Per ADR 0043, document which model produced the outputs.`,
                );
              }
              if (result.missingBackend) {
                warnings.push(
                  `Backend provenance missing: ${file.trim()} is completed with consumes_resources: true but has no 'backend' field in frontmatter. Per ADR 0043, document which backend was used.`,
                );
              }
              if (result.missingModelLine) {
                warnings.push(
                  `Model line missing in body: ${file.trim()} is completed with consumes_resources: true but Config/Method section has no 'Model:' line. Per ADR 0043, include a structured model identifier.`,
                );
              }
            }
          } catch { /* file read error */ }
        }
      }
    } catch { /* best effort */ }
  }

  // 8f. Visual artifact enforcement — check UI file changes include screenshots (ADR 0057)
  let visualArtifactViolation = false;
  if (hasCommit && headBefore) {
    try {
      const { stdout: changedOutput3 } = await exec(
        "git", ["diff", "--name-only", headBefore, "HEAD"],
        { cwd },
      );
      const allChangedFiles = changedOutput3.split("\n").filter((f) => f.trim());
      const visualCheck = checkVisualArtifactViolation(allChangedFiles);
      if (visualCheck.violation) {
        visualArtifactViolation = true;
        const fileList = visualCheck.uiFiles.slice(0, 5).join(", ");
        warnings.push(
          `Visual artifact violation (L0): UI files modified (${fileList}) but no screenshot artifacts (.png/.webp) committed. Per ADR 0057, autonomous UI work must include screenshots.`,
        );
      }

      // 8f2. Example-webapp submodule visual artifact check
      const exampleWebappViolation = await checkExampleWebappSubmoduleViolation(cwd, headBefore);
      if (exampleWebappViolation) {
        visualArtifactViolation = true;
        const fileList = exampleWebappViolation.uiFiles.join(", ");
        warnings.push(
          `Example-webapp visual artifact violation (L0): UI files modified in submodule (${fileList}) but no screenshot artifacts in tests/artifacts/ or screenshots/. Per ADR 0057, autonomous UI work on example-webapp must include screenshots.`,
        );
      }
    } catch { /* best effort */ }
  }

  // 8g. Findings provenance — check completed EXPERIMENT.md for numerical claims without provenance
  let findingsProvenanceViolation = false;
  if (hasCommit && headBefore) {
    try {
      const { stdout: changedOutput2 } = await exec(
        "git", ["diff", "--name-only", headBefore, "HEAD"],
        { cwd },
      );
      const expFiles = changedOutput2.split("\n").filter((f) =>
        EXPERIMENT_MD_RE.test(f.trim()),
      );

      for (const expFile of expFiles) {
        try {
          const content = await readFile(join(cwd, expFile.trim()), "utf-8");
          const provenanceViolations = checkFindingsProvenance(content);
          if (provenanceViolations.length > 0) {
            findingsProvenanceViolation = true;
            for (const v of provenanceViolations) {
              warnings.push(
                `Findings provenance violation (L0): ${expFile.trim()} — ${v}. Per CLAUDE.md, every numerical claim must include script+data provenance or inline arithmetic.`,
              );
            }
          }
        } catch { /* file read error */ }
      }
    } catch { /* best effort */ }
  }

  // 8h. Actionable implication task gate — L0 enforcement (ADR 0060)
  // Detects when findings/implications contain actionable language but no TASKS.md was modified.
  let actionableImplicationViolation = false;
  if (hasCommit && headBefore) {
    try {
      const { stdout: diffForImplications } = await exec(
        "git", ["diff", "-U0", headBefore, "HEAD"],
        { cwd, maxBuffer: 1024 * 1024 },
      );
      const { stdout: changedForImplications } = await exec(
        "git", ["diff", "--name-only", headBefore, "HEAD"],
        { cwd },
      );
      const changedFilesForImplications = changedForImplications.split("\n").filter((f) => f.trim());
      const implicationViolations = checkActionableImplications(diffForImplications, changedFilesForImplications);
      if (implicationViolations.length > 0) {
        actionableImplicationViolation = true;
        for (const v of implicationViolations) {
          warnings.push(
            `Actionable implication without task (L0): ${v}. Per ADR 0060, observations about missing work must generate tasks.`,
          );
        }
      }
    } catch { /* best effort */ }
  }

  // 8b. Incremental commits — check after all metrics are computed
  if (filesChanged > 0) {
    l2ChecksPerformed++; // L2 check: incremental commits
  }
  const incrementalWarning = checkIncrementalCommits(filesChanged, agentCommitCount);
  if (incrementalWarning) {
    warnings.push(incrementalWarning);
  }

  // 9. Orphaned [approval-needed] tag check
  // Detects tasks with [approval-needed] that have no matching APPROVAL_QUEUE.md entry.
  try {
    const orphanedWarnings = await checkOrphanedApprovalTags(cwd);
    l2ChecksPerformed++; // L2 check: orphaned approval-needed tags
    for (const w of orphanedWarnings) {
      warnings.push(`Orphaned approval-needed tag: ${w.detail}`);
    }
  } catch { /* best effort */ }

  // 10. Blocked-by external tag evidence check
  // Per ADR 0040, external blockers must have supporting evidence.
  try {
    const blockerWarnings = await checkBlockedByExternalTags(cwd, headBefore);
    l2ChecksPerformed++; // L2 check: blocked-by external evidence
    for (const w of blockerWarnings) {
      warnings.push(`Blocked-by external tag without evidence: ${w.detail}`);
    }
  } catch { /* best effort */ }

  // 11. Stale [in-progress] tag check — L0 enforcement
  // Detects orphaned [in-progress: YYYY-MM-DD] tags older than 7 days.
  let staleInProgressTagViolation = false;
  try {
    const staleWarnings = await checkStaleInProgressTags(cwd);
    if (staleWarnings.length > 0) {
      staleInProgressTagViolation = true;
      for (const w of staleWarnings) {
        warnings.push(`Stale in-progress tag (L0 violation): ${w.detail}`);
      }
    }
  } catch { /* best effort */ }

  // 12. Stale [blocked-by] tag check — L0 enforcement
  // Detects [blocked-by: ... (YYYY-MM-DD)] tags older than 7 days.
  let staleBlockedByTagViolation = false;
  try {
    const staleWarnings = await checkStaleBlockedByTags(cwd);
    if (staleWarnings.length > 0) {
      staleBlockedByTagViolation = true;
      for (const w of staleWarnings) {
        warnings.push(`Stale blocked-by tag (L0 violation): ${w.detail}`);
      }
    }
  } catch { /* best effort */ }

  // 12b. Completed blocker check — L0 enforcement
  // Detects [blocked-by: ...] tags where the blocking task is [x] completed.
  let completedBlockerViolation = false;
  try {
    const completedBlockerWarnings = await checkCompletedBlockerTags(cwd);
    if (completedBlockerWarnings.length > 0) {
      completedBlockerViolation = true;
      for (const w of completedBlockerWarnings) {
        warnings.push(`Completed blocker (L0 violation): ${w.detail}`);
      }
    }
  } catch { /* best effort */ }

  // Count L2 violations from warnings
  const l2ViolationCount = warnings.filter(isL2Violation).length;

  return {
    uncommittedFiles,
    orphanedFiles,
    hasLogEntry,
    hasCommit,
    hasCompleteFooter,
    ledgerConsistent,
    filesChanged,
    commitCount,
    agentCommitCount,
    warnings,
    fireAndForgetViolation,
    uncommittedFilesViolation,
    ledgerViolation,
    staleInProgressTagViolation,
    staleBlockedByTagViolation,
    completedBlockerViolation,
    zeroTurnDurationViolation,
    findingsProvenanceViolation,
    modelSelectionRationaleViolation,
    missingLogEntryViolation,
    literatureVerificationViolation,
    sleepViolation,
    stallViolation,
    stallViolationCommand: stallViolationCommandStr,
    visualArtifactViolation,
    actionableImplicationViolation,
    l2ViolationCount,
    l2ChecksPerformed,
  };
}

/**
 * Parse knowledge metrics from a git diff and file list. Pure function — no I/O.
 * @param diff - unified diff output (`git diff -U0 before..HEAD`)
 * @param changedFiles - list of changed file paths (`git diff --name-only`)
 * @param newFiles - set of file paths that are new (did not exist in pre-session HEAD).
 *                   If omitted, all files are treated as pre-existing (modifications only).
 */
export function parseKnowledgeFromDiff(
  diff: string,
  changedFiles: string[],
  newFiles?: Set<string>,
): KnowledgeMetrics {
  const isNew = newFiles ?? new Set<string>();

  const result: KnowledgeMetrics = {
    newExperimentFindings: 0,
    newDecisionRecords: 0,
    newLiteratureNotes: 0,
    openQuestionsResolved: 0,
    openQuestionsDiscovered: 0,
    experimentsCompleted: 0,
    crossReferences: 0,
    newAnalysisFiles: 0,
    logEntryFindings: 0,
    infraCodeChanges: 0,
    bugfixVerifications: 0,
    compoundActions: 0,
    structuralChanges: 0,
    feedbackProcessed: 0,
    diagnosesCompleted: 0,
    tasksCreated: 0,
  };

  const diffBlocks = diff.split(/^diff --git/m);

  // Extract file path from the first line of a diff block header.
  // The header looks like: " a/path/to/file b/path/to/file\n"
  const blockFile = (block: string): string => {
    const firstLine = block.split("\n")[0] ?? "";
    const m = firstLine.match(/ b\/(.+?)(?:\s|$)/);
    return m ? m[1] : "";
  };

  // 1. Numbered findings in EXPERIMENT.md files
  for (const block of diffBlocks) {
    if (!blockFile(block).endsWith("EXPERIMENT.md")) continue;
    for (const line of block.split("\n")) {
      if (/^\+\d+\.\s/.test(line)) {
        result.newExperimentFindings++;
      }
    }
  }

  // 2. New decision records and literature notes
  for (const file of changedFiles) {
    if (/^decisions\/\d{4}-/.test(file) && isNew.has(file)) {
      result.newDecisionRecords++;
    }
    if (file.includes("/literature/") && file.endsWith(".md") && isNew.has(file)) {
      result.newLiteratureNotes++;
    }
  }

  // 3. Open questions in README.md files
  for (const block of diffBlocks) {
    if (!blockFile(block).endsWith("README.md")) continue;
    const lines = block.split("\n");
    let inOQ = false;
    for (const line of lines) {
      if (line.includes("## Open questions")) inOQ = true;
      if (inOQ && /^##\s/.test(line) && !line.includes("## Open questions")) {
        inOQ = false;
      }
      if (inOQ && /^\+- /.test(line)) result.openQuestionsDiscovered++;
      if (inOQ && /^-- /.test(line)) result.openQuestionsResolved++;
    }
  }

  // 4. Experiments completed (status changed to completed or failed)
  const statusChanges = diff.match(/^\+status:\s*(completed|failed)/gm);
  if (statusChanges) {
    result.experimentsCompleted = statusChanges.length;
  }

  // 5. Cross-references (relative-path markdown links)
  const crossRefMatches = diff.match(/^\+.*\]\(\.\.\//gm);
  if (crossRefMatches) {
    result.crossReferences = crossRefMatches.length;
  }

  // 6. New analysis markdown files (projects/*/analysis/*.md)
  for (const file of changedFiles) {
    if (/^projects\/[^/]+\/analysis\/.*\.md$/.test(file) && isNew.has(file)) {
      result.newAnalysisFiles++;
    }
  }

  // 7. Numbered findings in README log entries (not EXPERIMENT.md)
  for (const block of diffBlocks) {
    const file = blockFile(block);
    if (file.endsWith("EXPERIMENT.md")) continue;
    if (!file.endsWith("README.md")) continue;
    for (const line of block.split("\n")) {
      if (/^\+\d+\.\s/.test(line) && !/^\+- \[[ x]\]/.test(line)) {
        result.logEntryFindings++;
      }
    }
  }

  // 7b. Findings in analysis files (projects/*/analysis/*.md) — ### Finding N: headers
  for (const block of diffBlocks) {
    const file = blockFile(block);
    if (!/^projects\/[^/]+\/analysis\/.*\.md$/.test(file)) continue;
    for (const line of block.split("\n")) {
      if (/^\+###\s+Finding\s+\d+/.test(line)) {
        result.logEntryFindings++;
      }
    }
  }

  // 7c. Findings in diagnosis files (projects/*/diagnosis/*.md) — ### Finding N: headers
  for (const block of diffBlocks) {
    const file = blockFile(block);
    if (!/^projects\/[^/]+\/diagnosis\/.*\.md$/.test(file)) continue;
    for (const line of block.split("\n")) {
      if (/^\+###\s+Finding\s+\d+/.test(line)) {
        result.logEntryFindings++;
      }
    }
  }

  // 8. Infrastructure source code changes (infra/**/*.ts|py|js, excluding tests and configs)
  const infraSourceRe = /^infra\/.*\.(ts|py|js)$/;
  const testFileRe = /\.(test|spec)\.(ts|js|py)$|_test\.(ts|js|py)$|\/test_[^/]+\.py$/;
  const configFileRe = /\/(package\.json|tsconfig\.json|vitest\.config\.\w+|\.eslintrc\.\w+|pixi\.toml)$/;
  for (const file of changedFiles) {
    if (infraSourceRe.test(file) && !testFileRe.test(file) && !configFileRe.test(file)) {
      result.infraCodeChanges++;
    }
  }

  // 9. Bugfix verifications (EXPERIMENT.md with added ## Verification section)
  for (const block of diffBlocks) {
    if (!blockFile(block).endsWith("EXPERIMENT.md")) continue;
    if (/^\+## Verification/m.test(block)) {
      result.bugfixVerifications++;
    }
  }

  // 10. Compound actions (changes to governance/system files)
  const compoundRe = /^(CLAUDE\.md|\.claude\/skills\/|decisions\/|docs\/sops\/)|\/patterns\//;
  for (const file of changedFiles) {
    if (compoundRe.test(file)) {
      result.compoundActions++;
    }
  }

  // 11. Structural changes (organizational files not covered by compound actions)
  // Includes: TASKS.md, APPROVAL_QUEUE.md, budget/ledger, docs/ (non-SOP), log archives, completed-tasks.md
  const structuralRe = /(?:^|\/)TASKS\.md$|^APPROVAL_QUEUE\.md$|\/budget\.yaml$|\/ledger\.yaml$|\/completed-tasks\.md$|\/log\/.*\.md$/;
  const docsNonSopRe = /^docs\/(?!sops\/).*\.md$/;
  for (const file of changedFiles) {
    if (compoundRe.test(file)) continue; // already counted as compound action
    if (structuralRe.test(file) || docsNonSopRe.test(file)) {
      result.structuralChanges++;
    }
  }

  // 12. Feedback processed (new feedback files in projects/*/feedback/)
  for (const file of changedFiles) {
    if (/\/feedback\/.*\.md$/.test(file) && isNew.has(file)) {
      result.feedbackProcessed++;
    }
  }

  // 13. Diagnoses completed (new diagnosis or postmortem files)
  for (const file of changedFiles) {
    if ((/\/diagnosis\/.*\.md$/.test(file) || /\/postmortem\/.*\.md$/.test(file)) && isNew.has(file)) {
      result.diagnosesCompleted++;
    }
  }

  // 14. Tasks created (new unchecked tasks in TASKS.md files)
  for (const block of diffBlocks) {
    if (!blockFile(block).endsWith("TASKS.md")) continue;
    for (const line of block.split("\n")) {
      if (/^\+- \[ \]/.test(line)) {
        result.tasksCreated++;
      }
    }
  }

  return result;
}

/**
 * Extract cross-project utilization metrics from a git diff.
 * Tracks which projects were touched, findings per project, and
 * references from one project's files to another project.
 * Pure function — no I/O.
 */
export function parseCrossProjectMetrics(
  diff: string,
  changedFiles: string[],
): CrossProjectMetrics {
  const projectsTouched = new Set<string>();
  for (const file of changedFiles) {
    const m = file.match(/^projects\/([^/]+)\//);
    if (m) projectsTouched.add(m[1]);
  }

  const findingsPerProject: Record<string, number> = {};
  const diffBlocks = diff.split(/^diff --git/m);

  const blockFile = (block: string): string => {
    const firstLine = block.split("\n")[0] ?? "";
    const m = firstLine.match(/ b\/(.+?)(?:\s|$)/);
    return m ? m[1] : "";
  };

  for (const block of diffBlocks) {
    const filePath = blockFile(block);
    const projMatch = filePath.match(/^projects\/([^/]+)\//);
    if (!projMatch) continue;
    const project = projMatch[1];

    let findingCount = 0;
    for (const line of block.split("\n")) {
      if (!line.startsWith("+")) continue;
      if (filePath.endsWith("EXPERIMENT.md") && /^\+\d+\.\s/.test(line)) {
        findingCount++;
      }
      if (filePath.endsWith("README.md") && /^\+\d+\.\s/.test(line) && !/^\+- \[[ x]\]/.test(line)) {
        findingCount++;
      }
      // ### Finding N: headers in analysis and diagnosis files
      if ((/\/analysis\/.*\.md$/.test(filePath) || /\/diagnosis\/.*\.md$/.test(filePath)) && /^\+###\s+Finding\s+\d+/.test(line)) {
        findingCount++;
      }
    }

    if (findingCount > 0) {
      findingsPerProject[project] = (findingsPerProject[project] ?? 0) + findingCount;
    }
  }

  let crossProjectRefs = 0;
  for (const block of diffBlocks) {
    const filePath = blockFile(block);
    const sourceProject = filePath.match(/^projects\/([^/]+)\//)?.[1];
    if (!sourceProject) continue;

    for (const line of block.split("\n")) {
      if (!line.startsWith("+")) continue;
      const refMatches = line.matchAll(/projects\/([^/\s)]+)\//g);
      for (const ref of refMatches) {
        if (ref[1] !== sourceProject) {
          crossProjectRefs++;
        }
      }
    }
  }

  return {
    projectsTouched: [...projectsTouched].sort(),
    findingsPerProject,
    crossProjectRefs,
  };
}

/**
 * Count cross-project utilization by diffing against pre-session HEAD.
 */
export async function countCrossProjectMetrics(
  cwd: string,
  headBefore: string | null,
): Promise<CrossProjectMetrics> {
  const empty: CrossProjectMetrics = {
    projectsTouched: [],
    findingsPerProject: {},
    crossProjectRefs: 0,
  };

  if (!headBefore) return empty;

  let diff: string;
  try {
    const { stdout } = await exec(
      "git", ["diff", "-U0", headBefore, "HEAD"],
      { cwd, maxBuffer: 1024 * 1024 },
    );
    diff = stdout;
  } catch {
    return empty;
  }

  let changedFiles: string[];
  try {
    const { stdout } = await exec(
      "git", ["diff", "--name-only", headBefore, "HEAD"],
      { cwd },
    );
    changedFiles = stdout.split("\n").filter((f) => f.trim());
  } catch {
    return empty;
  }

  return parseCrossProjectMetrics(diff, changedFiles);
}

/** Count knowledge output by diffing against pre-session HEAD. */
export async function countKnowledgeOutput(
  cwd: string,
  headBefore: string | null,
): Promise<KnowledgeMetrics> {
  const emptyResult: KnowledgeMetrics = {
    newExperimentFindings: 0,
    newDecisionRecords: 0,
    newLiteratureNotes: 0,
    openQuestionsResolved: 0,
    openQuestionsDiscovered: 0,
    experimentsCompleted: 0,
    crossReferences: 0,
    newAnalysisFiles: 0,
    logEntryFindings: 0,
    infraCodeChanges: 0,
    bugfixVerifications: 0,
    compoundActions: 0,
    structuralChanges: 0,
    feedbackProcessed: 0,
    diagnosesCompleted: 0,
    tasksCreated: 0,
  };

  if (!headBefore) return emptyResult;

  let diff: string;
  try {
    const { stdout } = await exec(
      "git", ["diff", "-U0", headBefore, "HEAD"],
      { cwd, maxBuffer: 1024 * 1024 },
    );
    diff = stdout;
  } catch {
    return emptyResult;
  }

  let changedFiles: string[];
  try {
    const { stdout } = await exec(
      "git", ["diff", "--name-only", headBefore, "HEAD"],
      { cwd },
    );
    changedFiles = stdout.split("\n").filter((f) => f.trim());
  } catch {
    return emptyResult;
  }

  // Determine which files are new (did not exist before the session)
  const newFiles = new Set<string>();
  for (const file of changedFiles) {
    try {
      await exec("git", ["cat-file", "-e", `${headBefore}:${file}`], { cwd });
    } catch {
      newFiles.add(file);
    }
  }

  return parseKnowledgeFromDiff(diff, changedFiles, newFiles);
}

/** Audit-related skill names that appear in README log entries when invoked. */
const AUDIT_SKILL_RE = /\/(review|audit-references|self-audit)\b/;

/**
 * Parse quality audit metrics from a git diff and file list. Pure function — no I/O.
 *
 * Detection heuristics:
 * - auditSkillsInvoked: Added lines in README.md files mentioning audit skill names.
 * - experimentsAudited: Pre-existing EXPERIMENT.md files that were modified (not newly created).
 * - auditFindings: Added lines in audited (pre-existing, modified) EXPERIMENT.md files
 *   that indicate corrections, issues, or review notes.
 */
export function parseQualityAuditMetrics(
  diff: string,
  changedFiles: string[],
  newFiles?: Set<string>,
): QualityAuditMetrics {
  const isNew = newFiles ?? new Set<string>();

  const result: QualityAuditMetrics = {
    auditSkillsInvoked: 0,
    auditFindings: 0,
    experimentsAudited: 0,
  };

  const diffBlocks = diff.split(/^diff --git/m);

  const blockFile = (block: string): string => {
    const firstLine = block.split("\n")[0] ?? "";
    const m = firstLine.match(/ b\/(.+?)(?:\s|$)/);
    return m ? m[1] : "";
  };

  // Track unique audit skill mentions (deduplicate across README blocks)
  const auditSkillsMentioned = new Set<string>();

  for (const block of diffBlocks) {
    const filePath = blockFile(block);

    // Detect audit skill invocations in README log entries
    if (filePath.endsWith("README.md")) {
      for (const line of block.split("\n")) {
        if (!line.startsWith("+")) continue;
        const skillMatch = line.match(AUDIT_SKILL_RE);
        if (skillMatch) {
          auditSkillsMentioned.add(skillMatch[1]);
        }
      }
    }

    // Detect audited experiments: pre-existing EXPERIMENT.md files that were modified
    if (filePath.endsWith("EXPERIMENT.md") && !isNew.has(filePath)) {
      result.experimentsAudited++;

      for (const line of block.split("\n")) {
        if (!line.startsWith("+")) continue;
        if (/^\+\d+\.\s/.test(line)) {
          result.auditFindings++;
        } else if (/^\+.*\b(incorrect|unverified|missing|FAIL|corrected|audit)\b/i.test(line)) {
          result.auditFindings++;
        }
      }
    }
  }

  result.auditSkillsInvoked = auditSkillsMentioned.size;

  return result;
}

/**
 * Count quality audit metrics by diffing against pre-session HEAD.
 */
export async function countQualityAuditMetrics(
  cwd: string,
  headBefore: string | null,
): Promise<QualityAuditMetrics> {
  const empty: QualityAuditMetrics = {
    auditSkillsInvoked: 0,
    auditFindings: 0,
    experimentsAudited: 0,
  };

  if (!headBefore) return empty;

  let diff: string;
  try {
    const { stdout } = await exec(
      "git", ["diff", "-U0", headBefore, "HEAD"],
      { cwd, maxBuffer: 1024 * 1024 },
    );
    diff = stdout;
  } catch {
    return empty;
  }

  let changedFiles: string[];
  try {
    const { stdout } = await exec(
      "git", ["diff", "--name-only", headBefore, "HEAD"],
      { cwd },
    );
    changedFiles = stdout.split("\n").filter((f) => f.trim());
  } catch {
    return empty;
  }

  // Determine which files are new (did not exist before the session)
  const newFiles = new Set<string>();
  for (const file of changedFiles) {
    try {
      await exec("git", ["cat-file", "-e", `${headBefore}:${file}`], { cwd });
    } catch {
      newFiles.add(file);
    }
  }

  return parseQualityAuditMetrics(diff, changedFiles, newFiles);
}

/**
 * Find experiment directories with running experiments (progress.json status: running).
 * Returns relative paths from cwd (e.g. "projects/sample-project/experiments/full-scale-flash-240").
 */
export async function findActiveExperimentDirs(cwd: string): Promise<string[]> {
  const active: string[] = [];
  const projectsDir = join(cwd, "projects");

  let projectEntries: string[];
  try {
    projectEntries = await readdir(projectsDir);
  } catch {
    return active;
  }

  for (const project of projectEntries) {
    const expDir = join(projectsDir, project, "experiments");
    let expEntries: string[];
    try {
      expEntries = await readdir(expDir);
    } catch {
      continue;
    }

    for (const expName of expEntries) {
      const progressPath = join(expDir, expName, "progress.json");
      try {
        const content = await readFile(progressPath, "utf-8");
        const data = JSON.parse(content);
        if (data.status === "running" || data.status === "retrying") {
          active.push(`projects/${project}/experiments/${expName}`);
        }
      } catch {
        // No progress.json or invalid JSON — not an active experiment
      }
    }
  }

  return active;
}

// ── Staleness checks ─────────────────────────────────────────────────────

const STALE_IN_PROGRESS_DAYS = 7;
const STALE_RUNNING_DAYS = 7;

export interface StalenessWarning {
  type: "stale_in_progress" | "stale_blocked_by" | "stale_running" | "completed_no_ledger" | "completed_blocker";
  file: string;
  detail: string;
}

/**
 * Check project READMEs for stale [in-progress] lifecycle tags.
 * Tags older than STALE_IN_PROGRESS_DAYS are flagged.
 */
async function checkStaleInProgressTags(cwd: string): Promise<StalenessWarning[]> {
  const warnings: StalenessWarning[] = [];
  const today = new Date();
  const projectsDir = join(cwd, "projects");

  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return warnings;
  }

  for (const entry of entries) {
    const readmePath = join(projectsDir, entry, "README.md");
    let content: string;
    try {
      content = await readFile(readmePath, "utf-8");
    } catch {
      continue;
    }

    // Find [in-progress: YYYY-MM-DD] tags
    const tagRe = /\[in-progress:\s*(\d{4}-\d{2}-\d{2})\]/g;
    let match: RegExpExecArray | null;
    while ((match = tagRe.exec(content)) !== null) {
      const tagDate = new Date(match[1]);
      const diffDays = Math.floor(
        (today.getTime() - tagDate.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (diffDays > STALE_IN_PROGRESS_DAYS) {
        // Extract task line for context
        const lineStart = content.lastIndexOf("\n", match.index) + 1;
        const lineEnd = content.indexOf("\n", match.index);
        const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
        warnings.push({
          type: "stale_in_progress",
          file: `projects/${entry}/README.md`,
          detail: `Tag [in-progress: ${match[1]}] is ${diffDays} days old (>${STALE_IN_PROGRESS_DAYS}d): ${line.slice(0, 120)}`,
        });
      }
    }
  }

  return warnings;
}

/**
 * Check TASKS.md files for stale [blocked-by: ... (YYYY-MM-DD)] lifecycle tags.
 * Tags older than STALE_IN_PROGRESS_DAYS are flagged.
 */
async function checkStaleBlockedByTags(cwd: string): Promise<StalenessWarning[]> {
  const warnings: StalenessWarning[] = [];
  const today = new Date();
  const projectsDir = join(cwd, "projects");

  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return warnings;
  }

  for (const entry of entries) {
    const tasksPath = join(projectsDir, entry, "TASKS.md");
    let content: string;
    try {
      content = await readFile(tasksPath, "utf-8");
    } catch {
      continue;
    }

    // Find [blocked-by: ... (YYYY-MM-DD)] tags with dates
    const tagRe = /\[blocked-by:[^\]]*\((\d{4}-\d{2}-\d{2})\)\]/g;
    let match: RegExpExecArray | null;
    while ((match = tagRe.exec(content)) !== null) {
      const tagDate = new Date(match[1]);
      const diffDays = Math.floor(
        (today.getTime() - tagDate.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (diffDays > STALE_IN_PROGRESS_DAYS) {
        // Extract task line for context
        const lineStart = content.lastIndexOf("\n", match.index) + 1;
        const lineEnd = content.indexOf("\n", match.index);
        const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
        warnings.push({
          type: "stale_blocked_by",
          file: `projects/${entry}/TASKS.md`,
          detail: `Tag [blocked-by: ... (${match[1]})] is ${diffDays} days old (>${STALE_IN_PROGRESS_DAYS}d): ${line.slice(0, 120)}`,
        });
      }
    }
  }

  return warnings;
}

// ── Completed blocker detection ──────────────────────────────────────────────

/** Blocker prefixes that reference external conditions, not tasks. */
const NON_TASK_BLOCKER_PREFIXES = [
  "external:",
  "date:",
  "time gate",
  "time —",
  "system:",
];

const BLOCKER_STOP_WORDS = new Set([
  "the", "and", "for", "from", "with", "not", "has", "have", "been",
  "that", "this", "are", "was", "were", "will", "can", "but", "all",
  "task", "tasks", "complete", "completed", "completion", "running",
]);

export interface BlockedTaskEntry {
  project: string;
  taskText: string;
  blockerDesc: string;
}

export interface CompletedTaskEntry {
  project: string;
  taskText: string;
}

/**
 * Match a blocker description against a completed task.
 * Uses keyword overlap with length-weighted scoring: extracts significant words
 * from the blocker, checks which appear in the completed task text, and sums
 * their lengths. A score ≥8 indicates a match (one long/specific word like
 * "ScoringService" is sufficient; two short words like "scoring pipeline"
 * also suffice). Also matches if the full blocker text is a substring.
 * Pure function — no I/O.
 */
export function blockerMatchesCompletedTask(
  blockerDesc: string,
  completedTaskText: string,
): boolean {
  const blockerLower = blockerDesc.toLowerCase().trim();
  const completedLower = completedTaskText.toLowerCase();

  if (completedLower.includes(blockerLower) && blockerLower.length >= 5) {
    return true;
  }

  const blockerWords = blockerLower
    .split(/[\s,;:()+/]+/)
    .filter((w) => w.length >= 3 && !BLOCKER_STOP_WORDS.has(w));

  if (blockerWords.length === 0) return false;

  const matchScore = blockerWords
    .filter((w) => completedLower.includes(w))
    .reduce((sum, w) => sum + w.length, 0);

  return matchScore >= 8;
}

/**
 * Find open tasks with [blocked-by: ...] tags where the blocking condition
 * matches a completed ([x]) task. Pure function — no I/O.
 *
 * @param blockedTasks - Open tasks with blocked-by tags (non-external prefixes only)
 * @param completedTasks - Completed tasks from all TASKS.md files
 * @returns Warnings for each blocked task whose blocker matches a completed task.
 */
export function findCompletedBlockerMatches(
  blockedTasks: BlockedTaskEntry[],
  completedTasks: CompletedTaskEntry[],
): StalenessWarning[] {
  const warnings: StalenessWarning[] = [];

  for (const { project, taskText, blockerDesc } of blockedTasks) {
    for (const completed of completedTasks) {
      if (blockerMatchesCompletedTask(blockerDesc, completed.taskText)) {
        const truncTask = taskText.slice(0, 100);
        const truncBlocker = blockerDesc.slice(0, 60);
        const truncCompleted = completed.taskText.slice(0, 80);
        warnings.push({
          type: "completed_blocker",
          file: `projects/${project}/TASKS.md`,
          detail: `"${truncTask}" is [blocked-by: ${truncBlocker}] but "${truncCompleted}" is [x] completed in ${completed.project}`,
        });
        break;
      }
    }
  }

  return warnings;
}

/**
 * Check TASKS.md files for [blocked-by: ...] tags where the blocking task is completed.
 * Scans all projects for open tasks with blocked-by tags and cross-references them
 * against completed tasks across all TASKS.md files.
 */
async function checkCompletedBlockerTags(cwd: string): Promise<StalenessWarning[]> {
  const projectsDir = join(cwd, "projects");

  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return [];
  }

  const blockedTasks: BlockedTaskEntry[] = [];
  const completedTasks: CompletedTaskEntry[] = [];
  const blockedByRe = /\[blocked-by:\s*([^\]]+)\]/gi;
  const completedTaskRe = /^\s*-\s+\[x\]\s+(.+)/;

  for (const entry of entries) {
    const tasksPath = join(projectsDir, entry, "TASKS.md");
    let content: string;
    try {
      content = await readFile(tasksPath, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (const line of lines) {
      const completedMatch = line.match(completedTaskRe);
      if (completedMatch) {
        completedTasks.push({ project: entry, taskText: completedMatch[1].trim() });
      }
    }

    // Also check completed-tasks.md for archived completed tasks
    try {
      const archiveContent = await readFile(join(projectsDir, entry, "completed-tasks.md"), "utf-8");
      for (const line of archiveContent.split("\n")) {
        const completedMatch = line.match(completedTaskRe);
        if (completedMatch) {
          completedTasks.push({ project: entry, taskText: completedMatch[1].trim() });
        }
      }
    } catch {
      // No completed-tasks.md — fine
    }

    // Collect open tasks with blocked-by tags (excluding non-task prefixes)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/^\s*-\s+\[ \]\s+/.test(line)) continue;

      // Collect the full task block (task line + indented continuations)
      const taskLines = [line];
      let j = i + 1;
      while (j < lines.length && /^\s{2,}/.test(lines[j]) && !/^\s*-\s+\[/.test(lines[j])) {
        taskLines.push(lines[j]);
        j++;
      }
      const fullText = taskLines.join(" ");

      let match: RegExpExecArray | null;
      blockedByRe.lastIndex = 0;
      while ((match = blockedByRe.exec(fullText)) !== null) {
        const blockerDesc = match[1].trim();
        const isNonTaskBlocker = NON_TASK_BLOCKER_PREFIXES.some(
          (prefix) => blockerDesc.toLowerCase().startsWith(prefix),
        );
        if (isNonTaskBlocker) continue;

        const taskText = line.replace(/^\s*-\s+\[ \]\s+/, "").trim();
        blockedTasks.push({ project: entry, taskText, blockerDesc });
      }
    }
  }

  return findCompletedBlockerMatches(blockedTasks, completedTasks);
}

/**
 * Check for stale running experiments (status: running older than STALE_RUNNING_DAYS).
 */
async function checkStaleRunningExperiments(cwd: string): Promise<StalenessWarning[]> {
  const warnings: StalenessWarning[] = [];
  const today = new Date();
  const projectsDir = join(cwd, "projects");

  let projectEntries: string[];
  try {
    projectEntries = await readdir(projectsDir);
  } catch {
    return warnings;
  }

  for (const project of projectEntries) {
    const expDir = join(projectsDir, project, "experiments");
    let expEntries: string[];
    try {
      expEntries = await readdir(expDir);
    } catch {
      continue;
    }

    for (const expName of expEntries) {
      const expMdPath = join(expDir, expName, "EXPERIMENT.md");
      let content: string;
      try {
        content = await readFile(expMdPath, "utf-8");
      } catch {
        continue;
      }

      // Quick check: is this a running experiment?
      const statusMatch = content.match(/^status:\s*running/m);
      if (!statusMatch) continue;

      // Extract date
      const dateMatch = content.match(/^date:\s*(\d{4}-\d{2}-\d{2})/m);
      if (!dateMatch) continue;

      const expDate = new Date(dateMatch[1]);
      const diffDays = Math.floor(
        (today.getTime() - expDate.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (diffDays > STALE_RUNNING_DAYS) {
        warnings.push({
          type: "stale_running",
          file: `projects/${project}/experiments/${expName}/EXPERIMENT.md`,
          detail: `Experiment has been 'running' since ${dateMatch[1]} (${diffDays} days, >${STALE_RUNNING_DAYS}d threshold)`,
        });
      }
    }
  }

  return warnings;
}

/**
 * Check for completed experiments that have no corresponding ledger entries.
 * Only checks projects that have a budget.yaml.
 */
async function checkCompletedWithoutLedger(cwd: string): Promise<StalenessWarning[]> {
  const warnings: StalenessWarning[] = [];
  const projectsDir = join(cwd, "projects");

  let projectEntries: string[];
  try {
    projectEntries = await readdir(projectsDir);
  } catch {
    return warnings;
  }

  for (const project of projectEntries) {
    const projectDir = join(projectsDir, project);
    const budgetPath = join(projectDir, "budget.yaml");
    const ledgerPath = join(projectDir, "ledger.yaml");

    // Only check projects with budgets
    try {
      await stat(budgetPath);
    } catch {
      continue;
    }

    // Read ledger to find which experiments are tracked
    const trackedExperiments = new Set<string>();
    try {
      const ledgerContent = await readFile(ledgerPath, "utf-8");
      const expRe = /experiment:\s*(.+)/g;
      let m: RegExpExecArray | null;
      while ((m = expRe.exec(ledgerContent)) !== null) {
        trackedExperiments.add(m[1].trim());
      }
    } catch {
      // No ledger file — all completed experiments are untracked
    }

    // Find completed experiments with result CSVs but no ledger entry
    const expDir = join(projectDir, "experiments");
    let expEntries: string[];
    try {
      expEntries = await readdir(expDir);
    } catch {
      continue;
    }

    for (const expName of expEntries) {
      const expMdPath = join(expDir, expName, "EXPERIMENT.md");
      let content: string;
      try {
        content = await readFile(expMdPath, "utf-8");
      } catch {
        continue;
      }

      const statusMatch = content.match(/^status:\s*(completed|failed)/m);
      if (!statusMatch) continue;

      // Check for result CSVs
      const resultsDir = join(expDir, expName, "results");
      let hasCsvs = false;
      try {
        const resultFiles = await readdir(resultsDir);
        hasCsvs = resultFiles.some((f) => f.endsWith(".csv"));
      } catch {
        // No results dir
      }

      if (!hasCsvs) continue;

      // Check if this experiment has a ledger entry
      if (!trackedExperiments.has(expName)) {
        warnings.push({
          type: "completed_no_ledger",
          file: `projects/${project}/experiments/${expName}/EXPERIMENT.md`,
          detail: `Completed experiment has result CSVs but no ledger entry in ${project}/ledger.yaml`,
        });
      }
    }
  }

  return warnings;
}

// ── Orphaned approval-needed tag detection ───────────────────────────────

export interface OrphanedApprovalTag {
  project: string;
  file: string;
  taskLine: string;
}

/**
 * Extract task lines with [approval-needed] tags from TASKS.md content.
 * Pure function — no I/O.
 * @param content - TASKS.md file content
 * @returns Array of task line strings containing [approval-needed]
 */
export function extractApprovalNeededTasks(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => line.includes("[approval-needed]"));
}

/**
 * Extract pending item titles from APPROVAL_QUEUE.md content.
 * Parses the ## Pending section and collects ### headings until ## Resolved.
 * Pure function — no I/O.
 * @param content - APPROVAL_QUEUE.md file content
 * @returns Array of pending item title strings (lowercased for matching)
 */
export function extractPendingApprovalTitles(content: string): string[] {
  const titles: string[] = [];
  let inPending = false;

  for (const line of content.split("\n")) {
    if (/^## Pending\b/.test(line)) {
      inPending = true;
      continue;
    }
    if (inPending && /^## /.test(line) && !/^## Pending/.test(line)) {
      break; // hit Resolved or another section
    }
    if (inPending && /^### /.test(line)) {
      // Extract title after "### YYYY-MM-DD — <title>"
      const titleMatch = line.match(/^###\s+\d{4}-\d{2}-\d{2}\s*—\s*(.+)/);
      if (titleMatch) {
        titles.push(titleMatch[1].trim().toLowerCase());
      }
    }
  }
  return titles;
}

/**
 * Extract denied approval titles from APPROVAL_QUEUE.md Resolved section.
 * Returns an array of lowercase title strings for items with "Decision: denied".
 */
export function extractDeniedApprovalTitles(content: string): string[] {
  const titles: string[] = [];
  let inResolved = false;
  let currentTitle: string | null = null;

  for (const line of content.split("\n")) {
    if (/^## Resolved\b/.test(line)) {
      inResolved = true;
      continue;
    }
    if (inResolved && /^## /.test(line) && !/^## Resolved/.test(line)) {
      break;
    }
    if (inResolved && /^### /.test(line)) {
      const titleMatch = line.match(/^###\s+\d{4}-\d{2}-\d{2}\s*—\s*(.+)/);
      currentTitle = titleMatch ? titleMatch[1].trim().toLowerCase() : null;
    }
    if (inResolved && currentTitle && /^Decision:\s*denied\b/i.test(line)) {
      titles.push(currentTitle);
      currentTitle = null;
    }
  }
  return titles;
}

/**
 * Extract approved (resolved, non-denied) approval titles from APPROVAL_QUEUE.md.
 * Returns an array of lowercase title strings for items with "Decision: approved".
 * Used to detect stale [approval-needed] tags that should be [approved: YYYY-MM-DD].
 */
export function extractApprovedApprovalTitles(content: string): string[] {
  const titles: string[] = [];
  let inResolved = false;
  let currentTitle: string | null = null;

  for (const line of content.split("\n")) {
    if (/^## Resolved\b/.test(line)) {
      inResolved = true;
      continue;
    }
    if (inResolved && /^## /.test(line) && !/^## Resolved/.test(line)) {
      break;
    }
    if (inResolved && /^### /.test(line)) {
      const titleMatch = line.match(/^###\s+\d{4}-\d{2}-\d{2}\s*—\s*(.+)/);
      currentTitle = titleMatch ? titleMatch[1].trim().toLowerCase() : null;
    }
    if (inResolved && currentTitle && /^Decision:\s*approved\b/i.test(line)) {
      titles.push(currentTitle);
      currentTitle = null;
    }
  }
  return titles;
}

/**
 * Check for orphaned [approval-needed] tags — tasks tagged but with no
 * matching pending entry in APPROVAL_QUEUE.md, or matching a denied approval.
 * Returns warnings for each orphaned tag found.
 */
async function checkOrphanedApprovalTags(cwd: string): Promise<StalenessWarning[]> {
  const warnings: StalenessWarning[] = [];

  let approvalContent: string;
  try {
    approvalContent = await readFile(join(cwd, "APPROVAL_QUEUE.md"), "utf-8");
  } catch {
    return warnings;
  }
  const pendingTitles = extractPendingApprovalTitles(approvalContent);
  const deniedTitles = extractDeniedApprovalTitles(approvalContent);
  const approvedTitles = extractApprovedApprovalTitles(approvalContent);

  const projectsDir = join(cwd, "projects");
  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return warnings;
  }

  for (const entry of entries) {
    const tasksPath = join(projectsDir, entry, "TASKS.md");
    let content: string;
    try {
      content = await readFile(tasksPath, "utf-8");
    } catch {
      continue;
    }

    const taggedLines = extractApprovalNeededTasks(content);
    for (const line of taggedLines) {
      const taskText = line
        .replace(/^[-*\s]*\[[ x]\]\s*/, "")
        .replace(/\[.*?\]/g, "")
        .replace(/^#+\s*/, "")
        .trim()
        .toLowerCase();

      const matchesTitle = (titles: string[]): boolean => {
        const taskWords = taskText.split(/\s+/).filter((w) => w.length > 3);
        return titles.some((title) => {
          const matchingWords = taskWords.filter((w) => title.includes(w));
          return matchingWords.length >= 2 || title.includes(taskText) || taskText.includes(title);
        });
      };

      // Check if matches a denied approval (highest priority warning)
      if (matchesTitle(deniedTitles)) {
        warnings.push({
          type: "stale_in_progress",
          file: `projects/${entry}/TASKS.md`,
          detail: `Denied approval still tagged: task was denied in APPROVAL_QUEUE.md, remove [approval-needed] and close task: ${line.trim().slice(0, 150)}`,
        });
        continue;
      }

      // Check if matches an approved (resolved) approval — stale tag
      if (matchesTitle(approvedTitles)) {
        warnings.push({
          type: "stale_in_progress",
          file: `projects/${entry}/TASKS.md`,
          detail: `Stale approval tag: task was approved in APPROVAL_QUEUE.md but still has [approval-needed]. Update to [approved: YYYY-MM-DD] or remove if completed: ${line.trim().slice(0, 150)}`,
        });
        continue;
      }

      // Check if has no pending entry
      if (!matchesTitle(pendingTitles)) {
        warnings.push({
          type: "stale_in_progress",
          file: `projects/${entry}/TASKS.md`,
          detail: `Orphaned [approval-needed] tag: task has no matching pending entry in APPROVAL_QUEUE.md: ${line.trim().slice(0, 150)}`,
        });
      }
    }
  }

  return warnings;
}

/**
 * Run all repo-wide staleness checks.
 * Returns warnings about stale tags, stale running experiments, missing ledger entries,
 * and orphaned approval-needed tags.
 */
export async function checkRepoStaleness(cwd: string): Promise<StalenessWarning[]> {
  const [inProgressWarnings, blockedByWarnings, runningWarnings, ledgerWarnings, orphanedApprovalWarnings, completedBlockerWarnings] = await Promise.all([
    checkStaleInProgressTags(cwd),
    checkStaleBlockedByTags(cwd),
    checkStaleRunningExperiments(cwd),
    checkCompletedWithoutLedger(cwd),
    checkOrphanedApprovalTags(cwd),
    checkCompletedBlockerTags(cwd),
  ]);
  return [...inProgressWarnings, ...blockedByWarnings, ...runningWarnings, ...ledgerWarnings, ...orphanedApprovalWarnings, ...completedBlockerWarnings];
}

/** Get the current HEAD commit hash. */
export async function getHeadCommit(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["log", "-1", "--format=%H"], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// ── Session summary footer validation ────────────────────────────────────

/** The 10 fields required by docs/sops/autonomous-work-cycle.md lines 78-89. */
export const REQUIRED_FOOTER_FIELDS = [
  "Session-type",
  "Duration",
  "Task-selected",
  "Task-completed",
  "Approvals-created",
  "Files-changed",
  "Commits",
  "Compound-actions",
  "Resources-consumed",
  "Budget-remaining",
] as const;

/**
 * Parse the most recent session summary footer from a README's content.
 * A footer can be either:
 *   (a) a fenced code block (``` or ~~~) whose first non-empty line starts
 *       with "Session-type:", or
 *   (b) an unfenced block of consecutive key-value lines starting with
 *       "Session-type:" and ending at a blank line, heading, or EOF.
 * Returns a Map of field→value for the FIRST (most recent) footer found,
 * since README log entries are in reverse-chronological order.
 */
export function parseSessionFooter(content: string): Map<string, string> | null {
  // Collect all footer candidates with their position in the content
  const candidates: Array<{ pos: number; fields: Map<string, string> }> = [];

  // (a) Fenced code blocks
  const blockRe = /^(?:`{3,}|~{3,})[^\n]*\n([\s\S]*?)^(?:`{3,}|~{3,})\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(content)) !== null) {
    const blockContent = match[1];
    const lines = blockContent.split("\n").filter((l) => l.trim());
    if (lines.length === 0) continue;
    if (!lines[0].startsWith("Session-type:")) continue;

    const fields = new Map<string, string>();
    for (const line of lines) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      fields.set(key, value);
    }
    candidates.push({ pos: match.index, fields });
  }

  // (b) Unfenced footer blocks: "Session-type:" at start of line, not inside
  // a fenced code block, followed by key-value lines until blank/heading/EOF.
  // Build a set of character ranges covered by fenced blocks to exclude them.
  const fencedRanges: Array<[number, number]> = [];
  const fenceRe = /^(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?^(?:`{3,}|~{3,})\s*$/gm;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fenceRe.exec(content)) !== null) {
    fencedRanges.push([fenceMatch.index, fenceMatch.index + fenceMatch[0].length]);
  }
  const isInsideFence = (pos: number) =>
    fencedRanges.some(([start, end]) => pos >= start && pos < end);

  const unfencedRe = /^Session-type:\s*.+$/gm;
  let uMatch: RegExpExecArray | null;
  while ((uMatch = unfencedRe.exec(content)) !== null) {
    if (isInsideFence(uMatch.index)) continue;

    // Collect consecutive key-value lines starting from this position
    const startPos = uMatch.index;
    const restContent = content.slice(startPos);
    const lines = restContent.split("\n");
    const fields = new Map<string, string>();
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") break;
      if (trimmed.startsWith("#")) break;
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) break;
      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();
      // Footer keys use Title-Case with hyphens (e.g., "Session-type")
      if (!/^[A-Z]/.test(key)) break;
      fields.set(key, value);
    }
    if (fields.has("Session-type")) {
      candidates.push({ pos: startPos, fields });
    }
  }

  if (candidates.length === 0) return null;

  // Return the first (earliest position = most recent entry in reverse-chronological README)
  candidates.sort((a, b) => a.pos - b.pos);
  return candidates[0].fields;
}

/**
 * Validate that the most recent session summary footer in content contains all
 * required fields. Returns:
 * - [] if all fields are present (valid)
 * - string[] of missing field names if some are absent
 * - null if no footer was found (nothing to validate)
 */
export function validateSessionFooter(content: string): string[] | null {
  const fields = parseSessionFooter(content);
  if (!fields) return null;

  const missing: string[] = [];
  for (const field of REQUIRED_FOOTER_FIELDS) {
    if (!fields.has(field)) {
      missing.push(field);
    }
  }
  return missing;
}

/** Format verification warnings as a human-readable string, or null if no warnings. */
export function formatVerification(result: VerificationResult): string | null {
  if (result.warnings.length === 0) return null;
  return result.warnings.map((w) => `- ${w}`).join("\n");
}

// ── Tier 1 convention checks (L2→L0 promotion) ─────────────────────────────

/**
 * Check for partial completion ban violations in a diff.
 * Detects lines in TASKS.md that mark a task [x] with a "(partial)" annotation.
 * Convention: tasks are either done [x] or not [ ] — never partially complete.
 * Pure function — no I/O.
 * @returns Array of violation descriptions (empty if none).
 */
export function checkPartialCompletionBan(diff: string): string[] {
  const violations: string[] = [];
  const blocks = diff.split(/^diff --git/m);

  for (const block of blocks) {
    const firstLine = block.split("\n")[0] ?? "";
    const fileMatch = firstLine.match(/ b\/(.+?)(?:\s|$)/);
    if (!fileMatch) continue;
    const filePath = fileMatch[1];
    if (!filePath.endsWith("TASKS.md")) continue;

    for (const line of block.split("\n")) {
      if (!line.startsWith("+")) continue;
      // Detect [x] with (partial) — case insensitive
      if (/\[x\].*\(partial\b/i.test(line)) {
        violations.push(
          `Partial completion ban: ${filePath} has [x] with (partial) annotation: ${line.slice(1).trim().slice(0, 120)}`,
        );
      }
    }
  }

  return violations;
}

/**
 * Patterns in task text that indicate the task requires code changes, not just documentation.
 * Used by D1 false completion detection.
 */
export const CODE_SIGNAL_PATTERNS: RegExp[] = [
  /\.(py|ts|tsx|js|jsx|sh|rs|go|java|c|cpp)\b/,
  /\bscript\b/i,
  /\bfunction\b/i,
  /\bimplement\b/i,
  /\bpipeline\b/i,
  /\bendpoint\b/i,
];

/**
 * Detect potential false task completions (D1 — task completion integrity).
 * Flags sessions that mark a task [x] in TASKS.md but only committed .md files,
 * when the task description implies code changes (mentions file extensions, scripts, etc.).
 * Pure function — no I/O.
 *
 * @param diff - unified diff output from the session
 * @param changedFiles - list of changed file paths
 * @returns Array of violation descriptions (empty if none).
 */
export function checkFalseTaskCompletion(
  diff: string,
  changedFiles: string[],
): string[] {
  if (changedFiles.length === 0) return [];

  const hasNonMdFiles = changedFiles.some((f) => !f.endsWith(".md"));
  if (hasNonMdFiles) return [];

  const violations: string[] = [];
  const blocks = diff.split(/^diff --git/m);

  for (const block of blocks) {
    const firstLine = block.split("\n")[0] ?? "";
    const fileMatch = firstLine.match(/ b\/(.+?)(?:\s|$)/);
    if (!fileMatch) continue;
    const filePath = fileMatch[1];
    if (!filePath.endsWith("TASKS.md")) continue;

    for (const line of block.split("\n")) {
      if (!line.startsWith("+")) continue;
      if (!/\[x\]/.test(line)) continue;
      const taskText = line.slice(1).trim();
      if (CODE_SIGNAL_PATTERNS.some((p) => p.test(taskText))) {
        violations.push(
          `Potential false task completion (D1): ${filePath} marks "${taskText.slice(0, 120)}" as complete, but session committed only .md files. Task implies code changes.`,
        );
      }
    }
  }

  return violations;
}

/**
 * Check incremental commit discipline.
 * Sessions with 10+ file changes but only 1 agent commit are likely deferring
 * all work to a single end-of-session commit — a workflow failure.
 * Pure function — no I/O.
 * @returns Warning string or null if OK.
 */
export function checkIncrementalCommits(
  filesChanged: number,
  agentCommitCount: number,
): string | null {
  if (filesChanged >= 10 && agentCommitCount <= 1) {
    return `Incremental commit violation: ${filesChanged} files changed but only ${agentCommitCount} agent commit(s). Sessions with 10+ file changes should have multiple intermediate commits.`;
  }
  return null;
}

/**
 * Check that a literature note contains a Verified field.
 * Literature notes must include "Verified: YYYY-MM-DD" or "Verified: false".
 * Only checks content that looks like a literature note (has Citation: line).
 * Pure function — no I/O.
 * @returns true if valid (has Verified field or not a literature note), false if violation.
 */
export function checkLiteratureVerified(content: string): boolean {
  // Only check files that look like literature notes (have a Citation: line)
  if (!content || !/^Citation:/m.test(content)) return true;
  return /^Verified:/m.test(content);
}

/** Threshold for zero-turn duration violation (60 seconds). */
export const ZERO_TURN_DURATION_THRESHOLD_MS = 60_000;

/**
 * Check for zero-turn session with long duration violation.
 * Sessions with 0 turns but duration > 60s indicate the LLM was never invoked.
 * This is an L0 violation (code-enforced).
 * Pure function — no I/O.
 * @returns true if violation (0 turns + duration > 60s), false otherwise.
 */
export function checkZeroTurnDurationViolation(
  numTurns: number | null | undefined,
  durationMs: number | null | undefined,
): boolean {
  return (
    numTurns === 0 &&
    durationMs !== null &&
    durationMs !== undefined &&
    durationMs > ZERO_TURN_DURATION_THRESHOLD_MS
  );
}

/**
 * Check that scripts with LLM/VLM API imports have model selection rationale
 * documented in the experiment's EXPERIMENT.md Config section.
 * Pure function — no I/O.
 *
 * @param scriptContent - Content of a Python/JS script file
 * @param experimentContent - Content of the corresponding EXPERIMENT.md
 * @returns true if no LLM imports found or rationale present, false if violation.
 */
export function checkModelSelectionRationale(
  scriptContent: string,
  experimentContent: string,
): boolean {
  // Check for LLM/VLM API usage patterns
  const llmPatterns = [
    /\bimport\s+openai\b/,
    /\bfrom\s+openai\b/,
    /\bimport\s+anthropic\b/,
    /\bfrom\s+anthropic\b/,
    /\bimport\s+google\.\w*ai\b/,
    /\bfrom\s+google\b.*\bai\b/,
    /gateway\.ai\.cloudflare\.com/,
    /\bopenai\.OpenAI\b/,
    /\bAnthropic\b\s*\(/,
    /\bgenai\b.*\bGenerativeModel\b/,
  ];

  const hasLlmUsage = llmPatterns.some((pattern) => pattern.test(scriptContent));
  if (!hasLlmUsage) return true;

  // Check for model selection rationale in EXPERIMENT.md
  const rationalePatterns = [
    /model.selection.guide/i,
    /model-capability-limits/i,
    /selected\s+per\b/i,
    /\bmodel\b.*\bselected\b/i,
    /\bselected\b.*\bmodel\b/i,
    /\bmodel\b.*\brationale\b/i,
  ];

  return rationalePatterns.some((pattern) => pattern.test(experimentContent));
}

/**
 * Check findings provenance in EXPERIMENT.md.
 * Per CLAUDE.md, every numerical claim in a Findings section must include either
 * (a) a script + data file reference, or (b) inline arithmetic from referenced data.
 * Pure function — no I/O.
 *
 * @param content - EXPERIMENT.md file content
 * @returns Array of violation descriptions (findings with numerical claims but no provenance).
 *          Empty array if no violations or no Findings section.
 */
export function checkFindingsProvenance(content: string): string[] {
  const violations: string[] = [];

  const frontmatter = parseExperimentFrontmatter(content);
  if (!frontmatter) return violations;
  if (frontmatter.get("status") !== "completed") return violations;

  const bodyMatch = content.match(/^---\n[\s\S]*?\n?---\n?([\s\S]*)$/);
  const body = bodyMatch ? bodyMatch[1] : content;

  const findingsMatch = body.match(/## Findings\s*\n([\s\S]*?)(?=\n## |\n---\s*$|$)/);
  if (!findingsMatch) return violations;
  const findingsText = findingsMatch[1];

  const findings = splitFindings(findingsText);

  for (const finding of findings) {
    if (!hasNumericalClaim(finding.text)) continue;
    if (!hasProvenance(finding.text)) {
      const preview = finding.text.split("\n")[0].slice(0, 120);
      violations.push(`Finding ${finding.number}: "${preview}"`);
    }
  }

  return violations;
}

/** Split a Findings section into individual finding blocks. */
function splitFindings(text: string): Array<{ number: number; text: string }> {
  const findings: Array<{ number: number; text: string }> = [];
  const lines = text.split("\n");
  let current: { number: number; lines: string[] } | null = null;

  for (const line of lines) {
    const findingStart = line.match(/^(?:\*\*F?\d+[:.]\*?\*?|\d+\.)\s/);
    if (findingStart) {
      if (current) {
        findings.push({ number: current.number, text: current.lines.join("\n") });
      }
      const numMatch = line.match(/(\d+)/);
      current = { number: numMatch ? parseInt(numMatch[1], 10) : 0, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) {
    findings.push({ number: current.number, text: current.lines.join("\n") });
  }

  return findings;
}

const NUMERICAL_CLAIM_RE = /\d+\.?\d*%|\b\d+\.\d{1,4}\b|\b\d+\/\d+\b/;

/** Detect numerical claims that require provenance. */
function hasNumericalClaim(text: string): boolean {
  return NUMERICAL_CLAIM_RE.test(text);
}

const PROVENANCE_MARKERS = [
  /\bProvenance\b/i,
  /`[^`]*\.(py|csv|json|ts|js|jsonl|yaml|md)`/,
  /`[^`]*\/[^`]+`/,
  /\b\w+\.(py|csv|json|jsonl)\b/,
  /\d+\s*\/\s*\d+\s*=\s*\d/,
  /\(\d+\s*\/\s*\d+\b/,
  /\bresults?\//i,
  /\banalysis\//i,
  /\bexperiments?\//i,
  /\bcomputed\b/i,
  /\bcalculated\b/i,
  /\bderived from\b/i,
  /\bsee\s+`/i,
  /\boutput of\b/i,
  /\bscript\b/i,
];

/** Check if finding text contains provenance markers. */
function hasProvenance(text: string): boolean {
  return PROVENANCE_MARKERS.some((re) => re.test(text));
}

// ── Actionable implication task gate (ADR 0060) ─────────────────────────

/** Signal phrases that indicate an observation about missing work. */
const ACTIONABLE_IMPLICATION_PHRASES = [
  // Future-directive
  /\bshould\s+(use|be|have|include|run|create|add|update|generate|produce)\b/i,
  /\bneeds?\s+to\b/i,
  /\bmust\s+(be|have|include)\b/i,
  /\brequires?\s+(a|an|the|further|additional)\b/i,
  // Gap-identifying
  /\bgap\b/i,
  /\bmissing\b/i,
  /\bnot\s+yet\b/i,
  /\bno\s+task\b/i,
  /\bnot\s+covered\b/i,
  // Work-identifying
  /\bnext\s+step/i,
  /\bfollow-?up\b/i,
  /\bfuture\s+work\b/i,
  /\bremains?\s+to\s+be\b/i,
];

/**
 * Check if a session modified EXPERIMENT.md Findings/Implications or
 * diagnosis/postmortem Recommendations/Next steps or
 * architecture/synthesis reports with actionable language
 * but did not also modify any TASKS.md file. Per ADR 0060, observations
 * about missing work must generate tasks.
 * Pure function — no I/O.
 *
 * @param diff - unified diff output (`git diff -U0 before..HEAD`)
 * @param changedFiles - list of changed file paths from the session
 * @returns Array of violation descriptions. Empty if no violations.
 */
export function checkActionableImplications(
  diff: string,
  changedFiles: string[],
): string[] {
  const violations: string[] = [];

  // If any TASKS.md was modified, the session engaged with the task pipeline — pass
  const touchedTasks = changedFiles.some((f) => f.endsWith("/TASKS.md") || f === "TASKS.md");
  if (touchedTasks) return violations;

  // Find EXPERIMENT.md, diagnosis, postmortem, architecture, and synthesis files in the diff
  const actionableFiles = changedFiles.filter(
    (f) =>
      EXPERIMENT_MD_RE.test(f.trim()) ||
      DIAGNOSIS_MD_RE.test(f.trim()) ||
      POSTMORTEM_MD_RE.test(f.trim()) ||
      ARCHITECTURE_MD_RE.test(f.trim()) ||
      SYNTHESIS_MD_RE.test(f.trim()),
  );
  if (actionableFiles.length === 0) return violations;

  // Parse the diff to find added lines in relevant sections
  const diffLines = diff.split("\n");
  let currentFile = "";
  let inActionableSection = false;
  let fileType: "experiment" | "diagnosis" | "postmortem" | "architecture" | "synthesis" | null = null;

  for (const line of diffLines) {
    // Track current file from diff headers
    const fileMatch = line.match(/^\+\+\+ b\/(.*)/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      inActionableSection = false;
      fileType = null;
      continue;
    }

    // Determine file type and check if relevant
    if (EXPERIMENT_MD_RE.test(currentFile)) {
      fileType = "experiment";
    } else if (DIAGNOSIS_MD_RE.test(currentFile)) {
      fileType = "diagnosis";
    } else if (POSTMORTEM_MD_RE.test(currentFile)) {
      fileType = "postmortem";
    } else if (ARCHITECTURE_MD_RE.test(currentFile)) {
      fileType = "architecture";
    } else if (SYNTHESIS_MD_RE.test(currentFile)) {
      fileType = "synthesis";
    } else {
      continue;
    }

    // Detect section headers based on file type
    if (line.startsWith("+")) {
      let sectionMatch = false;

      if (fileType === "experiment") {
        // EXPERIMENT.md: Findings or Implications sections
        sectionMatch = /^[+]\s*##\s*(Findings|Implications)/i.test(line);
      } else if (fileType === "diagnosis" || fileType === "postmortem") {
        // Diagnosis/Postmortem: Recommendations or Next steps sections
        sectionMatch = /^[+]\s*##\s*(Recommendations|Next\s+steps)/i.test(line);
      } else if (fileType === "architecture") {
        // Architecture: Recommendation, Implementation Priority, Risk Assessment sections
        sectionMatch = /^[+]\s*##\s*(Recommendation|Implementation\s+Priority|Risk\s+Assessment)/i.test(line);
      } else if (fileType === "synthesis") {
        // Synthesis: Implications section
        sectionMatch = /^[+]\s*##\s*Implications/i.test(line);
      }

      if (sectionMatch) {
        inActionableSection = true;
        continue;
      }
    }

    // A new ## section ends the actionable section
    if (line.startsWith("+") && /^[+]\s*##\s+[^#]/.test(line)) {
      const isExperimentSection = /Findings|Implications/i.test(line);
      const isDiagnosisPostmortemSection = /Recommendations|Next\s+steps/i.test(line);
      const isArchitectureSection = /Recommendation|Implementation\s+Priority|Risk\s+Assessment/i.test(line);
      const isSynthesisSection = /^##\s+Implications/i.test(line.slice(1));
      if (!isExperimentSection && !isDiagnosisPostmortemSection && !isArchitectureSection && !isSynthesisSection) {
        inActionableSection = false;
        continue;
      }
    }

    // Check added lines in actionable sections for actionable phrases
    if (inActionableSection && line.startsWith("+") && !line.startsWith("+++")) {
      const content = line.slice(1); // Remove the leading +
      for (const phrase of ACTIONABLE_IMPLICATION_PHRASES) {
        if (phrase.test(content)) {
          const preview = content.trim().slice(0, 100);
          const sectionLabel =
            fileType === "experiment"
              ? "Findings/Implications"
              : fileType === "diagnosis" || fileType === "postmortem"
                ? "Recommendations/Next steps"
                : fileType === "architecture"
                  ? "Recommendation/Implementation Priority/Risk Assessment"
                  : "Implications";
          violations.push(
            `${currentFile} — ${sectionLabel} contain actionable language ("${preview}") but no TASKS.md was modified`,
          );
          // One violation per file is enough
          inActionableSection = false;
          break;
        }
      }
    }
  }

  return violations;
}

// ── Visual artifact enforcement (ADR 0057) ──────────────────────────────

/** UI file extensions that indicate visual/frontend changes. */
const UI_FILE_EXTENSIONS = /\.(html|jinja|jinja2|css|scss|less|tsx|jsx|vue|svelte)$/;

/** JS/TS files in UI-specific directory paths. */
const UI_DIRECTORY_PATTERN = /\/(templates?|static|components?|views?|pages?|layouts?|ui)\/.+\.(js|ts)$/;

/** Image file extensions that qualify as screenshot artifacts. */
const SCREENSHOT_ARTIFACT_RE = /\.(png|webp|jpg|jpeg)$/;

/** Example-webapp UI paths that require screenshot verification. */
const EXAMPLE_WEBAPP_UI_PATHS = [
  /^modules\/example-webapp\/templates?\//,
  /^modules\/example-webapp\/static\/css\//,
  /^modules\/example-webapp\/static\/js\//,
];

/** Example-webapp artifact paths that satisfy screenshot requirement. */
const EXAMPLE_WEBAPP_ARTIFACT_PATHS = [
  /^modules\/example-webapp\/tests\/artifacts\//,
  /^modules\/example-webapp\/screenshots?\//,
];

/**
 * Check if a session that modified UI files also committed screenshot artifacts.
 * Per ADR 0057, autonomous UI work must include visual verification artifacts
 * (screenshots) committed alongside template/CSS/JS changes.
 * Pure function — no I/O.
 *
 * @param changedFiles - list of changed file paths from the session diff
 * @returns object with violation flag and list of UI files that triggered the check
 */
export function checkVisualArtifactViolation(
  changedFiles: string[],
): { violation: boolean; uiFiles: string[] } {
  const uiFiles = changedFiles.filter(
    (f) => UI_FILE_EXTENSIONS.test(f) || UI_DIRECTORY_PATTERN.test(f),
  );

  if (uiFiles.length === 0) {
    return { violation: false, uiFiles: [] };
  }

  const hasScreenshots = changedFiles.some((f) => SCREENSHOT_ARTIFACT_RE.test(f));

  return { violation: !hasScreenshots, uiFiles };
}

/**
 * Check if any changed files are example-webapp UI paths.
 * Pure function — no I/O.
 */
export function hasExampleWebappUIChanges(changedFiles: string[]): boolean {
  return changedFiles.some((f) => EXAMPLE_WEBAPP_UI_PATHS.some((p) => p.test(f)));
}

/**
 * Check if any changed files are example-webapp artifact paths.
 * Pure function — no I/O.
 */
export function hasExampleWebappArtifacts(changedFiles: string[]): boolean {
  return changedFiles.some((f) => EXAMPLE_WEBAPP_ARTIFACT_PATHS.some((p) => p.test(f)));
}

/**
 * Check example-webapp submodule for UI changes without screenshot artifacts.
 * When the submodule pointer is updated, runs git diff inside the submodule
 * to detect template/CSS/JS changes and verifies screenshot artifacts exist.
 *
 * @param cwd - main repo root directory
 * @param headBefore - commit hash before session
 * @returns violation info or null if no violation
 */
async function checkExampleWebappSubmoduleViolation(
  cwd: string,
  headBefore: string | null,
): Promise<{ uiFiles: string[]; submodulePointerChanged: boolean } | null> {
  if (!headBefore) return null;

  try {
    const { stdout: changedOutput } = await exec(
      "git",
      ["diff", "--name-only", headBefore, "HEAD"],
      { cwd },
    );
    const changedFiles = changedOutput.split("\n").filter((f) => f.trim());

    const submodulePointerChanged = changedFiles.includes("modules/example-webapp");
    if (!submodulePointerChanged) return null;

    const submodulePath = join(cwd, "modules", "example-webapp");

    try {
      await stat(submodulePath);
    } catch {
      return null;
    }

    const { stdout: submoduleDiff } = await exec(
      "git",
      ["diff", "--name-only", "HEAD~1", "HEAD"],
      { cwd: submodulePath },
    );

    const submoduleChangedFiles = submoduleDiff
      .split("\n")
      .filter((f) => f.trim())
      .map((f) => `modules/example-webapp/${f.trim()}`);

    const uiFiles = submoduleChangedFiles.filter((f) =>
      EXAMPLE_WEBAPP_UI_PATHS.some((p) => p.test(f)),
    );

    if (uiFiles.length === 0) return null;

    const hasArtifacts = submoduleChangedFiles.some((f) =>
      EXAMPLE_WEBAPP_ARTIFACT_PATHS.some((p) => p.test(f)),
    );

    if (hasArtifacts) return null;

    return { uiFiles: uiFiles.slice(0, 5), submodulePointerChanged: true };
  } catch {
    return null;
  }
}

/**
 * Check that a completed, resource-consuming EXPERIMENT.md has model and backend
 * in frontmatter. Pure function — no I/O. (ADR 0043)
 *
 * @param experimentContent - Content of EXPERIMENT.md
 * @returns object with missing fields, or null if no check needed
 */
export function checkModelBackendProvenance(
  experimentContent: string,
): { missingModel: boolean; missingBackend: boolean; missingModelLine: boolean } | null {
  const frontmatter = parseExperimentFrontmatter(experimentContent);
  if (!frontmatter) return null;

  const status = frontmatter.get("status");
  const consumes = frontmatter.get("consumes_resources");

  // Only check completed + resource-consuming records
  if (status !== "completed" || consumes !== "true") return null;

  const missingModel = !frontmatter.get("model");
  const missingBackend = !frontmatter.get("backend");

  // Check for Model: line in Config or Method section body
  const bodyMatch = experimentContent.match(/^---\n[\s\S]*?\n?---\n?([\s\S]*)$/);
  const body = bodyMatch ? bodyMatch[1] : experimentContent;
  const missingModelLine = !/^Model:/m.test(body);

  return { missingModel, missingBackend, missingModelLine };
}
