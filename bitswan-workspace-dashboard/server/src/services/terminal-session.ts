import type { WebSocket } from 'ws';
import type { IPty } from 'node-pty';
import { killPty } from './pty.js';

const BACKPRESSURE_LIMIT = 1024 * 1024;

interface ControlMessage {
  type: string;
  cols?: number;
  rows?: number;
}

/** Caller supplies a closure so per-route ssh args / env can be passed in. */
export type PtySpawner = (cols: number, rows: number) => IPty;

export interface TerminalConnectionOptions {
  /**
   * Idle timeout in milliseconds. When set, the WS is closed after this many
   * milliseconds without any PTY output AND without any client input. Used
   * by the coding-agent route to free idle Claude sessions. `0` disables.
   */
  idleTimeoutMs?: number;
}

/**
 * Bridge a WebSocket to a freshly spawned pty for the lifetime of the
 * connection. Binary frames flow as raw bytes in both directions; text
 * frames carry JSON control messages (`resize`, `ping`). The bridge
 * applies simple buffered-amount backpressure to avoid memory blowup
 * when the client can't keep up with the shell.
 */
export function handleTerminalConnection(
  socket: WebSocket,
  spawn: PtySpawner,
  options: TerminalConnectionOptions = {},
): void {
  let term: IPty;
  try {
    term = spawn(80, 24);
  } catch (err) {
    socket.send(JSON.stringify({ type: 'error', message: String(err) }));
    socket.close(1011, 'pty spawn failed');
    return;
  }

  // Idle timer: reset on PTY output OR client input. When it fires we send
  // input bytes to the PTY that ask the *remote* foreground process (e.g.
  // Claude, possibly wrapped in dtach inside the agent container) to exit,
  // then close the WS. We can't just SIGINT the local ssh — under dtach
  // that only detaches from a still-running Claude. Sending Ctrl+C bytes
  // flows through ssh → asciinema → dtach → claude, and a double Ctrl+C
  // is Claude's exit gesture. The combined output+input silence signal
  // avoids false positives during long tool calls where Claude has no
  // output but is still working.
  const idleMs = options.idleTimeoutMs ?? 0;
  let idleTimer: NodeJS.Timeout | null = null;
  let timedOut = false;
  const closeForIdle = () => {
    timedOut = true;
    try {
      socket.send(
        JSON.stringify({
          type: 'idle-timeout',
          message: 'Closed due to inactivity. Pick the session and click Resume to continue.',
        }),
      );
    } catch {
      // socket may already be in CLOSING
    }
    // Two Ctrl+Cs ~100ms apart. Claude treats it as exit; raw bash falls
    // through to the wrapper finishing and the ssh closing on its own.
    try {
      term.write('\x03');
    } catch {
      // process may already be gone
    }
    setTimeout(() => {
      try {
        term.write('\x03');
      } catch {
        // already gone
      }
    }, 100);
    setTimeout(() => {
      try {
        socket.close(1000, 'idle timeout');
      } catch {
        // already closed
      }
    }, 2500);
  };
  const armIdle = () => {
    if (idleMs <= 0 || timedOut) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(closeForIdle, idleMs);
  };
  armIdle();

  let paused = false;
  const onPtyData = (data: string) => {
    socket.send(Buffer.from(data, 'utf8'));
    armIdle();
    if (!paused && socket.bufferedAmount > BACKPRESSURE_LIMIT) {
      paused = true;
      term.pause();
    }
  };
  term.onData(onPtyData);

  const drainInterval = setInterval(() => {
    if (paused && socket.bufferedAmount < BACKPRESSURE_LIMIT / 2) {
      paused = false;
      term.resume();
    }
  }, 100);

  term.onExit(({ exitCode, signal }) => {
    socket.send(JSON.stringify({ type: 'exit', exitCode, signal }));
    socket.close(1000, 'pty exited');
  });

  socket.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      term.write(data.toString('utf8'));
      armIdle();
      return;
    }
    let msg: ControlMessage;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    switch (msg.type) {
      case 'resize':
        if (typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          term.resize(msg.cols, msg.rows);
        }
        return;
      case 'ping':
        socket.send(JSON.stringify({ type: 'pong' }));
    }
  });

  const cleanup = () => {
    if (idleTimer) clearTimeout(idleTimer);
    clearInterval(drainInterval);
    killPty(term);
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}
