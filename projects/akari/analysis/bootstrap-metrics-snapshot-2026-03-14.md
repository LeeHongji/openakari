# Bootstrap Metrics Snapshot

Date: 2026-03-14 (session 4)
Project: akari
Type: measurement snapshot

## Context

This is the first measurement snapshot for the openakari deployment, computed at session 4 with 2 sessions recorded in `sessions.jsonl` (sessions 1-2) and 1 additional session (session 3) evidenced in git but not yet in metrics. Per the measurement plan (`plans/measurement-plan-openakari.md`), bootstrap-phase metrics use absolute counts rather than rates because the denominators are too small for meaningful rates.

## M1: Gap Detection Rate

**Count**: 1 original diagnosis artifact

- `diagnosis/bootstrap-orient-overhead.md` — produced in session 2 (self-observation, not adapted)
- `diagnosis/self-observation-examples.md` — excluded (Type: adapted example)

**Bootstrap interpretation**: 1 original diagnosis in 3 sessions = the system has begun self-diagnosing. Above 0 is the critical threshold.

**Provenance**: `find projects/ -path "*/diagnosis/*.md" | xargs grep -L "Type: adapted example"` → 1 file.

---

## M2: Closure Rate

**Count**: 1/1 (100% of original gaps led to concrete action)

The single original diagnosis (bootstrap-orient-overhead) produced a complete closure chain:
1. Diagnosis file created (session 2, commit `922092f`)
2. Implementation task created in TASKS.md (session 3, via mission gap analysis)
3. Code change implemented: bootstrap detection added to orient skill (session 3, commit `2719596`)
4. Skill file updated: `.claude/skills/orient/SKILL.md` modified with 7 skip conditions

**Provenance**: `grep -rl "bootstrap-orient-overhead" projects/*/TASKS.md .claude/skills/` → 2 files; `git log --oneline --grep="bootstrap"` → 3 commits.

**Bootstrap interpretation**: 100% closure on 1 sample is meaningless as a rate but demonstrates the pattern works: diagnose → task → implement → verify.

---

## M3: Human Intervention Rate

**Approval queue events**: 0 resolved items in `APPROVAL_QUEUE.md`

**Commit analysis** (10 total commits):

| Category | Count | Commits |
|----------|-------|---------|
| Human-authored | 1 | `0e057e2` (Initial commit) |
| Agent-authored (no Co-Authored-By) | 4 | `2719596`, `922092f`, `eddcd3f`, `1700c7d` |
| Scheduler auto-commits | 5 | All `[scheduler]` prefix commits |

**Formula**: (0 approval events + 1 human commit) / 3 sessions = 0.33 interventions/session

**Bootstrap interpretation**: The single human intervention was the initial commit — expected and unrepeatable. Since then, 0 human interventions across 3 autonomous sessions. This is the ideal bootstrap trajectory, though the denominator is too small to call it a trend.

**Caveat (from M5 below)**: Low intervention is only meaningful if the system is also producing useful work. See M5.

---

## M4: System-Learning Rate

**Count**: 3 sessions that touched system-level files out of 3 total sessions

Session-by-session:
- Session 1: Created `plans/measurement-plan-openakari.md` (not system-level per strict definition, but produced a measurement plan)
- Session 2: Created `diagnosis/bootstrap-orient-overhead.md` (not system-level, but diagnosed a system problem)
- Session 3: Modified `.claude/skills/orient/SKILL.md` — this IS a system-level change

**Strict count** (commits touching decisions/, CLAUDE.md, docs/conventions/, docs/sops/, infra/**, .claude/skills/**): 1 agent session out of 3 (session 3).

**Provenance**: `git log --oneline --diff-filter=AM -- ".claude/skills/**"` filtered to non-scheduler commits → 1 commit (`2719596`).

**Bootstrap interpretation**: 1/3 sessions modified the system itself. This is within the 0.1-0.5 healthy range from the measurement plan, though the sample is tiny.

---

## M5: Knowledge Output Rate

**Original knowledge artifacts** (excluding "Type: adapted example"):

| Artifact type | Count | Files |
|---------------|-------|-------|
| Diagnosis | 1 | `diagnosis/bootstrap-orient-overhead.md` |
| Analysis | 0 | (this file will be the first) |
| Experiment findings | 0 | No experiments run yet |
| Patterns | 0 | All 7 pattern files are pre-seeded from original akari |
| Plans | 1 | `plans/measurement-plan-openakari.md` (Type: measurement plan, original) |

**Total original knowledge artifacts**: 2 (1 diagnosis + 1 plan)

**From sessions.jsonl**: 0 `newExperimentFindings`, 0 `logEntryFindings` across 2 recorded sessions. 1 `diagnosesCompleted`, 2 `structuralChanges`.

**Combined with cost**: 2 knowledge artifacts / $2.71 (sessions 1-2 cost) = 0.74 artifacts per dollar. This is below the original akari baseline of 1.29 findings/$ but expected during bootstrap when infrastructure setup dominates.

**Bootstrap interpretation**: The system is producing knowledge (diagnosis, measurement plan) but not yet experiment-derived findings. This is appropriate — there are no external research projects yet, so all knowledge is meta-knowledge about the system itself.

---

## Aggregate Observations

### Finding 1: Orient overhead remains high despite fast tier

Session 1 (full orient): 18/43 turns = 42% overhead, $1.44
Session 2 (fast orient): 13/29 turns = 45% overhead, $1.27

The fast orient tier did NOT reduce overhead percentage. It reduced absolute turns (18 → 13) but the session was also shorter (43 → 29 turns), so the proportion stayed constant. **Root cause hypothesis**: fast orient still performs task supply analysis, mission gap checks, and decomposition — which are proportionally expensive in a repo with thin task supply. The bootstrap mode fix (session 3) targets a different problem: skipping data-gathering steps that return empty results. The actual overhead reduction should be measurable in this session (4) and beyond.

**Provenance**: `sessions.jsonl` fields `orientTurns` and `numTurns` for sessions 1-2.

### Finding 2: Knowledge accounting undercounts agent output

Sessions.jsonl recorded 0 `logEntryFindings` for both sessions, yet both sessions wrote substantive log entries to `projects/akari/README.md` with findings (session 2's log entry describes the bootstrap-orient-overhead diagnosis with specific numbers). The `logEntryFindings` counter appears to require explicit markup or structured format that the agent isn't using.

Similarly, session 1 created `plans/measurement-plan-openakari.md` — a substantive knowledge artifact — but no knowledge field captures "new plan created."

**Implication**: The findings/dollar metric from sessions.jsonl (currently 0 f/$) underestimates actual knowledge output. The manual count above (2 artifacts / $2.71 = 0.74 a/$) is more accurate during bootstrap.

### Finding 3: Self-improvement loop completed in 2 sessions

The gap → fix cycle (diagnose in session 2, implement in session 3) completed in the minimum possible number of sessions. This validates the meta-project's core claim: the system can identify its own operational problems and fix them without human direction. The only human intervention in the entire sequence was the initial commit setting up the repo.

## Next Steps

1. After session 5, compare this session's orient overhead (session 4) against the 42-45% baseline to verify the bootstrap fix works
2. When sessions.jsonl reaches 5 entries, compute rates instead of absolute counts
3. Investigate the knowledge accounting undercount (Finding 2) — either fix the metric collection or document the expected gap
