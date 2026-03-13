# akari

Minimal cron scheduler for autonomous agent sessions. Manages scheduled jobs that invoke `claude -p` to run autonomous work cycles.

Status: active
Mission: Provide a standalone, zero-dependency (beyond croner) scheduler for akari autonomous execution.
Done when: Scheduler reliably triggers autonomous sessions on cron schedule with job state persistence.

## Architecture

```
CLI (cli.ts)
 ├── add/list/remove/run    → JobStore (store.ts) → jobs.json
 └── start (daemon)         → SchedulerService (service.ts)
                                ├── poll loop (30s)
                                ├── computeNextRunAtMs (schedule.ts)
                                └── executeJob (executor.ts) → claude -p
```

- **types.ts**: Job schema (schedule, payload, state)
- **schedule.ts**: Cron expression → next run time (via croner library)
- **store.ts**: JSON file persistence for job definitions and state
- **executor.ts**: Spawns `claude -p` as child process with `--dangerously-skip-permissions` for unattended execution
- **service.ts**: Timer loop that checks for due jobs and runs them
- **cli.ts**: CLI entry point for managing jobs and running the daemon

## Usage

```bash
# Install and build
cd infra/scheduler
npm install
npm run build

# Add the akari work cycle job
node dist/cli.js add \
  --name "akari-work-cycle" \
  --cron "0 * * * *" \
  --tz "UTC" \
  --message "You are an autonomous research agent starting a work session on the akari repo. You MUST complete ALL 5 steps of the autonomous work cycle SOP at docs/sops/autonomous-work-cycle.md: Step 1: Run /orient. Step 2: Select a task. Step 3: Classify scope. Step 4: Execute or defer to APPROVAL_QUEUE.md. Step 5: Git commit and log. Do NOT just produce a text report." \
  --model opus \
  --cwd /path/to/akari

# List jobs
node dist/cli.js list

# Run a job immediately (for testing)
node dist/cli.js run <job-id>

# Start the daemon (foreground)
node dist/cli.js start

# Check status
node dist/cli.js status
```

## Production deployment (pm2)

```bash
# Start the scheduler daemon via pm2 (from repo root)
pm2 start infra/scheduler/ecosystem.config.js

# Or if already running, restart to pick up config changes
pm2 restart akari

# Save for reboot persistence
pm2 save

# Monitor
pm2 logs akari
pm2 status

# Stop
pm2 stop akari
```

Openakari does not ship a dashboard UI. It ships a local control API (see below).

## Creating jobs

**Always use the CLI `add` command. Do not edit `jobs.json` directly.**

The `add` command computes `nextRunAtMs` and stamps the schedule fingerprint atomically. Direct JSON editing risks creating jobs with `null` `nextRunAtMs` that will never fire. See [postmortem-scheduled-jobs-never-fired-2026-03-05.md](../../projects/akari/postmortem/postmortem-scheduled-jobs-never-fired-2026-03-05.md) for the incident where three jobs silently failed for 11+ days due to this issue.

## Job storage

Jobs are persisted to `.scheduler/jobs.json` relative to the scheduler directory. Each job tracks:
- Schedule (cron expression or interval)
- Payload (message, model, working directory)
- State (next run, last run, status, error, run count)

## Agent backends

The scheduler supports two agent backends, configurable per-job or globally:

| Backend | How | Model default | Supervision | Cost tracking |
|---------|-----|---------------|-------------|---------------|
| `claude` | Claude Code CLI (`claude -p --output-format stream-json`) | per job config | full (watch/ask/stop) | yes |
| `cursor` | Cursor Agent CLI (`agent -p --output-format stream-json`) | `opus-4.6-thinking` | partial (watch/stop only, no ask) | no |

**Configuration:**

- **Per-job**: `--backend claude|cursor|auto` when adding a job
- **Global**: `AGENT_BACKEND=claude|cursor|auto` env var (default: `auto`)
- **`auto` mode**: tries Claude first; if Claude fails (rate limit, usage limit, process error), automatically retries with Cursor

The Cursor backend has no native system prompt flag, so for chat queries the system prompt is prepended to the user message in `<system_instructions>` tags. Cursor sessions don't report API cost, and the `ask` supervision command (message injection) is not supported — use `stop` to interrupt instead.

## Slack integration (reference only)

Openakari ships Slack integration as a **reference implementation**, not as an out-of-the-box supported integration.

See `infra/scheduler/reference-implementations/slack/`.

The scheduler runs without Slack. If you want Slack notifications, copy/adapt the reference implementation into your own environment.

## Control API (no dashboard UI)

The scheduler starts a local HTTP API (default: `http://127.0.0.1:8420`) for monitoring and push coordination.

Key endpoints:

- `GET /api/status` — unified status snapshot (sessions, experiments, jobs)
- `POST /api/push/enqueue` — enqueue a git push request
- `GET /api/push/status/:sessionId` — check push status/result for a session

## External health monitoring

The scheduler includes a `check-health` command for external monitoring. This runs independently of the scheduler process and alerts if the API becomes unresponsive.

### Usage

```bash
# Run health check manually
node dist/cli.js check-health --notify

# Options:
#   --url <url>         Scheduler API URL (default: http://localhost:8420)
#   --timeout <ms>      Request timeout in ms (default: 5000)
#   --state-file <path> State file for tracking failures (default: /tmp/akari-health-state.json)
#   --notify            Send Slack DM on failure/recovery
```

### System cron setup

Add to `/etc/cron.d/akari-health` (or user crontab):

```
# Check scheduler health every 2 minutes
*/2 * * * * <user> cd /path/to/akari/infra/scheduler && node dist/cli.js check-health --notify >> /var/log/akari-health.log 2>&1
```

### Behavior

- Pings `/api/status` endpoint
- Tracks consecutive failures in state file
- Sends Slack alert on second consecutive failure (avoids spamming on transient glitches)
- Sends recovery notification when scheduler comes back online
- Exits with code 1 if `consecutiveFailures >= 2` (useful for monitoring systems)

### Why external?

Internal monitoring (health-watchdog) only runs when the scheduler is running. If the scheduler crashes or hangs, internal checks stop. External cron-based monitoring catches these cases.

## Design decisions

- **No external dependencies beyond croner**: The scheduler uses Node.js built-ins for everything except cron expression parsing.
- **Polling, not event-driven**: The daemon polls every 30s. This is simple, reliable, and adequate for jobs that run at most hourly.
- **Max concurrent sessions limit**: By default, only 1 session runs at a time. This prevents overlapping sessions when a job spans multiple poll intervals. Configure via `maxConcurrentSessions` option (0 = unlimited). The limit applies across all jobs — different job types cannot run simultaneously when the limit is reached.
- **Serialized pushes under concurrency**: Fleet workers can request pushes via the control API so `git push` is effectively serialized.
- **Store reloaded on each tick**: Allows external modification (e.g., `add` from CLI while daemon runs) without restart.
- **Explicit multi-step prompts required**: Prototype testing (see [projects/akari/README.md](../../projects/akari/README.md) experiment log) showed that referencing the SOP file alone produces orient-only behavior (2/7 SOP steps). Explicitly enumerating all 5 steps in the prompt achieves 7/7 adherence.
- **CLAUDECODE env var stripped**: The executor removes the `CLAUDECODE` environment variable before spawning claude, preventing nested-session guard from blocking execution when the scheduler itself runs inside a Claude Code context.
- **Multi-backend with auto-fallback**: Claude SDK is the primary backend (richer supervision, cost tracking). Cursor CLI is the fallback when Claude is unavailable (rate limits, usage caps). The `auto` mode makes this transparent — sessions run on whichever backend is available.

## Push Queue

The fleet operates N=16+ workers that each commit to the git repository. Without coordination, concurrent `git push` operations cause race conditions, merge conflicts, and repository lockups.

### Problem

Multiple workers pushing simultaneously creates contention:
- Git's push/pull mechanism is not designed for high-concurrency writes
- Concurrent pushes trigger "non-fast-forward" errors
- Workers may overwrite each other's commits
- Repository can enter inconsistent state requiring manual intervention

### Solution

Push queuing decouples commit from push:

1. **Workers commit locally** — `git add && git commit` runs immediately in the worker's session
2. **Push request queued** — Worker calls `/api/push-queue` endpoint instead of `git push`
3. **Serialized execution** — Single push processor dequeues and executes pushes sequentially
4. **Conflict detection** — Before push, fetches remote and checks for conflicts
5. **Retry with backoff** — Failed pushes retry with exponential backoff (max 3 attempts)

### Design Rationale

See [decisions/0061-push-queuing.md](../../decisions/0061-push-queuing.md) for the full ADR.

**Key insight**: Git push is inherently serial. The queue makes this explicit and eliminates race conditions at the source.

**Tradeoffs**:
- Latency: Pushes are async (worker doesn't wait for confirmation)
- Simplicity: Single-processor model avoids distributed locking complexity
- Resilience: Conflicts detected proactively; failures logged with context

### API Endpoints

- `POST /api/push/enqueue` — Enqueue a push request
- `GET /api/push/status/:sessionId` — Get status/result of a specific session push

### Conflict Resolution

When a conflict is detected, the push is rejected with details. The worker session ends cleanly; a subsequent session (by the same or different worker) will pull the updated remote and continue work.

## Log

### 2026-02-16 — Multi-backend support (Claude + Cursor)

Added agent backend abstraction supporting both Claude Code SDK and Cursor Agent CLI, with automatic fallback.

New `backend.ts` module provides `AgentBackend` interface with two implementations:
- `ClaudeBackend`: wraps existing `@anthropic-ai/claude-agent-sdk` (no behavioral change for existing jobs)
- `CursorBackend`: spawns `agent -p --output-format stream-json --yolo --trust` with `opus-4.6-thinking` model, parses NDJSON output, maps to common message format

`resolveBackend("auto")` returns a `FallbackBackend` that tries Claude first and retries with Cursor on rate-limit, usage-limit, or process-exit errors. Verified: Claude failing inside nested session → Cursor fallback succeeds in ~5s. System prompt prepending via `<system_instructions>` tags works for Cursor chat.

Changes: `backend.ts` (new), `executor.ts` (uses backend abstraction), `chat.ts` (uses backend), `session.ts` (`Query` → `SessionHandle`), `slack.ts` (guards `ask` for Cursor, uses `handle.interrupt()`), `types.ts` (`backend` field on `JobPayload`), `cli.ts` (`--backend` flag).

Sources: `agent --help`, `agent models`, Cursor stream-json output format testing

### 2026-02-15 (c)

Prototype validation and production deployment. Two test runs:

- **Run 1** (vague prompt: "Begin with /orient"): Agent produced orientation report only, 34s, 2/7 SOP steps. Diagnosis: agent treated `claude -p` as single-turn text generation.
- **Run 2** (explicit prompt enumerating all 5 steps): Agent completed full cycle in 90s, 7/7 SOP steps, produced 2 git commits.

Key fix: executor now strips CLAUDECODE env var (prevents nested-session guard). Session output captured to `.scheduler/logs/` with timestamps.

Production job updated to use explicit multi-step prompt. Daemon managed by pm2 (`pm2 restart akari`). Process saved for reboot persistence.

Sources: [projects/akari/README.md](../../projects/akari/README.md) experiment log, `.scheduler/logs/prototype-test-*.log`

### 2026-02-15 (b)

Fixed executor to use correct Claude CLI invocation: `claude -p` with positional prompt argument and `--dangerously-skip-permissions` for unattended execution (previously used non-existent `--message` flag). Fixed build script to use `npx tsc`. Added `.scheduler/`, `dist/`, `node_modules/` to repo `.gitignore`. Verified build and CLI operations (add, list, status, remove) all work.

Tested: `node dist/cli.js add --name akari-work-cycle --cron "0 9,21 * * *" --tz UTC --model opus --cwd /path/to/repo --message "..."` → job created, next run 2026-02-15T21:00:00.000Z.

Sources: `claude --help` output, [decisions/0005-autonomous-execution.md](../../decisions/0005-autonomous-execution.md)

### 2026-02-15

Initial implementation. Extracted scheduling primitives from OpenClaw cron system, built standalone scheduler with: cron/interval scheduling via croner, JSON file persistence, claude -p execution, CLI for job management, polling daemon service.

Sources: OpenClaw `src/cron/` (types, schedule computation pattern), [decisions/0005-autonomous-execution.md](../../decisions/0005-autonomous-execution.md)
