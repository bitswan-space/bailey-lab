import fs from 'node:fs';
import { startMockAnthropic } from './mock-anthropic.js';

const mock = await startMockAnthropic(Number(process.env.MOCK_PORT ?? 45999));
console.log(`mock anthropic on ${mock.baseUrl}`);
setInterval(() => {
  if (mock.requests.length) {
    const seen = mock.requests.splice(0, mock.requests.length);
    for (const r of seen) {
      console.log(`REQ ${r.method} ${r.path}`);
      if (r.path === '/v1/messages') {
        fs.writeFileSync('/tmp/claude-0/-root/bce0babf-52a9-4893-ab8b-b5f90cb764f9/scratchpad/last-body.json', JSON.stringify(r.body, null, 1));
      }
    }
  }
}, 500);
