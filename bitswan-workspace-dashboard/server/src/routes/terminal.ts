import type { FastifyInstance } from 'fastify';
import { handleTerminalConnection } from '../services/terminal-session.js';

/**
 * Websocket-pty bridge for the embedded shell in the Agents tab.
 */
export function registerTerminalRoutes(app: FastifyInstance): void {
  app.get('/ws/terminal', { websocket: true }, (socket) => {
    handleTerminalConnection(socket);
  });
}
