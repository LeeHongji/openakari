---
name: orient
description: "Use at the start of every work session to assess current state and select the highest-value task"
complexity: opus-only
model-minimum: opus
disable-model-invocation: false
allowed-tools: ["Read", "Grep", "Glob", "Bash(git *)"]
argument-hint: "[fast | full | project-name] — 'fast' for abbreviated orient, 'full' for comprehensive, or project name to scope"
---

# /orient

You are starting or resuming a work session on the akari research group repo. Your job is to quickly build situational awareness and recommend the single highest-leverage next action.

## Tier selection (ADR 0030)

Orient has two tiers: **fast** (abbreviated, ~2-3 turns) and **full** (comprehensive, ~5-7 turns).

- `/orient fast` — run fast orient (skip to "Fast orient" section below)
- `/orient full` — run full orient (use the standard procedure below)
- `/orient` (no argument) — **auto-detect tier**:
  - The scheduler injects `SCHEDULER DIRECTIVE: ... Use /orient fast` into the session prompt when a full orient ran recently (<2h). If you see this directive, run fast orient. Otherwise, run full orient.
  - If no scheduler directive is present and no explicit argument given, run full orient.
- `/orient <project-name>` — run full orient scoped to that project

## Bootstrap detection

Before running any orient tier, check session count: count the lines in `.scheduler/metrics/sessions.jsonl` (or note if the file doesn't exist). If the count is **fewer than 5**, the repo is in **bootstrap mode**.

In bootstrap mode, **skip** the following steps (they produce zero value with insufficient data):
- **Efficiency summary**: Rates and trends are meaningless with <5 data points. Instead, report "Bootstrap mode: N sessions, skipping efficiency metrics."
- **Cross-session pattern detection**: Requires 3+ occurrences in 10 sessions — impossible with <5.
- **Fleet metrics**: No fleet baseline to compare against.
- **Horizon-scan intel**: Skip reading `.scheduler/skill-reports/` — unlikely to exist at bootstrap.
- **Compound opportunity scanning**: No accumulated experiments/diagnoses to compound yet (check anyway only if diagnosis files exist).
- **Ledger reconciliation**: Skip unless `budget.yaml` and experiment `progress.json` files actually exist.

This reduces orient overhead from ~42% to ~20% of session turns during the bootstrap phase. See `projects/akari/diagnosis/bootstrap-orient-overhead.md` for the analysis.

## Fast orient

When running in fast mode, do only the following:

### Step 0: Commit orphaned work
Same as full orient — run `!git status`, commit and push any orphaned changes.

### Gather context (minimal)
Read the following in parallel:
1. `!git log --oneline -5` — recent activity
2. `!git status` (reuse from step 0)
3. `projects/*/TASKS.md` — for all active projects. Also read `projects/*/README.md` headers (first ~5 lines) to extract each project's `Priority:` field for project-level ranking (ADR 0036). Skip full READMEs, status.md, and roadmap.
4. **Efficiency summary**: **Skip if bootstrap mode** (<5 sessions) — report "Bootstrap mode: N sessions, skipping efficiency metrics" instead. Otherwise, read the last 10 work-cycle sessions from `.scheduler/metrics/sessions.jsonl` using `Read` with negative offset (e.g., offset=-15) to avoid reading the entire file. Compute and report these concrete metrics (not just flags):
    - **Findings/dollar** (primary KPI): `(sum of newExperimentFindings + logEntryFindings) / sum of costUsd` across the 10 sessions. Compare to baseline: 1.29 f/$ overall (from 154 sessions through 2026-02-22). Flag if <0.5 f/$.
    - **Genuine waste rate**: Sessions where all `knowledge` fields sum to zero AND (`orphanedFiles` is 0 or absent) AND `filesChanged < 50` AND `backend != 'cursor'`. Report count and %. Flag if >10%.
    - **Orient overhead**: Mean `orientTurns / numTurns` for sessions with `numTurns > 10`. Report as %. Baseline: 42% (from 154 sessions). Flag if >40%.
    - **Avg cost/session**: Mean `costUsd`. Baseline: $3.66. Flag if >$8 (2× baseline).
    - **Avg turns**: Mean `numTurns`. Flag if >80.

    **Fleet workers**: If this is a fleet session (check for `SESSION_ID=fleet-worker-` in prompt), compute fleet-specific KPIs instead of cost-based metrics:
    - **Task completion rate**: Fraction with `verification.hasCommit === true`. Target: ≥80%.
    - **Verification pass rate**: Fraction with both `hasCommit === true` AND `hasLogEntry === true`. Target: ≥70%.
    - **Log entry rate**: Fraction with `hasLogEntry === true`. Target: ≥80%.
    - **Knowledge production rate**: Fraction where any `knowledge` field is non-zero. Target: ≥30%.
    Report fleet metrics in the efficiency summary section with "Fleet efficiency:" prefix.

### Task supply and decomposition

Improve task quality and supply while scanning. If your repo enables fleet-style execution, you may also maintain fleet-ready task supply; otherwise treat `[fleet-eligible]` / `[requires-opus]` as optional routing metadata only.

### Mission gap check (ADR 0049)

For each high-priority project with ≤2 unblocked tasks, do a lightweight mission gap check:

1. Read the project's `Done when` criteria from README.md (already loaded from step 3)
2. For each condition in `Done when`, check if there's a corresponding open task in TASKS.md
3. If any `Done when` condition has no corresponding open task AND is not already satisfied by completed work, generate a task:
   ```
   - [ ] <imperative verb phrase for the gap> [optional routing tag]
      Why: Mission gap — no task for <condition> (per ADR 0049)
      Done when: <verifiable condition matching the Done when criterion>
   ```
4. Report in output: "Mission gaps: N conditions checked, M tasks generated" or "Mission gaps: none — all Done when conditions have tasks"

This prevents projects from stalling when their task queue depletes while mission-critical work remains undone.

### Select task
Extract unblocked tasks from TASKS.md files. Apply project priority grouping first (`high` > `medium` | untagged > `low`, per ADR 0036), then apply the same task-level ranking criteria as full orient (prevents waste > unblocks > produces knowledge > matches momentum > cost-proportionate), but skip strategic alignment check, repetition penalty scan, and compound opportunity scanning.

**Stale blocker check**: While scanning TASKS.md files, note any `[blocked-by: external: ... (YYYY-MM-DD)]` tags older than 7 days. These tasks may be actionable if the blocker has resolved — flag them for re-verification in the task recommendation rationale.

**Routing tag check (ADR 0045)**: If your repo uses routing tags, tag any untagged task with `[fleet-eligible]` or `[requires-opus]` using the checklist from `CLAUDE.md`. If your repo does not use fleet execution, skip tagging and proceed with normal task selection.

If the candidate task has `consumes_resources: true` or is tagged with a budget-related note, also read the project's `budget.yaml` and compute remaining budget from `ledger.yaml` before recommending.

**Empty-queue fallback**: If no actionable tasks are found across all eligible projects after ranking, do NOT immediately end the session. Instead:
1. **Mission gap analysis (ADR 0049)**: Run the full mission gap analysis (see below) for ALL active projects, not just high-priority. This is the primary fallback — most empty queues are caused by missing tasks, not missing recommendations.
2. If mission gap analysis generates tasks, select from the generated tasks.
3. If no mission gaps found, scan for unsurfaced recommendation files: run `grep -rl "^##.*\(Recommend\|Prevention\|Next steps\|Proposed solution\)" projects/*/experiments/*/EXPERIMENT.md projects/*/diagnosis/*.md projects/*/postmortem/*.md projects/*/analysis/*.md 2>/dev/null | xargs grep -L "Recommendations surfaced:"` to find files with recommendation sections that lack surfaced markers.
4. If unsurfaced files exist, recommend: "Run `/compound deep` to process N unsurfaced recommendation files" as the task.
5. If no unsurfaced files exist either, log "no actionable tasks, no mission gaps, and no unsurfaced recommendations" and end the session.

### Claim task

If your repo exposes a task-claim API, use it to avoid duplicate work. Otherwise skip claiming and proceed.

### Output format (fast)

Report these sections:
- **Mission gaps**: For high-priority projects with ≤2 unblocked tasks
- **Recommended task**: Task text, project, 1-line rationale
- **Uncommitted work**: Git status summary or "clean"
- **Budget gate**: Result if resource task, or "n/a"
- **Task supply updates**: Any task generation, decomposition, or routing-tag updates made during orient
- **Efficiency summary**: Findings/$, waste %, overhead %, avg cost, avg turns with baselines and flags

Skip: Cross-session patterns, Gravity signals, Model-fit awareness, Horizon-scan intel, Compound opportunities, Risks, Recommended skill (covered by full orient).

---

## Full orient

The standard comprehensive orient procedure. Runs when explicitly requested (`/orient full`), when auto-detection determines it's needed, or when scoped to a project.

## Scope

If a project argument is provided (e.g. `/orient sample-project`), scope to that project only:
- Read only `projects/<arg>/README.md` (not all projects)
- Also read domain knowledge files: `projects/<arg>/knowledge.md` (if it exists) and `projects/<arg>/knowledge/*.md` (if the directory exists). Both patterns are used — some projects use a flat file, others use a directory. This injects accumulated domain knowledge into session context (per feedback-domain-knowledge-leverage-llm-properties R1)
- Also read `projects/<arg>/decisions/*.md` if the directory exists — project-direction decisions inform task context (per ADR 0035)
- Skip cross-project comparison — focus on within-project task ranking
- Still read git status and recent git log for repo-wide awareness

If no project argument, assess all active projects and recommend the highest-leverage task across all of them.

## Step 0: Commit orphaned work

Before anything else, run `!git status`. If there are uncommitted changes from previous sessions (modified files, untracked artifacts), commit and push them immediately. Orphaned work is the most common knowledge-loss pattern (F1 in diagnosis). Do not analyze or assess — just commit what's there with a descriptive message, then push.

Skip this step only if `git status` is clean.

## Gather context

Read the following in parallel:

1. Recent git activity:
   - `!git log --oneline -15`
   - `!git status` (already done above — reuse the output)
2. Group status: `docs/status.md`
3. Project READMEs and TASKS — either the scoped project or all active projects: `projects/*/README.md` (for context, log, questions) and `projects/*/TASKS.md` (for task selection). **Extract each project's `Priority:` field** from its README (high | medium | low; absent = medium). This is used during project-level ranking (see "Rank tasks" below and ADR 0036). For **scoped** orient, also read domain knowledge files: `projects/<arg>/knowledge.md` (if it exists) and `projects/<arg>/knowledge/*.md` (if the directory exists) — domain knowledge should be in working context for task selection and execution planning. For all projects, check for `projects/<project>/decisions/` and read any files there — project-direction decisions (strategic pivots, methodology changes) inform task context and prevent re-litigating settled choices (per ADR 0035).
4. For **every** active project (not just the scoped one): read `budget.yaml` and `ledger.yaml` (if they exist) to compute per-project budget/deadline status. This is required for the "Budget & Deadline Status" section of the output.
5. **Ledger reconciliation**: **Skip if bootstrap mode** (<5 sessions) — unlikely to have experiment data to reconcile. Otherwise, for each active project with a `budget.yaml`, scan `projects/<project>/experiments/*/progress.json` for completed experiments that have a `consumption_audit` section. Compare the audit's `csv_derived_calls` (or `unique_derived_calls` if duplicates were detected) against `ledger_recorded`. Flag any experiment where `actual / recorded > 2` or `recorded / actual > 2` (i.e., ledger is off by more than 2×). Report these in the "Budget & Deadline Status" section as ledger reconciliation warnings. This catches phantom ledger entries — the flash-240 incident recorded 8,568 calls vs 39,222 actual (4.6× discrepancy) and went undetected for 16 hours because orient trusted the ledger. See [decisions/0027-experiment-resource-safeguards.md](../../../decisions/0027-experiment-resource-safeguards.md).
6. Research roadmap: `docs/roadmap.md` — for active research questions and strategic priorities
7. Cross-session patterns: **Skip if bootstrap mode** (<5 sessions) — pattern detection requires 3+ occurrences, impossible with <5 sessions. Otherwise, read `.scheduler/metrics/sessions.jsonl` (last 10 sessions, using `Read` with negative offset to avoid reading the entire file). Use the pattern detector (`infra/scheduler/src/patterns.ts`) logic to check for recurring violations: sessions without commits, zero-knowledge sessions, uncommitted files, missing log entries, timeouts, or cost anomalies. A pattern requires 3+ occurrences in the last 10 sessions. Report any detected patterns in the "Cross-session patterns" section of the output.
8. Model-fit awareness: If candidate tasks depend on model-specific behavior, flag uncertainty and recommend an empirical check rather than assuming capability.
9. Horizon-scan intel: **Skip if bootstrap mode** (<5 sessions) — unlikely to have scan reports at bootstrap. Otherwise, check `.scheduler/skill-reports/horizon-scan-*.md` for recent scan reports (last 14 days). If any exist, read the most recent one and note: (a) actionable findings that created tasks or updated the model registry, (b) informative findings relevant to candidate tasks, (c) the scan date (to flag staleness if >14 days old). Report in the "Horizon-scan intel" section of the output. If no reports exist or all are >14 days old, note "No recent horizon-scan data."
   10. **Efficiency summary**: **Skip if bootstrap mode** (<5 sessions) — report "Bootstrap mode: N sessions, skipping efficiency metrics" instead. Otherwise, from `.scheduler/metrics/sessions.jsonl` (reuse data from step 7), compute five metrics over the last 10 work-cycle sessions. Report concrete values with comparison to baselines (from `projects/akari/analysis/baseline-efficiency-report-2026-02-22.md`):
     - **Findings/dollar** (primary KPI): `(sum of newExperimentFindings + logEntryFindings) / sum of costUsd`. Baseline: 1.29 f/$. Flag if <0.5 f/$.
     - **Genuine waste rate**: Count sessions where ALL `knowledge` fields sum to zero AND (`orphanedFiles` is 0 or absent) AND `filesChanged < 50` AND `backend != 'cursor'`. Baseline: 6.3%. Flag if >10%.
     - **Orient overhead**: Mean `orientTurns / numTurns` for sessions with `numTurns > 10`. Baseline: 42%. Flag if >40%. This is the single largest efficiency lever per baseline report Finding 2.
     - **Avg cost/session**: Mean `costUsd`. Baseline: $3.66. Flag if >$8 (>2× baseline).
     - **Avg turns**: Mean `numTurns`. Flag if >80.
     Report in the "Efficiency summary" section of the output. Always report concrete numbers, not just "OK" — the numbers enable trend tracking across sessions.
     
     **Fleet workers** (sessions with `backend: "opencode"`): Cost-based metrics don't apply ($0 compute). Instead, compute and report these fleet-specific KPIs from the same 10 sessions:
     - **Task completion rate**: Fraction with `verification.hasCommit === true`. Target: ≥80%.
     - **Verification pass rate**: Fraction with both `hasCommit === true` AND `hasLogEntry === true`. Target: ≥70%.
     - **Log entry rate**: Fraction with `hasLogEntry === true`. Target: ≥80%.
     - **Knowledge production rate**: Fraction where any `knowledge` field is non-zero. Target: ≥30%.
     Report fleet metrics in a separate "Fleet efficiency summary" section. Flag any rate below target.
11. **External work staleness**: Read `APPROVAL_QUEUE.md` and find pending items with `Type: external` and a `Requested: YYYY-MM-DD` field. For each, compute days since request. Flag any that are 7+ days old. Report in the "External work status" section of the output. This enables the orient session to check for stale external requests and re-evaluate the approach (per ADR 0040).
12. **Blocked-by tag freshness**: Scan all `projects/*/TASKS.md` files for `[blocked-by: external: ... (YYYY-MM-DD)]` patterns. Extract the date from each tag. Compute days since the date. Flag any tags older than 7 days as stale. Report in the "External work status" section alongside APPROVAL_QUEUE.md external items. This catches tasks that remain blocked without re-verification.


## Mission gap analysis (ADR 0049)

Before ranking tasks, check whether active projects have tasks for all their `Done when` conditions. This step ensures the system is goal-directed — working toward project completion, not just executing whatever happens to be in the queue.

### Procedure

For each active project with `Priority: high` or `medium` (already read in "Gather context"):

1. **Extract `Done when` criteria** from the project README. Decompose compound criteria into discrete verifiable conditions. E.g., "benchmark covers ≥5 models across ≥3 skill categories with validated rubrics" decomposes into: (a) ≥5 models benchmarked, (b) ≥3 skill categories covered, (c) rubrics validated.

2. **For each condition**, determine its status:
   - **Satisfied**: Evidence exists that the condition is met (completed experiment, artifact on disk, completed task with verification)
   - **Has task**: An open task in TASKS.md would satisfy this condition when completed
   - **Gap**: Condition is unsatisfied AND no open task addresses it

3. **For each gap**, generate a task proposal following the standard task schema:
    ```
    - [ ] <imperative verb phrase> [optional routing tag]
      Why: Mission gap — no task for "<condition>" (per ADR 0049)
      Done when: <verifiable condition that satisfies the Done when criterion>
      Priority: <inherit from project priority>
   ```
    If your repo uses routing tags, apply the eligibility checklist to determine the routing tag.

4. **Write generated tasks** to the project's TASKS.md under a "## Mission gap tasks" section. Unlike fleet decomposition proposals (which are output-only), mission gap tasks ARE written directly — they represent work the project structurally requires.

### Report

Include a "Mission gap analysis" section in the output:
```
### Mission gap analysis
<per-project summary>
**<project>**: N conditions, M satisfied, K have tasks, J gaps
  Gaps: <list each gap condition and generated task, or "none">
```

### When to skip

Skip mission gap analysis for:
- Projects with `Priority: low` (unless in empty-queue fallback mode)
- Projects with `Status: paused` or `Status: completed`
- Projects with >5 unblocked tasks (task supply is healthy; gap analysis can wait for next full orient)

## Rank tasks

Extract all unblocked tasks from `TASKS.md` files. For each task, assess:

1. **Prevents waste?** Does this task stop resources from being burned on broken configs, invalid setups, or known-bad patterns? (e.g., adding canary execution, fixing a config bug before re-running an experiment). Tasks that prevent waste are almost always highest leverage because they protect the denominator of findings/dollar.

2. **Unblocks others?** How many other tasks or experiments depend on this completing? A task that unblocks 3 others is worth more than a task that unblocks 0. Check for `[blocked-by: ...]` tags that reference this task.

3. **Produces knowledge?** Does the task have a clear hypothesis, falsifiable outcome, or "Done when" that includes a finding or decision? Tasks that produce knowledge (findings, decisions, resolved questions) directly serve the mission. Tasks that only produce operational output (code that works, configs that run) are lower leverage unless they enable knowledge-producing tasks.

4. **Matches momentum?** Is there recent work (last 2-3 sessions) building toward this task? Continuing a thread is cheaper than starting a new one — context is warm, dependencies are fresh, partial work may exist.

5. **Cost-proportionate?** Is the expected cost (API calls, time, complexity) proportionate to the expected knowledge output? A $0.50 analysis that produces 3 findings beats a $5 experiment that produces 1.

**Project priority grouping (ADR 0036):** Before applying task-level criteria, group candidate tasks by their project's priority: `high` > `medium` | untagged > `low`. Only consider tasks from lower-priority projects when all higher-priority projects have no actionable tasks. Within a project priority group, apply the task-level criteria below. This ensures human-set project priority takes precedence over task-level ranking.

**Ranking algorithm:** Score each task by the first criterion it satisfies, in order. Criterion 1 (prevents waste) dominates criterion 2 (unblocks), which dominates criterion 3 (produces knowledge), etc. Within the same criterion, prefer lower cost.

**Strategic alignment:** When recommending, state how the task connects to an active research question from `docs/roadmap.md`. If it doesn't connect to any, flag this as potential drift — it may still be valid (infrastructure work), but the disconnect should be explicit.

**Repetition penalty:** Before finalizing a recommendation, scan the project README log (and archived `log/` entries if needed) for the last 5 "Task-selected:" entries. If the candidate task (or a task analyzing the same experiment/artifact) appears in 3+ of those entries, apply a repetition penalty:
- Flag it: "WARNING: This task has been selected N/5 recent sessions. Check for diminishing returns."
- Check whether the task has genuinely new preconditions since last selection (e.g., experiment just completed, blocker removed, >20% new data accumulated).
- If no new preconditions exist, prefer an alternative task. If no alternatives exist, recommend the task but note the repetition risk.
- See [decisions/0023-incremental-analysis-throttling.md](../../../decisions/0023-incremental-analysis-throttling.md) for context.

**Priority tiebreaker:** Within tasks at the same criterion level, prefer `Priority: high` > `Priority: medium` > `Priority: low` > untagged.

**Decomposition scan (ADR 0045):** While scanning tasks, check for decomposition opportunities:
1. **Requires-Opus tasks**: If your repo uses routing tags, tasks tagged `[requires-opus]` need higher-capability handling. Check if they're correctly scoped.
2. **Decomposable tasks**: Any task with >2 independent steps, >3 files, or mixed mechanical+judgment work should be decomposed into smaller subtasks.
3. **Report in output**: Include any task-supply or decomposition updates you made.

Do NOT recommend tasks from:
- Tasks with `[blocked-by: ...]` tags with unresolved blockers
- Tasks with `[in-progress: ...]` tags (already being worked on)
- Tasks requiring approval (`[approval-needed]`) without `[approved: ...]`

**Empty-queue fallback**: If no actionable tasks are found across all eligible projects after ranking, do NOT immediately end the session. Instead:
1. Scan for unsurfaced recommendation files: run `grep -rl "^##.*\(Recommend\|Prevention\|Next steps\|Proposed solution\)" projects/*/experiments/*/EXPERIMENT.md projects/*/diagnosis/*.md projects/*/postmortem/*.md projects/*/analysis/*.md 2>/dev/null | xargs grep -L "Recommendations surfaced:"` to find files with recommendation sections that lack surfaced markers.
2. If unsurfaced files exist, recommend: "Run `/compound deep` to process N unsurfaced recommendation files" as the task. Include the file count and list in the output.
3. If no unsurfaced files exist either, log "no actionable tasks and no unsurfaced recommendations" and end the session.

This fallback converts empty-queue situations into productive discovery sessions. See [projects/akari/analysis/task-discovery-workflow-gap-2026-02-22.md](../../../projects/akari/analysis/task-discovery-workflow-gap-2026-02-22.md) R4.

## Task supply generation and decomposition (ADR 0047, ADR 0053)

Task generation is a primary output of orient, not just a side effect. If you notice thin task supply, stale blockers, or over-broad tasks, improve the queue before selecting work. In repos that enable fleet execution, this also helps maintain fleet-ready supply.

**Generation procedure (apply relevant sources, write tasks directly to TASKS.md):**
1. **Unblock stale blockers**: Find `[blocked-by: ...]` tags where the referenced condition is now resolved (prerequisite task marked `[x]`, infrastructure issue fixed, time gate passed). Remove the tag.
2. **Decompose broad tasks**: Split tasks with >2 independent steps into smaller subtasks. If your repo uses routing tags, retain or refine the tags as appropriate.
3. **Extract preparatory work from blocked tasks**: For blocked tasks, identify prerequisite setup that is NOT blocked (directory creation, config files, script stubs, documentation). Create subtasks for these preparatory steps.
4. **Create follow-up tasks from recent completions**: Scan recently completed tasks (`[x]`) for implied follow-up work: validation of completed implementation, documentation updates, cross-project propagation, analysis of new artifacts.
5. **Create project maintenance tasks**: Add tasks for compliance audits (`Run /self-audit on <project>`) — but **only for projects not audited in the last 7 days**. Check by running `ls projects/*/diagnosis/compliance-audit-*.md 2>/dev/null` and extracting dates from filenames (YYYY-MM-DD pattern). Skip projects with recent audits. Also add documentation updates, test coverage, or cross-project analysis per standing inventory.
6. **Create knowledge management tasks**: Add tasks for cross-reference verification, README status verification, completed task archival (TASKS.md with >10 completed tasks), and experiment frontmatter audits.

After generating, report what changed in the task supply.

### Decomposition procedure

Apply the decomposition procedure from [docs/conventions/task-lifecycle.md](../../../../docs/conventions/task-lifecycle.md) — write subtasks directly to TASKS.md, splitting along mechanical/judgment boundaries.

### Report

Include a "Decomposition" subsection in the output:
```
### Decomposition
<N tasks scanned, M decomposable. K subtasks written to TASKS.md.>
<list each decomposition with subtasks>
<or "no decomposition opportunities found">
```

## Claim task

After selecting the recommended task (re-evaluating if decomposition created higher-priority subtasks), claim it if your repo exposes a task-claim mechanism. Otherwise proceed without claiming.

## Assess context

For the recommended task and its project, also evaluate:

- **Gravity signals**: Are there recurring manual fixes or workarounds flagged in recent logs?
- **Uncommitted work**: Does `git status` show meaningful uncommitted changes that should be committed first?
- **Budget state**: If the project has `budget.yaml`, is there remaining headroom for the recommended task?
- **Decision debt**: Are there implicit choices being made that should be recorded in `decisions/` (system-wide) or `projects/<project>/decisions/` (project-direction, per ADR 0035)?
- **Model-fit awareness**: If the recommended task depends on model capability, flag uncertainty and suggest an empirical check.
- **Compound opportunities**: **Skip if bootstrap mode** (<5 sessions) unless diagnosis files already exist. Otherwise, check for recent `diagnosis-*.md` and `postmortem-*.md` files (last 14 days) in `projects/`. If any contain unactioned recommendations relevant to the recommended task, surface them so the session can address them during execution or the compound phase. Additionally, scan completed `EXPERIMENT.md` files for recommendation sections (headers matching: Recommendations, Proposed solutions, Proposal: ..., Implications..., Prevention, Next steps) that lack the `<!-- Recommendations surfaced: YYYY-MM-DD -->` marker. Report the count and experiment IDs — e.g., "3 completed experiments have unsurfaced recommendations: exp-a (2 actionable), exp-b (1 actionable). Consider running `/compound deep` to process them."

## Output format

Produce a brief orientation report with these sections:

**State**: 2-3 sentence summary

**Budget & Deadline Status**: Per-project budget/deadline summary. Flag over-budget or past-deadline projects. Include ledger reconciliation warnings (experiments with >2× actual/recorded discrepancy).

**Uncommitted work**: Git status

**External work status**: Pending external requests and stale blocked-by tags from APPROVAL_QUEUE.md and TASKS.md. Flag items 7+ days old.

**Mission gap analysis**: Per-project condition counts (satisfied, has task, gaps). List gaps and generated tasks.

**Recommended task**: Task text, project, why highest-leverage, expected output, estimated cost

**Cross-session patterns**: Recurring violations from sessions.jsonl

**Gravity signals**: Recurring manual patterns

**Model-fit awareness**: Any model-dependent risks or suggested checks

**Horizon-scan intel**: Recent findings from .scheduler/skill-reports/horizon-scan-*.md

**Compound opportunities**: Unactioned recommendations and unsurfaced experiment recommendations

**Efficiency summary**: Findings/$, waste %, overhead %, avg cost, avg turns with baselines and flags

**Task supply updates**: What you generated, decomposed, or re-tagged

**Decomposition**: Tasks scanned, decomposable, subtasks written

**Chat suggestion supply**: Untriaged suggestions by project

**Risks**: Anything wrong, stalled, or drifting

**Recommended skill**: Which skill to apply first, or "none — proceed with implementation"

**Skill selection guide**:
- Just finished experiment → `/review`
- Results to interpret → `/diagnose`
- Reviewing plan/design → `/simplify` or `/critique`
- Something went wrong → `/postmortem` or `/diagnose`
- Accumulated findings → `/synthesize`
- Recurring pattern → `/gravity`
- Need papers → `/lit-review`
- Designing experiment → `/design`
- Research gap → `/project propose`
- Paper ready → `/publish`
- Infra changes → `/refresh-skills`
- Infra health → `/architecture`
- Compliance → `/self-audit`
- End of session → `/compound`

Keep the report concise. End with one clear recommended task.
