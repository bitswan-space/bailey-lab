import * as pty from 'node-pty';

const ALLOWED_ENV = {
  TERM: 'xterm-256color',
  HOME: '/workspace/workspace',
  USER: 'coder',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  SHELL: '/bin/bash',
};

export interface SpawnOptions {
  shell?: string;
  /**
   * Argv for the spawned process. When omitted, defaults to `['-l']` for the
   * fallback `/bin/bash` shell; callers that pass a different `shell` (e.g.
   * `ssh`) must pass their own argv.
   */
  args?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
  /**
   * Extra env vars merged on top of the `ALLOWED_ENV` whitelist. Used for
   * per-session metadata (e.g. `SSH_WORKTREE`, `SSH_BP`) that needs to
   * survive into the spawned process so the remote `SendEnv` propagation
   * sees them. Treated as trusted by callers — do not put user input here.
   */
  extraEnv?: Record<string, string>;
}

/**
 * Spawn a pty with a minimal, fixed env. Inheriting the parent's environment
 * would leak server-side secrets (deploy tokens, oauth client config) into
 * the spawned process — `ALLOWED_ENV` is the entire whitelist, plus any
 * `extraEnv` the caller explicitly passes.
 */
export function spawnPty(opts: SpawnOptions = {}): pty.IPty {
  const shell = opts.shell ?? process.env.PTY_SHELL ?? '/bin/bash';
  // When no args are supplied, treat the shell as `/bin/bash`-like and pass
  // `-l` for a login shell. Callers spawning `ssh` etc. provide their own argv.
  const args = opts.args ?? ['-l'];
  // ssh callers pass `cwd: undefined` to inherit; the bash default keeps the
  // historical behaviour.
  const cwd = opts.cwd === undefined ? undefined : (opts.cwd ?? '/workspace/workspace');

  const env = {
    ...ALLOWED_ENV,
    SHELL: shell,
    ...(opts.extraEnv ?? {}),
  };

  return pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    cwd: cwd ?? '/workspace/workspace',
    env,
  });
}

/**
 * SIGHUP the pty and follow up with SIGKILL after 2s in case the child
 * ignored the hangup. Both kills are best-effort — a missing process is
 * a normal outcome.
 */
export function killPty(p: pty.IPty): void {
  try {
    p.kill('SIGHUP');
  } catch {
    // already gone
  }
  setTimeout(() => {
    try {
      p.kill('SIGKILL');
    } catch {
      // already gone
    }
  }, 2000);
}
