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
          from_version: 'v2026.07.30.10', to_version: 'v2026.07.31.57', is_rollback: false, can_rollback: true },
        { id: 5, ts: '2026-07-30T09:00:00Z', actor: 'tim@x', target_kind: 'workspace', target_name: 'wraptest',
          from_version: 'g1', to_version: 'g2', is_rollback: false, can_rollback: true },
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

  // Issue #347: the running binary reports "2026.08.03.68" and the AOC the tag
  // "v2026.08.05.70". The server row must offer the update (not an "Up to date"
  // pill beside a current → latest line) and render one version style.
  it('offers the server update when the versions differ only by the "v" prefix style', () => {
    render(<Host View={UpdatesView} data={withUpdates({
      server: { current: '2026.08.03.68', latest: 'v2026.08.05.70', update_available: true },
    })} />);
    expect(screen.getByRole('button', { name: /Update available/ })).toBeTruthy();
    expect(screen.queryByText('Up to date')).toBeNull();
    expect(screen.getByText(/v2026\.08\.03\.68\s+→\s+v2026\.08\.05\.70/)).toBeTruthy();
  });

  it('rolls a workspace back to a retained version via its history row', async () => {
    const s = spies();
    let hit = null;
    installFetch({ '/bailey/api/workspaces/wraptest/rollback': (url, init) => {
      hit = { url, body: init.body };
      return { ndjson: [{ event: 'done', fraction: 1, message: 'ok' }] };
    } });
    render(<Host View={UpdatesView} data={withUpdates()} extra={s} />);
    // The row button only opens a confirm dialog — it does NOT roll back yet.
    fireEvent.click(screen.getByTitle('Roll back to g1'));
    expect(screen.getByText(/Roll wraptest back to g1\?/)).toBeTruthy();
    expect(hit).toBeNull();
    // Confirming fires the rollback.
    fireEvent.click(screen.getByRole('button', { name: 'Roll back' }));
    await waitFor(() => expect(hit).not.toBeNull());
    expect(hit.url).toContain('/bailey/api/workspaces/wraptest/rollback');
    expect(JSON.parse(hit.body).id).toBe(5);
    await waitFor(() => expect(s.toast).toHaveBeenCalledWith(expect.stringContaining('rolled back to g1'), 'success'));
    expect(s.refresh).toHaveBeenCalledWith('updates');
  });

  // Issue #367: the upgrade/rollback endpoints are owner-gated, so an admin who
  // doesn't own the workspace used to get a button that only ever 403'd with
  // "only the workspace owner can update it".
  describe('owner gating (issue #367)', () => {
    const stale = (over) => ({
      name: 'notmine', versions: { gitops: 'g1', latest_gitops: 'g2' }, ...over,
    });

    it('offers Update on a workspace the caller can update', () => {
      render(<Host View={UpdatesView} data={withUpdates({
        workspaces: [stale({ can_update: true, owner: 'me@x' })],
      })} />);
      expect(screen.getByRole('button', { name: /Update/ })).toBeTruthy();
    });

    it('replaces the Update button with the owner to ask when the caller cannot update', () => {
      render(<Host View={UpdatesView} data={withUpdates({
        workspaces: [stale({ can_update: false, owner: 'tim@x' })],
      })} />);
      expect(screen.queryByRole('button', { name: /Update/ })).toBeNull();
      expect(screen.getByText('Only tim@x can update this')).toBeTruthy();
      // The row itself still reports what's behind.
      expect(screen.getByText('notmine')).toBeTruthy();
      expect(screen.getByText(/gitops g1 → g2/)).toBeTruthy();
    });

    it('falls back to a generic owner note when no owner is recorded', () => {
      render(<Host View={UpdatesView} data={withUpdates({
        workspaces: [stale({ can_update: false })],
      })} />);
      expect(screen.getByText('Only the workspace owner can update this')).toBeTruthy();
    });

    it('hides the rollback control on history rows the caller cannot roll back', () => {
      render(<Host View={UpdatesView} data={withUpdates({
        history: [{ id: 5, ts: '2026-07-30T09:00:00Z', actor: 'tim@x', target_kind: 'workspace',
          target_name: 'wraptest', from_version: 'g1', to_version: 'g2', is_rollback: false, can_rollback: false }],
      })} />);
      expect(screen.queryByTitle('Roll back to g1')).toBeNull();
      // The audit trail is still readable — only the action is withheld.
      expect(screen.getByText('wraptest')).toBeTruthy();
      expect(screen.getByText(/tim@x updated/)).toBeTruthy();
    });
  });

  it('cancelling the confirm dialog does not roll back', async () => {
    const s = spies();
    let hit = null;
    installFetch({ '/bailey/api/workspaces/wraptest/rollback': () => { hit = true; return { ndjson: [{ event: 'done' }] }; } });
    render(<Host View={UpdatesView} data={withUpdates()} extra={s} />);
    fireEvent.click(screen.getByTitle('Roll back to g1'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    // Dialog dismissed; no request made.
    expect(screen.queryByText(/Roll wraptest back to g1\?/)).toBeNull();
    expect(hit).toBeNull();
  });
});
