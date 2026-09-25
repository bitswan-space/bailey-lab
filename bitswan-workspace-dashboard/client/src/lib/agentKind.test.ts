import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agentChoiceFromPreference,
  getAgentChoice,
  isAgentKind,
  setAgentChoice,
  subscribeAgentChoice,
} from './agentKind.ts';

test('the server’s preference becomes a choice only when it names a known agent', () => {
  assert.deepEqual(agentChoiceFromPreference('opencode'), { state: 'chosen', kind: 'opencode' });
  assert.deepEqual(agentChoiceFromPreference('claude-code'), { state: 'chosen', kind: 'claude-code' });
  assert.deepEqual(agentChoiceFromPreference(undefined), { state: 'unchosen' });
  assert.deepEqual(agentChoiceFromPreference('vim'), { state: 'unchosen' });
  assert.equal(isAgentKind('OpenCode'), false);
});

test('subscribers hear a change, and only a change', () => {
  let heard = 0;
  const off = subscribeAgentChoice(() => {
    heard += 1;
  });
  setAgentChoice({ state: 'chosen', kind: 'opencode' });
  setAgentChoice({ state: 'chosen', kind: 'opencode' });
  assert.equal(heard, 1);
  assert.deepEqual(getAgentChoice(), { state: 'chosen', kind: 'opencode' });
  setAgentChoice({ state: 'chosen', kind: 'claude-code' });
  assert.equal(heard, 2);
  off();
  setAgentChoice({ state: 'unchosen' });
  assert.equal(heard, 2);
  assert.deepEqual(getAgentChoice(), { state: 'unchosen' });
});

test('the snapshot keeps its identity until something changes', () => {
  setAgentChoice({ state: 'unchosen' });
  const a = getAgentChoice();
  setAgentChoice({ state: 'unchosen' });
  assert.equal(getAgentChoice(), a);
});
