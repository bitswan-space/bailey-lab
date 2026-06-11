import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Channel returned by `openSse`. Use `write()` to push framed event chunks,
 * `end()` to close cleanly, and `signal` to cancel any upstream `fetch` when
 * the downstream client disconnects.
 */
export interface SseChannel {
  /** Write a raw SSE chunk (caller is responsible for `event:` / `data:` framing). */
  write: (chunk: string) => void;
  /** End the response and stop the keepalive timer. Idempotent. */
  end: () => void;
  /** Aborted when the downstream client disconnects. */
  signal: AbortSignal;
}

/**
 * Set up an SSE response and wire up the cleanup machinery shared by every
 * streaming route: headers, keepalive comment pings (defeats idle-connection
 * killers in proxies), and abort propagation on client disconnect.
 */
export function openSse(
  req: FastifyRequest,
  reply: FastifyReply,
  options: { keepaliveMs?: number } = {},
): SseChannel {
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-store');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no');
  reply.raw.flushHeaders?.();

  const ac = new AbortController();
  let closed = false;

  const write = (chunk: string) => {
    if (closed) return;
    reply.raw.write(chunk);
  };

  const end = () => {
    if (closed) return;
    closed = true;
    ac.abort();
    clearInterval(keepalive);
    try {
      reply.raw.end();
    } catch {
      // already ended — ignore
    }
  };

  const keepaliveMs = options.keepaliveMs ?? 20_000;
  const keepalive = setInterval(() => {
    if (!closed) reply.raw.write(':keepalive\n\n');
  }, keepaliveMs);

  req.raw.on('close', end);
  req.raw.on('error', end);

  return { write, end, signal: ac.signal };
}
