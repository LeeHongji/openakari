/** Security guards for Slack bot commands: path traversal, command injection, PID ownership. */

import { resolve, relative } from "node:path";
import { readFile } from "node:fs/promises";

// ── Path safety ──────────────────────────────────────────────────────────────

/**
 * Ensure a resolved path stays within the allowed root directory.
 * Rejects path traversal (../) and symlink escapes.
 * Throws SecurityError if the path escapes the root.
 */
export function assertSafeRepoPath(repoDir: string, untrustedPath: string): string {
  const resolved = resolve(repoDir, untrustedPath);
  const rel = relative(repoDir, resolved);
  if (rel.startsWith("..") || resolve(resolved) !== resolved) {
    throw new SecurityError(`Path escapes repo directory: ${untrustedPath}`);
  }
  return resolved;
}

/**
 * Validate project and experiment ID path segments.
 * Only allows alphanumeric, hyphens, underscores, and dots (no slashes or ..).
 */
export function validatePathSegment(segment: string, label: string): void {
  if (!segment || /[/\\]/.test(segment) || segment === ".." || segment === ".") {
    throw new SecurityError(`Invalid ${label}: ${segment}`);
  }
  // Only allow safe characters
  if (!/^[a-zA-Z0-9._-]+$/.test(segment)) {
    throw new SecurityError(`Invalid characters in ${label}: ${segment}`);
  }
}

// ── Command validation ───────────────────────────────────────────────────────

/** Executables explicitly allowed — checked before the blocklist to prevent accidental blocking.
 *  Cursor Agent CLI (`agent`, `cursor-agent`) and `cursor` are used by the CursorBackend
 *  and must remain accessible from Slack bot sessions. */
const ALLOWED_EXECUTABLES = new Set([
  "cursor", "cursor-agent", "agent",
]);

/** Executables that must never be invoked from Slack. */
const BLOCKED_EXECUTABLES = new Set([
  // Privilege escalation
  "sudo", "su", "doas", "pkexec",
  // Process/service management
  "kill", "killall", "pkill",
  "systemctl", "service",
  "init", "telinit",
  // System power
  "shutdown", "reboot", "halt", "poweroff",
  // Destructive filesystem
  "rm", "rmdir", "shred", "wipefs",
  "mkfs", "mke2fs", "mkswap",
  "fdisk", "parted", "gdisk",
  "dd",
  // Mount / disk
  "mount", "umount", "losetup",
  // Network / firewall
  "iptables", "ip6tables", "nft", "ufw",
  "ifconfig", "ip",
  // User/group management
  "useradd", "userdel", "usermod",
  "groupadd", "groupdel", "groupmod",
  "passwd", "chpasswd",
  // Cron / at
  "crontab", "at", "batch",
  // Dangerous shells (could bypass everything)
  "bash", "sh", "zsh", "fish", "dash", "csh", "tcsh", "ksh",
  // Container escape
  "docker", "podman", "kubectl", "crictl",
  // Cloud CLI (could access/modify cloud resources)
  "aws",
  // Package managers (could install malicious packages)
  "apt", "apt-get", "dpkg", "yum", "dnf", "pacman", "snap", "flatpak",
  "pip", "pip3", "gem", "cargo",
  // npm/yarn/pnpm handled separately (run/test/start OK, install blocked)
  // Agent/scheduler recursion
  "claude",
]);

/** Dangerous pm2 subcommands that would stop the scheduler itself. */
const PM2_STOP_PATTERNS = [
  /^pm2\s+stop\s+akari\b/i,
  /^pm2\s+stop\s+--id\s+\d+/i,
  /^pm2\s+stop\s+all\b/i,
  /^pm2\s+delete\s+akari\b/i,
  /^pm2\s+delete\s+all\b/i,
];

/** Destructive git operations that can corrupt history or lose work.
 *  Applied per-segment (after splitting on shell operators). */
const DANGEROUS_GIT_PATTERNS = [
  /\bgit\s+push\s+.*(?:--force\b|-f\b)/i,
  /\bgit\s+push\s+.*--force-with-lease\b/i,
  /\bgit\s+reset\s+--hard\b/i,
];

/** Shells that are blocked by default but allowed for experiment launch (running .sh scripts). */
const SHELL_EXECUTABLES = new Set(["bash", "sh", "zsh", "fish", "dash", "csh", "tcsh", "ksh"]);

/** JS package managers — only mutation subcommands are blocked. */
const JS_PKG_MANAGERS = new Set(["npm", "yarn", "pnpm"]);
const JS_PKG_DANGEROUS_SUBCMDS = new Set([
  "install", "i", "ci", "add", "remove", "uninstall", "rm",
  "link", "unlink", "publish", "unpublish", "pack",
]);

/** Check if a JS package manager command is safe (run/test/start OK, install blocked). */
function checkJsPkgManager(basename: string, restArgs: string[]): void {
  if (!JS_PKG_MANAGERS.has(basename)) return;
  const subcmd = restArgs.find((a) => !a.startsWith("-"))?.toLowerCase();
  if (!subcmd || JS_PKG_DANGEROUS_SUBCMDS.has(subcmd)) {
    throw new SecurityError(`Blocked command: ${basename} ${subcmd ?? "(no subcommand)"}`);
  }
  // safe subcommands: run, start, test, exec, info, list, outdated, etc.
}

/**
 * Validate a command array before passing it to spawn().
 * Blocks dangerous executables and shell wrappers.
 * Throws SecurityError if the command is unsafe.
 *
 * @param allowShells - If true, permit shell executables (bash, sh, etc.).
 *   Use for experiment launch where the command is a shell script run via run.py.
 */
export function validateCommand(command: string[], opts?: { allowShells?: boolean }): void {
  if (command.length === 0) {
    throw new SecurityError("Empty command");
  }

  const executable = command[0];
  // Extract basename in case of absolute path (e.g., /usr/bin/sudo)
  const basename = executable.split("/").pop()?.toLowerCase() ?? "";

  // Allowlist takes precedence — never block explicitly allowed executables
  if (!ALLOWED_EXECUTABLES.has(basename)) {
    if (BLOCKED_EXECUTABLES.has(basename)) {
      // Allow shells when explicitly permitted (experiment launch path)
      if (opts?.allowShells && SHELL_EXECUTABLES.has(basename)) {
        // ok — experiment scripts need shell execution
      } else {
        throw new SecurityError(`Blocked executable: ${basename}`);
      }
    }

    // JS package managers: allow safe subcommands (run, test, start), block mutations
    checkJsPkgManager(basename, command.slice(1));

    // Block env/nohup/strace wrappers that could prefix a dangerous command
    const WRAPPER_EXECUTABLES = new Set(["env", "nohup", "strace", "ltrace", "timeout", "nice", "ionice", "setsid", "xargs"]);
    if (WRAPPER_EXECUTABLES.has(basename)) {
      // Check if the wrapped command is also safe
      const innerIdx = command.findIndex((arg, i) => i > 0 && !arg.startsWith("-"));
      if (innerIdx > 0) {
        const innerBasename = command[innerIdx].split("/").pop()?.toLowerCase() ?? "";
        if (BLOCKED_EXECUTABLES.has(innerBasename) && !ALLOWED_EXECUTABLES.has(innerBasename)) {
          throw new SecurityError(`Blocked executable via wrapper: ${innerBasename}`);
        }
      }
    }
  }

  // Block shell invocations via -c flag (e.g., python3 -c "import os; os.system('rm -rf /')")
  // is too hard to fully prevent, but we block the obvious shell wrappers above.
}

// ── Shell command validation (for Bash tool strings) ─────────────────────────

/**
 * Validate a shell command string (as received by Claude Code's Bash tool).
 * Extracts executables from the command and checks against the blocklist.
 * Throws SecurityError if the command contains dangerous executables.
 */
/** Tool names that execute shell commands across different backends. */
const SHELL_TOOL_NAMES = new Set(["Bash", "Shell", "bash"]);

/**
 * Check an SDK message for Bash tool_use blocks containing pm2 stop/delete commands.
 * Returns the violating command, or null if no violation.
 * Used by L0 enforcement in agent.ts to terminate sessions that attempt self-termination.
 */
export function checkMessageForPm2Violation(
  msg: { type?: string; message?: { content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }> } },
): string | null {
  if (msg.type !== "assistant" || !msg.message?.content) return null;

  for (const block of msg.message.content) {
    if (block.type !== "tool_use" || !SHELL_TOOL_NAMES.has(block.name ?? "")) continue;
    const command = block.input?.["command"];
    if (typeof command !== "string") continue;

    for (const pattern of PM2_STOP_PATTERNS) {
      if (pattern.test(command)) {
        return command;
      }
    }
  }

  return null;
}

export function validateShellCommand(cmd: string): void {
  if (!cmd.trim()) {
    throw new SecurityError("Empty shell command");
  }

  // Block pm2 stop/delete commands that would kill the scheduler itself
  for (const pattern of PM2_STOP_PATTERNS) {
    if (pattern.test(cmd)) {
      throw new SecurityError("Blocked command: pm2 stop/delete would terminate the scheduler itself. Use /api/restart instead.");
    }
  }

  // Block destructive git operations (force push, hard reset) that can corrupt history
  for (const pattern of DANGEROUS_GIT_PATTERNS) {
    if (pattern.test(cmd)) {
      throw new SecurityError("Blocked command: destructive git operation (force push or hard reset) is not allowed.");
    }
  }

  // Split on shell operators to find all commands in a pipeline/chain
  // Handles: cmd1 && cmd2, cmd1 || cmd2, cmd1 ; cmd2, cmd1 | cmd2, $(cmd), `cmd`
  const segments = cmd.split(/[;&|`]|\$\(/).map((s) => s.trim()).filter(Boolean);

  for (const segment of segments) {
    // Extract the first word (executable), skipping leading env assignments (KEY=val)
    const words = segment.split(/\s+/);
    let executable = "";
    for (const word of words) {
      // Skip env var assignments like FOO=bar
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
      // Skip shell redirections
      if (/^[<>]/.test(word) || /^\d+[<>]/.test(word)) break;
      executable = word;
      break;
    }
    if (!executable) continue;

    const basename = executable.split("/").pop()?.toLowerCase() ?? "";

    // Allowlist takes precedence — never block explicitly allowed executables
    if (ALLOWED_EXECUTABLES.has(basename)) continue;

    if (BLOCKED_EXECUTABLES.has(basename)) {
      throw new SecurityError(`Blocked command: ${basename}`);
    }

    // JS package managers: allow safe subcommands, block mutations
    const execIdx = words.indexOf(executable);
    checkJsPkgManager(basename, words.slice(execIdx + 1));

    // Check for wrapper commands (env, nohup, etc.) wrapping a blocked command
    const WRAPPER_EXECUTABLES = new Set(["env", "nohup", "strace", "ltrace", "timeout", "nice", "ionice", "setsid", "xargs"]);
    if (WRAPPER_EXECUTABLES.has(basename)) {
      // Find the next non-flag argument
      const restWords = words.slice(words.indexOf(executable) + 1);
      for (const w of restWords) {
        if (w.startsWith("-")) continue;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
        const innerBasename = w.split("/").pop()?.toLowerCase() ?? "";
        if (BLOCKED_EXECUTABLES.has(innerBasename) && !ALLOWED_EXECUTABLES.has(innerBasename)) {
          throw new SecurityError(`Blocked command via wrapper: ${innerBasename}`);
        }
        break;
      }
    }
  }
}

// ── PID ownership ────────────────────────────────────────────────────────────

/**
 * Verify a PID belongs to the current user before sending a signal.
 * Reads /proc/<pid>/status to check the UID.
 * Returns true if the process exists and is owned by the current user.
 */
export async function validatePidOwnership(pid: number): Promise<boolean> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf-8");
    const uidLine = status.split("\n").find((l) => l.startsWith("Uid:"));
    if (!uidLine) return false;
    // Uid: <real> <effective> <saved> <fs>
    const realUid = parseInt(uidLine.split(/\s+/)[1], 10);
    return realUid === process.getuid!();
  } catch {
    // Process doesn't exist or no access
    return false;
  }
}

// ── Error type ───────────────────────────────────────────────────────────────

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityError";
  }
}
