/** Action tag parsing and confirmation prompt generation for chat agent responses.
 *  Pure functions — no side effects, no Slack dependency. */

// ── Types ────────────────────────────────────────────────────────────────────

export interface PendingAction {
  kind: "approve" | "deny" | "launch_experiment" | "run_job" | "run_burst" | "fleet_control" | "approve_evolution" | "reject_evolution";
  itemIndex?: number;   // for approve/deny
  notes?: string;       // for approve/deny
  project?: string;     // for launch_experiment
  expId?: string;       // for launch_experiment
  command?: string;     // for launch_experiment
  jobId?: string;       // for run_job, run_burst
  maxSessions?: number; // for run_burst
  maxCost?: number;     // for run_burst
  autofix?: boolean;    // for run_burst
  fleetOp?: "enable" | "disable" | "status" | "resize";  // for fleet_control
  fleetSize?: number;   // for fleet_control resize/enable
}

export interface ParsedAction {
  tag: string;
  kind: string;
  params: Record<string, string>;
}

// ── Regex patterns ───────────────────────────────────────────────────────────

const APPROVAL_ACTION_RE = /\[ACTION:(approve|deny)\s+item=(\d+)(?:\s+notes="([^"]*)")?\]/;
const SESSION_ACTION_RE = /\[ACTION:(stop_session|ask_session|watch_session)\s+id="([^"]+)"(?:\s+message="([^"]*)")?\]/;
const EXPERIMENT_ACTION_RE = /\[ACTION:(launch_experiment|stop_experiment)\s+project="([^"]+)"\s+id="([^"]+)"(?:\s+command="([^"]*)")?\]/;
const RUN_JOB_ACTION_RE = /\[ACTION:run_job\s+id="([^"]+)"\]/;
const DEEP_WORK_ACTION_RE = /\[ACTION:deep_work\s+task="([^"]+)"(?:\s+project="([^"]*)")?\]/;
const GENERATE_REPORT_ACTION_RE = /\[ACTION:generate_report\s+type="([^"]+)"(?:\s+project="([^"]*)")?(?:\s+from="([^"]*)")?(?:\s+to="([^"]*)")?\]/;
const SEND_FILES_ACTION_RE = /\[ACTION:send_files\s+paths="([^"]+)"(?:\s+caption="([^"]*)")?\]/;
const SEND_IMAGES_ACTION_RE = /\[ACTION:send_images\s+paths="([^"]+)"(?:\s+caption="([^"]*)")?\]/;
const RUN_BURST_ACTION_RE = /\[ACTION:run_burst\s+job="([^"]+)"(?:\s+max_sessions=(\d+))?(?:\s+max_cost=(\d+(?:\.\d+)?))?(?:\s+autofix=(true|false))?\]/;
const SUGGEST_TASK_ACTION_RE = /\[ACTION:suggest_task\s+project="([^"]+)"\s+task="([^"]+)"\]/;
const NOTE_QUESTION_ACTION_RE = /\[ACTION:note_question\s+project="([^"]+)"\s+question="([^"]+)"\]/;
const AWAIT_RESPONSE_ACTION_RE = /\[ACTION:await_response\s+context="([^"]*)"\]/;
const CREATE_TASK_ACTION_RE = /\[ACTION:create_task\s+project="([^"]+)"\s+task="([^"]+)"\s+done_when="([^"]+)"\]/;
const FLEET_CONTROL_ACTION_RE = /\[ACTION:fleet_control\s+op="(enable|disable|status|resize)"(?:\s+size=(\d+))?\]/;
const START_EVOLUTION_ACTION_RE = /\[ACTION:start_evolution\s+task="([^"]+)"\s+description="([^"]+)"\]/;
const APPROVE_EVOLUTION_ACTION_RE = /\[ACTION:approve_evolution\]/;
const REJECT_EVOLUTION_ACTION_RE = /\[ACTION:reject_evolution\]/;
const RESTART_ACTION_RE = /\[ACTION:restart\]/;

// ── Tag stripping ────────────────────────────────────────────────────────────

/** Strip [ACTION:...] tags from text before showing to users.
 *  Collapses resulting blank lines. */
export function stripActionTags(text: string): string {
  return text
    .replace(/\[ACTION:\w+[^\]]*\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Action parsing ───────────────────────────────────────────────────────────

export function findActionTag(text: string): ParsedAction | null {
  let match = text.match(APPROVAL_ACTION_RE);
  if (match) {
    return {
      tag: match[0],
      kind: match[1],
      params: { item: match[2], notes: match[3] ?? "" },
    };
  }

  match = text.match(SESSION_ACTION_RE);
  if (match) {
    return {
      tag: match[0],
      kind: match[1],
      params: { id: match[2], message: match[3] ?? "" },
    };
  }

  match = text.match(EXPERIMENT_ACTION_RE);
  if (match) {
    return {
      tag: match[0],
      kind: match[1],
      params: { project: match[2], id: match[3], command: match[4] ?? "" },
    };
  }

  match = text.match(RUN_JOB_ACTION_RE);
  if (match) {
    return {
      tag: match[0],
      kind: "run_job",
      params: { id: match[1] },
    };
  }

  match = text.match(DEEP_WORK_ACTION_RE);
  if (match) {
    return {
      tag: match[0],
      kind: "deep_work",
      params: { task: match[1], project: match[2] ?? "" },
    };
  }

  match = text.match(GENERATE_REPORT_ACTION_RE);
  if (match) {
    return {
      tag: match[0],
      kind: "generate_report",
      params: { type: match[1], project: match[2] ?? "", from: match[3] ?? "", to: match[4] ?? "" },
    };
  }

  match = text.match(SEND_FILES_ACTION_RE);
  if (match) {
    return {
      tag: match[0],
      kind: "send_files",
      params: { paths: match[1], caption: match[2] ?? "" },
    };
  }

  match = text.match(SEND_IMAGES_ACTION_RE);
  if (match) {
    return {
      tag: match[0],
      kind: "send_files",
      params: { paths: match[1], caption: match[2] ?? "" },
    };
  }

  match = text.match(RUN_BURST_ACTION_RE);
  if (match) {
    return {
      tag: match[0],
      kind: "run_burst",
      params: {
        job: match[1],
        max_sessions: match[2] ?? "10",
        max_cost: match[3] ?? "20",
        autofix: match[4] ?? "true",
      },
    };
  }

  match = text.match(SUGGEST_TASK_ACTION_RE);
  if (match) {
    return {
      tag: match[0],
      kind: "suggest_task",
      params: { project: match[1], task: match[2] },
    };
  }

  match = text.match(NOTE_QUESTION_ACTION_RE);
  if (match) {
    return {
      tag: match[0],
      kind: "note_question",
      params: { project: match[1], question: match[2] },
    };
  }

  match = text.match(AWAIT_RESPONSE_ACTION_RE);
  if (match) {
    return {
      tag: match[0],
      kind: "await_response",
      params: { context: match[1] },
    };
  }

  match = text.match(CREATE_TASK_ACTION_RE);
  if (match) {
    return {
      tag: match[0],
      kind: "create_task",
      params: { project: match[1], task: match[2], done_when: match[3] },
    };
  }

  match = text.match(FLEET_CONTROL_ACTION_RE);
  if (match) {
    return {
      tag: match[0],
      kind: "fleet_control",
      params: { op: match[1], size: match[2] ?? "" },
    };
  }

  match = text.match(START_EVOLUTION_ACTION_RE);
  if (match) {
    return {
      tag: match[0],
      kind: "start_evolution",
      params: { task: match[1], description: match[2] },
    };
  }

  match = text.match(APPROVE_EVOLUTION_ACTION_RE);
  if (match) {
    return {
      tag: match[0],
      kind: "approve_evolution",
      params: {},
    };
  }

  match = text.match(REJECT_EVOLUTION_ACTION_RE);
  if (match) {
    return {
      tag: match[0],
      kind: "reject_evolution",
      params: {},
    };
  }

  match = text.match(RESTART_ACTION_RE);
  if (match) {
    return {
      tag: match[0],
      kind: "restart",
      params: {},
    };
  }

  return null;
}

/** Find all action tags in text. Returns array of ParsedAction objects (may be empty). */
export function findAllActionTags(text: string): ParsedAction[] {
  const results: ParsedAction[] = [];
  const tagPattern = /\[ACTION:\w+[^\]]*\]/g;
  let match;
  while ((match = tagPattern.exec(text)) !== null) {
    const tagText = match[0];
    const parsed = findActionTag(tagText);
    if (parsed) {
      results.push(parsed);
    }
  }
  return results;
}

// ── Eager action setting ─────────────────────────────────────────────────────

/** Eagerly set pendingAction from a parsed action tag during streaming.
 *  Only handles confirmable actions (launch_experiment, run_job, approve, deny).
 *  Returns the PendingAction if set, null otherwise.
 *  Note: deep_work is immediate — no pendingAction needed. */
export function eagerlySetPendingAction(
  parsed: ParsedAction,
): PendingAction | null {
  if (parsed.kind === "launch_experiment") {
    const { project, id: expId, command } = parsed.params;
    if (!command || !project || !expId) return null;
    return { kind: "launch_experiment", project, expId, command };
  }
  if (parsed.kind === "deep_work" || parsed.kind === "generate_report" || parsed.kind === "send_files" || parsed.kind === "create_task") {
    return null;
  }
  if (parsed.kind === "run_burst") {
    return {
      kind: "run_burst",
      jobId: parsed.params.job,
      maxSessions: parseInt(parsed.params.max_sessions, 10),
      maxCost: parseFloat(parsed.params.max_cost),
      autofix: parsed.params.autofix !== "false",
    };
  }
  if (parsed.kind === "fleet_control") {
    const op = parsed.params.op as "enable" | "disable" | "status" | "resize";
    if (op === "status") return null; // status is immediate, no confirmation
    return {
      kind: "fleet_control",
      fleetOp: op,
      fleetSize: parsed.params.size ? parseInt(parsed.params.size, 10) : (op === "enable" ? 2 : 0),
    };
  }
  if (parsed.kind === "run_job") {
    return { kind: "run_job", jobId: parsed.params.id };
  }
  if (parsed.kind === "approve" || parsed.kind === "deny") {
    const itemIndex = parseInt(parsed.params.item, 10) - 1;
    return { kind: parsed.kind as "approve" | "deny", itemIndex, notes: parsed.params.notes || undefined };
  }
  return null;
}

// ── Chat mode action filtering ───────────────────────────────────────────────

/** Actions allowed in chat-mode channels. All other actions are blocked. */
const CHAT_MODE_ALLOWED_ACTIONS = new Set(["suggest_task", "note_question", "send_files"]);

/** Check if an action kind is allowed in chat mode. */
export function isChatModeAction(kind: string): boolean {
  return CHAT_MODE_ALLOWED_ACTIONS.has(kind);
}

// ── Confirmation prompts ─────────────────────────────────────────────────────

/** Generate a confirmation prompt for a pending action. */
export function buildConfirmPrompt(action: PendingAction): string {
  switch (action.kind) {
    case "launch_experiment":
      return `:point_right: _Confirm: reply *yes* to launch experiment *${action.project}/${action.expId}* with command \`${action.command}\`, or *no* to cancel._`;
    case "run_job":
      return `:point_right: _Confirm: reply *yes* to run job *${action.jobId}* now, or *no* to cancel._`;
    case "run_burst":
      return `:point_right: _Confirm: reply *yes* to create burst request for *${action.jobId}* (${action.maxSessions} sessions, $${action.maxCost} cap${action.autofix ? ", autofix on" : ""}), or *no* to cancel._`;
    case "fleet_control":
      if (action.fleetOp === "enable" || action.fleetOp === "resize")
        return `:point_right: _Confirm: reply *yes* to ${action.fleetOp} fleet workers (size=${action.fleetSize}), or *no* to cancel._`;
      if (action.fleetOp === "disable")
        return `:point_right: _Confirm: reply *yes* to disable fleet workers (running workers will complete), or *no* to cancel._`;
      return `:point_right: _Reply *yes* to confirm fleet control, or *no* to cancel._`;
    case "approve":
      return `:point_right: _Confirm: reply *yes* to approve, or *no* to cancel._`;
    case "deny":
      return `:point_right: _Confirm: reply *yes* to deny, or *no* to cancel._`;
    case "approve_evolution":
      return `:point_right: _Reply *approve* to merge the evolution into main, or *reject* to discard it._`;
    case "reject_evolution":
      return `:point_right: _Reply *yes* to reject and discard the evolution, or *no* to keep it for review._`;
    default:
      return `:point_right: _Reply *yes* to confirm, or *no* to cancel._`;
  }
}
