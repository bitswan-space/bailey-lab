import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { agentSshTarget, sshBaseArgs, SSH_ENV, type AgentSshTarget } from './agent-ssh.js';

/**
 * One SSH port-forward per user to their OpenCode server.
 *
 * The OpenCode server listens on a loopback port inside the coding-agent
 * container, which the dashboard cannot reach directly (see agent-ssh.ts). A
 * forward-only ssh connection (`-N -L`) through the gitops proxy makes that
 * port appear on this container's loopback, where the HTTP forwarder and the
 * WebSocket bridge connect to it. sshd's ForceCommand never runs for a `-N`
 * connection, so no wrapper session is started on the far side.
 *
 * One connection per user carries every request as SSH channels; the gitops
 * proxy sees exactly one TCP connection per tunnel.
 */

const READY_TIMEOUT_MS = 20_000;
const READY_POLL_MS = 200;

export interface Tunnel {
  localPort: number;
  remotePort: number;
  lastUsedAt: number;
  child: ChildProcess;
}

const tunnels = new Map<string, Tunnel>();
const opening = new Map<string, Promise<Tunnel>>();

/** A loopback port nothing is listening on right now. */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('could not pick a port'))));
    });
  });
}

/** Whether something accepts TCP connections on this loopback port. */
export function portAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1_000, () => done(false));
  });
}

// eslint-disable-next-line no-restricted-syntax -- undefined = no tunnel
function alive(t: Tunnel | undefined): t is Tunnel {
  return !!t && t.child.exitCode === null && !t.child.killed;
}

/** The live tunnel for `email`, if any. */
// eslint-disable-next-line no-restricted-syntax -- undefined = no tunnel
export function tunnelFor(email: string): Tunnel | undefined {
  const t = tunnels.get(email);
  return alive(t) ? t : undefined;
}

/** Mark the tunnel as used, for the idle reaper. */
export function touchTunnel(email: string): void {
  const t = tunnels.get(email);
  if (t) t.lastUsedAt = Date.now();
}

/**
 * Make sure a tunnel to `remotePort` exists for `email` and return its local
 * port. A tunnel to a different remote port (the server was restarted on a new
 * one) is replaced.
 */
export async function ensureTunnel(
  email: string,
  remotePort: number,
  target: AgentSshTarget = agentSshTarget(),
): Promise<number> {
  const existing = tunnelFor(email);
  if (existing && existing.remotePort === remotePort) {
    existing.lastUsedAt = Date.now();
    return existing.localPort;
  }
  if (existing) closeTunnel(email);
  const pending = opening.get(email);
  if (pending) return (await pending).localPort;

  const open = openTunnel(email, remotePort, target).finally(() => opening.delete(email));
  opening.set(email, open);
  return (await open).localPort;
}

async function openTunnel(email: string, remotePort: number, target: AgentSshTarget): Promise<Tunnel> {
  // The port is picked and released before ssh binds it; losing that race
  // makes ssh exit through ExitOnForwardFailure, which the loop below reads
  // as "try once more with a fresh port".
  for (let attempt = 0; attempt < 2; attempt++) {
    const localPort = await freeLoopbackPort();
    const child = spawn(
      'ssh',
      [
        ...sshBaseArgs(target),
        '-N',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'ServerAliveInterval=30',
        '-o',
        'ServerAliveCountMax=3',
        '-L',
        `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
        `agent@${target.host}`,
      ],
      { env: SSH_ENV, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    const tunnel: Tunnel = { localPort, remotePort, lastUsedAt: Date.now(), child };
    child.once('exit', () => {
      if (tunnels.get(email) === tunnel) tunnels.delete(email);
    });

    // ssh prints nothing when the forward is up, so readiness is "the local
    // port accepts connections" — which it does the moment ssh has bound it.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline && child.exitCode === null) {
      if (await portAccepts(localPort)) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
    if (ready) {
      tunnels.set(email, tunnel);
      return tunnel;
    }
    child.kill('SIGTERM');
    if (child.exitCode === null || attempt === 1) {
      throw new Error(
        `ssh port-forward to the coding agent did not come up${stderr ? `: ${stderr.trim()}` : ''}`,
      );
    }
  }
  throw new Error('ssh port-forward to the coding agent did not come up');
}

/** Tear down `email`'s tunnel, if any. */
export function closeTunnel(email: string): void {
  const t = tunnels.get(email);
  tunnels.delete(email);
  if (t && t.child.exitCode === null) t.child.kill('SIGTERM');
}

/** Tear down every tunnel (server shutdown). */
export function closeAllTunnels(): void {
  for (const email of [...tunnels.keys()]) closeTunnel(email);
}
