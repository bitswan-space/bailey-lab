import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentSshTarget } from './coding-agent.js';

/**
 * The SSH target must default to the gitops agent-ssh proxy: the agent
 * container sits on the isolated `<ws>-agent` network the dashboard is
 * deliberately not part of, so pointing at `<ws>-coding-agent:22` directly
 * (the pre-isolation behaviour) yields exactly the "could not be reached"
 * regression this guards against.
 */

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('defaults to the gitops proxy on :2222', () => {
  withEnv(
    { CODING_AGENT_HOST: undefined, CODING_AGENT_SSH_PORT: undefined, BITSWAN_WORKSPACE_NAME: 'foo' },
    () => {
      assert.deepEqual(agentSshTarget(), { host: 'foo-gitops', port: 2222 });
    },
  );
});

test('CODING_AGENT_HOST overrides to a direct connection on :22', () => {
  withEnv(
    { CODING_AGENT_HOST: 'localhost', CODING_AGENT_SSH_PORT: undefined, BITSWAN_WORKSPACE_NAME: 'foo' },
    () => {
      assert.deepEqual(agentSshTarget(), { host: 'localhost', port: 22 });
    },
  );
});

test('CODING_AGENT_SSH_PORT refines the override port', () => {
  withEnv(
    { CODING_AGENT_HOST: 'localhost', CODING_AGENT_SSH_PORT: '2202', BITSWAN_WORKSPACE_NAME: 'foo' },
    () => {
      assert.deepEqual(agentSshTarget(), { host: 'localhost', port: 2202 });
    },
  );
});
