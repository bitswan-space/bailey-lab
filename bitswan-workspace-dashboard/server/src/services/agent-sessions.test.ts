import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

/**
 * `latestSession` picks one (copy, bp)-scoped resume candidate from the
 * per-conversation meta files the agent's session wrapper writes. The tests
 * pin the parts the Agents tab depends on: scope + user filtering, the
 * newest-attach-wins ordering, and tolerance of the stale pre-refactor meta
 * layout that may still sit on the volume.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sessions-'));
process.env.AGENT_SESSIONS_DIR = dir;
// AGENT_HOME_DIR stays unset → title lookups hit a nonexistent path and
// resolve to '' without error; titles aren't under test here.

const { latestSession, findSessionOwnerEmail } = await import('./agent-sessions.js');

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';

function writeMeta(
  name: string,
  meta: Record<string, unknown>,
): void {
  fs.writeFileSync(path.join(dir, `${name}.meta.json`), JSON.stringify(meta));
}

writeMeta(U1, {
  user_email: 'alice@example.com',
  worktree: 'copy-a',
  bp: 'bp-1',
  claude_session_id: U1,
  started_at: '2026-08-01T10:00:00+00:00',
});
writeMeta(U2, {
  user_email: 'alice@example.com',
  worktree: 'copy-a',
  bp: 'bp-1',
  claude_session_id: U2,
  started_at: '2026-08-02T10:00:00+00:00',
});
// Another user, same scope — must never be Alice's resume candidate.
writeMeta(U3, {
  user_email: 'bob@example.com',
  worktree: 'copy-a',
  bp: 'bp-1',
  claude_session_id: U3,
  started_at: '2026-08-03T10:00:00+00:00',
});
// Stale pre-refactor layout: timestamped filename, extra fields, newer than
// everything — but a different bp, so it must not leak into bp-1.
writeMeta('20260804_120000_alice_copy-a_bp-2', {
  id: '20260804_120000_alice_copy-a_bp-2',
  user_email: 'alice@example.com',
  worktree: 'copy-a',
  bp: 'bp-2',
  claude_session_id: '44444444-4444-4444-8444-444444444444',
  kind: 'claude',
  started_at: '2026-08-04T12:00:00+00:00',
  logged: true,
});
// Corrupt file — skipped silently.
fs.writeFileSync(path.join(dir, 'broken.meta.json'), '{nope');

test('picks the newest session in scope for the requesting user', async () => {
  const s = await latestSession({
    copy: 'copy-a',
    bp: 'bp-1',
    userEmail: 'alice@example.com',
  });
  assert.equal(s?.claudeSessionId, U2);
});

test("other users' sessions are invisible", async () => {
  const s = await latestSession({
    copy: 'copy-a',
    bp: 'bp-1',
    userEmail: 'bob@example.com',
  });
  assert.equal(s?.claudeSessionId, U3);
});

test('a scope with no sessions resolves to null', async () => {
  const s = await latestSession({
    copy: 'copy-a',
    bp: 'bp-9',
    userEmail: 'alice@example.com',
  });
  assert.equal(s, null);
});

test('owner lookup reads the per-UUID meta directly', async () => {
  assert.equal(await findSessionOwnerEmail(U3), 'bob@example.com');
  // Unknown conversation (or a legacy one with only a timestamped meta):
  // no recorded owner, same allowance legacy sessions always had.
  assert.equal(
    await findSessionOwnerEmail('99999999-9999-4999-8999-999999999999'),
    null,
  );
  // Non-UUID input never touches the filesystem.
  assert.equal(await findSessionOwnerEmail('../../etc/passwd'), null);
});
