import { execFile } from 'node:child_process';
import { promises as dns } from 'node:dns';

/**
 * How the dashboard reaches the coding-agent container: ssh, always.
 *
 * The agent sits on the isolated `<ws>-agent` bridge (shared only with gitops)
 * that this dashboard is deliberately NOT part of — the agent runs untrusted
 * code and the dashboard trusts X-Forwarded-Email, so putting them on one
 * network would let the agent forge identities. Instead gitops (dual-homed)
 * runs a raw TCP proxy on :2222 to the agent's sshd; SSH auth and encryption
 * stay end-to-end. See bitswan-gitops app/services/agent_ssh_proxy.py.
 *
 * Three callers share this module: the terminal path (routes/coding-agent.ts),
 * the one-shot commands the OpenCode integration issues (`sshExec`), and the
 * port-forwards it keeps open (services/opencode-tunnel.ts).
 */

/** The workspace keypair the daemon installs; its public half is the agent's authorized_keys. */
export const SSH_KEY = '/workspace/.ssh/id_ed25519';

export interface AgentSshTarget {
  host: string;
  port: number;
}

/** Where the agent's sshd is reached from here (normally the gitops TCP proxy). */
export function agentSshTarget(): AgentSshTarget {
  // Allow an explicit override for setups where the coding-agent's sshd is
  // directly reachable (e.g. a dev compose without the isolated networks).
  const override = process.env.CODING_AGENT_HOST;
  if (override) {
    return { host: override, port: Number(process.env.CODING_AGENT_SSH_PORT ?? 22) };
  }
  const ws = process.env.BITSWAN_WORKSPACE_NAME ?? 'default';
  return { host: `${ws}-gitops`, port: 2222 };
}

/**
 * Wait until DNS resolves the SSH target hostname (normally the gitops
 * container carrying the agent-ssh proxy; the agent itself is on a network
 * this container can't see). The container takes a moment to register with
 * docker's embedded DNS after it starts — without this poll, the first
 * session attempt after a cold start can fail with "Could not resolve
 * hostname".
 */
export async function waitForAgentDns(host: string, attempts = 15, delayMs = 1000): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      await dns.lookup(host);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

/**
 * The environment ssh child processes get. Inheriting the server's would leak
 * its secrets (deploy token, gitops credentials) into a process whose argv and
 * environment are visible to anything else in this container — the same
 * whitelist services/pty.ts applies to the terminal path.
 */
export const SSH_ENV: Record<string, string> = {
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  HOME: '/workspace/workspace',
  USER: 'coder',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
};

/**
 * The ssh options every non-interactive connection to the agent uses. Key-only
 * auth against a host whose key changes on every container recreation, so host
 * keys are not checked; BatchMode turns any prompt into a failure instead of a
 * hang.
 */
export function sshBaseArgs(target: AgentSshTarget = agentSshTarget()): string[] {
  return [
    '-p',
    String(target.port),
    '-i',
    SSH_KEY,
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-o',
    'BatchMode=yes',
    '-o',
    'LogLevel=ERROR',
  ];
}

export interface SshExecResult {
  /** The remote command's exit code; 255 is ssh itself failing to connect. */
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run one command in the coding-agent container as `email`.
 *
 * This is the wrapper's non-interactive path: sshd's ForceCommand
 * (agent-session-wrapper) derives the per-user config directory from
 * SSH_USER_EMAIL, sets the git identity, and then runs the command with
 * `bash -c`. Only SSH_USER_EMAIL is sent — SSH_WORKTREE would make the wrapper
 * seed MCP config into that copy as a side effect, and no command issued here
 * is about one copy.
 */
export function sshExec(opts: {
  email: string;
  command: string;
  timeoutMs?: number;
  target?: AgentSshTarget;
}): Promise<SshExecResult> {
  const target = opts.target ?? agentSshTarget();
  const args = [...sshBaseArgs(target), '-o', 'SendEnv=SSH_USER_EMAIL', `agent@${target.host}`, opts.command];
  return new Promise((resolve) => {
    execFile(
      'ssh',
      args,
      {
        env: { ...SSH_ENV, SSH_USER_EMAIL: opts.email },
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        // execFile reports a non-zero exit as an error carrying `code`; a
        // signal (our timeout) has no code, and a spawn failure has a string
        // one (ENOENT). Both read as "did not run", 255 like ssh's own failures.
        const code = typeof error.code === 'number' ? error.code : 255;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? error.message) });
      },
    );
  });
}
