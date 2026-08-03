import type { FastifyInstance } from 'fastify';

const DAEMON_URL =
  process.env.BITSWAN_DAEMON_URL ??
  'http://bitswan-automation-server-daemon:8080';

/**
 * `/api/public-endpoints` — the workspace's published public endpoints (#220),
 * fetched from the automation-server daemon over bitswan_network. The
 * Deployments tab uses it to badge Open-app links that are also public. Fails
 * soft: returns [] if the daemon is unreachable so the tab still renders.
 */
export function registerPublicEndpointRoutes(app: FastifyInstance): void {
  app.get('/api/public-endpoints', async (_req, reply) => {
    try {
      const res = await fetch(`${DAEMON_URL}/public-endpoints`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return reply.send([]);
      const data = await res.json();
      return reply.send(Array.isArray(data) ? data : []);
    } catch {
      return reply.send([]);
    }
  });
}
