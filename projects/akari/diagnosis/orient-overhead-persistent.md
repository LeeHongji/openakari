# Diagnosis: Orient overhead remains high despite fast tier

Date: 2026-03-14
Status: diagnosed
Self-improvement loop: 3 (orient overhead, continued from loop 1)

## Observation

Fast orient was introduced in session 3 to reduce orient overhead from ~42% to a target of ~20%. After 4 fast-orient sessions, the average overhead is **51.6%** — worse than the original full orient session (41.9%).

| Session | Tier | orientTurns | numTurns | Overhead |
|---------|------|-------------|----------|----------|
| 1 | full | 18 | 43 | 41.9% |
| 2 | fast | 13 | 29 | 44.8% |
| 3 | full | 24 | 38 | 63.2% |
| 4 | fast | 17 | 32 | 53.1% |
| 5 | fast | 20 | 35 | 57.1% |
| 6 | fast | 21 | 41 | 51.2% |

Fast orient sessions (2,4,5,6) average: 51.6% overhead, 17.75 orient turns.
Full orient sessions (1,3) average: 52.5% overhead, 21 orient turns.
Difference: negligible.

## Root causes

### Finding 1: Fast orient retains all high-cost steps (RC1 — primary)

The fast orient procedure skips ~12 steps from full orient, but the skipped steps are predominantly low-cost reads (`docs/status.md`, `docs/roadmap.md`, `budget.yaml`) or steps that return empty results at bootstrap (cross-session patterns, horizon-scan, fleet metrics). Every high-cost step is retained:

**Retained in fast orient (high-cost):**
- Step 0: git status + orphan commit (2-3 turns)
- Gather context: read all TASKS.md + README headers (2-4 turns)
- Efficiency summary: read sessions.jsonl + compute 5 metrics (2-3 turns)
- Task supply and decomposition scan (1-2 turns)
- Mission gap check for high-priority projects (2-4 turns)
- Full task selection ranking (1-2 turns)
- Empty-queue fallback grep (1-2 turns if triggered)
- Output report (1-2 turns)

**Evidence:** Session 1 (full orient) used 7 Read calls. Session 2 (fast orient) also used 7 Read calls. Session 5 (fast orient) used 17 Read calls and 28 Bash calls — more than any full orient session.

The fast tier achieves ~3-turn savings (21 → 17.75 turns average) — a 15% reduction, not the 52% reduction needed to reach 20% overhead.

### Finding 2: `orientTurns` measurement is prematurely stopped by TodoWrite (RC2)

In `infra/scheduler/src/sdk.ts` (line 128, 152-153):

```typescript
const EXECUTION_PHASE_TOOLS = new Set(["Edit", "Write", "TodoWrite"]);
// ...
if (EXECUTION_PHASE_TOOLS.has(name) && this.orientStartTurn !== null && this._orientTurns === undefined) {
  this._orientTurns = this.assistantTurnCount - this.orientStartTurn;
}
```

The `orientTurns` counter is locked at the **first** TodoWrite call. But agents use TodoWrite during orient (to track orient progress per CLAUDE.md instructions). This means turns spent on mission gap analysis, task selection, and the orient report after TodoWrite are counted as task execution, not orient overhead.

The reported 51.6% overhead may be an **understatement**. The true orient cost could be higher.

### Finding 3: `wasFullOrient()` threshold is miscalibrated (RC3)

In `infra/scheduler/src/orient-tier.ts` (line 6):

```typescript
const FAST_ORIENT_TURNS_THRESHOLD = 15;
```

`wasFullOrient()` returns `true` when `orientTurns > 15`. This threshold was designed for "fast = ~2-3 turns" but fast orient actually produces 13-21 turns. Result: 3 of 4 fast sessions (S4=17, S5=20, S6=21) are misclassified as "full orient", updating `lastFullOrientAt` and perpetuating the fast-tier injection cycle.

This creates a feedback loop: fast orient runs → takes 17+ turns → classified as full → fast tier injected next session → repeat. The system never detects that fast orient isn't producing the expected turn reduction.

### Finding 4: 20% overhead target is structurally unreachable (RC4)

Current task phases run 12-20 turns for typical work (analysis, diagnosis, single-file edits). Even with a hypothetical 10-turn orient, overhead would be:
- 10/(10+12) = 45% (small task)
- 10/(10+20) = 33% (large task)
- 10/(10+40) = 20% (very large task)

To reach 20% overhead, either orient must be under ~5 turns OR tasks must consistently exceed 40 turns. Neither is achievable with the current orient procedure or current task types. The 20% target was aspirational, not engineering-derived.

## Proposed fixes

### Fix A: Remove TodoWrite from EXECUTION_PHASE_TOOLS (RC2 fix)

In `infra/scheduler/src/sdk.ts` line 128, change:
```typescript
const EXECUTION_PHASE_TOOLS = new Set(["Edit", "Write", "TodoWrite"]);
```
to:
```typescript
const EXECUTION_PHASE_TOOLS = new Set(["Edit", "Write"]);
```

**Rationale:** TodoWrite is used during orient for progress tracking and does not signal task execution has begun. Edit and Write are reliable signals — agents read and plan during orient, but only edit/write files during task execution.

**Risk:** Low. If an orient procedure writes a TASKS.md update via Edit (e.g., mission gap task generation), this would be counted as orient end. That's acceptable — writing to TASKS.md during orient IS the transition point between planning and acting.

### Fix B: Raise wasFullOrient threshold (RC3 fix)

In `infra/scheduler/src/orient-tier.ts` line 6, change:
```typescript
const FAST_ORIENT_TURNS_THRESHOLD = 15;
```
to:
```typescript
const FAST_ORIENT_TURNS_THRESHOLD = 25;
```

**Rationale:** Full orient produces 18-24 turns (sessions 1, 3). Fast orient produces 13-21 turns. A threshold of 25 would correctly classify all observed sessions: full orient sessions (18, 24) as full, fast orient sessions (13, 17, 20, 21) as fast. This breaks the misclassification feedback loop.

### Fix C: Revise overhead target to 35% (RC4 fix)

Update the measurement plan and orient skill to use 35% as the overhead baseline instead of 20%. This reflects the structural reality that orient takes 13-21 turns and tasks take 12-20 turns. A 35% target is achievable with a 10-turn orient and 20-turn task phase: 10/30 = 33%.

### Fix D: Reduce fast orient procedure steps (RC1 fix, future)

The fast orient skill text could be further streamlined. Candidates for removal or deferral:
- **Efficiency summary**: compute only when explicitly requested, not every session
- **Mission gap check**: run only on full orient, not fast
- **Task supply generation**: limit to unblocking stale blockers, skip decomposition on fast

This is a convention change (modifying SKILL.md) and should be done after Fixes A-C are implemented and measured.

## Impact estimate

- Fix A: Corrects measurement only. No behavioral change. Allows accurate tracking.
- Fix B: Prevents misclassification feedback loop. Enables correct tier detection.
- Fix C: Sets achievable target. Prevents false-positive "overhead too high" flags.
- Fix A+B+C together: Enables accurate measurement, correct tier detection, and realistic targets. Expected measured overhead with accurate counting: ~50-55% (since TodoWrite truncation was hiding additional orient turns). But with Fix D implemented, could drop to ~35-40%.
