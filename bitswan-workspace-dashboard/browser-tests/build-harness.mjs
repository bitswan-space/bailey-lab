// Bundles the real RequirementsTable into a standalone page for the browser
// tests. Nothing is stubbed: the component under test is the shipped one, with
// only its data and callbacks supplied by the harness.
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dashboard = resolve(here, '..');

// esbuild comes from the dashboard's own dependencies rather than being
// duplicated here — the bundle needs that node_modules tree anyway, for React
// and the client's component imports.
let build;
try {
  build = createRequire(resolve(dashboard, 'package.json'))('esbuild').build;
} catch {
  console.error(
    `Could not load esbuild from ${dashboard}.\n` +
      'Run `npm install` in bitswan-workspace-dashboard first.',
  );
  process.exit(1);
}

await build({
  entryPoints: [resolve(here, 'harness-requirements.tsx')],
  outfile: resolve(here, 'bundle.js'),
  bundle: true,
  format: 'iife',
  jsx: 'automatic',
  // The client's `@/*` path alias, resolved for a standalone bundle.
  alias: { '@': resolve(dashboard, 'client/src') },
  absWorkingDir: dashboard,
  // This directory is not an npm workspace, so bare imports need an explicit
  // resolution root.
  nodePaths: [resolve(dashboard, 'node_modules')],
  loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'warning',
});
