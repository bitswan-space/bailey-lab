import { test, expect } from '@playwright/test';

const BASE = process.env.VSCODE_HOST_URL ?? 'http://127.0.0.1:8760';

async function inbox(page: import('@playwright/test').Page) {
  return (await (await page.request.get(BASE + '/__inbox')).json()) as {
    count: number;
    messages: { request?: { type?: string }; type?: string }[];
  };
}

test.describe('sidebar interaction against a mock Anthropic API', () => {
  test('sign-in state, prompt round trip, and image paste', async ({ page }) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
    });

    await page.goto(BASE + '/', { waitUntil: 'load', timeout: 60_000 });
    await page.waitForFunction(() => document.querySelectorAll('*').length > 50, { timeout: 30_000 });
    await page.waitForTimeout(6000);

    const bodyText = await page.locator('body').innerText();
    console.log('--- auth surface ---');
    console.log('shows a sign-in prompt :', /sign in|log in|subscription|console account/i.test(bodyText));
    console.log('body head              :', JSON.stringify(bodyText.slice(0, 200)));

    const editable = page.locator('[contenteditable], [role="textbox"], textarea').first();
    const haveInput = await editable.count();
    console.log('prompt input found     :', haveInput > 0);

    const before = await inbox(page);

    if (haveInput > 0) {
      await editable.click();
      await editable.type('hello from the shim', { delay: 10 });
      await page.waitForTimeout(500);
      console.log('typed text landed      :', (await page.locator('body').innerText()).includes('hello from the shim'));
    }

    console.log('--- image paste ---');
    const pasteResult = await page.evaluate(async () => {
      const target =
        (document.querySelector('[contenteditable]') as HTMLElement | null) ??
        (document.querySelector('[role="textbox"]') as HTMLElement | null) ??
        (document.querySelector('textarea') as HTMLElement | null);
      if (!target) return { dispatched: false, reason: 'no prompt element' };

      const canvas = document.createElement('canvas');
      canvas.width = 24;
      canvas.height = 24;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#c1440e';
      ctx.fillRect(0, 0, 24, 24);
      const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), 'image/png'));
      const file = new File([blob], 'pasted.png', { type: 'image/png' });

      const dt = new DataTransfer();
      dt.items.add(file);
      target.focus();
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      const notCancelled = target.dispatchEvent(ev);
      return { dispatched: true, blobBytes: blob.size, defaultPrevented: !notCancelled };
    });
    console.log('paste dispatched       :', JSON.stringify(pasteResult));

    await page.waitForTimeout(6000);
    const after = await inbox(page);
    const newMessages = after.messages.slice(Math.max(0, after.messages.length - (after.count - before.count)));
    const newTypes = newMessages.map((m) => m.request?.type ?? m.type ?? '?');
    console.log('bridge msgs after paste:', after.count - before.count);
    console.log('new message types      :', JSON.stringify(newTypes));
    console.log('image-ish messages     :', JSON.stringify(JSON.stringify(newMessages).match(/"[a-z_]*image[a-z_]*"/gi)?.slice(0, 6) ?? []));

    const afterPasteText = await page.locator('body').innerText();
    console.log('attachment chip text?  :', JSON.stringify((afterPasteText.match(/pasted\.png|image|attach/gi) ?? []).slice(0, 6)));

    const mock = (await (await page.request.get(BASE + '/__mock')).json()) as {
      baseUrl: string; count: number; requests: { method: string; path: string }[];
    };
    console.log('--- mock anthropic ---');
    console.log('mock base url          :', mock.baseUrl);
    console.log('mock requests          :', mock.count, JSON.stringify(mock.requests.slice(0, 8)));

    console.log('--- submit the turn ---');
    const sendButton = page.locator('button').last();
    await sendButton.click({ timeout: 5000 }).catch(async () => {
      await editable.press('Enter').catch(() => undefined);
    });
    await page.waitForTimeout(12_000);

    const mockAfter = (await (await page.request.get(BASE + '/__mock')).json()) as {
      count: number;
      requests: { method: string; path: string; blockTypes: string[]; imageBlocks: number }[];
    };
    const posts = mockAfter.requests.filter((r) => r.method === 'POST' && r.path === '/v1/messages');
    console.log('POST /v1/messages count:', posts.length);
    console.log('block types sent       :', JSON.stringify(posts.map((p) => p.blockTypes).slice(0, 3)));
    console.log('image blocks sent      :', posts.reduce((n, p) => n + p.imageBlocks, 0));

    const finalText = await page.locator('body').innerText();
    console.log('mock reply rendered?   :', /MOCK/i.test(finalText));
    console.log('final body tail        :', JSON.stringify(finalText.slice(-320)));
    const inboxFinal = await inbox(page);
    console.log('bridge msgs total      :', inboxFinal.count);
    console.log('bridge types (tail)    :', JSON.stringify(inboxFinal.messages.slice(-8).map((m) => m.request?.type ?? m.type ?? '?')));
    await page.screenshot({ path: 'vscode-host-submitted.png' });

    console.log('page errors            :', JSON.stringify(pageErrors.slice(0, 4)));
    console.log('console errors         :', JSON.stringify(consoleErrors.slice(0, 4)));
    await page.screenshot({ path: 'vscode-host-interaction.png' });

    expect(haveInput, 'a prompt input exists to paste into').toBeGreaterThan(0);
  });
});
