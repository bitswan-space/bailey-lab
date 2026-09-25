import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickLatest } from './opencode-api.js';
import { classifyStartResult, parseServerInfo } from './opencode-server.js';

const info = {
  version: '2.0.16',
  port: 43931,
  username: 'opencode',
  password: 'pw',
  pid: 4242,
  started_at: '2026-09-24T12:00:00+00:00',
};

test('the server description is the last JSON line, whatever the shell printed first', () => {
  const stdout = `Welcome banner\n[bitswan] something\n${JSON.stringify(info)}\n`;
  assert.deepEqual(parseServerInfo(stdout), {
    version: '2.0.16',
    port: 43931,
    username: 'opencode',
    password: 'pw',
    pid: 4242,
    startedAt: '2026-09-24T12:00:00+00:00',
  });
});

test('a description without the fields the dashboard needs is an error, not a half server', () => {
  assert.throws(() => parseServerInfo('{"healthy": false}'));
  assert.throws(() => parseServerInfo(''));
  assert.throws(() => parseServerInfo('{"port": "43931", "password": "pw", "pid": 1}'));
});

test('exit 127 means the image has no opencode — a fact, not a retry', () => {
  const r = classifyStartResult({ code: 127, stdout: '', stderr: 'opencode is not installed' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.result.state, 'unavailable');
});

test('ssh failing to connect and the script failing are errors worth retrying', () => {
  const ssh = classifyStartResult({ code: 255, stdout: '', stderr: 'Connection refused' });
  assert.equal(ssh.ok, false);
  if (!ssh.ok) {
    assert.equal(ssh.result.state, 'error');
    assert.match(ssh.result.reason, /Connection refused/);
  }
  const script = classifyStartResult({ code: 1, stdout: '', stderr: 'did not answer within 60s' });
  assert.equal(script.ok, false);
  if (!script.ok) assert.equal(script.result.state, 'error');
});

test('a clean exit carries the server description', () => {
  const r = classifyStartResult({ code: 0, stdout: JSON.stringify(info), stderr: '' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.info.port, 43931);
});

test('the latest session is the most recently updated one', () => {
  const sessions = [
    { id: 'ses_a', time: { created: 1, updated: 5 } },
    { id: 'ses_b', time: { created: 2, updated: 9 } },
    { id: 'ses_c', time: { created: 3, updated: 3 } },
  ];
  assert.equal(pickLatest(sessions)?.id, 'ses_b');
  assert.equal(pickLatest([]), undefined);
});
