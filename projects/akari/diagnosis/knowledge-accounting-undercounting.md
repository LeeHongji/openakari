# Diagnosis: Knowledge Accounting Undercounting

Date: 2026-03-14
Project: akari
Type: self-observation diagnosis
Severity: high

## Problem

All 4 automated sessions report `newExperimentFindings: 0` and `logEntryFindings: 0` in sessions.jsonl, despite analysis files containing 8+ explicitly labeled findings. The primary KPI (findings/$) computes as **0.00 f/$** when the true rate is approximately **1.45 f/$** (8 findings / $5.55 total cost). Self-measurement is broken — the system cannot evaluate its own knowledge output.

## Evidence

### sessions.jsonl knowledge counters vs actual findings

| Session | Cost | Recorded findings | Actual findings | Source |
|---------|------|-------------------|-----------------|--------|
| 1 (345dloxm-ccd08894) | $1.44 | 0 | 0 | Produced measurement plan (structural, not findings) |
| 2 (345dloxm-7663c31a) | $1.27 | 0 | 1 | `diagnosis/bootstrap-orient-overhead.md` — diagnosis artifact |
| 3 (345dloxm-11e1ef71) | $1.54 | 0 | 0 | Infrastructure change (orient skill), no explicit findings |
| 4 (345dloxm-b15dfd0e) | $1.30 | 0 | 3 | `analysis/bootstrap-metrics-snapshot-2026-03-14.md` — 3 findings |
| 5 (this session's predecessor) | ~$1.30 | 0 | 4 | `analysis/human-intervention-rate-2026-03-14.md` — 4 findings |

**Provenance**: sessions.jsonl lines 1-4 for recorded values; `git log --oneline` for commit messages that explicitly state finding counts ("feat: measure human intervention rate (M3) with 4 findings", "feat: first bootstrap metrics snapshot (M1-M5) with 3 findings"); analysis files contain `### Finding N:` headers.

### Discrepancy: 0 recorded vs 8 actual = 100% undercount

The system has produced 8 documented findings across 5 sessions but recorded zero in its metrics. The `newAnalysisFiles` counter correctly records 1 for sessions 3 and 4, proving the diff parser sees the analysis files — it just doesn't count their findings.

## Root cause analysis

### The code path

The knowledge counting logic lives in `infra/scheduler/src/verify.ts`, function `parseKnowledgeFromDiff()` (lines 1047-1111).

Two counters are relevant:

1. **`newExperimentFindings`** (lines 1048-1055): Counts added lines matching `/^\+\d+\.\s/` in files ending with `EXPERIMENT.md`. Analysis files (`analysis/*.md`) don't match this filter.

2. **`logEntryFindings`** (lines 1102-1111): Counts added lines matching `/^\+\d+\.\s/` in files ending with `README.md`, excluding `EXPERIMENT.md`. Line 1105 explicitly filters: `if (!file.endsWith("README.md")) continue;` — this rejects all analysis files.

### Why analysis files are invisible

The counter was designed for a convention where findings live in two places:
- **EXPERIMENT.md** → `newExperimentFindings`
- **README.md log entries** → `logEntryFindings`

But the openakari repo developed a third convention: **standalone analysis files** (`projects/*/analysis/*.md`) that contain explicitly labeled findings sections. These files are:
- Correctly detected as new files (counter `newAnalysisFiles` increments)
- **Never scanned for findings content**

### The format mismatch

Even if analysis files were scanned, the regex `/^\+\d+\.\s/` (numbered items like "1. Finding text") wouldn't match the actual format used in analysis files: `### Finding 1:` (markdown headers). The counting logic assumes findings are numbered list items, but the analysis files use `### Finding N:` headers.

### Summary

Two bugs compound:
1. **File filter too narrow**: Only `EXPERIMENT.md` and `README.md` are scanned for findings
2. **Regex doesn't match analysis format**: Analysis files use `### Finding N:` headers, not `1. ` numbered lists

## Impact

- **Primary KPI (findings/$) is always 0.0** — makes efficiency tracking meaningless
- **Bootstrap metrics M2/M5 undercount** — the measurement plan relies on sessions.jsonl knowledge counters as a data source
- **Self-improvement loops can't be measured** — the system cannot detect whether it's producing more or less knowledge over time
- **Orient efficiency summary is blind** — when the system exits bootstrap mode, findings/$ comparisons against the 1.29 baseline will always show 0.0 and trigger false alarms

## Proposed fix

### Option A: Extend parseKnowledgeFromDiff (recommended)

Add analysis files to the findings scan with a regex that matches both formats:

```typescript
// 8b. Findings in analysis files (projects/*/analysis/*.md)
for (const block of diffBlocks) {
  const file = blockFile(block);
  if (!/^projects\/[^/]+\/analysis\/.*\.md$/.test(file)) continue;
  for (const line of block.split("\n")) {
    // Match "### Finding N:" headers (analysis file convention)
    if (/^\+###\s+Finding\s+\d+/.test(line)) {
      result.logEntryFindings++;
    }
  }
}
```

Also add a similar block for diagnosis files (`projects/*/diagnosis/*.md`), since the bootstrap-orient-overhead diagnosis is also a knowledge artifact that went uncounted.

### Option B: Normalize finding format (not recommended)

Require all findings to use `1. ` numbered lists and put them in README.md log entries. This would make the existing counter work but loses the benefit of standalone analysis files (searchability, cross-referencing, independent artifact tracking).

### Option C: Add a new counter `analysisFindings` (alternative)

Add a dedicated counter rather than reusing `logEntryFindings`. Pros: distinguishes finding sources. Cons: requires downstream changes to KPI computation. The simplest fix is Option A.

### Test update

The test file `infra/scheduler/src/verify-knowledge.test.ts` should add test cases for:
- Analysis file with `### Finding N:` headers
- Diagnosis file with findings
- Mixed commit with EXPERIMENT.md + analysis file findings

## What this diagnosis demonstrates

This is the second self-observation diagnosis in the akari meta-project (M1: 1 → 2). It follows the same pattern as the first (bootstrap-orient-overhead): identify a gap from operational data, trace it to specific code, and propose a concrete fix.

Together, the two diagnoses form a pattern: the system's self-measurement infrastructure was designed for a mature repo's conventions but doesn't match the conventions that naturally emerged during bootstrap. Both fixes (orient bootstrap mode, knowledge counter extension) address the same root cause — **assumed conventions that don't hold at bootstrap**.
