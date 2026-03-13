# Measurement Plan: openakari Self-Improvement

Date: 2026-03-14
Project: akari
Type: measurement plan
Status: active

## Goal

Define concrete, measurable metrics for whether this openakari deployment is improving itself over time. Each metric has an explicit data source, computation method, and interpretation guide — designed to work even during the bootstrap phase when operational data is sparse.

## Context

This plan replaces the adapted example at `plans/self-improvement-measurement.md`. That file defined the right conceptual framework (gap detection → closure → effectiveness → intervention rate → system-learning rate). This plan operationalizes it for the actual data sources available in this repo.

### Current data sources

| Source | Path | What it contains | Available now? |
|--------|------|-------------------|----------------|
| Git log | `git log` | Commits, authors, timestamps | Yes (4 commits) |
| Session metrics | `.scheduler/metrics/sessions.jsonl` | Per-session cost, turns, knowledge counts, verification | No — populates when scheduler runs |
| Tasks | `projects/*/TASKS.md` | Task lifecycle: creation, completion, tagging | Yes |
| Approval queue | `APPROVAL_QUEUE.md` | Human intervention events | Yes (empty) |
| Project logs | `projects/*/README.md` (Log section) | Session summaries, dated entries | Yes (1 entry) |
| Diagnosis files | `projects/*/diagnosis/*.md` | Self-detected failure modes | Yes (1 example) |
| Decision records | `decisions/*.md` | Architectural choices | Yes (66 adapted) |
| Analysis files | `projects/*/analysis/*.md` | Quantitative findings | Yes (1 example) |
| Patterns | `projects/akari/patterns/*.md` | Extracted recurring patterns | Yes (7 files) |

## Metrics

### M1: Gap Detection Rate

**What it measures**: How often the system identifies its own operational failure modes from evidence, rather than waiting for human direction.

**Data source**: Count files matching `projects/*/diagnosis/*.md` and `projects/*/postmortem/*.md` that are NOT tagged `Type: adapted example`. Divide by session count.

**Computation**:
```bash
# Count original diagnosis/postmortem artifacts
find projects/ -path "*/diagnosis/*.md" -o -path "*/postmortem/*.md" | \
  xargs grep -L "Type: adapted example" 2>/dev/null | wc -l

# Count sessions (from git log, counting session-tagged commits)
git log --oneline --grep="session" | wc -l
# Or from sessions.jsonl when available:
# wc -l < .scheduler/metrics/sessions.jsonl
```

**Formula**: `original_gap_artifacts / sessions`

**Interpretation**:
- 0.0 = system never self-diagnoses (fully dependent on human direction)
- 0.1-0.3 = occasional self-diagnosis (healthy early stage)
- 0.5+ = frequent self-diagnosis (mature self-observation)

**Bootstrap note**: During the first 10 sessions, compute this as an absolute count rather than a rate. The denominator is too small for a meaningful rate.

---

### M2: Closure Rate

**What it measures**: What fraction of self-detected gaps lead to concrete action (a code change, convention update, new task, or decision record)?

**Data source**: For each diagnosis/postmortem file, check whether:
- A task in TASKS.md references it or addresses the same issue
- A commit message references the diagnosis
- A decision record was created in response
- A convention or infrastructure change was made

**Computation**:
```bash
# For each diagnosis file, search for references in TASKS.md, decisions/, git log
for f in projects/*/diagnosis/*.md; do
  name=$(basename "$f" .md)
  echo "=== $name ==="
  grep -rl "$name" projects/*/TASKS.md decisions/ 2>/dev/null
  git log --oneline --grep="$name"
done
```

**Formula**: `gaps_with_followup / total_original_gaps`

**Interpretation**:
- <0.3 = most gaps are identified but never acted on (diagnosis theater)
- 0.3-0.7 = healthy closure rate
- >0.7 = strong follow-through

**Bootstrap note**: Track as absolute pairs (gap → action) until there are at least 5 original diagnosis artifacts.

---

### M3: Human Intervention Rate

**What it measures**: How much explicit human action is required per unit of autonomous work?

**Data source (primary)**: `APPROVAL_QUEUE.md` — count entries in the Resolved section. Each resolved item is one intervention event.

**Data source (secondary)**: Git log — commits by human authors (non-scheduler, non-agent commits). Identify by absence of `[scheduler]` prefix and absence of `Co-Authored-By: Claude` in commit body.

**Computation**:
```bash
# Count resolved approval items
grep -c "^### " APPROVAL_QUEUE.md  # under ## Resolved section

# Count human-only commits
git log --oneline | grep -v "\[scheduler\]" | grep -v "Co-Authored-By" | wc -l

# Count total sessions
# From sessions.jsonl or git log session markers
```

**Formula**: `(approval_events + human_commits) / sessions`

**Interpretation**:
- Decreasing trend = system becoming more autonomous
- Stable = system operating at its current capability ceiling
- Increasing = new capabilities or governance being added (expected during bootstrap)

**Caution**: A low rate is only meaningful if the system is also producing useful work (see M5). Low intervention + zero output = silent failure, not autonomy.

---

### M4: System-Learning Rate

**What it measures**: How often does a session embed a learning back into the system itself (conventions, infrastructure, skills, decision records)?

**Data source**: Git diffs touching system-level files:
- `decisions/*.md` (new decision records)
- `CLAUDE.md` (convention updates)
- `docs/conventions/*.md`, `docs/sops/*.md` (procedure updates)
- `infra/**` (infrastructure changes)
- `.claude/skills/**` (skill updates)

**Computation**:
```bash
# Count commits that touch system-level files
git log --oneline --diff-filter=AM -- \
  "decisions/*.md" "CLAUDE.md" "docs/conventions/*.md" \
  "docs/sops/*.md" "infra/**" ".claude/skills/**" | wc -l

# Divide by total session count
```

**Formula**: `system_changing_sessions / total_sessions`

**Interpretation**:
- 0.0 = system never evolves its own infrastructure (pure task execution)
- 0.1-0.3 = occasional self-modification (typical for stable systems)
- 0.3-0.5 = active self-evolution (healthy growth phase)
- >0.5 = may indicate excessive meta-work vs. actual research

---

### M5: Knowledge Output Rate

**What it measures**: Is the system producing actual research knowledge, not just operational overhead?

**Data source**: Count knowledge-producing artifacts per session:
- New analysis files (`projects/*/analysis/*.md`)
- Experiment findings (EXPERIMENT.md files with `## Findings` sections)
- Log entries with substantive findings (not just "selected task X")
- New patterns documented (`projects/*/patterns/*.md`)

**Computation**:
```bash
# Count knowledge artifacts (non-example)
find projects/ \( -path "*/analysis/*.md" -o -path "*/patterns/*.md" \) | \
  xargs grep -L "Type: adapted example" 2>/dev/null | wc -l

# Count experiment findings
grep -rl "^## Findings" projects/*/experiments/*/EXPERIMENT.md 2>/dev/null | wc -l

# When sessions.jsonl is available, use:
# sum of (newExperimentFindings + logEntryFindings) per session
```

**Formula**: `knowledge_artifacts / sessions`

**Combined with cost (when available)**: `knowledge_artifacts / total_cost_usd` = findings per dollar (the primary KPI from the original akari system, baseline: 1.29 f/$)

**Interpretation**:
- This is the denominator check for M3. Low intervention is only good if knowledge output is nonzero.
- Target: >0.5 knowledge artifacts per session once the system is past bootstrap.

## Measurement cadence

| Phase | Sessions | Cadence | Method |
|-------|----------|---------|--------|
| Bootstrap | 0-10 | Every session | Manual count in orient report |
| Early | 10-50 | Every 10 sessions | Script or orient efficiency summary |
| Steady | 50+ | Weekly or per-25-sessions | Automated via sessions.jsonl metrics |

During bootstrap, report absolute counts rather than rates. The denominators are too small for meaningful rates, and trends require at least 3 data points.

## Baseline

As of 2026-03-14 (session 0):
- M1 (Gap Detection): 0 original artifacts (1 adapted example exists)
- M2 (Closure Rate): N/A (no original gaps to close)
- M3 (Intervention Rate): ~1.0 (all commits so far are human-initiated or scheduler auto-commits)
- M4 (System-Learning): N/A (no autonomous sessions yet)
- M5 (Knowledge Output): 0 original artifacts (examples exist but are adapted)

## Next steps

1. Run the first measurement after 5 autonomous sessions have completed
2. Create a script to automate the computation once sessions.jsonl is populated
3. Record each measurement as a dated analysis file in `projects/akari/analysis/`
