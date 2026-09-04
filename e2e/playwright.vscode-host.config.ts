import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PROBE_PORT ?? 8760);
const SERVER_CWD = '../bitswan-workspace-dashboard/server';

export default defineConfig({
  testDir: './tests',
  testMatch: /vscode-host\.spec\.ts/,
  timeout: 120_000,
  retries: 0,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${PORT}` },
  webServer: {
    command: `node --import tsx src/vscode-host/dev-server.ts`,
    cwd: SERVER_CWD,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      CLAUDE_EXTENSION_PATH: process.env.CLAUDE_EXTENSION_PATH ?? '',
      PROBE_WORKSPACE: process.env.PROBE_WORKSPACE ?? '',
      PROBE_PORT: String(PORT),
    },
  },
});
