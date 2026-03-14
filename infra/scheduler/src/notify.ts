/** Approval queue parsing, write-back, Slack message building, and context-aware Q&A. No Slack SDK dependency — pure data. */

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { runQuery } from "./sdk.js";
import type { Job } from "./types.js";
import type { ExecutionResult } from "./executor.js";

const execFileAsync = promisify(execFile);

export interface ApprovalItem {
  date: string;
  title: string;
  project: string;
  type: string;
  request?: string;
  context?: string;
  options?: string;
  estimatedCost?: string;
  questions?: string[];
  answers?: string[];
  job?: string;
  maxSessions?: number;
  maxCost?: number;
  autofix?: boolean;
  rawBlock: string;
}

/** Read APPROVAL_QUEUE.md content, or null if missing. */
export async function readQueueFile(repoDir: string): Promise<string | null> {
  try {
    return await readFile(join(repoDir, "APPROVAL_QUEUE.md"), "utf-8");
  } catch {
    return null;
  }
}

/** Parse the Pending section of APPROVAL_QUEUE.md into structured items. */
export function parsePendingItems(content: string): ApprovalItem[] {
  const pendingMatch = content.match(/## Pending\n([\s\S]*?)(?=\n## Resolved|$)/);
  if (!pendingMatch) return [];

  const pendingSection = pendingMatch[1];

  // Split on ### boundaries, keeping the delimiter
  const blocks = pendingSection.split(/(?=^### )/m).filter((b) => b.trim().startsWith("### "));

  const items: ApprovalItem[] = [];
  for (const block of blocks) {
    const headerMatch = block.match(/^### (\d{4}-\d{2}-\d{2}) — (.+)/);
    if (!headerMatch) continue;

    const field = (name: string): string | undefined => {
      const m = block.match(new RegExp(`^${name}: (.+)$`, "m"));
      return m ? m[1].trim() : undefined;
    };

    const questions: string[] = [];
    const answers: string[] = [];
    for (const line of block.split("\n")) {
      const qm = line.match(/^Question: (.+)$/);
      if (qm) questions.push(qm[1].trim());
      const am = line.match(/^Answer: (.+)$/);
      if (am) answers.push(am[1].trim());
    }

    items.push({
      date: headerMatch[1],
      title: headerMatch[2].trim(),
      project: field("Project") ?? "unknown",
      type: field("Type") ?? "unknown",
      request: field("Request"),
      context: field("Context"),
      options: field("Options"),
      estimatedCost: field("Estimated cost"),
      questions: questions.length > 0 ? questions : undefined,
      answers: answers.length > 0 ? answers : undefined,
      job: field("Job"),
      maxSessions: field("Max-sessions") ? parseInt(field("Max-sessions")!, 10) : undefined,
      maxCost: field("Max-cost") ? parseFloat(field("Max-cost")!) : undefined,
      autofix: field("Autofix") === "true" ? true : field("Autofix") === "false" ? false : undefined,
      rawBlock: block,
    });
  }

  return items;
}

/** Parse APPROVAL_QUEUE.md and return pending items. */
export async function getPendingApprovals(repoDir: string): Promise<ApprovalItem[]> {
  const content = await readQueueFile(repoDir);
  if (!content) return [];
  return parsePendingItems(content);
}

/** Remove item from Pending and append to Resolved with decision metadata. */
export async function resolveApproval(
  repoDir: string,
  item: ApprovalItem,
  decision: "approved" | "denied",
  notes?: string,
): Promise<void> {
  const queuePath = join(repoDir, "APPROVAL_QUEUE.md");
  const content = await readFile(queuePath, "utf-8");

  // Remove the item's raw block from Pending
  let updated = content.replace(item.rawBlock, "");

  // If Pending section is now empty (only whitespace between ## Pending and ## Resolved), restore placeholder
  updated = updated.replace(
    /(## Pending\n)\s*(\n## Resolved)/,
    "$1\n*No pending items.*\n$2",
  );

  // Build resolved entry
  const today = new Date().toISOString().slice(0, 10);
  let entry = `\n### ${item.date} — ${item.title}\nDecision: ${decision}\nBy: human (via Slack)\nDate: ${today}`;
  if (notes) entry += `\nNotes: ${notes}`;
  
  // Preserve burst-specific fields for burst type approvals
  if (item.type === "burst") {
    entry += `\nType: burst`;
    if (item.job) entry += `\nJob: ${item.job}`;
    if (item.maxSessions !== undefined) entry += `\nMax-sessions: ${item.maxSessions}`;
    if (item.maxCost !== undefined) entry += `\nMax-cost: ${item.maxCost}`;
    if (item.autofix !== undefined) entry += `\nAutofix: ${item.autofix}`;
  }
  
  entry += "\n";

  // Insert after ## Resolved heading (replace placeholder if present)
  if (updated.includes("*No resolved items yet.*")) {
    updated = updated.replace("*No resolved items yet.*", entry.trimStart());
  } else {
    updated = updated.replace(/(## Resolved\n)/, `$1${entry}`);
  }

  await writeFile(queuePath, updated, "utf-8");
}

/** Append a question line to an item's block in the Pending section. */
export async function addInterviewQuestion(
  repoDir: string,
  item: ApprovalItem,
  question: string,
): Promise<void> {
  const queuePath = join(repoDir, "APPROVAL_QUEUE.md");
  const content = await readFile(queuePath, "utf-8");

  // Append the question at the end of the item's raw block
  const augmented = item.rawBlock.trimEnd() + `\nQuestion: ${question}\n`;
  const updated = content.replace(item.rawBlock, augmented);

  await writeFile(queuePath, updated, "utf-8");
}

/** Append an answer line after the last Question/Answer line in an item's block. */
export async function addInterviewAnswer(
  repoDir: string,
  item: ApprovalItem,
  answer: string,
): Promise<void> {
  const queuePath = join(repoDir, "APPROVAL_QUEUE.md");
  const content = await readFile(queuePath, "utf-8");

  const augmented = item.rawBlock.trimEnd() + `\nAnswer: ${answer}\n`;
  const updated = content.replace(item.rawBlock, augmented);

  await writeFile(queuePath, updated, "utf-8");
}

const MAX_CONTEXT_CHARS = 8000;

/** Gather relevant project files for an approval item to use as Q&A context. */
export async function gatherContextFiles(
  repoDir: string,
  item: ApprovalItem,
): Promise<string> {
  const parts: string[] = [];

  // Always include the item's raw block
  parts.push(`--- Approval Item ---\n${item.rawBlock.trim()}\n`);

  // Always try project README
  const filePaths = new Set<string>();
  if (item.project && item.project !== "unknown") {
    filePaths.add(`projects/${item.project}/README.md`);
  }

  // Extract file paths from context field
  if (item.context) {
    const pathMatches = item.context.match(/(?:projects|infra|docs|decisions)\/[\w./-]+/g);
    if (pathMatches) {
      for (const p of pathMatches) filePaths.add(p);
    }
  }

  for (const relPath of filePaths) {
    try {
      let content = await readFile(join(repoDir, relPath), "utf-8");
      if (content.length > MAX_CONTEXT_CHARS) {
        content = content.slice(0, MAX_CONTEXT_CHARS) + "\n...(truncated)";
      }
      parts.push(`--- ${relPath} ---\n${content}\n`);
    } catch {
      // skip missing files
    }
  }

  return parts.join("\n");
}

/** Query Claude to answer a question given context. */
export async function queryContext(
  question: string,
  context: string,
  repoDir: string,
): Promise<{ answer: string; ok: boolean }> {
  const prompt = [
    "You are answering a human's question about a pending approval item in a research project.",
    "Use only the provided context to answer. Be concise (2-4 sentences). If the context doesn't contain enough information, say so.",
    "",
    context,
    "",
    `Question: ${question}`,
  ].join("\n");

  try {
    const result = await runQuery({
      prompt,
      cwd: repoDir,
      model: "haiku",
      maxTurns: 1,
    });
    return { answer: result.text || "No answer produced.", ok: !!result.text };
  } catch (err) {
    return { answer: `Error: ${err instanceof Error ? err.message : String(err)}`, ok: false };
  }
}

/** Get a summary of git commits made during a session.
 *  Returns one-line-per-commit string, or null if no commits found. */
export async function getSessionCommitSummary(cwd: string, durationMs: number): Promise<string | null> {
  try {
    // Look back session duration + 30s buffer for commits
    const sinceSec = Math.ceil(durationMs / 1000) + 30;
    const { stdout } = await execFileAsync("git", [
      "log", "--oneline", `--since=${sinceSec} seconds ago`, "--reverse",
    ], { cwd, timeout: 5000 });
    const lines = stdout.trim().split("\n").filter(l => {
      const trimmed = l.trim();
      if (!trimmed) return false;
      // Exclude scheduler auto-commits so work summary shows only agent work
      if (trimmed.includes("[scheduler] auto-commit")) return false;
      return true;
    });
    if (lines.length === 0) return null;
    // Show up to 5 commits; summarize if more
    const shown = lines.slice(0, 5).map(l => `• ${l.replace(/^[a-f0-9]+ /, "")}`).join("\n");
    const extra = lines.length > 5 ? `\n… and ${lines.length - 5} more` : "";
    return shown + extra;
  } catch {
    return null;
  }
}

/** Build Slack blocks for a session completion notification. */
export function buildSessionBlocks(
  job: Job,
  result: ExecutionResult,
  approvals: ApprovalItem[],
  budgetStatus?: BudgetStatus | null,
  budgetProjectName?: string,
  commitSummary?: string | null,
): Record<string, unknown>[] {
  const status = result.ok ? "completed" : "failed";
  const emoji = result.ok ? ":white_check_mark:" : ":x:";
  const duration = Math.round(result.durationMs / 1000);

  const costStr = result.costUsd !== undefined ? `$${result.costUsd.toFixed(2)}` : "n/a";
  const turnsStr = result.numTurns !== undefined ? `${result.numTurns}` : "n/a";
  const nextRunStr = job.state.nextRunAtMs
    ? new Date(job.state.nextRunAtMs).toLocaleTimeString("en-US", { hour12: false, timeZone: "Asia/Shanghai" })
    : "—";

  const blocks: Record<string, unknown>[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `${emoji} Akari session: ${status}` },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Job:*\n${job.name}` },
        { type: "mrkdwn", text: `*Duration:*\n${duration}s` },
        { type: "mrkdwn", text: `*Cost:*\n${costStr}` },
        { type: "mrkdwn", text: `*Turns:*\n${turnsStr}` },
        { type: "mrkdwn", text: `*Run #:*\n${job.state.runCount + 1}` },
        { type: "mrkdwn", text: `*Next run:*\n${nextRunStr}` },
      ],
    },
  ];

  if (result.error) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Error:*\n\`\`\`${result.error.slice(0, 500)}\`\`\`` },
    });
  }

  if (approvals.length > 0) {
    blocks.push(
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:rotating_light: *${approvals.length} pending approval(s) — action needed:*\n${formatApprovals(approvals)}`,
        },
      },
    );
  }

  if (budgetStatus && budgetStatus.resources.length > 0) {
    blocks.push(...buildBudgetBlocks(budgetStatus, budgetProjectName));
  }

  // Work summary: prefer git commit messages (reliable), fall back to stdout extraction
  const summary = commitSummary ?? (result.stdout ? extractWorkSummary(result.stdout) : null);
  if (summary) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Work completed:*\n${summary}` },
    });
  }

  return blocks;
}

// ── Budget status ─────────────────────────────────────────────────────────

export interface BudgetResourceStatus {
  resource: string;
  consumed: number;
  limit: number;
  unit: string;
  pct: number;
}

export interface BudgetStatus {
  resources: BudgetResourceStatus[];
  deadline?: string;
  hoursToDeadline?: number;
}

/** Parse ledger YAML text and accumulate resource totals into the given record. */
function accumulateLedgerTotals(ledgerText: string, totals: Record<string, number>): void {
  let currentEntryResource: string | null = null;
  for (const line of ledgerText.split("\n")) {
    const trimmed = line.trimEnd();
    const resMatch = trimmed.match(/^\s+resource:\s*(.+)/);
    if (resMatch) {
      currentEntryResource = resMatch[1].trim();
      continue;
    }
    const amtMatch = trimmed.match(/^\s+amount:\s*(\d+(?:\.\d+)?)/);
    if (amtMatch && currentEntryResource) {
      totals[currentEntryResource] = (totals[currentEntryResource] ?? 0) + parseFloat(amtMatch[1]);
      currentEntryResource = null;
      continue;
    }
    // Reset on new entry boundary
    if (trimmed.match(/^\s+-\s+date:/)) {
      currentEntryResource = null;
    }
  }
}

/** Find ledger.yaml path for a project. Returns root ledger if it exists. */
async function findLedgerPaths(projectDir: string): Promise<string[]> {
  const rootLedger = join(projectDir, "ledger.yaml");
  try {
    await stat(rootLedger);
    return [rootLedger];
  } catch {
    return [];
  }
}

/**
 * Read budget.yaml + ledger.yaml from a project dir using line-based parsing.
 * Returns null if no budget.yaml exists.
 */
export async function readBudgetStatus(projectDir: string): Promise<BudgetStatus | null> {
  let budgetText: string;
  try {
    budgetText = await readFile(join(projectDir, "budget.yaml"), "utf-8");
  } catch {
    return null;
  }

  // Parse resources from budget.yaml (flat enough for line-based parsing)
  const resources: Record<string, { limit: number; unit: string }> = {};
  let currentResource: string | null = null;
  let deadline: string | undefined;

  for (const line of budgetText.split("\n")) {
    const trimmed = line.trimEnd();

    // deadline: 2026-03-01T00:00:00Z
    const deadlineMatch = trimmed.match(/^deadline:\s*(.+)$/);
    if (deadlineMatch) {
      deadline = deadlineMatch[1].trim().replace(/["']/g, "");
      continue;
    }

    // Detect resource key (indented under resources:, has colon, no limit/unit keyword)
    const resourceKeyMatch = trimmed.match(/^  (\w[\w_-]*):\s*$/);
    if (resourceKeyMatch) {
      currentResource = resourceKeyMatch[1];
      resources[currentResource] = { limit: 0, unit: "" };
      continue;
    }

    if (currentResource) {
      const limitMatch = trimmed.match(/^\s+limit:\s*(\d+)/);
      if (limitMatch) {
        resources[currentResource].limit = parseInt(limitMatch[1], 10);
        continue;
      }
      const unitMatch = trimmed.match(/^\s+unit:\s*(.+)/);
      if (unitMatch) {
        resources[currentResource].unit = unitMatch[1].trim();
        continue;
      }
    }
  }

  // Parse ledger.yaml entries and sum amounts per resource.
  const totals: Record<string, number> = {};
  const ledgerPaths = await findLedgerPaths(projectDir);
  for (const lp of ledgerPaths) {
    try {
      const ledgerText = await readFile(lp, "utf-8");
      accumulateLedgerTotals(ledgerText, totals);
    } catch {
      // Skip unreadable ledger files
    }
  }

  // Build status
  const resourceStatuses: BudgetResourceStatus[] = [];
  for (const [name, spec] of Object.entries(resources)) {
    const consumed = totals[name] ?? 0;
    resourceStatuses.push({
      resource: name,
      consumed,
      limit: spec.limit,
      unit: spec.unit,
      pct: spec.limit > 0 ? Math.round((consumed / spec.limit) * 100) : 0,
    });
  }

  let hoursToDeadline: number | undefined;
  if (deadline) {
    const dl = new Date(deadline.replace("Z", "+00:00"));
    if (!isNaN(dl.getTime())) {
      hoursToDeadline = Math.round((dl.getTime() - Date.now()) / (1000 * 60 * 60));
    }
  }

  return { resources: resourceStatuses, deadline, hoursToDeadline };
}

/** Format budget status as Slack Block Kit section. */
export function buildBudgetBlocks(status: BudgetStatus, projectName?: string): Record<string, unknown>[] {
  const lines: string[] = [];

  for (const r of status.resources) {
    const icon = r.pct >= 100 ? ":no_entry:" : r.pct >= 90 ? ":warning:" : ":large_green_circle:";
    lines.push(`${icon} *${r.resource}*: ${r.consumed}/${r.limit} ${r.unit} (${r.pct}%)`);
  }

  if (status.deadline) {
    const dlIcon =
      status.hoursToDeadline !== undefined && status.hoursToDeadline <= 0
        ? ":no_entry:"
        : status.hoursToDeadline !== undefined && status.hoursToDeadline <= 24
          ? ":warning:"
          : ":calendar:";
    const timeStr =
      status.hoursToDeadline !== undefined
        ? status.hoursToDeadline <= 0
          ? "PASSED"
          : `${status.hoursToDeadline}h remaining`
        : "";
    lines.push(`${dlIcon} *Deadline*: ${status.deadline} (${timeStr})`);
  }

  return [
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: `:bar_chart: *Budget status${projectName ? ` (${projectName})` : ""}:*\n${lines.join("\n")}` },
    },
  ];
}

/** Scan projects/ under repoDir for any budget.yaml files and return statuses with warnings.
 *  @param excludeProjects Project directory names to skip (e.g. EXCLUDED_PROJECTS). */
export async function readAllBudgetStatuses(
  repoDir: string,
  excludeProjects?: string[],
): Promise<{ project: string; status: BudgetStatus }[]> {
  const results: { project: string; status: BudgetStatus }[] = [];
  const projectsDir = join(repoDir, "projects");
  const excludeSet = new Set(excludeProjects ?? []);
  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (excludeSet.has(entry)) continue;
    const projectPath = join(projectsDir, entry);
    try {
      const s = await stat(projectPath);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }
    const status = await readBudgetStatus(projectPath);
    if (status) {
      results.push({ project: entry, status });
    }
  }
  return results;
}

/** Build Slack blocks for a standalone approval alert. */
export function buildApprovalBlocks(approvals: ApprovalItem[]): Record<string, unknown>[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: ":inbox_tray: Akari: approvals waiting" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${approvals.length} item(s) in APPROVAL_QUEUE.md need human decision:\n${formatApprovals(approvals)}`,
      },
    },
  ];
}

function formatApprovals(approvals: ApprovalItem[]): string {
  return approvals
    .map((a) => `• *${a.title}* (${a.project}, ${a.date}) — ${a.type}`)
    .join("\n");
}

/** Extract a work summary from agent stdout. Looks for final summaries, lists, or key statements. */
function extractWorkSummary(stdout: string): string | null {
  const lines = stdout.trim().split("\n");
  if (lines.length === 0) return null;

  // Strategy 1: Look for markdown lists in the last 20 lines (common summary pattern)
  const lastLines = lines.slice(-20);
  const listItems: string[] = [];
  for (const line of lastLines) {
    const match = line.match(/^[•\-*]\s+(.+)/);
    if (match) {
      listItems.push(match[1].trim());
    }
  }
  if (listItems.length > 0 && listItems.length <= 10) {
    return listItems.map(item => `• ${item}`).join("\n");
  }

  // Strategy 2: Look for "Done" or "Completed" statements in last 10 lines
  const doneLines = lastLines.slice(-10).filter(line => {
    const lower = line.toLowerCase();
    return (lower.includes("done") || lower.includes("complete") || lower.includes("finished") || 
            lower.includes("created") || lower.includes("updated") || lower.includes("fixed")) &&
           !lower.includes("not ") && line.trim().length > 10;
  });
  if (doneLines.length > 0 && doneLines.length <= 5) {
    return doneLines.map(line => line.trim()).join("\n");
  }

  // Strategy 3: Last substantial paragraph (at least 2 sentences, not too long)
  const lastParagraphs = stdout.trim().split(/\n\s*\n/).filter(p => p.trim().length > 0);
  if (lastParagraphs.length > 0) {
    const lastPara = lastParagraphs[lastParagraphs.length - 1].trim();
    const sentences = lastPara.split(/[.!?]\s+/);
    if (sentences.length >= 2 && lastPara.length < 500) {
      return lastPara;
    }
  }

  // Fallback: Last 2-3 non-empty lines, truncated
  const nonEmpty = lines.filter(l => l.trim().length > 0);
  const tail = nonEmpty.slice(-3).join("\n").trim();
  return tail.length > 10 && tail.length < 400 ? tail : null;
}
