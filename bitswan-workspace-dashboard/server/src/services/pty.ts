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
  cwd?: string;
  cols?: number;
  rows?: number;
}

/**
 * Spawn a login shell pty with a minimal, fixed env. Inheriting the parent's
 * environment would leak server-side secrets (deploy tokens, oauth client
 * config) into the user's shell — `ALLOWED_ENV` is the entire whitelist.
 */
export function spawnPty(opts: SpawnOptions = {}): pty.IPty {
  const shell = opts.shell ?? process.env.PTY_SHELL ?? '/bin/bash';
  const cwd = opts.cwd ?? '/workspace/workspace';

  return pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    cwd,
    env: { ...ALLOWED_ENV, SHELL: shell },
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
