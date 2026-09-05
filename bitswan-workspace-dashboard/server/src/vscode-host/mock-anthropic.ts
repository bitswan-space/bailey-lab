import http from 'node:http';

export interface MockAnthropic {
  port: number;
  baseUrl: string;
  requests: { method: string; path: string; body: unknown }[];
  close: () => Promise<void>;
}

const MODELS = [
  { id: 'claude-opus-5', display_name: 'Claude Opus 5', type: 'model', created_at: '2026-04-01T00:00:00Z' },
  { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', type: 'model', created_at: '2026-04-01T00:00:00Z' },
  { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', type: 'model', created_at: '2025-10-01T00:00:00Z' },
];

function sse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function describeUserTurn(body: unknown): { text: string; images: number } {
  const messages = (body as { messages?: { role?: string }[] })?.messages ?? [];
  const userTurns = messages.filter((m) => m?.role === 'user');
  const last = userTurns[userTurns.length - 1] as { content?: unknown } | undefined;
  const content = last?.content;
  if (typeof content === 'string') return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: '', images: 0 };
  let text = '';
  let images = 0;
  for (const block of content as { type?: string; text?: string }[]) {
    if (block?.type === 'text') text += `${stripReminders(block.text ?? '')}\n`;
    if (block?.type === 'image') images += 1;
  }
  return { text: text.trim(), images };
}

function stripReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

function mockAnswer(turn: { text: string; images: number }): string {
  const prompt = turn.text.toLowerCase();
  if (turn.images > 0) {
    return `I can see the ${turn.images === 1 ? 'image' : `${turn.images} images`} you attached. ${
      prompt ? 'Working from that plus your note, ' : 'From the screenshot, '
    }here is what I would change: the layout needs the totals column right-aligned, and the header row should stay fixed while the table scrolls.`;
  }
  if (!prompt) return 'I did not receive a prompt — say what you would like me to do.';
  if (/\btest|pytest|coverage\b/.test(prompt)) {
    return 'I ran the test suite for this business process: 12 passed, 0 failed. The invoice-total rounding case is the one worth watching — it only passes because the fixture uses whole currency units.';
  }
  if (/\badd|implement|build|create\b/.test(prompt)) {
    return 'I added the endpoint to the backend, wired it into the frontend table, and updated README.md so the next person sees it. Two files changed, both inside this business process.';
  }
  if (/\bwhat|how|why|explain|describe\b/.test(prompt)) {
    return 'This business process reads invoices from the inbound bucket, extracts totals in the backend worker, and renders them in the frontend table. The worker is the part you will want to change most often.';
  }
  return `Understood — "${turn.text.slice(0, 80)}". I will start in this business process and keep the change inside it.`;
}

export async function startMockAnthropic(port = 0): Promise<MockAnthropic> {
  const requests: MockAnthropic['requests'] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      requests.push({ method: req.method ?? 'GET', path: url.pathname, body });

      if (url.pathname === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: MODELS, has_more: false, first_id: MODELS[0]!.id, last_id: MODELS[2]!.id }));
        return;
      }

      if (url.pathname.startsWith('/v1/models/')) {
        const id = url.pathname.slice('/v1/models/'.length);
        const found = MODELS.find((m) => m.id === id) ?? MODELS[0]!;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...found, max_input_tokens: 1_000_000, max_tokens: 128_000 }));
        return;
      }

      if (url.pathname === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 42 }));
        return;
      }

      if (url.pathname === '/v1/messages') {
        const turn = describeUserTurn(body);
        const reply = mockAnswer(turn);
        const streaming = Boolean((body as { stream?: boolean })?.stream);
        const model = (body as { model?: string })?.model ?? 'claude-opus-5';

        if (!streaming) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'msg_mock',
              type: 'message',
              role: 'assistant',
              model,
              content: [{ type: 'text', text: reply }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 10 },
            }),
          );
          return;
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        sse(res, 'message_start', {
          type: 'message_start',
          message: {
            id: 'msg_mock',
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        });
        sse(res, 'content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        });
        for (const piece of reply.match(/.{1,24}/g) ?? [reply]) {
          sse(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: piece },
          });
        }
        sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
        sse(res, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 12 },
        });
        sse(res, 'message_stop', { type: 'message_stop' });
        res.end();
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mock: true, path: url.pathname }));
    });
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;

  return {
    port: boundPort,
    baseUrl: `http://127.0.0.1:${boundPort}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
