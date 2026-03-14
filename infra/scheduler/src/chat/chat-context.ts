/** Chat context gathering — assembles system status, project summaries, budget warnings,
 *  and on-demand details into a context string for the chat agent's prompt. */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  getPendingApprovals,
  gatherContextFiles,
  readBudgetStatus,
  readAllBudgetStatuses,
} from "../notify.js";
import { EXCLUDED_PROJECTS } from "../constants.js";
import type { JobStore } from "../store.js";
import { listSessions } from "../session.js";

/** Gather contextual information for the chat agent's system prompt.
 *  Includes system status, jobs, sessions, approvals, budgets, and project summaries.
 *  On-demand sections are added when the user message references specific content. */
export async function gatherChatContext(
  repoDir: string,
  store: JobStore,
  userMessage: string,
): Promise<string> {
  const parts: string[] = [];

  // System status
  await store.load();
  const jobs = store.list();
  const enabled = jobs.filter((j) => j.enabled);
  const nextMs = store.getNextWakeMs();
  parts.push(
    `--- System Status ---`,
    `Jobs: ${jobs.length} total, ${enabled.length} enabled`,
    `Next run: ${nextMs ? new Date(nextMs).toISOString() : "none"}`,
    "",
  );

  // Job details
  if (jobs.length > 0) {
    parts.push(`--- Jobs ---`);
    for (const job of jobs) {
      const sched = job.schedule.kind === "cron"
        ? `cron ${job.schedule.expr} (${job.schedule.tz ?? "UTC"})`
        : `every ${job.schedule.everyMs}ms`;
      const last = job.state.lastStatus
        ? `${job.state.lastStatus} (${job.state.runCount} runs)`
        : "never run";
      parts.push(`- ${job.name} (id: ${job.id}) [${job.enabled ? "enabled" : "disabled"}]: ${sched}, last: ${last}`);
    }
    parts.push("");
  }

  // Active sessions
  const sessions = listSessions();
  if (sessions.length > 0) {
    parts.push(`--- Active Sessions (${sessions.length}) ---`);
    for (const s of sessions) {
      const elapsed = Math.round(s.elapsedMs / 1000);
      parts.push(`- ${s.jobName} [${s.id}]: ${elapsed}s, ${s.numTurns} turns, $${s.costUsd.toFixed(4)}`);
      parts.push(`  Last: ${s.lastActivity.slice(0, 100)}`);
    }
    parts.push("");
  } else {
    parts.push(`--- Active Sessions: none ---`, "");
  }

  // Pending approvals
  const approvals = await getPendingApprovals(repoDir);
  if (approvals.length > 0) {
    parts.push(`--- Pending Approvals (${approvals.length}) ---`);
    for (let i = 0; i < approvals.length; i++) {
      const a = approvals[i];
      let entry = `${i + 1}. [${a.date}] ${a.title} (${a.project}) — ${a.type}`;
      if (a.request) entry += `\n   Request: ${a.request}`;
      if (a.estimatedCost) entry += `\n   Cost: ${a.estimatedCost}`;
      if (a.options) entry += `\n   Options: ${a.options}`;
      parts.push(entry);
    }
    parts.push("");
  } else {
    parts.push(`--- Pending Approvals: none ---`, "");
  }

  // Budget warnings for projects approaching limits (exclude non-autonomous projects)
  const budgetStatuses = await readAllBudgetStatuses(repoDir, EXCLUDED_PROJECTS);
  const budgetWarnings: string[] = [];
  for (const { project, status } of budgetStatuses) {
    const overBudget = status.resources.filter((r) => r.pct >= 100);
    const nearBudget = status.resources.filter((r) => r.pct >= 80 && r.pct < 100);
    const deadlineSoon = status.hoursToDeadline !== undefined && status.hoursToDeadline <= 72;
    const deadlinePassed = status.hoursToDeadline !== undefined && status.hoursToDeadline <= 0;
    if (overBudget.length > 0 || nearBudget.length > 0 || deadlineSoon) {
      let line = `*${project}*:`;
      for (const r of overBudget) line += ` :no_entry: ${r.resource} ${r.pct}%`;
      for (const r of nearBudget) line += ` :warning: ${r.resource} ${r.pct}%`;
      if (deadlinePassed) line += ` :no_entry: deadline passed`;
      else if (deadlineSoon) line += ` :warning: deadline in ${status.hoursToDeadline}h`;
      budgetWarnings.push(line);
    }
  }
  if (budgetWarnings.length > 0) {
    parts.push(`--- Budget Warnings ---`, ...budgetWarnings, "");
  }

  // Project summaries (first 5 lines of each README)
  const projectsDir = join(repoDir, "projects");
  try {
    const entries = await readdir(projectsDir);
    const summaries: string[] = [];
    for (const entry of entries) {
      const readmePath = join(projectsDir, entry, "README.md");
      try {
        const s = await stat(join(projectsDir, entry));
        if (!s.isDirectory()) continue;
        const content = await readFile(readmePath, "utf-8");
        const lines = content.split("\n").slice(0, 5).join("\n");
        summaries.push(`[${entry}]\n${lines}`);
      } catch {
        // skip
      }
    }
    if (summaries.length > 0) {
      parts.push(`--- Projects ---`, ...summaries, "");
    }
  } catch {
    // no projects dir
  }

  // On-demand: if message mentions a project name, include full README (truncated)
  const msgLower = userMessage.toLowerCase();
  try {
    const entries = await readdir(projectsDir);
    for (const entry of entries) {
      if (msgLower.includes(entry.toLowerCase())) {
        try {
          let content = await readFile(join(projectsDir, entry, "README.md"), "utf-8");
          if (content.length > 4000) {
            content = content.slice(0, 4000) + "\n...(truncated)";
          }
          parts.push(`--- Full README: ${entry} ---`, content, "");
        } catch {
          // skip
        }
      }
    }
  } catch {
    // no projects dir
  }

  // On-demand: if message mentions experiments, include running/recent experiment progress
  if (/\b(experiment|running|launch|status|progress)\b/i.test(userMessage)) {
    try {
      const { listExperiments: listExps } = await import("../experiments.js");
      const allExps = await listExps(repoDir);
      const relevant = allExps.filter((e: any) =>
        e.progress?.status === "running" ||
        e.progress?.status === "stopping" ||
        (e.progress?.status === "failed" && e.progress?.updated_at &&
          Date.now() - new Date(e.progress.updated_at).getTime() < 3600_000) ||
        (e.progress?.status === "completed" && e.progress?.updated_at &&
          Date.now() - new Date(e.progress.updated_at).getTime() < 3600_000)
      );
      if (relevant.length > 0) {
        parts.push(`--- Experiment Status ---`);
        for (const exp of relevant) {
          const p = exp.progress!;
          let line = `${exp.project}/${exp.id}: ${p.status}`;
          if (p.pct !== undefined) line += ` (${p.pct}%)`;
          if (p.message) line += ` — ${p.message}`;
          if (p.error) line += ` — error: ${p.error}`;
          if (p.started_at) line += ` — started: ${p.started_at}`;
          if (p.command) line += `\n  command: ${p.command.join(" ")}`;
          parts.push(line);
        }
        parts.push("");
      }
    } catch {
      // experiments module not available
    }
  }

  // On-demand: if discussing a specific approval, include its context files
  for (let i = 0; i < approvals.length; i++) {
    const a = approvals[i];
    if (
      msgLower.includes(a.title.toLowerCase()) ||
      msgLower.includes(`item ${i + 1}`) ||
      msgLower.includes(`#${i + 1}`)
    ) {
      const ctx = await gatherContextFiles(repoDir, a);
      parts.push(`--- Context for approval: ${a.title} ---`, ctx, "");
      break; // only one to avoid context explosion
    }
  }

  return parts.join("\n");
}
