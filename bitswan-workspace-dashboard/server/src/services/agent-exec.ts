import { spawn } from 'node:child_process';

/**
 * One-shot, non-interactive command execution inside the workspace's
 * coding-agent container, over the same SSH channel the Agents tab uses for
 * interactive Claude sessions (key at `/workspace/.ssh/id_ed25519`, user
 * `agent`). Unlike the interactive path (which spawns a PTY and lets the
 * container's `agent-session-wrapper` launch Claude), this sends a command
 * string as SSH_ORIGINAL_COMMAND with SSH_LOGGED=false, which the wrapper
 * runs via `exec bash -c "$cmd"` and pipes straight back — so we get the
 * command's stdout/stderr + exit code with no asciinema recording in the way.
 *
 * This is how the dashboard drives the deterministic
 * `bitswan-coding-agent requirements test` command (the binary, BITSWAN_GITOPS_URL
 * and the gitops *agent* secret all live in that container, not here): the CLI
 * execs the test inside the BP's live-dev deployment and writes pass/fail back
 * to testable-requirements.toml, which we then re-read.
 */

const SSH_KEY = '/workspace/.ssh/id_ed25519';

// Cap captured output so a chatty test runner can't blow up memory; the tail is
// what matters for a pass/fail summary, but we keep the head (where pytest's
// failing-assert detail usually is) and mark the truncation.
const MAX_OUTPUT_BYTES = 256 * 1024;

/** Mirrors `agentHost()` in routes/coding-agent.ts (kept local so the
 *  interactive WS path is untouched by changes here). */
function agentHost(): string {
  const override = process.env.CODING_AGENT_HOST;
  if (override) return override;
  const ws = process.env.BITSWAN_WORKSPACE_NAME ?? 'default';
  return `${ws}-coding-agent`;
}

export interface AgentExecResult {
  /** Remote command exit code; 255 is an SSH-level failure (host unreachable). */
  exitCode: number;
  /** Combined stdout+stderr from the remote command, truncated to a cap. */
  output: string;
  /** stdout alone, for callers that parse the command's output and can't
   *  afford stderr noise interleaved into it. Same truncation cap. */
  stdout: string;
}

function sshExec(opts: {
  command: string;
  /** Omitted for commands that aren't scoped to a copy (the wrapper then
   *  lands in `/workspace/copies`, which per-user commands don't care about). */
  copy?: string;
  bp?: string;
  email: string;
  /** Piped to the remote command's stdin. This is the ONLY safe channel for
   *  user-controlled data — never interpolate it into `command`. */
  stdin?: string;
  timeoutMs: number;
}): Promise<AgentExecResult> {
  const host = agentHost();
  const args = [
    '-i',
    SSH_KEY,
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    // Silence the "Permanently added <host>" host-key warning — it lands on
    // stderr and would pollute `output` for callers that show it verbatim.
    '-o',
    'LogLevel=ERROR',
    // Fail fast instead of hanging on a password/known-hosts prompt.
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    // The container's sshd only AcceptEnv's this fixed set; SSH_LOGGED=false
    // is what makes the wrapper run our command non-interactively and pipe it
    // back rather than recording it with asciinema.
    '-o',
    'SendEnv=SSH_USER_EMAIL',
    '-o',
    'SendEnv=SSH_LOGGED',
    '-o',
    'SendEnv=SSH_WORKTREE',
    '-o',
    'SendEnv=SSH_BP',
    `agent@${host}`,
    opts.command,
  ];

  return new Promise<AgentExecResult>((resolve, reject) => {
    const child = spawn('ssh', args, {
      env: {
        ...process.env,
        SSH_USER_EMAIL: opts.email,
        SSH_LOGGED: 'false',
        ...(opts.copy ? { SSH_WORKTREE: opts.copy } : {}),
        ...(opts.bp ? { SSH_BP: opts.bp } : {}),
      },
    });

    let output = '';
    let stdout = '';
    let truncated = false;
    const capture = (chunk: Buffer, isStdout: boolean) => {
      if (isStdout && stdout.length <= MAX_OUTPUT_BYTES) {
        stdout += chunk.toString('utf8');
      }
      if (truncated) return;
      output += chunk.toString('utf8');
      if (output.length > MAX_OUTPUT_BYTES) {
        output = output.slice(0, MAX_OUTPUT_BYTES) + '\n…(output truncated)';
        truncated = true;
      }
    };
    child.stdout.on('data', (c: Buffer) => capture(c, true));
    child.stderr.on('data', (c: Buffer) => capture(c, false));
    // End stdin either way: without this, remote commands that read stdin
    // (`cat > file`) would block forever waiting for EOF.
    child.stdin.end(opts.stdin ?? '');

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`agent exec timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, output, stdout });
    });
  });
}

/**
 * Per-user Claude statusline script, stored at `$CLAUDE_CONFIG_DIR/statusline.sh`
 * in the coding-agent container. The container's default statusline
 * (/usr/local/bin/claude-statusline) execs this file when it exists, so an
 * upload takes effect on the next render — including in already-open
 * sessions. All three operations run as the calling user: the wrapper
 * resolves CLAUDE_CONFIG_DIR from SSH_USER_EMAIL, so `$CLAUDE_CONFIG_DIR`
 * below expands remotely to the right per-user dir and the server never
 * re-derives the email slug.
 */

export interface AgentStatusline {
  script: string;
  /** True when the user has uploaded their own script; false = the
   *  container's built-in default (returned as a starting point to edit). */
  custom: boolean;
}

/** Read the user's effective statusline: their upload, or the shipped default. */
export async function getAgentStatusline(email: string): Promise<AgentStatusline> {
  const res = await sshExec({
    command:
      'if [ -f "$CLAUDE_CONFIG_DIR/statusline.sh" ]; then echo CUSTOM; cat "$CLAUDE_CONFIG_DIR/statusline.sh"; ' +
      // Old images predate the default script — an empty DEFAULT is fine.
      'else echo DEFAULT; cat /usr/local/bin/claude-statusline 2>/dev/null || true; fi',
    email,
    timeoutMs: 15_000,
  });
  if (res.exitCode !== 0) {
    throw new Error(`statusline read failed (exit ${res.exitCode}): ${res.output.trim()}`);
  }
  const nl = res.stdout.indexOf('\n');
  const marker = nl === -1 ? res.stdout.trim() : res.stdout.slice(0, nl).trim();
  return {
    script: nl === -1 ? '' : res.stdout.slice(nl + 1),
    custom: marker === 'CUSTOM',
  };
}

/** Exit code the remote command uses to say "script failed `bash -n`". */
const STATUSLINE_SYNTAX_EXIT = 42;

/** Install the user's statusline script; `{ok: false}` carries `bash -n` output. */
export async function putAgentStatusline(
  email: string,
  script: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await sshExec({
    // The script travels via stdin (never interpolated into the command).
    // `bash -n` gates the install so a typo'd upload can't take effect —
    // Claude would render nothing and the user would have no feedback why.
    command:
      'set -e; tmp=$(mktemp); trap \'rm -f "$tmp"\' EXIT; cat > "$tmp"; ' +
      'if err=$(bash -n "$tmp" 2>&1); then install -m 755 "$tmp" "$CLAUDE_CONFIG_DIR/statusline.sh"; ' +
      `else printf '%s' "$err"; exit ${STATUSLINE_SYNTAX_EXIT}; fi`,
    email,
    stdin: script,
    timeoutMs: 15_000,
  });
  if (res.exitCode === STATUSLINE_SYNTAX_EXIT) {
    return { ok: false, error: res.stdout.trim() || 'script failed bash -n syntax check' };
  }
  if (res.exitCode !== 0) {
    throw new Error(`statusline save failed (exit ${res.exitCode}): ${res.output.trim()}`);
  }
  return { ok: true };
}

/** Remove the user's upload so the container's default statusline is back. */
export async function deleteAgentStatusline(email: string): Promise<void> {
  const res = await sshExec({
    command: 'rm -f "$CLAUDE_CONFIG_DIR/statusline.sh"',
    email,
    timeoutMs: 15_000,
  });
  if (res.exitCode !== 0) {
    throw new Error(`statusline reset failed (exit ${res.exitCode}): ${res.output.trim()}`);
  }
}

/** Requirement IDs are `REQ-###` / `AI-###` style; this is the safety check
 *  before the id is interpolated into the remote shell command. */
export function isSafeRequirementId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

/**
 * Run the deterministic `requirements test` command in the BP's live-dev
 * container. With `id` set, runs that one requirement; otherwise every
 * non-proposed requirement. The CLI auto-detects the copy + live-dev
 * deployment from the working directory (the wrapper cd's into
 * `/workspace/copies/<copy>/<bp>` when SSH_BP is set), so we only pass --id.
 */
export function runRequirementTests(opts: {
  copy: string;
  bp: string;
  email: string;
  id?: string;
}): Promise<AgentExecResult> {
  if (opts.id !== undefined && !isSafeRequirementId(opts.id)) {
    return Promise.reject(new Error('invalid requirement id'));
  }
  const idArg = opts.id ? ` --id ${opts.id}` : '';
  // Source the env file the agent entrypoint writes (BITSWAN_GITOPS_URL +
  // BITSWAN_GITOPS_AGENT_SECRET) — a non-login `bash -c` doesn't read
  // /etc/profile.d, and the CLI needs both to reach the gitops exec endpoint.
  const command = `source /etc/profile.d/bitswan-agent.sh && bitswan-coding-agent requirements test${idArg}`;
  return sshExec({
    command,
    copy: opts.copy,
    bp: opts.bp,
    email: opts.email,
    // A whole-BP run execs one test process per requirement in the live-dev
    // container; give it room but don't hang the request forever.
    timeoutMs: 5 * 60_000,
  });
}
