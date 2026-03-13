/** Custom Subagents integration for agent-teams (Phase 0 builders + Phase 1 composition).
 *  Provides builders for SDK `agents` option, team lifecycle hooks, and ready-to-use session configs. */

import type {
  AgentDefinition,
  HookCallbackMatcher,
  HookEvent,
  SubagentStartHookInput,
  SubagentStopHookInput,
  TaskCompletedHookInput,
  TeammateIdleHookInput,
  HookJSONOutput,
} from "./sdk.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Configuration for a skill-based subagent. */
export interface SkillAgentConfig {
  name: string;
  description: string;
  prompt: string;
  model?: "sonnet" | "opus" | "haiku";
  tools?: string[];
  skills?: string[];
  maxTurns?: number;
}

/** Timestamped record of a team lifecycle event. */
export interface TeamEventLog {
  event: "SubagentStart" | "SubagentStop" | "TaskCompleted" | "TeammateIdle";
  timestamp: number;
  agentId?: string;
  agentType?: string;
  taskId?: string;
  taskSubject?: string;
  teammateName?: string;
}

// ── Builders ─────────────────────────────────────────────────────────────────

/** Convert an array of skill-based agent configs into the SDK `agents` record.
 *  Each config maps to an `AgentDefinition` keyed by the agent name. */
export function buildTeamAgents(
  configs: SkillAgentConfig[],
): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {};

  for (const cfg of configs) {
    const def: AgentDefinition = {
      description: cfg.description,
      prompt: cfg.prompt,
      tools: cfg.tools,
      maxTurns: cfg.maxTurns,
    };
    if (cfg.model) def.model = cfg.model;
    if (cfg.skills) def.skills = cfg.skills;
    agents[cfg.name] = def;
  }

  return agents;
}

/** Build SDK hook matchers that log team lifecycle events to an array.
 *  Hooks are non-blocking (return `{ continue: true }`). */
export function buildTeamHooks(
  events: TeamEventLog[],
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    SubagentStart: [
      {
        hooks: [
          async (input): Promise<HookJSONOutput> => {
            const data = input as SubagentStartHookInput;
            events.push({
              event: "SubagentStart",
              timestamp: Date.now(),
              agentId: data.agent_id,
              agentType: data.agent_type,
            });
            return { continue: true };
          },
        ],
      },
    ],

    SubagentStop: [
      {
        hooks: [
          async (input): Promise<HookJSONOutput> => {
            const data = input as SubagentStopHookInput;
            events.push({
              event: "SubagentStop",
              timestamp: Date.now(),
              agentId: data.agent_id,
              agentType: data.agent_type,
            });
            return { continue: true };
          },
        ],
      },
    ],

    TaskCompleted: [
      {
        hooks: [
          async (input): Promise<HookJSONOutput> => {
            const data = input as TaskCompletedHookInput;
            events.push({
              event: "TaskCompleted",
              timestamp: Date.now(),
              taskId: data.task_id,
              taskSubject: data.task_subject,
              teammateName: data.teammate_name,
            });
            return { continue: true };
          },
        ],
      },
    ],

    TeammateIdle: [
      {
        hooks: [
          async (input): Promise<HookJSONOutput> => {
            const data = input as TeammateIdleHookInput;
            events.push({
              event: "TeammateIdle",
              timestamp: Date.now(),
              teammateName: data.teammate_name,
            });
            return { continue: true };
          },
        ],
      },
    ],
  };
}

// ── Phase 1: Agent configs and session composition ──────────────────────────

/** Default team agent configs for the analyst + builder team. */
export const TEAM_AGENT_CONFIGS: SkillAgentConfig[] = [
  {
    name: "analyst",
    description:
      "Research analyst — reviews findings, audits metrics, checks for tautologies, " +
      "and produces synthesis. Read-heavy; writes reports and analysis documents.",
    prompt:
      "You are a research analyst on the akari team. Your job is to review experiment " +
      "findings, audit metrics for validity, check conclusions for tautologies or " +
      "unsupported claims, and produce synthesis across experiments. Follow CLAUDE.md " +
      "conventions. Write findings to project files immediately (inline logging).",
    model: "sonnet",
    maxTurns: 32,
  },
  {
    name: "builder",
    description:
      "Implementation specialist — writes code, tests, and infrastructure changes. " +
      "TDD workflow: failing tests first, then implementation.",
    prompt:
      "You are a builder on the akari team. Your job is to implement code changes, " +
      "write tests (TDD: failing tests first), fix bugs, and build infrastructure. " +
      "Follow CLAUDE.md conventions. Run tests before committing. Log what you build " +
      "to project files immediately (inline logging).",
    model: "opus",
    maxTurns: 48,
  },
];

/** Result of buildTeamSession — everything needed to spawn a team-enabled agent. */
export interface TeamSessionConfig {
  agents: Record<string, AgentDefinition>;
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  events: TeamEventLog[];
}

/** Build a ready-to-use team session config with agents and hooks.
 *  Pass the returned `agents` and `hooks` to `spawnAgent()` via SpawnAgentOpts. */
export function buildTeamSession(
  configs: SkillAgentConfig[] = TEAM_AGENT_CONFIGS,
): TeamSessionConfig {
  const events: TeamEventLog[] = [];
  return {
    agents: buildTeamAgents(configs),
    hooks: buildTeamHooks(events),
    events,
  };
}
