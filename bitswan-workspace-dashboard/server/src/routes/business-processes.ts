import type { FastifyInstance } from 'fastify';
import {
  discoverBusinessProcesses,
  isValidBpId,
  readReadme,
} from '../services/workspace.js';

export interface BusinessProcessRoutesOptions {
  workspaceRoot: string;
}

/**
 * `/api/business-processes` — filesystem-backed listing of BPs in the workspace
 * plus a per-BP README endpoint. Path-traversal-safe via {@link isValidBpId}.
 */
export function registerBusinessProcessRoutes(
  app: FastifyInstance,
  { workspaceRoot }: BusinessProcessRoutesOptions,
): void {
  app.get('/api/business-processes', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return discoverBusinessProcesses(workspaceRoot);
  });

  app.get<{ Params: { id: string } }>(
    '/api/business-processes/:id/readme',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!isValidBpId(req.params.id)) {
        return reply.code(400).send({ error: 'invalid bp id' });
      }
      const content = await readReadme(req.params.id, workspaceRoot);
      return { content };
    },
  );
}
