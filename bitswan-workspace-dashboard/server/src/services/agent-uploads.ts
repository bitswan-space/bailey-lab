import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * Periodic sweeper for `.agent-uploads/` directories — the drop target for
 * images pasted into agent terminals (see client SessionTerminal.tsx). The
 * images are consumed by Claude the moment they're referenced (the content
 * is folded into its session transcript), so anything left on disk is pure
 * residue. Files older than the TTL are deleted, and a directory whose last
 * upload has aged out is removed entirely — the next paste recreates it.
 *
 * Uploads live at exactly two depths, mirroring the agent session cwds
 * (routes/coding-agent.ts): `copies/<copy>/.agent-uploads` for copy-level
 * sync sessions and `copies/<copy>/<bp>/.agent-uploads` for BP sessions.
 */

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const TTL_MS =
  Number(process.env.AGENT_UPLOADS_TTL_HOURS || '') > 0
    ? Number(process.env.AGENT_UPLOADS_TTL_HOURS) * 60 * 60 * 1000
    : 7 * 24 * 60 * 60 * 1000;

const UPLOADS_DIRNAME = '.agent-uploads';

async function listDirs(parent: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name !== '.git')
      .map((e) => path.join(parent, e.name));
  } catch {
    return []; // parent missing or unreadable — nothing to sweep
  }
}

/** Delete stale files in one uploads dir; drop the dir if it ends up empty. */
async function sweepUploadsDir(dir: string, cutoff: number): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const file = path.join(dir, name);
    try {
      const st = await fs.lstat(file);
      if (st.isFile() && st.mtimeMs < cutoff) {
        await fs.unlink(file);
        removed += 1;
      }
    } catch {
      // raced with a concurrent upload/delete — leave it for the next sweep
    }
  }
  // Non-recursive rmdir: fails harmlessly if a fresh upload landed between
  // the readdir above and here.
  await fs.rmdir(dir).catch(() => undefined);
  return removed;
}

export async function sweepAgentUploads(workspaceRoot: string): Promise<number> {
  const cutoff = Date.now() - TTL_MS;
  let removed = 0;
  for (const copyDir of await listDirs(path.join(workspaceRoot, 'copies'))) {
    removed += await sweepUploadsDir(path.join(copyDir, UPLOADS_DIRNAME), cutoff);
    for (const bpDir of await listDirs(copyDir)) {
      if (path.basename(bpDir) === UPLOADS_DIRNAME) continue;
      removed += await sweepUploadsDir(path.join(bpDir, UPLOADS_DIRNAME), cutoff);
    }
  }
  return removed;
}

export function startAgentUploadsSweeper(
  app: FastifyInstance,
  opts: { workspaceRoot: string },
): void {
  const run = async () => {
    try {
      const removed = await sweepAgentUploads(opts.workspaceRoot);
      if (removed > 0) {
        app.log.info({ removed }, 'agent-uploads sweep removed stale images');
      }
    } catch (err) {
      app.log.warn({ err }, 'agent-uploads sweep failed');
    }
  };
  void run();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}
