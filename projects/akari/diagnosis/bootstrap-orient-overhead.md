# Diagnosis: Orient Overhead at Bootstrap

Date: 2026-03-14
Project: akari
Type: self-observation diagnosis
Severity: medium

## Problem

The first automated session (run 345dloxm, 2026-03-13) spent 42% of its turns on orient (18 of 43 turns) and produced zero knowledge findings. The entire $1.44 session cost yielded a measurement plan (structural change) but no empirical observations, giving a findings/dollar rate of 0.00.

This is the bootstrap planning trap: the system's first autonomous action was to plan how to measure itself, rather than directly observing what was happening.

## Evidence

### Session metrics (from `.scheduler/metrics/sessions.jsonl`)

| Metric | Value | Baseline | Assessment |
|--------|-------|----------|------------|
| Orient turns / total turns | 18/43 = 42% | 42% (mature repo) | At ceiling despite near-empty repo |
| Findings (experiment + log) | 0 | 1.29 f/$ | Zero knowledge output |
| Cost | $1.44 | $0.66 | 2.2x baseline |
| Structural changes | 1 | - | Measurement plan created |
| Files changed | 3 | - | Plan + task update + log |

### What the session did

1. Ran full orient (18 turns) — read project READMEs, TASKS.md, sessions.jsonl, status.md, roadmap.md, budget files, etc.
2. Selected task: "Adapt the self-improvement measurement plan"
3. Produced `plans/measurement-plan-openakari.md` — a plan for how to measure improvement
4. Updated TASKS.md and README log

### What the session did NOT do

- Observe any concrete operational behavior
- Produce any empirical finding
- Diagnose any failure mode
- Measure any metric (only defined metrics)

## Root cause analysis

Two reinforcing factors:

### 1. Orient procedure doesn't scale down for bootstrap repos

The orient skill is designed for mature repos with rich history. At bootstrap:
- `sessions.jsonl` had 0 entries to analyze, yet the session still ran the full efficiency summary computation
- Mission gap analysis checked 4 decomposed conditions against 3 tasks — useful but disproportionate for a 3-task queue
- Cross-session pattern detection requires 3+ occurrences in 10 sessions — impossible with <3 sessions
- Horizon-scan, fleet metrics, compound opportunities, and ledger reconciliation all returned empty — each consuming turns for zero return

The orient procedure has no bootstrap mode that skips inapplicable checks. Every check runs regardless of data availability.

### 2. Task selection favored planning over observation

The TASKS.md offered three options:
1. "Measure human intervention rate" (needs 2+ time windows — limited data)
2. "Write one self-observation diagnosis" (needs operational evidence — some available)
3. "Add one local example of a successful self-improvement loop" (needs a completed loop — none exist)

The session chose a fourth option: adapting the measurement plan from the examples. This was a valid `[requires-opus]` task marked high priority, but it was fundamentally a meta-planning task. The task ranking correctly prioritized it (high priority > medium priority), but the priority assignment itself encoded a planning-first bias.

## Proposed fix

### Short-term (convention)

When the repo has fewer than 5 automated sessions, orient should:
- Skip efficiency summary (insufficient data for rates or trends)
- Skip cross-session pattern detection (needs 3+ occurrences)
- Skip fleet metrics, horizon-scan, and compound opportunity scanning
- Run orient in fast mode by default (the scheduler directive already attempted this for this session, but the first session ran full orient)

This could reduce orient overhead to ~20% of turns at bootstrap.

### Medium-term (task design)

Bootstrap-phase tasks should prefer direct observation over meta-planning. A simple heuristic: if no diagnosis files exist yet (M1 = 0), the highest-leverage task is always "observe something and write it down" rather than "plan what to observe."

### What this diagnosis demonstrates

This file is itself an example of the failure mode it diagnoses: the system can identify its own planning bias by examining session metrics. The evidence is mechanical (session.jsonl data), the diagnosis is falsifiable (orient overhead should decrease in future sessions), and the proposed fix is actionable (convention change for bootstrap mode).

This is the first original diagnosis artifact for the akari meta-project (M1 moves from 0 to 1).
