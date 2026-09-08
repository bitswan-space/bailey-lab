import { test, expect } from '@playwright/test';

const BASE = process.env.VSCODE_HOST_URL ?? 'http://127.0.0.1:8760';

test.describe('Claude Code sidebar rendered by the dashboard vscode shim', () => {
  test('the webview bundle boots, renders, and talks to the extension host', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
    });
    page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
    page.on('requestfailed', (r) => failedRequests.push(`${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`));

    const res = await page.goto(BASE + '/', { waitUntil: 'load', timeout: 60_000 });
    expect(res?.status(), 'dev server served the webview').toBe(200);

    await page.waitForFunction(() => document.body && document.body.childElementCount > 0, { timeout: 30_000 });
    await page.waitForTimeout(8000);

    const bridgeLog = await page.evaluate(() => (window as unknown as { __bridgeLog?: string[] }).__bridgeLog ?? []);
    const bodyText = (await page.locator('body').innerText().catch(() => '')).trim();
    const domNodes = await page.evaluate(() => document.querySelectorAll('*').length);
    const inbox = await (await page.request.get(BASE + '/__inbox')).json();

    console.log('--- vscode shim browser probe ---');
    console.log('dom nodes            :', domNodes);
    console.log('bridge log           :', JSON.stringify(bridgeLog.slice(0, 12)));
    console.log('messages to extension:', inbox.count);
    console.log('first inbox messages :', JSON.stringify(inbox.messages.slice(0, 5)).slice(0, 600));
    console.log('body text            :', JSON.stringify(bodyText.slice(0, 400)));
    console.log('console errors       :', JSON.stringify(consoleErrors.slice(0, 5)));
    console.log('page errors          :', JSON.stringify(pageErrors.slice(0, 5)));
    console.log('failed requests      :', JSON.stringify(failedRequests.slice(0, 5)));

    await page.screenshot({ path: 'vscode-host-sidebar.png' });

    expect(failedRequests, 'no asset failed to load').toEqual([]);
    expect(pageErrors, 'webview bundle threw no uncaught error').toEqual([]);
    expect(domNodes, 'the bundle rendered a real DOM, not an empty shell').toBeGreaterThan(20);
    expect(bridgeLog, 'the webview opened the bridge to the extension host').toContain('open');
    expect(inbox.count, 'the webview sent at least one message to the extension').toBeGreaterThan(0);
  });
});
