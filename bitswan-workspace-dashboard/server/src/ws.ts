import type { WebSocket } from 'ws';
import type { IPty } from 'node-pty';
import { spawnPty, killPty } from './pty.js';

const BACKPRESSURE_LIMIT = 1024 * 1024;

interface ControlMessage {
  type: string;
  cols?: number;
  rows?: number;
}

export function handleTerminalConnection(socket: WebSocket): void {
  let term: IPty;
  try {
    term = spawnPty();
  } catch (err) {
    socket.send(JSON.stringify({ type: 'error', message: String(err) }));
    socket.close(1011, 'pty spawn failed');
    return;
  }

  let paused = false;
  const onPtyData = (data: string) => {
    socket.send(Buffer.from(data, 'utf8'));
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
        return;
    }
  });

  const cleanup = () => {
    clearInterval(drainInterval);
    killPty(term);
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}
