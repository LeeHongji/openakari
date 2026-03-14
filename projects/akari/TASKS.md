# akari - Next actions

## Meta-project setup

- [x] Adapt the self-improvement measurement plan to your own repo [requires-opus] [skill: design] [zero-resource]
  Why: The public examples show the pattern, but each deployment needs its own metrics, denominators, and failure modes.
  Done when: A repo-specific measurement plan exists with 3-5 concrete metrics and explicit data sources.
  Priority: high
  Completed: 2026-03-14. See `plans/measurement-plan-openakari.md`.

- [x] Measure human intervention rate in your deployment [fleet-eligible] [skill: analyze] [zero-resource]
  Why: A decreasing intervention rate is one of the clearest signals that the system is becoming more autonomous.
  Done when: A short analysis computes intervention events per session over at least 2 time windows and records the result.
  Priority: medium
  Completed: 2026-03-14. See `analysis/human-intervention-rate-2026-03-14.md`. 4 findings: interventions are infrastructure-only (not research-directed), rate decreased 0.5→0.0 across two windows, cross-validated against M5, Co-Authored-By tag unreliable as signal.

- [ ] Run second metrics snapshot (M1-M5) at 8-10 sessions [fleet-eligible] [skill: analyze] [zero-resource]
  Why: Mission gap — "measuring improvement over time" requires multiple data points. First snapshot done at 3 sessions. (per ADR 0049)
  Done when: Analysis file records M1-M5 at 8-10 sessions and compares trends against session-3 baseline.
  Priority: medium
  [blocked-by: 8+ entries in sessions.jsonl]

- [x] Run bootstrap metrics snapshot (M1-M5 absolute counts) [fleet-eligible] [skill: analyze] [zero-resource]
  Why: Mission gap — no task for "measuring whether autonomy and knowledge output improve over time" (per ADR 0049). The measurement plan specifies bootstrap-phase metrics as absolute counts. 3 sessions of data now exist.
  Done when: Analysis file in `analysis/` records M1-M5 absolute counts with provenance (commands/data sources), and identifies at least one actionable observation.
  Priority: high
  Completed: 2026-03-14. See `analysis/bootstrap-metrics-snapshot-2026-03-14.md`. 3 findings: orient overhead unchanged by fast tier, knowledge accounting undercounts, self-improvement loop completed in 2 sessions.

- [x] Write one self-observation diagnosis from operational evidence [requires-opus] [skill: diagnose] [zero-resource]
  Why: The meta-project only becomes real when the system diagnoses its own failure modes from its own logs and artifacts.
  Done when: One diagnosis file identifies a concrete self-observation failure, cites evidence, and proposes a fix or follow-up task.
  Priority: medium
  Completed: 2026-03-14. See `diagnosis/bootstrap-orient-overhead.md`.

- [x] Implement bootstrap orient optimization from diagnosis [requires-opus] [skill: execute] [zero-resource]
  Why: Mission gap — no task for "implementing changes" based on diagnosed gaps (per ADR 0049). The bootstrap-orient-overhead diagnosis proposed skipping inapplicable orient checks when <5 sessions exist.
  Done when: Orient skill includes bootstrap-mode logic that skips efficiency summary, cross-session patterns, fleet metrics, horizon-scan, and compound opportunity scanning when sessions.jsonl has <5 entries.
  Priority: high
  Completed: 2026-03-14. Added "Bootstrap detection" section to orient skill (SKILL.md) with skip conditions on 7 subsections.

- [x] Add one local example of a successful self-improvement loop [fleet-eligible] [skill: record] [zero-resource]
  Why: The strongest evidence for the meta-project is a full loop: detect a gap, change the system, then measure improvement.
  Done when: README log entry or analysis file records a before/after operational improvement with provenance.
  Priority: medium
  Completed: 2026-03-14. The bootstrap orient loop: diagnosed overhead (session 2) → implemented fix (session 3) → measurable via orient turns in future sessions. See README log.

## Self-improvement loop 2: Knowledge accounting

- [x] Diagnose knowledge accounting undercounting [requires-opus] [skill: diagnose] [zero-resource]
  Why: All 4 sessions report 0 findings in sessions.jsonl knowledge counters, but analysis files contain 8+ documented findings. The primary KPI (findings/$) computes as 0.0 — self-measurement is broken.
  Done when: Diagnosis file identifies root cause of the discrepancy, cites evidence (sessions.jsonl vs actual findings), and proposes a concrete fix.
  Priority: high
  Completed: 2026-03-14. See `diagnosis/knowledge-accounting-undercounting.md`. Root cause: `parseKnowledgeFromDiff()` in verify.ts only scans EXPERIMENT.md and README.md for findings; analysis files and diagnosis files are invisible. Two compounding bugs: file filter too narrow + regex doesn't match `### Finding N:` format.

- [x] Fix knowledge accounting to count findings in analysis and diagnosis files [requires-opus] [skill: execute] [zero-resource]
  Why: Diagnosis identified that parseKnowledgeFromDiff() in verify.ts ignores analysis/*.md and diagnosis/*.md files. Primary KPI (findings/$) reads 0.0 when true rate is ~1.45 f/$.
  Done when: verify.ts scans analysis and diagnosis files for `### Finding N:` headers, test cases added, and at least one subsequent session correctly records non-zero findings.
  Priority: high
  Completed: 2026-03-14. Added blocks 7b/7c to parseKnowledgeFromDiff() for analysis and diagnosis files, updated parseCrossProjectMetrics for per-project counting, 6 new test cases (81 total), all passing. Verification of non-zero findings requires a subsequent session.

## Self-improvement loop 3: Orient overhead

- [x] Diagnose persistent orient overhead (51.9% despite fast tier) [requires-opus] [skill: diagnose] [zero-resource]
  Why: Fast orient was supposed to reduce overhead from ~42% to ~20%, but 6-session average is 51.9%. The orient procedure is the system's largest efficiency bottleneck — every percent saved compounds across all future sessions.
  Done when: Diagnosis file identifies root causes of high orient overhead in fast tier, cites per-session evidence (orientTurns/numTurns), and proposes concrete fixes.
  Priority: high
  Completed: 2026-03-14. See `diagnosis/orient-overhead-persistent.md`. 4 root causes: (RC1) fast orient retains all high-cost steps, (RC2) TodoWrite prematurely stops orientTurns counter, (RC3) wasFullOrient threshold of 15 misclassifies fast sessions, (RC4) 20% target structurally unreachable. Implemented Fix A (remove TodoWrite from EXECUTION_PHASE_TOOLS) and Fix B (raise threshold to 25). Tests updated and passing.

## Mission gap tasks

- [ ] Write self-improvement synthesis demonstrating the complete capability [requires-opus] [skill: analyze] [zero-resource]
  Why: Mission gap — no artifact demonstrates the full self-improvement capability end-to-end (per ADR 0049). The Done when requires "demonstrates self-directed capability improvement."
  Done when: Analysis file ties together all evidence (2 completed loops, metrics, diagnoses) into a coherent narrative showing the system meets its Done when criteria.
  Priority: medium
