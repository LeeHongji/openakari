# akari - Next actions

## Meta-project setup

- [x] Adapt the self-improvement measurement plan to your own repo [requires-opus] [skill: design] [zero-resource]
  Why: The public examples show the pattern, but each deployment needs its own metrics, denominators, and failure modes.
  Done when: A repo-specific measurement plan exists with 3-5 concrete metrics and explicit data sources.
  Priority: high
  Completed: 2026-03-14. See `plans/measurement-plan-openakari.md`.

- [ ] Measure human intervention rate in your deployment [fleet-eligible] [skill: analyze] [zero-resource]
  Why: A decreasing intervention rate is one of the clearest signals that the system is becoming more autonomous.
  Done when: A short analysis computes intervention events per session over at least 2 time windows and records the result.
  Priority: medium

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
