import { activateExtension, type ExtensionHost } from './host.js';
import { resolveWebviewView } from './api.js';
import { touchReport } from './recorder.js';

const extensionPath = process.env.CLAUDE_EXTENSION_PATH;
const workspaceFolder = process.env.PROBE_WORKSPACE ?? process.cwd();
const deadlineMs = Number(process.env.PROBE_DEADLINE_MS ?? 20_000);

if (!extensionPath) {
  console.error('set CLAUDE_EXTENSION_PATH to the unpacked extension/ directory');
  process.exit(2);
}

type Outcome =
  | { kind: 'resolved'; host: ExtensionHost; ms: number }
  | { kind: 'threw'; error: unknown; ms: number }
  | { kind: 'pending'; ms: number };

const started = Date.now();

const activation: Promise<Outcome> = activateExtension({ extensionPath, workspaceFolder }).then(
  (host) => ({ kind: 'resolved', host, ms: Date.now() - started }) as Outcome,
  (error) => ({ kind: 'threw', error, ms: Date.now() - started }) as Outcome,
);

const deadline: Promise<Outcome> = new Promise((resolve) => {
  const t = setTimeout(() => resolve({ kind: 'pending', ms: Date.now() - started }), deadlineMs);
  t.unref();
});

const outcome = await Promise.race([activation, deadline]);

switch (outcome.kind) {
  case 'resolved':
    console.log(`activate() RESOLVED in ${outcome.ms}ms\n`);
    console.log('registered commands         :', outcome.host.state.commands.size);
    console.log('webview view ids            :', JSON.stringify(outcome.host.state.webviewViewProviders.map((r) => r.viewId)));
    console.log('messages shown to the user  :', JSON.stringify(outcome.host.state.messagesToUser));
    for (const reg of outcome.host.state.webviewViewProviders) {
      try {
        const view = await resolveWebviewView(reg, {
          extensionPath: extensionPath!,
          resourceBase: 'https://dashboard.example/api/coding-agent/vscode/asset',
        });
        const refs = [...view.html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
        console.log('');
        console.log(`view ${view.viewId}: html ${view.html.length} bytes`);
        console.log('  options :', JSON.stringify(view.options));
        console.log('  refs    :', JSON.stringify(refs.slice(0, 8)));
      } catch (err) {
        console.log('');
        console.log(`view ${reg.viewId}: resolve FAILED - ${String((err as Error)?.message ?? err)}`);
      }
    }
    break;
  case 'threw':
    console.log(`activate() THREW after ${outcome.ms}ms`);
    console.log(String((outcome.error as Error)?.stack ?? outcome.error).split('\n').slice(0, 10).join('\n'));
    break;
  case 'pending':
    console.log(`activate() STILL PENDING after ${outcome.ms}ms (extension is alive, not crashed)`);
    break;
}

console.log('');
console.log(touchReport());
process.exit(outcome.kind === 'threw' ? 1 : 0);
