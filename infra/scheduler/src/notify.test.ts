/** Tests for readBudgetStatus(), readAllBudgetStatuses(), buildSessionBlocks(), and parsePendingItems() in notify.ts. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readBudgetStatus, readAllBudgetStatuses, buildSessionBlocks, parsePendingItems, resolveApproval } from "./notify.js";
import { parseResolvedBurstItems, findExecutableBursts } from "./approval-burst.js";
import type { Job } from "./types.js";
import type { ExecutionResult } from "./executor.js";

const BUDGET_YAML = `resources:
  simulation_calls:
    limit: 300
    unit: calls
  cost_units:
    limit: 800
    unit: units

deadline: 2026-03-01T00:00:00Z
`;

const LEDGER_YAML = `entries:
  - date: "2026-02-16"
    experiment: baseline
    resource: simulation_calls
    amount: 60
    detail: "60 calls"
  - date: "2026-02-16"
    experiment: baseline
    resource: cost_units
    amount: 240
    detail: "60 x 4"
`;

const LEDGER_YAML_2 = `entries:
  - date: "2026-02-17"
    experiment: routing
    resource: simulation_calls
    amount: 120
    detail: "120 calls"
  - date: "2026-02-17"
    experiment: routing
    resource: cost_units
    amount: 400
    detail: "120 x ~3.3"
`;

describe("readBudgetStatus", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "notify-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no budget.yaml exists", async () => {
    const result = await readBudgetStatus(tmpDir);
    expect(result).toBeNull();
  });

  it("returns 0 consumed when budget.yaml exists but no ledger", async () => {
    await writeFile(join(tmpDir, "budget.yaml"), BUDGET_YAML);
    const result = await readBudgetStatus(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.resources).toHaveLength(2);
    expect(result!.resources[0]).toMatchObject({
      resource: "simulation_calls",
      consumed: 0,
      limit: 300,
      unit: "calls",
      pct: 0,
    });
  });

  it("reads ledger.yaml at project root (standard path)", async () => {
    await writeFile(join(tmpDir, "budget.yaml"), BUDGET_YAML);
    await writeFile(join(tmpDir, "ledger.yaml"), LEDGER_YAML);
    const result = await readBudgetStatus(tmpDir);
    expect(result).not.toBeNull();
    const simCalls = result!.resources.find((r) => r.resource === "simulation_calls");
    const costUnits = result!.resources.find((r) => r.resource === "cost_units");
    expect(simCalls!.consumed).toBe(60);
    expect(costUnits!.consumed).toBe(240);
  });

  it("parses deadline correctly", async () => {
    await writeFile(join(tmpDir, "budget.yaml"), BUDGET_YAML);
    const result = await readBudgetStatus(tmpDir);
    expect(result!.deadline).toBe("2026-03-01T00:00:00Z");
    expect(result!.hoursToDeadline).toBeDefined();
  });

  it("handles malformed budget.yaml gracefully", async () => {
    await writeFile(join(tmpDir, "budget.yaml"), "this is not valid yaml {{{");
    const result = await readBudgetStatus(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.resources).toEqual([]);
  });

  it("handles empty budget.yaml", async () => {
    await writeFile(join(tmpDir, "budget.yaml"), "");
    const result = await readBudgetStatus(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.resources).toEqual([]);
  });

  it("handles budget.yaml with missing required fields", async () => {
    await writeFile(join(tmpDir, "budget.yaml"), "resources:\n  - name: test\n");
    const result = await readBudgetStatus(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.resources).toEqual([]);
  });
});

describe("readAllBudgetStatuses", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "notify-all-test-"));
    await mkdir(join(tmpDir, "projects"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns budgets from all projects with budget.yaml", async () => {
    await mkdir(join(tmpDir, "projects", "alpha"));
    await mkdir(join(tmpDir, "projects", "beta"));
    await writeFile(join(tmpDir, "projects", "alpha", "budget.yaml"), BUDGET_YAML);
    await writeFile(join(tmpDir, "projects", "beta", "budget.yaml"), BUDGET_YAML);

    const results = await readAllBudgetStatuses(tmpDir);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.project).sort()).toEqual(["alpha", "beta"]);
  });

  it("skips excluded projects", async () => {
    await mkdir(join(tmpDir, "projects", "alpha"));
    await mkdir(join(tmpDir, "projects", "excluded-project"));
    await writeFile(join(tmpDir, "projects", "alpha", "budget.yaml"), BUDGET_YAML);
    await writeFile(join(tmpDir, "projects", "excluded-project", "budget.yaml"), BUDGET_YAML);

    const results = await readAllBudgetStatuses(tmpDir, ["excluded-project"]);
    expect(results).toHaveLength(1);
    expect(results[0].project).toBe("alpha");
  });

  it("returns all projects when excludeProjects is not provided", async () => {
    await mkdir(join(tmpDir, "projects", "alpha"));
    await mkdir(join(tmpDir, "projects", "beta"));
    await writeFile(join(tmpDir, "projects", "alpha", "budget.yaml"), BUDGET_YAML);
    await writeFile(join(tmpDir, "projects", "beta", "budget.yaml"), BUDGET_YAML);

    const results = await readAllBudgetStatuses(tmpDir);
    expect(results).toHaveLength(2);
  });

  it("returns all projects when excludeProjects is empty", async () => {
    await mkdir(join(tmpDir, "projects", "alpha"));
    await mkdir(join(tmpDir, "projects", "beta"));
    await writeFile(join(tmpDir, "projects", "alpha", "budget.yaml"), BUDGET_YAML);
    await writeFile(join(tmpDir, "projects", "beta", "budget.yaml"), BUDGET_YAML);

    const results = await readAllBudgetStatuses(tmpDir, []);
    expect(results).toHaveLength(2);
  });
});

describe("buildSessionBlocks", () => {
  const makeJob = (overrides?: Partial<Job>): Job => ({
    id: "test-job",
    name: "test-session",
    schedule: { kind: "cron", expr: "0 * * * *" },
    payload: { message: "Run /orient", model: "opus", backend: "cursor" },
    enabled: true,
    createdAtMs: Date.now(),
    state: { nextRunAtMs: null, lastRunAtMs: null, lastStatus: null, lastError: null, lastDurationMs: null, runCount: 0 },
    ...overrides,
  });

  const makeResult = (overrides?: Partial<ExecutionResult>): ExecutionResult => ({
    ok: true,
    durationMs: 120_000,
    exitCode: 0,
    stdout: "Done.",
    backend: "cursor",
    ...overrides,
  });

  it("includes job name in session completion fields", () => {
    const blocks = buildSessionBlocks(makeJob(), makeResult(), []);
    const json = JSON.stringify(blocks);
    expect(json).toContain("test-session");
  });

  it("includes cost and turns in session fields", () => {
    const blocks = buildSessionBlocks(makeJob(), makeResult({ costUsd: 1.53, numTurns: 38 }), []);
    const json = JSON.stringify(blocks);
    expect(json).toContain("$1.53");
    expect(json).toContain("38");
  });

  it("shows n/a when cost and turns are undefined", () => {
    const blocks = buildSessionBlocks(makeJob(), makeResult(), []);
    const json = JSON.stringify(blocks);
    expect(json).toContain("n/a");
  });

  it("includes next run time", () => {
    const nextRunMs = Date.now() + 1800_000; // 30 min from now
    const job = makeJob({ state: { nextRunAtMs: nextRunMs, lastRunAtMs: null, lastStatus: null, lastError: null, lastDurationMs: null, runCount: 0 } });
    const blocks = buildSessionBlocks(job, makeResult(), []);
    const json = JSON.stringify(blocks);
    expect(json).toContain("Next run");
  });
});

describe("parsePendingItems", () => {
  it("returns empty when only sentinel text present", () => {
    const content = `## Pending\n\n*No pending items.*\n\n## Resolved\n`;
    expect(parsePendingItems(content)).toEqual([]);
  });

  it("returns items when entries co-exist with sentinel text", () => {
    const content = [
      "## Pending",
      "",
      "### 2026-02-22 — Burst mode: run",
      "Project: akari",
      "Type: burst",
      "Request: Run a burst of autonomous sessions on the run job.",
      "",
      "*No pending items.*",
      "",
      "## Resolved",
    ].join("\n");
    const items = parsePendingItems(content);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Burst mode: run");
    expect(items[0].type).toBe("burst");
  });

  it("returns items when no sentinel text present", () => {
    const content = [
      "## Pending",
      "",
      "### 2026-02-22 — Test item",
      "Project: test",
      "Type: resource",
      "Request: Something",
      "",
      "## Resolved",
    ].join("\n");
    const items = parsePendingItems(content);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Test item");
  });

  it("parses burst-specific fields from pending items", () => {
    const content = [
      "## Pending",
      "",
      "### 2026-02-26 — Burst mode: akari-work-cycle",
      "Project: akari",
      "Type: burst",
      "Request: Run a burst of autonomous sessions on the akari-work-cycle job.",
      "Context: User requested burst mode via Slack chat.",
      "Job: akari-work-cycle",
      "Max-sessions: 10",
      "Max-cost: 20",
      "Autofix: true",
      "",
      "## Resolved",
    ].join("\n");
    const items = parsePendingItems(content);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("burst");
    expect(items[0].job).toBe("akari-work-cycle");
    expect(items[0].maxSessions).toBe(10);
    expect(items[0].maxCost).toBe(20);
    expect(items[0].autofix).toBe(true);
  });
});

describe("resolveApproval — burst field preservation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "resolve-burst-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("preserves burst fields when resolving a burst approval", async () => {
    const queueContent = [
      "# Approval Queue",
      "",
      "## Pending",
      "",
      "### 2026-02-26 — Burst mode: akari-work-cycle",
      "Project: akari",
      "Type: burst",
      "Request: Run a burst of autonomous sessions on the akari-work-cycle job.",
      "Context: User requested burst mode via Slack chat.",
      "Job: akari-work-cycle",
      "Max-sessions: 10",
      "Max-cost: 20",
      "Autofix: true",
      "",
      "## Resolved",
      "",
      "*No resolved items yet.*",
    ].join("\n");

    await writeFile(join(tmpDir, "APPROVAL_QUEUE.md"), queueContent);

    const items = parsePendingItems(queueContent);
    expect(items).toHaveLength(1);

    await resolveApproval(tmpDir, items[0], "approved", "test approval");

    const resolvedContent = await readFile(join(tmpDir, "APPROVAL_QUEUE.md"), "utf-8");
    
    const resolvedItems = parseResolvedBurstItems(resolvedContent);
    expect(resolvedItems).toHaveLength(1);
    expect(resolvedItems[0].job).toBe("akari-work-cycle");
    expect(resolvedItems[0].maxSessions).toBe(10);
    expect(resolvedItems[0].maxCost).toBe(20);
    expect(resolvedItems[0].autofix).toBe(true);
    expect(resolvedItems[0].decision).toBe("approved");
  });

  it("finds approved burst as executable after resolution", async () => {
    const queueContent = [
      "# Approval Queue",
      "",
      "## Pending",
      "",
      "### 2026-02-26 — Burst mode: akari-work-cycle",
      "Project: akari",
      "Type: burst",
      "Job: akari-work-cycle",
      "Max-sessions: 5",
      "Max-cost: 15",
      "Autofix: false",
      "",
      "## Resolved",
      "",
      "*No resolved items yet.*",
    ].join("\n");

    await writeFile(join(tmpDir, "APPROVAL_QUEUE.md"), queueContent);

    const items = parsePendingItems(queueContent);
    await resolveApproval(tmpDir, items[0], "approved");

    const resolvedContent = await readFile(join(tmpDir, "APPROVAL_QUEUE.md"), "utf-8");
    const executable = findExecutableBursts(parseResolvedBurstItems(resolvedContent));
    
    expect(executable).toHaveLength(1);
    expect(executable[0].job).toBe("akari-work-cycle");
  });
});
