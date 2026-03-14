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
