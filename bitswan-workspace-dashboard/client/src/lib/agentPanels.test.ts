import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_LIVE_AGENT_PANELS,
  agentScopeKey,
  rememberAgentPanel,
  sameAgentScope,
  type AgentPanelEntry,
} from './agentPanels.ts';

const scope = (copy: string, bp: string) => ({ copy, bp });
const keys = (live: AgentPanelEntry[]) => live.map((e) => agentScopeKey(e.scope));

/**
 * The bug this file exists for: the agent panel was remounted per (copy, BP),
 * so switching business processes reloaded the Claude Code webview — and a
 * reloaded webview makes the extension sweep its live channels, killing the
 * run that had been going on in the background. Panels now outlive the switch.
 */
test('a panel already mounted is not re-created when it is shown again', () => {
  const first = rememberAgentPanel([], scope('mine', 'orders'), 1);
  const again = rememberAgentPanel(first, scope('mine', 'orders'), 2);
  assert.deepEqual(keys(again), ['mine orders']);
  assert.equal(again[0]?.shownAt, 2);
});

test('showing the same panel at the same tick changes nothing at all', () => {
  const live = rememberAgentPanel([], scope('mine', 'orders'), 1);
  assert.equal(rememberAgentPanel(live, scope('mine', 'orders'), 1), live);
});

test('switching back and forth keeps both panels mounted', () => {
  let live = rememberAgentPanel([], scope('mine', 'orders'), 1);
  live = rememberAgentPanel(live, scope('mine', 'invoices'), 2);
  live = rememberAgentPanel(live, scope('mine', 'orders'), 3);
  assert.deepEqual(keys(live), ['mine orders', 'mine invoices']);
});

/**
 * Order is load-bearing: React moves DOM nodes to reorder children, and moving
 * an iframe reloads it — which would reintroduce the reload this avoids.
 */
test('mounted panels never change position in the list', () => {
  let live = rememberAgentPanel([], scope('mine', 'a'), 1);
  live = rememberAgentPanel(live, scope('mine', 'b'), 2);
  live = rememberAgentPanel(live, scope('mine', 'c'), 3);
  const before = keys(live);
  live = rememberAgentPanel(live, scope('mine', 'a'), 4);
  live = rememberAgentPanel(live, scope('mine', 'b'), 5);
  assert.deepEqual(keys(live), before);
});

test('the same BP in two copies is two panels — each has its own agent', () => {
  let live = rememberAgentPanel([], scope('mine', 'orders'), 1);
  live = rememberAgentPanel(live, scope('theirs', 'orders'), 2);
  assert.deepEqual(keys(live), ['mine orders', 'theirs orders']);
  assert.equal(sameAgentScope(scope('mine', 'orders'), scope('theirs', 'orders')), false);
});

test('past the cap the least recently shown panel is the one dropped', () => {
  let live: AgentPanelEntry[] = [];
  live = rememberAgentPanel(live, scope('mine', 'a'), 1, 3);
  live = rememberAgentPanel(live, scope('mine', 'b'), 2, 3);
  live = rememberAgentPanel(live, scope('mine', 'c'), 3, 3);
  // 'a' is the oldest by insertion, but showing it again makes 'b' the stalest.
  live = rememberAgentPanel(live, scope('mine', 'a'), 4, 3);
  live = rememberAgentPanel(live, scope('mine', 'd'), 5, 3);
  assert.deepEqual(keys(live), ['mine a', 'mine c', 'mine d']);
});

test('eviction leaves the survivors where they were', () => {
  let live: AgentPanelEntry[] = [];
  live = rememberAgentPanel(live, scope('mine', 'a'), 1, 2);
  live = rememberAgentPanel(live, scope('mine', 'b'), 2, 2);
  live = rememberAgentPanel(live, scope('mine', 'c'), 3, 2);
  assert.deepEqual(keys(live), ['mine b', 'mine c']);
});

test('the panel just shown is never the one evicted', () => {
  let live: AgentPanelEntry[] = [];
  for (let i = 0; i < MAX_LIVE_AGENT_PANELS + 3; i++) {
    live = rememberAgentPanel(live, scope('mine', `bp${i}`), i + 1);
    assert.equal(live.length <= MAX_LIVE_AGENT_PANELS, true);
    assert.equal(agentScopeKey(live[live.length - 1]?.scope ?? scope('', '')), `mine bp${i}`);
  }
});

test('a cap of zero still keeps the panel being shown', () => {
  const live = rememberAgentPanel([], scope('mine', 'orders'), 1, 0);
  assert.deepEqual(keys(live), ['mine orders']);
});
