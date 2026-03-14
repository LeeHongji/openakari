/** Tests for knowledge counting, file patterns, and metrics in verify.ts. */

import { describe, it, expect } from "vitest";
import { parseKnowledgeFromDiff, parseCrossProjectMetrics, parseQualityAuditMetrics, PROJECT_README_RE, EXPERIMENT_MD_RE } from "./verify.js";

describe("PROJECT_README_RE", () => {
  it("matches top-level project READMEs", () => {
    expect(PROJECT_README_RE.test("projects/akari/README.md")).toBe(true);
    expect(PROJECT_README_RE.test("projects/sample-project/README.md")).toBe(true);
  });

  it("matches nested subdirectory READMEs", () => {
    expect(PROJECT_README_RE.test("projects/akari/log/README.md")).toBe(true);
  });

  it("rejects non-project paths", () => {
    expect(PROJECT_README_RE.test("README.md")).toBe(false);
    expect(PROJECT_README_RE.test("docs/README.md")).toBe(false);
    expect(PROJECT_README_RE.test("infra/scheduler/README.md")).toBe(false);
  });

  it("rejects non-README files under projects", () => {
    expect(PROJECT_README_RE.test("projects/akari/EXPERIMENT.md")).toBe(false);
    expect(PROJECT_README_RE.test("projects/sample-project/budget.yaml")).toBe(false);
  });
});

describe("EXPERIMENT_MD_RE", () => {
  it("matches EXPERIMENT.md files under projects/*/experiments/", () => {
    expect(EXPERIMENT_MD_RE.test("projects/akari/experiments/test/EXPERIMENT.md")).toBe(true);
    expect(EXPERIMENT_MD_RE.test("projects/sample-project/experiments/flash-240/EXPERIMENT.md")).toBe(true);
    expect(EXPERIMENT_MD_RE.test("projects/tree-gen-project/experiments/vlm-scoring/EXPERIMENT.md")).toBe(true);
  });

  it("rejects EXPERIMENT.md files outside experiments directory", () => {
    expect(EXPERIMENT_MD_RE.test("projects/akari/EXPERIMENT.md")).toBe(false);
    expect(EXPERIMENT_MD_RE.test("projects/akari/results/EXPERIMENT.md")).toBe(false);
  });

  it("rejects non-EXPERIMENT.md files under experiments directory", () => {
    expect(EXPERIMENT_MD_RE.test("projects/akari/experiments/test/config.yaml")).toBe(false);
    expect(EXPERIMENT_MD_RE.test("projects/akari/experiments/test/results.csv")).toBe(false);
  });

  it("rejects non-project paths", () => {
    expect(EXPERIMENT_MD_RE.test("experiments/test/EXPERIMENT.md")).toBe(false);
    expect(EXPERIMENT_MD_RE.test("docs/experiments/test/EXPERIMENT.md")).toBe(false);
  });
});

// ── Knowledge counting tests ────────────────────────────────────────────────

describe("parseKnowledgeFromDiff", () => {
  // ── Existing detection: EXPERIMENT.md findings ──

  it("counts numbered findings in EXPERIMENT.md diffs", () => {
    const diff = `diff --git a/projects/akari/experiments/test/EXPERIMENT.md b/projects/akari/experiments/test/EXPERIMENT.md
--- a/projects/akari/experiments/test/EXPERIMENT.md
+++ b/projects/akari/experiments/test/EXPERIMENT.md
@@ -10,0 +11,3 @@
+1. First finding about detection rates.
+2. Second finding about false positives.
+3. Third finding about coverage.
`;
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/experiments/test/EXPERIMENT.md",
    ]);
    expect(result.newExperimentFindings).toBe(3);
  });

  // ── Existing detection: decision records ──

  it("counts new decision records", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "decisions/0021-new-convention.md",
      "decisions/0022-another-decision.md",
    ], new Set(["decisions/0021-new-convention.md", "decisions/0022-another-decision.md"]));
    expect(result.newDecisionRecords).toBe(2);
  });

  it("does not count modified (existing) decision records", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "decisions/0001-existing.md",
    ], new Set()); // empty set = all files existed before
    expect(result.newDecisionRecords).toBe(0);
  });

  // ── Existing detection: literature notes ──

  it("counts new literature notes", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "projects/sample-project/literature/wu2024-gpteval3d.md",
    ], new Set(["projects/sample-project/literature/wu2024-gpteval3d.md"]));
    expect(result.newLiteratureNotes).toBe(1);
  });

  // ── Existing detection: experiments completed ──

  it("counts completed experiments from status lines", () => {
    const diff = `diff --git a/projects/akari/experiments/test/EXPERIMENT.md b/projects/akari/experiments/test/EXPERIMENT.md
--- a/projects/akari/experiments/test/EXPERIMENT.md
+++ b/projects/akari/experiments/test/EXPERIMENT.md
@@ -5 +5 @@
-status: planned
+status: completed
`;
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/experiments/test/EXPERIMENT.md",
    ]);
    expect(result.experimentsCompleted).toBe(1);
  });

  // ── Existing detection: tasks created ──

  it("counts new unchecked tasks in TASKS.md diffs", () => {
    const diff = `diff --git a/projects/akari/TASKS.md b/projects/akari/TASKS.md
--- a/projects/akari/TASKS.md
+++ b/projects/akari/TASKS.md
@@ -10,0 +11,2 @@
+- [ ] New task one [fleet-eligible]
+- [ ] New task two [requires-opus]
`;
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/TASKS.md",
    ]);
    expect(result.tasksCreated).toBe(2);
  });

  it("does not count checked tasks in TASKS.md diffs", () => {
    const diff = `diff --git a/projects/akari/TASKS.md b/projects/akari/TASKS.md
--- a/projects/akari/TASKS.md
+++ b/projects/akari/TASKS.md
@@ -10,0 +11,2 @@
+- [x] Completed task
+- [ ] Open task
`;
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/TASKS.md",
    ]);
    expect(result.tasksCreated).toBe(1);
  });

  it("does not count tasks in non-TASKS.md files", () => {
    const diff = `diff --git a/projects/akari/README.md b/projects/akari/README.md
--- a/projects/akari/README.md
+++ b/projects/akari/README.md
@@ -10,0 +11,2 @@
+- [ ] This looks like a task but is in README
+- [ ] Another fake task
`;
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/README.md",
    ]);
    expect(result.tasksCreated).toBe(0);
  });

  it("counts tasks added even when modifying existing tasks", () => {
    const diff = `diff --git a/projects/akari/TASKS.md b/projects/akari/TASKS.md
--- a/projects/akari/TASKS.md
+++ b/projects/akari/TASKS.md
@@ -5 +5 @@
-- [ ] Old task text
+- [ ] Updated task text with more details
`;
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/TASKS.md",
    ]);
    // Note: This counts the added line, even though it's a modification.
    // The metric tracks unchecked task lines added to TASKS.md.
    expect(result.tasksCreated).toBe(1);
  });

  // ── NEW: analysis files ──

  it("counts new analysis markdown files", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "projects/sample-project/analysis/mesh-quality-analysis.md",
      "projects/sample-project/analysis/tier-voting-results.md",
    ], new Set([
      "projects/sample-project/analysis/mesh-quality-analysis.md",
      "projects/sample-project/analysis/tier-voting-results.md",
    ]));
    expect(result.newAnalysisFiles).toBe(2);
  });

  it("does not count modified analysis files as new", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "projects/sample-project/analysis/existing-analysis.md",
    ], new Set()); // existed before
    expect(result.newAnalysisFiles).toBe(0);
  });

  it("does not count non-markdown analysis files", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "projects/sample-project/analysis/import-full-dataset.py",
    ], new Set(["projects/sample-project/analysis/import-full-dataset.py"]));
    expect(result.newAnalysisFiles).toBe(0);
  });

  // ── NEW: log entry findings ──

  it("counts numbered findings in README log entries", () => {
    const diff = `diff --git a/projects/akari/README.md b/projects/akari/README.md
--- a/projects/akari/README.md
+++ b/projects/akari/README.md
@@ -15,0 +15,10 @@
+### 2026-02-19 — Session summary
+
+**Key findings:**
+1. Knowledge metric detection is severely undercounting.
+2. Uncommitted file accumulation is the primary SOP failure mode.
+3. Session average duration is 9.5 min vs 60-min budget.
+
+Sources: sessions.jsonl
`;
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/README.md",
    ]);
    expect(result.logEntryFindings).toBe(3);
  });

  it("does not double-count EXPERIMENT.md findings as log entry findings", () => {
    const diff = `diff --git a/projects/akari/experiments/test/EXPERIMENT.md b/projects/akari/experiments/test/EXPERIMENT.md
@@ -10,0 +11,2 @@
+1. Finding in experiment file.
+2. Another experiment finding.
`;
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/experiments/test/EXPERIMENT.md",
    ]);
    // These should only count as experiment findings, not log entry findings
    expect(result.newExperimentFindings).toBe(2);
    expect(result.logEntryFindings).toBe(0);
  });

  it("counts findings in README log but not in task/action sections", () => {
    // Lines in "Next actions" should not be counted
    const diff = `diff --git a/projects/akari/README.md b/projects/akari/README.md
@@ -100,0 +100,5 @@
+### 2026-02-19 — Session
+
+1. Real finding in a log entry.
+
+- [ ] 1. This is a task, not a finding
`;
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/README.md",
    ]);
    expect(result.logEntryFindings).toBe(1);
  });

  // ── NEW: infra code changes ──

  it("counts new and modified infra source files, excluding tests", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "infra/scheduler/src/budget-gate.ts",       // new source
      "infra/scheduler/src/budget-gate.test.ts",   // new test — excluded
      "infra/experiment-runner/run.py",             // modified source
    ], new Set([
      "infra/scheduler/src/budget-gate.ts",
      "infra/scheduler/src/budget-gate.test.ts",
    ]));
    expect(result.infraCodeChanges).toBe(2);
  });

  it("counts modified infra source files", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "infra/scheduler/src/verify.ts",
      "infra/scheduler/src/metrics.ts",
    ], new Set()); // both existed before = modifications
    expect(result.infraCodeChanges).toBe(2);
  });

  it("does not count infra test files as code changes", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "infra/scheduler/src/verify.test.ts",
      "infra/scheduler/src/chat.test.ts",
    ], new Set());
    expect(result.infraCodeChanges).toBe(0);
  });

  it("does not count infra config files as code changes", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "infra/scheduler/package.json",
      "infra/scheduler/tsconfig.json",
      "infra/scheduler/vitest.config.ts",
    ], new Set());
    expect(result.infraCodeChanges).toBe(0);
  });

  it("does not count Python test_ prefixed files as code changes", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "infra/experiment-validator/test_validate.py",
    ], new Set());
    expect(result.infraCodeChanges).toBe(0);
  });

  // ── NEW: bugfix verifications ──

  it("counts bugfix experiments with verification sections", () => {
    const diff = `diff --git a/projects/akari/experiments/fix-race-condition/EXPERIMENT.md b/projects/akari/experiments/fix-race-condition/EXPERIMENT.md
@@ -3 +3 @@
-status: planned
+status: completed
@@ -10,0 +11,5 @@
+## Verification
+
+Before: race condition triggered in 3/10 runs.
+After: 0/10 runs with race condition.
+Regression test added: chat.test.ts "handles concurrent confirmations"
`;
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/experiments/fix-race-condition/EXPERIMENT.md",
    ]);
    expect(result.bugfixVerifications).toBe(1);
  });

  it("does not count verification sections outside EXPERIMENT.md", () => {
    const diff = `diff --git a/projects/akari/README.md b/projects/akari/README.md
@@ -10,0 +11,3 @@
+## Verification
+
+Tested and confirmed working.
`;
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/README.md",
    ]);
    expect(result.bugfixVerifications).toBe(0);
  });

  // ── Combined detection ──

  it("correctly counts a typical session with mixed output types", () => {
    const diff = `diff --git a/projects/akari/experiments/spot-check/EXPERIMENT.md b/projects/akari/experiments/spot-check/EXPERIMENT.md
@@ -3 +3 @@
-status: planned
+status: completed
@@ -20,0 +21,3 @@
+1. Zero false positives on 87 experiments.
+2. Two validators implemented: CSV row count and config n_runs.
diff --git a/projects/akari/README.md b/projects/akari/README.md
@@ -15,0 +15,6 @@
+### 2026-02-19 — Spot check validator
+
+1. Implemented spot-check validator for EXPERIMENT.md claims.
+2. TDD workflow: 13 new tests, all passing.
`;
    const changedFiles = [
      "projects/akari/experiments/spot-check/EXPERIMENT.md",
      "projects/akari/README.md",
      "projects/akari/analysis/validation-coverage.md",
      "infra/experiment-validator/validate.py",
      "infra/experiment-validator/validate_test.py",
    ];
    const newFiles = new Set([
      "projects/akari/analysis/validation-coverage.md",
    ]);
    const result = parseKnowledgeFromDiff(diff, changedFiles, newFiles);
    expect(result.newExperimentFindings).toBe(2);
    expect(result.logEntryFindings).toBe(2);
    expect(result.newAnalysisFiles).toBe(1);
    expect(result.infraCodeChanges).toBe(1); // validate.py (not test file)
    expect(result.experimentsCompleted).toBe(1);
  });

  // ── Edge cases ──

  it("returns zeros for empty diff and no changed files", () => {
    const result = parseKnowledgeFromDiff("", []);
    expect(result.newExperimentFindings).toBe(0);
    expect(result.newDecisionRecords).toBe(0);
    expect(result.newLiteratureNotes).toBe(0);
    expect(result.newAnalysisFiles).toBe(0);
    expect(result.logEntryFindings).toBe(0);
    expect(result.infraCodeChanges).toBe(0);
    expect(result.bugfixVerifications).toBe(0);
    expect(result.structuralChanges).toBe(0);
    expect(result.feedbackProcessed).toBe(0);
    expect(result.diagnosesCompleted).toBe(0);
  });

  it("handles diff with no added lines (deletions only)", () => {
    const diff = `diff --git a/projects/akari/README.md b/projects/akari/README.md
@@ -5,2 +5 @@
-Old line 1
-Old line 2
`;
    const result = parseKnowledgeFromDiff(diff, ["projects/akari/README.md"]);
    expect(result.newExperimentFindings).toBe(0);
    expect(result.logEntryFindings).toBe(0);
  });

  // ── NEW: compound actions ──

  it("counts CLAUDE.md changes as compound actions", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "CLAUDE.md",
    ], new Set());
    expect(result.compoundActions).toBe(1);
  });

  it("counts skill file changes as compound actions", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      ".claude/skills/orient/SKILL.md",
      ".claude/skills/compound/SKILL.md",
    ], new Set());
    expect(result.compoundActions).toBe(2);
  });

  it("counts new decision records as compound actions", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "decisions/0021-new-convention.md",
    ], new Set(["decisions/0021-new-convention.md"]));
    expect(result.compoundActions).toBe(1);
    // Also counted as a decision record
    expect(result.newDecisionRecords).toBe(1);
  });

  it("counts modified decision records as compound actions", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "decisions/0005-autonomous-execution.md",
    ], new Set());
    expect(result.compoundActions).toBe(1);
    // Modified decisions are not new decision records
    expect(result.newDecisionRecords).toBe(0);
  });

  it("counts pattern doc changes as compound actions", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/patterns/skills-architecture.md",
      "projects/akari/patterns/autonomous-execution.md",
    ], new Set());
    expect(result.compoundActions).toBe(2);
  });

  it("does not count non-compound files", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/README.md",
      "infra/scheduler/src/verify.ts",
      "projects/sample-project/analysis/results.md",
    ], new Set());
    expect(result.compoundActions).toBe(0);
  });

  it("counts compound actions in a mixed session", () => {
    const diff = `diff --git a/projects/akari/experiments/test/EXPERIMENT.md b/projects/akari/experiments/test/EXPERIMENT.md
@@ -10,0 +11,2 @@
+1. Finding about compound actions.
`;
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/experiments/test/EXPERIMENT.md",
      "CLAUDE.md",
      ".claude/skills/orient/SKILL.md",
      "decisions/0021-compound-metric.md",
      "infra/scheduler/src/verify.ts",
    ], new Set(["decisions/0021-compound-metric.md"]));
    expect(result.compoundActions).toBe(3); // CLAUDE.md + skill + decision
    expect(result.newExperimentFindings).toBe(1);
    expect(result.newDecisionRecords).toBe(1);
    expect(result.infraCodeChanges).toBe(1);
  });

  it("counts SOP file changes as compound actions", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "docs/sops/autonomous-work-cycle.md",
    ], new Set());
    expect(result.compoundActions).toBe(1);
  });

  // ── NEW: structural changes ──

  it("counts TASKS.md changes as structural changes", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/TASKS.md",
      "projects/sample-project/TASKS.md",
    ], new Set());
    expect(result.structuralChanges).toBe(2);
  });

  it("counts APPROVAL_QUEUE.md as a structural change", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "APPROVAL_QUEUE.md",
    ], new Set());
    expect(result.structuralChanges).toBe(1);
  });

  it("counts budget and ledger files as structural changes", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "projects/sample-project/budget.yaml",
      "projects/sample-project/ledger.yaml",
    ], new Set());
    expect(result.structuralChanges).toBe(2);
  });

  it("counts completed-tasks.md and log archive files as structural changes", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "projects/sample-project/completed-tasks.md",
      "projects/sample-project/log/2026-02-20-venue-selection.md",
    ], new Set([
      "projects/sample-project/log/2026-02-20-venue-selection.md",
    ]));
    expect(result.structuralChanges).toBe(2);
  });

  it("counts docs/ changes as structural changes", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "docs/status.md",
      "docs/roadmap.md",
      "docs/model-capability-limits.md",
    ], new Set());
    expect(result.structuralChanges).toBe(3);
  });

  it("does not double-count compound action files as structural changes", () => {
    // CLAUDE.md, skills, decisions, SOPs are already compound actions — structural should not count them
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "CLAUDE.md",
      ".claude/skills/orient/SKILL.md",
      "decisions/0030-tiered-orient.md",
      "docs/sops/autonomous-work-cycle.md",
    ], new Set(["decisions/0030-tiered-orient.md"]));
    expect(result.structuralChanges).toBe(0);
    expect(result.compoundActions).toBe(4);
  });

  it("does not count project source code or experiment files as structural", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "infra/scheduler/src/verify.ts",
      "projects/akari/experiments/test/EXPERIMENT.md",
      "projects/akari/README.md",
    ], new Set());
    expect(result.structuralChanges).toBe(0);
  });

  // ── NEW: feedback processed ──

  it("counts new feedback files", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/feedback/feedback-orient-weight.md",
      "projects/akari/feedback/feedback-token-efficiency.md",
    ], new Set([
      "projects/akari/feedback/feedback-orient-weight.md",
      "projects/akari/feedback/feedback-token-efficiency.md",
    ]));
    expect(result.feedbackProcessed).toBe(2);
  });

  it("does not count modified feedback files as new", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/feedback/feedback-orient-weight.md",
    ], new Set());
    expect(result.feedbackProcessed).toBe(0);
  });

  // ── NEW: diagnoses completed ──

  it("counts new diagnosis files", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/diagnosis/diagnosis-flash-240-crash.md",
    ], new Set([
      "projects/akari/diagnosis/diagnosis-flash-240-crash.md",
    ]));
    expect(result.diagnosesCompleted).toBe(1);
  });

  it("counts new postmortem files", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/postmortem/postmortem-hallucination-2026-02-19.md",
    ], new Set([
      "projects/akari/postmortem/postmortem-hallucination-2026-02-19.md",
    ]));
    expect(result.diagnosesCompleted).toBe(1);
  });

  it("counts both diagnosis and postmortem files together", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/diagnosis/diagnosis-budget-issue.md",
      "projects/sample-project/postmortem/postmortem-retry-waste.md",
    ], new Set([
      "projects/akari/diagnosis/diagnosis-budget-issue.md",
      "projects/sample-project/postmortem/postmortem-retry-waste.md",
    ]));
    expect(result.diagnosesCompleted).toBe(2);
  });

  it("does not count modified diagnosis files as new", () => {
    const diff = "";
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/diagnosis/diagnosis-old-issue.md",
    ], new Set());
    expect(result.diagnosesCompleted).toBe(0);
  });

  // ── NEW: findings in analysis and diagnosis files (### Finding N: headers) ──

  it("counts ### Finding N: headers in analysis file diffs", () => {
    const diff = `diff --git a/projects/akari/analysis/bootstrap-metrics.md b/projects/akari/analysis/bootstrap-metrics.md
--- /dev/null
+++ b/projects/akari/analysis/bootstrap-metrics.md
@@ -0,0 +1,15 @@
+# Bootstrap Metrics Snapshot
+
+### Finding 1: Orient overhead unchanged by fast tier
+The fast orient tier did not reduce overhead percentage.
+
+### Finding 2: Knowledge accounting undercounts
+Sessions record 0 findings despite producing analysis artifacts.
+
+### Finding 3: Self-improvement loop completed in 2 sessions
+The bootstrap orient optimization was a full detect-implement-measure loop.
`;
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/analysis/bootstrap-metrics.md",
    ], new Set(["projects/akari/analysis/bootstrap-metrics.md"]));
    expect(result.logEntryFindings).toBe(3);
  });

  it("counts ### Finding N: headers in diagnosis file diffs", () => {
    const diff = `diff --git a/projects/akari/diagnosis/knowledge-accounting.md b/projects/akari/diagnosis/knowledge-accounting.md
--- /dev/null
+++ b/projects/akari/diagnosis/knowledge-accounting.md
@@ -0,0 +1,10 @@
+# Diagnosis: Knowledge Accounting
+
+### Finding 1: File filter too narrow
+Only EXPERIMENT.md and README.md are scanned.
+
+### Finding 2: Regex format mismatch
+Analysis files use headers, not numbered lists.
`;
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/diagnosis/knowledge-accounting.md",
    ], new Set(["projects/akari/diagnosis/knowledge-accounting.md"]));
    expect(result.logEntryFindings).toBe(2);
  });

  it("does not count ### Finding headers in README.md (already covered by existing logic)", () => {
    const diff = `diff --git a/projects/akari/README.md b/projects/akari/README.md
@@ -15,0 +15,5 @@
+### 2026-03-14 — Session summary
+
+### Finding 1: Something discovered
+This is a finding in a README log entry.
`;
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/README.md",
    ]);
    // README findings are counted by the existing numbered-list logic (block 7),
    // not the ### Finding N: header logic. This test ensures no double-counting.
    expect(result.logEntryFindings).toBe(0);
  });

  it("counts findings from analysis files in a mixed commit", () => {
    const diff = `diff --git a/projects/akari/experiments/test/EXPERIMENT.md b/projects/akari/experiments/test/EXPERIMENT.md
@@ -10,0 +11,2 @@
+1. Experiment finding one.
+2. Experiment finding two.
diff --git a/projects/akari/analysis/intervention-rate.md b/projects/akari/analysis/intervention-rate.md
--- /dev/null
+++ b/projects/akari/analysis/intervention-rate.md
@@ -0,0 +1,8 @@
+# Human Intervention Rate
+
+### Finding 1: Interventions are infrastructure-only
+No research-directed human interventions observed.
+
+### Finding 2: Rate decreased over time
+Window A: 0.5, Window B: 0.0.
`;
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/experiments/test/EXPERIMENT.md",
      "projects/akari/analysis/intervention-rate.md",
    ], new Set(["projects/akari/analysis/intervention-rate.md"]));
    expect(result.newExperimentFindings).toBe(2);
    expect(result.logEntryFindings).toBe(2);
    expect(result.newAnalysisFiles).toBe(1);
  });

  it("does not count ### Finding headers in non-analysis/diagnosis files", () => {
    const diff = `diff --git a/projects/akari/knowledge/domain-facts.md b/projects/akari/knowledge/domain-facts.md
@@ -0,0 +1,5 @@
+# Domain Facts
+
+### Finding 1: Not a real finding
+This is in a knowledge file, not analysis or diagnosis.
`;
    const result = parseKnowledgeFromDiff(diff, [
      "projects/akari/knowledge/domain-facts.md",
    ], new Set(["projects/akari/knowledge/domain-facts.md"]));
    expect(result.logEntryFindings).toBe(0);
  });
});

// ── Cross-project utilization metrics ────────────────────────────────────────

describe("parseCrossProjectMetrics", () => {
  it("detects projects touched from changed files", () => {
    const result = parseCrossProjectMetrics("", [
      "projects/akari/README.md",
      "projects/sample-project/TASKS.md",
      "CLAUDE.md",
    ]);
    expect([...result.projectsTouched].sort()).toEqual(["akari", "sample-project"]);
    expect(result.crossProjectRefs).toBe(0);
    expect(result.findingsPerProject).toEqual({});
  });

  it("counts findings per project from EXPERIMENT.md diffs", () => {
    const diff = [
      "diff --git a/projects/akari/experiments/test/EXPERIMENT.md b/projects/akari/experiments/test/EXPERIMENT.md",
      "+1. First finding",
      "+2. Second finding",
      "diff --git a/projects/sample-project/experiments/test/EXPERIMENT.md b/projects/sample-project/experiments/test/EXPERIMENT.md",
      "+1. Sample finding",
    ].join("\n");

    const result = parseCrossProjectMetrics(diff, [
      "projects/akari/experiments/test/EXPERIMENT.md",
      "projects/sample-project/experiments/test/EXPERIMENT.md",
    ]);
    expect(result.findingsPerProject).toEqual({ akari: 2, "sample-project": 1 });
  });

  it("counts findings per project from README.md log entries", () => {
    const diff = [
      "diff --git a/projects/bench-project/README.md b/projects/bench-project/README.md",
      "+1. Model-identity ceiling confirmed at 70.4%",
      "+2. Visual features add +3.8pp",
      "+- [x] Some completed task",
    ].join("\n");

    const result = parseCrossProjectMetrics(diff, ["projects/bench-project/README.md"]);
    expect(result.findingsPerProject).toEqual({ "bench-project": 2 });
  });

  it("detects cross-project references in added lines", () => {
    const diff = [
      "diff --git a/projects/akari/README.md b/projects/akari/README.md",
      "+See `projects/sample-project/experiments/flash-240/EXPERIMENT.md` for details.",
      "+Also see projects/bench-project/knowledge.md for background.",
      " This line is unchanged context.",
    ].join("\n");

    const result = parseCrossProjectMetrics(diff, ["projects/akari/README.md"]);
    expect(result.crossProjectRefs).toBe(2);
  });

  it("does not count within-project references as cross-project", () => {
    const diff = [
      "diff --git a/projects/akari/README.md b/projects/akari/README.md",
      "+See `projects/akari/experiments/test/EXPERIMENT.md` for details.",
    ].join("\n");

    const result = parseCrossProjectMetrics(diff, ["projects/akari/README.md"]);
    expect(result.crossProjectRefs).toBe(0);
  });

  it("does not count references from non-project files", () => {
    const diff = [
      "diff --git a/CLAUDE.md b/CLAUDE.md",
      "+See projects/sample-project/README.md for example.",
    ].join("\n");

    const result = parseCrossProjectMetrics(diff, ["CLAUDE.md"]);
    expect(result.crossProjectRefs).toBe(0);
  });

  it("returns empty metrics for empty diff", () => {
    const result = parseCrossProjectMetrics("", []);
    expect(result.projectsTouched).toEqual([]);
    expect(result.findingsPerProject).toEqual({});
    expect(result.crossProjectRefs).toBe(0);
  });

  it("handles multiple cross-project references on one line", () => {
    const diff = [
      "diff --git a/projects/akari/analysis/test.md b/projects/akari/analysis/test.md",
      "+Compare projects/sample-project/data.csv with projects/bench-project/results.csv",
    ].join("\n");

    const result = parseCrossProjectMetrics(diff, ["projects/akari/analysis/test.md"]);
    expect(result.crossProjectRefs).toBe(2);
  });

  it("counts ### Finding N: headers in analysis files per project", () => {
    const diff = [
      "diff --git a/projects/akari/analysis/metrics.md b/projects/akari/analysis/metrics.md",
      "+### Finding 1: Orient overhead unchanged",
      "+### Finding 2: Knowledge accounting undercounts",
      "diff --git a/projects/sample-project/diagnosis/crash-report.md b/projects/sample-project/diagnosis/crash-report.md",
      "+### Finding 1: Root cause identified",
    ].join("\n");

    const result = parseCrossProjectMetrics(diff, [
      "projects/akari/analysis/metrics.md",
      "projects/sample-project/diagnosis/crash-report.md",
    ]);
    expect(result.findingsPerProject).toEqual({ akari: 2, "sample-project": 1 });
  });

  it("combines findings from experiment and readme in same project", () => {
    const diff = [
      "diff --git a/projects/akari/experiments/test/EXPERIMENT.md b/projects/akari/experiments/test/EXPERIMENT.md",
      "+1. Experiment finding",
      "diff --git a/projects/akari/README.md b/projects/akari/README.md",
      "+1. Log entry finding",
    ].join("\n");

    const result = parseCrossProjectMetrics(diff, [
      "projects/akari/experiments/test/EXPERIMENT.md",
      "projects/akari/README.md",
    ]);
    expect(result.findingsPerProject).toEqual({ akari: 2 });
  });
});

// ── Quality audit metrics ───────────────────────────────────────────────────

describe("parseQualityAuditMetrics", () => {
  it("returns zeros for empty diff and no changed files", () => {
    const result = parseQualityAuditMetrics("", []);
    expect(result.auditSkillsInvoked).toBe(0);
    expect(result.auditFindings).toBe(0);
    expect(result.experimentsAudited).toBe(0);
  });

  it("detects audit skill mentions in README log entries", () => {
    const diff = [
      "diff --git a/projects/akari/README.md b/projects/akari/README.md",
      "+### 2026-02-24 — Audit session",
      "+",
      "+Ran /review metrics on all completed experiments.",
      "+Also ran /audit-references to verify citations.",
    ].join("\n");

    const result = parseQualityAuditMetrics(diff, ["projects/akari/README.md"]);
    expect(result.auditSkillsInvoked).toBe(2);
  });

  it("deduplicates repeated mentions of the same audit skill", () => {
    const diff = [
      "diff --git a/projects/akari/README.md b/projects/akari/README.md",
      "+Ran /review on experiment A.",
      "+Then ran /review on experiment B.",
    ].join("\n");

    const result = parseQualityAuditMetrics(diff, ["projects/akari/README.md"]);
    expect(result.auditSkillsInvoked).toBe(1);
  });

  it("detects all three audit skill types", () => {
    const diff = [
      "diff --git a/projects/akari/README.md b/projects/akari/README.md",
      "+/review metrics and findings checked.",
      "+/audit-references found 2 broken DOIs.",
      "+/self-audit passed all convention checks.",
    ].join("\n");

    const result = parseQualityAuditMetrics(diff, ["projects/akari/README.md"]);
    expect(result.auditSkillsInvoked).toBe(3);
  });

  it("counts pre-existing EXPERIMENT.md files as audited", () => {
    const diff = [
      "diff --git a/projects/akari/experiments/test/EXPERIMENT.md b/projects/akari/experiments/test/EXPERIMENT.md",
      "+1. Added finding after review.",
      "diff --git a/projects/sample-project/experiments/flash/EXPERIMENT.md b/projects/sample-project/experiments/flash/EXPERIMENT.md",
      "+status: completed",
    ].join("\n");

    const changedFiles = [
      "projects/akari/experiments/test/EXPERIMENT.md",
      "projects/sample-project/experiments/flash/EXPERIMENT.md",
    ];
    const result = parseQualityAuditMetrics(diff, changedFiles, new Set());
    expect(result.experimentsAudited).toBe(2);
  });

  it("does not count new EXPERIMENT.md files as audited", () => {
    const diff = [
      "diff --git a/projects/akari/experiments/new-exp/EXPERIMENT.md b/projects/akari/experiments/new-exp/EXPERIMENT.md",
      "+---",
      "+id: new-exp",
      "+status: planned",
      "+---",
    ].join("\n");

    const changedFiles = ["projects/akari/experiments/new-exp/EXPERIMENT.md"];
    const newFiles = new Set(["projects/akari/experiments/new-exp/EXPERIMENT.md"]);
    const result = parseQualityAuditMetrics(diff, changedFiles, newFiles);
    expect(result.experimentsAudited).toBe(0);
  });

  it("counts audit findings from numbered additions in pre-existing EXPERIMENT.md", () => {
    const diff = [
      "diff --git a/projects/akari/experiments/test/EXPERIMENT.md b/projects/akari/experiments/test/EXPERIMENT.md",
      "+1. Missing provenance for 3 claims.",
      "+2. CSV row count mismatch: claimed 100, actual 97.",
    ].join("\n");

    const result = parseQualityAuditMetrics(
      diff,
      ["projects/akari/experiments/test/EXPERIMENT.md"],
      new Set(),
    );
    expect(result.auditFindings).toBe(2);
  });

  it("counts audit keyword lines as findings in pre-existing EXPERIMENT.md", () => {
    const diff = [
      "diff --git a/projects/akari/experiments/test/EXPERIMENT.md b/projects/akari/experiments/test/EXPERIMENT.md",
      "+Note: This claim is unverified — no provenance provided.",
      "+FAIL: Title does not match fetched page.",
      "+Corrected the URL after audit.",
    ].join("\n");

    const result = parseQualityAuditMetrics(
      diff,
      ["projects/akari/experiments/test/EXPERIMENT.md"],
      new Set(),
    );
    expect(result.auditFindings).toBe(3);
  });

  it("does not count findings in new EXPERIMENT.md files", () => {
    const diff = [
      "diff --git a/projects/akari/experiments/new/EXPERIMENT.md b/projects/akari/experiments/new/EXPERIMENT.md",
      "+1. Finding in a new experiment.",
      "+This is incorrect but it's in a new file.",
    ].join("\n");

    const changedFiles = ["projects/akari/experiments/new/EXPERIMENT.md"];
    const newFiles = new Set(["projects/akari/experiments/new/EXPERIMENT.md"]);
    const result = parseQualityAuditMetrics(diff, changedFiles, newFiles);
    expect(result.auditFindings).toBe(0);
    expect(result.experimentsAudited).toBe(0);
  });

  it("handles a complete audit session with mixed signals", () => {
    const diff = [
      "diff --git a/projects/akari/README.md b/projects/akari/README.md",
      "+### 2026-02-24 — Audit session",
      "+Ran /review on 3 experiments.",
      "+Ran /audit-references to check provenance.",
      "diff --git a/projects/akari/experiments/exp-a/EXPERIMENT.md b/projects/akari/experiments/exp-a/EXPERIMENT.md",
      "+1. Missing provenance on claim about 95% accuracy.",
      "diff --git a/projects/akari/experiments/exp-b/EXPERIMENT.md b/projects/akari/experiments/exp-b/EXPERIMENT.md",
      "+Corrected the row count from 100 to 97.",
      "diff --git a/projects/akari/experiments/exp-c/EXPERIMENT.md b/projects/akari/experiments/exp-c/EXPERIMENT.md",
      "+No issues found.",
    ].join("\n");

    const changedFiles = [
      "projects/akari/README.md",
      "projects/akari/experiments/exp-a/EXPERIMENT.md",
      "projects/akari/experiments/exp-b/EXPERIMENT.md",
      "projects/akari/experiments/exp-c/EXPERIMENT.md",
    ];
    const result = parseQualityAuditMetrics(diff, changedFiles, new Set());
    expect(result.auditSkillsInvoked).toBe(2);
    expect(result.experimentsAudited).toBe(3);
    expect(result.auditFindings).toBe(2); // 1 numbered + 1 "Corrected" keyword
  });

  it("does not detect audit skills in non-README files", () => {
    const diff = [
      "diff --git a/projects/akari/TASKS.md b/projects/akari/TASKS.md",
      "+- [ ] Run /review on completed experiments",
    ].join("\n");

    const result = parseQualityAuditMetrics(diff, ["projects/akari/TASKS.md"]);
    expect(result.auditSkillsInvoked).toBe(0);
  });

  it("does not detect audit skills in removed lines", () => {
    const diff = [
      "diff --git a/projects/akari/README.md b/projects/akari/README.md",
      "-Ran /review last session.",
      "+Updated log entry.",
    ].join("\n");

    const result = parseQualityAuditMetrics(diff, ["projects/akari/README.md"]);
    expect(result.auditSkillsInvoked).toBe(0);
  });
});
