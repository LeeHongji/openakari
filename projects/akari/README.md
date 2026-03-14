# akari: Meta-Project for Self-Improvement

Status: active
Mission: Study and improve the autonomous research system itself.
Done when: The system demonstrates self-directed capability improvement by identifying gaps from operational data, implementing changes, and measuring whether autonomy and knowledge output improve over time.

## Context

Akari's core idea is that the research system should study itself.

This project is the meta-project for openakari. Its subject is not an external benchmark or domain problem. Its subject is the behavior of the autonomous system itself: how sessions coordinate, where they fail, how human intervention changes over time, and which infrastructure or convention changes actually improve performance.

The artifacts here are adapted from the original private akari repo's operational history. They are included as examples of what it looks like when an AI-native software system treats its own operations as a research object.

## Log

### 2026-03-14 (session 7)

Task-selected: Fix knowledge accounting to count findings in analysis and diagnosis files. Implemented the fix diagnosed in session 6: added blocks 7b (analysis files) and 7c (diagnosis files) to `parseKnowledgeFromDiff()` in `infra/scheduler/src/verify.ts` to scan for `### Finding N:` headers. Also updated `parseCrossProjectMetrics()` to count these findings per project. TDD approach: wrote 6 failing tests first, then implemented. All 81 knowledge tests pass. This completes the second self-improvement loop (knowledge accounting): diagnose (session 6) → implement fix (session 7). Verification that subsequent sessions correctly record non-zero findings will happen in session 8+.

### 2026-03-14 (session 6)

Task-selected: Diagnose knowledge accounting undercounting. Investigated why all 4 prior sessions report 0 findings in sessions.jsonl despite 8+ documented findings in analysis files. Traced root cause to `parseKnowledgeFromDiff()` in `infra/scheduler/src/verify.ts` (lines 1047-1111): two compounding bugs — (1) file filter only scans EXPERIMENT.md and README.md, ignoring analysis/*.md and diagnosis/*.md, (2) regex `/^\+\d+\.\s/` doesn't match the `### Finding N:` header format used in analysis files. True findings/$ rate is ~1.45 f/$ (8 findings / $5.55), not 0.0 as recorded. This is the second self-observation diagnosis (M1: 1 → 2), following the same pattern as bootstrap-orient-overhead: identify gap from operational data → trace to specific code → propose fix. Created implementation task for the fix. See `diagnosis/knowledge-accounting-undercounting.md`.

### 2026-03-14 (session 5)

Task-selected: Measure human intervention rate in your deployment. Analyzed all 11 git commits and APPROVAL_QUEUE.md across 4 prior sessions. Classified each commit by author type (human/agent/scheduler) using timestamp correlation with sessions.jsonl. Computed M3 over two 2-session windows: Window A (sessions 1-2) = 0.5 interventions/session, Window B (sessions 3-4) = 0.0. Four findings: (1) both human interventions were infrastructure-only (repo setup, scheduler bugfix), zero research-direction interventions, (2) rate trajectory 0.5→0.0 matches expected bootstrap pattern, (3) cross-validation with M5 confirms low intervention reflects genuine autonomy not silent failure, (4) Co-Authored-By tag is unreliable for distinguishing human-initiated vs autonomous commits. Also generated mission gap task for second metrics snapshot at 8-10 sessions. See `analysis/human-intervention-rate-2026-03-14.md`.

### 2026-03-14 (session 4)

Task-selected: Run bootstrap metrics snapshot (M1-M5 absolute counts). Generated this task via mission gap analysis (no existing task for "measuring improvement over time"). Computed all 5 metrics from measurement plan using absolute counts: M1=1 original diagnosis, M2=1/1 closure (100%), M3=0.33 interventions/session (only initial commit), M4=1/3 sessions touched system files, M5=2 original knowledge artifacts ($0.74/artifact). Three findings: (1) fast orient tier didn't reduce overhead percentage (45% vs 42%) — bootstrap skip fix should help, (2) sessions.jsonl knowledge counters undercount actual output (0 findings recorded vs 2 artifacts produced), (3) self-improvement loop completed in minimum 2 sessions. See `analysis/bootstrap-metrics-snapshot-2026-03-14.md`.

### 2026-03-14 (session 3)

Task-selected: Implement bootstrap orient optimization from diagnosis. Added a "Bootstrap detection" section to the orient skill that checks `sessions.jsonl` line count and skips 7 inapplicable steps when <5 sessions exist: efficiency summary, cross-session patterns, fleet metrics, horizon-scan, ledger reconciliation, compound opportunities, and (in fast orient) efficiency summary. This is the first complete self-improvement loop in the repo: session 2 diagnosed the bootstrap orient overhead problem (42% of turns, 0 findings), session 3 implemented the fix. Expected outcome: orient overhead drops from ~42% to ~20% of turns for bootstrap sessions. Measurement: compare `orientTurns / numTurns` in sessions 4+ against the 42% baseline from sessions 1-2. Also completed mission gap analysis, generating the implementation task itself (ADR 0049). Two tasks completed in one session: the implementation task and "Add one local example of a successful self-improvement loop" (this loop IS the example).

### 2026-03-14 (session 2)

Task-selected: Write one self-observation diagnosis from operational evidence. Examined session metrics from run 345dloxm (the first automated session). Diagnosed "bootstrap orient overhead" — the orient procedure spent 42% of turns (18/43) in a near-empty repo, and the session produced 0 findings despite $1.44 cost. Root cause: orient doesn't scale down for bootstrap repos, and task selection favored meta-planning over direct observation. Proposed fix: skip inapplicable orient checks when <5 sessions exist. This is the first original diagnosis artifact (M1: 0 -> 1). See `diagnosis/bootstrap-orient-overhead.md`.

### 2026-03-14 (session 1)

Task-selected: Adapt self-improvement measurement plan. Created `plans/measurement-plan-openakari.md` with 5 concrete metrics (Gap Detection Rate, Closure Rate, Human Intervention Rate, System-Learning Rate, Knowledge Output Rate), each with explicit data sources, computation methods, and interpretation guides. Metrics are designed to work during bootstrap (absolute counts) and scale to automated computation via sessions.jsonl once the scheduler is active. Recorded baseline values at session 0.

### 2026-03-08

Created the public meta-project scaffold for openakari. Added a project README, task list, and three example artifacts adapted from the original akari repo: a self-improvement measurement plan, a human-intervention trend analysis, and a self-observation diagnosis. These examples show how the system studies its own behavior rather than only external tasks.

## Open questions

- Which self-improvement metrics are robust enough to compare across different forks or deployments of openakari?
- What is the smallest useful amount of operational logging needed to support real self-study without overwhelming orient cost?
- Which kinds of capability improvements transfer across projects, and which depend on the specific repo's history and conventions?
