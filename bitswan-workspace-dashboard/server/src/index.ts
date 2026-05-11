import { buildServer } from './server.js';
import { GitopsClient } from './gitops.js';

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';

const deployUrl = process.env.BITSWAN_DEPLOY_URL;
const deploySecret = process.env.BITSWAN_DEPLOY_SECRET;

let gitops: GitopsClient | null = null;
if (deployUrl && deploySecret) {
  gitops = new GitopsClient(deployUrl, deploySecret);
  await gitops.start();
} else {
  console.warn(
    '[dashboard] BITSWAN_DEPLOY_URL / BITSWAN_DEPLOY_SECRET not set — running without gitops',
  );
}

const app = await buildServer({ gitops });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  if (gitops) await gitops.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
