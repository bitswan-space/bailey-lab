// views-updates.test.jsx — the admin Updates view: no CLI hints (issue #254),
// the update audit log (who / which versions / when), and rollback wiring.
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SC_UPDATES, installFetch } from './harness.js';
import { makeData, Host, spies } from './ctx.js';

const { UpdatesView } = SC_UPDATES;

function withUpdates(over = {}) {
  return makeData({
    updates: {
      server: { current: 'v2026.07.31.57', latest: '', update_available: false },
      workspaces: [],
      rollback_depth: 3,
      history: [
        { id: 7, ts: '2026-07-31T10:00:00Z', actor: 'admin@x', target_kind: 'server', target_name: '',
          from_version: 'v2026.07.30.10', to_version: 'v2026.07.31.57', is_rollback: false },
        { id: 5, ts: '2026-07-30T09:00:00Z', actor: 'tim@x', target_kind: 'workspace', target_name: 'wraptest',
          from_version: 'g1', to_version: 'g2', is_rollback: false },
      ],
      ...over,
    },
  });
}

describe('UpdatesView', () => {
  it('does not document CLI commands in the UI (issue #254)', () => {
    render(<Host View={UpdatesView} data={withUpdates()} />);
    expect(screen.queryByText(/bitswan rollback/)).toBeNull();
    expect(screen.queryByText(/self-update --rollback/)).toBeNull();
    expect(screen.queryByText(/from the host/)).toBeNull();
  });

  it('renders the update audit log — who, which versions, and when', () => {
    render(<Host View={UpdatesView} data={withUpdates()} />);
    expect(screen.getByText('Update history')).toBeTruthy();
    // "Automation server" appears in both the server card and its history row.
    expect(screen.getAllByText('Automation server').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('wraptest')).toBeTruthy();          // the workspace row
    expect(screen.getByText(/admin@x updated/)).toBeTruthy();   // who
    expect(screen.getByText(/g1 → g2/)).toBeTruthy();           // which versions
  });

  it('empty history shows an honest empty state', () => {
    render(<Host View={UpdatesView} data={withUpdates({ history: [] })} />);
    expect(screen.getByText('No updates recorded yet.')).toBeTruthy();
  });

  it('rolls a workspace back to a retained version via its history row', async () => {
    const s = spies();
    let hit = null;
    installFetch({ '/bailey/api/workspaces/wraptest/rollback': (url, init) => {
      hit = { url, body: init.body };
      return { ndjson: [{ event: 'done', fraction: 1, message: 'ok' }] };
    } });
    render(<Host View={UpdatesView} data={withUpdates()} extra={s} />);
    fireEvent.click(screen.getByTitle('Roll back to g1'));
    await waitFor(() => expect(hit).not.toBeNull());
    expect(hit.url).toContain('/bailey/api/workspaces/wraptest/rollback');
    expect(JSON.parse(hit.body).id).toBe(5);
    await waitFor(() => expect(s.toast).toHaveBeenCalledWith(expect.stringContaining('rolled back to g1'), 'success'));
    expect(s.refresh).toHaveBeenCalledWith('updates');
  });
});
