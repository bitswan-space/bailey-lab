// views-workspaces.test.jsx — OverviewView + WorkspacesView (+ create modal,
// manage drawer, empty-trash). Covers loaded/loading/error states, search,
// create (success + invalid + error), trash/restore/update. Every workspace is
// live (from /bailey/api/workspaces) — there is no seed/member-edit UI.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { SC_WORKSPACES, installFetch } from './harness.js';
import { makeData, Host, spies } from './ctx.js';

const { OverviewView, WorkspacesView } = SC_WORKSPACES;

const overview = {
  counts: { workspaces: 5, people: 6, trustedDevices: 3, pendingApprovals: 2 },
  identity: { claimedBy: 'tomas@harmonum.ai', claimedAt: 'Mar 02', version: 'Bailey 2.7', online: true, region: 'eu', uptime: '71d' },
  activity: [{ icon: 'flag', tone: 'primary', who: 'tomas@h', text: 'claimed this server', when: '6h ago' }],
};

describe('OverviewView', () => {
  it('renders loaded counts, identity, activity, and stat navigation', () => {
    const s = spies();
    render(<Host View={OverviewView} data={makeData({ overview })} extra={s} />);
    expect(screen.getByText('Server overview')).toBeTruthy();
    expect(screen.getByText('claimed this server')).toBeTruthy();
    // pending banner + review approvals
    fireEvent.click(screen.getByText('Review approvals'));
    fireEvent.click(screen.getByText('Workspaces'));
    fireEvent.click(screen.getByText('People'));
    fireEvent.click(screen.getByText('Devices'));
    fireEvent.click(screen.getByText('Pending'));
    expect(s.go).toHaveBeenCalledWith('approvals');
    expect(s.go).toHaveBeenCalledWith('workspaces');
  });
  it('shows the loading/error banner and retries', () => {
    const s = spies();
    render(<Host View={OverviewView} data={makeData({ overview: null, load: { ...makeData().load, overview: 'error' }, error: { overview: 'boom' } })} extra={s} />);
    fireEvent.click(screen.getByText('Retry'));
    expect(s.refresh).toHaveBeenCalledWith('overview');
  });
  it('renders empty activity state', () => {
    render(<Host View={OverviewView} data={makeData({ overview: { ...overview, activity: [], counts: { ...overview.counts, pendingApprovals: 0 } } })} />);
    expect(screen.getByText('No activity yet')).toBeTruthy();
    expect(screen.getByText('All clear')).toBeTruthy();
  });
});

describe('WorkspacesView', () => {
  function liveWs(over = {}) {
    return {
      id: 'demo', name: 'demo', owner: 'tomas@harmonum.ai', members: [], processes: 0, automations: 0,
      created: '', activity: '', status: 'active', dashboard: '#', editorUrl: 'http://e', gitopsUrl: 'http://g',
      isOwner: true, isTrashed: false, apps: [], live: true, ...over,
    };
  }

  it('renders a live workspace list, opens it, opens the manage drawer', () => {
    const s = spies();
    const data = makeData({ workspaces: [liveWs()] });
    render(<Host View={WorkspacesView} data={data} extra={s} />);
    expect(screen.getByText('Workspaces')).toBeTruthy();
    fireEvent.click(screen.getByText('Open'));
    expect(s.openUrl).toHaveBeenCalled();
    fireEvent.click(screen.getByTitle('Manage workspace'));
    // No seed Ownership/Members UI — the drawer shows open links + share note.
    expect(screen.getByText('You own this workspace')).toBeTruthy();
    expect(screen.queryByText('Ownership')).toBeNull();
    expect(screen.queryByText('Transfer ownership')).toBeNull();
  });

  it('empty workspace list shows the empty state', () => {
    render(<Host View={WorkspacesView} data={makeData()} />);
    expect(screen.getByText(/not in any workspace yet/)).toBeTruthy();
  });

  it('search filters the list (>3 workspaces)', () => {
    const many = ['a', 'b', 'c', 'd'].map((n) => liveWs({ id: n, name: n }));
    render(<Host View={WorkspacesView} data={makeData({ workspaces: many })} />);
    const search = screen.getByPlaceholderText('Search workspaces & apps…');
    fireEvent.change(search, { target: { value: 'zzzznomatch' } });
    expect(screen.getByText('No workspaces match')).toBeTruthy();
  });

  it('recovery warning links to security', () => {
    const s = spies();
    render(<Host View={WorkspacesView} data={makeData()} extra={s} />);
    fireEvent.click(screen.getByText('Set up recovery'));
    expect(s.go).toHaveBeenCalledWith('security');
  });

  it('empty-trash flow streams and refreshes', async () => {
    const s = spies();
    installFetch({ '/bailey/api/workspaces/empty-trash': { ndjson: [{ event: 'done' }] } });
    // one trashed live workspace so the Empty trash button shows
    const data = makeData({ workspaces: [liveWs({ status: 'archived', isTrashed: true })] });
    render(<Host View={WorkspacesView} data={data} extra={s} />);
    fireEvent.click(screen.getByText(/Empty trash/));
    fireEvent.click(screen.getByText('Permanently delete'));
    await waitFor(() => expect(s.toast).toHaveBeenCalledWith('Trash emptied', 'success'));
  });

  it('create workspace: invalid name disables, valid name streams + closes', async () => {
    const s = spies();
    installFetch({ '/bailey/api/workspaces': { ndjson: [{ event: 'start', message: 'go' }, { event: 'log', message: 'step' }, { event: 'done' }] } });
    render(<Host View={WorkspacesView} data={makeData()} extra={s} />);
    fireEvent.click(screen.getAllByText('New workspace')[0]);
    const name = screen.getByPlaceholderText('e.g. payroll-automation');
    fireEvent.change(name, { target: { value: 'Bad Name!' } });
    expect(screen.getByText(/doesn't match the allowed format/)).toBeTruthy();
    fireEvent.change(name, { target: { value: 'payroll' } });
    fireEvent.click(screen.getByText('Create workspace'));
    await waitFor(() => expect(s.toast).toHaveBeenCalledWith(expect.stringContaining('created'), 'success'));
  });

  it('create workspace surfaces a backend error', async () => {
    installFetch({ '/bailey/api/workspaces': { status: 500, json: { error: 'create failed' } } });
    render(<Host View={WorkspacesView} data={makeData()} />);
    fireEvent.click(screen.getAllByText('New workspace')[0]);
    fireEvent.change(screen.getByPlaceholderText('e.g. payroll-automation'), { target: { value: 'payroll' } });
    fireEvent.click(screen.getByText('Create workspace'));
    await waitFor(() => expect(screen.getByText('create failed')).toBeTruthy());
  });

  it('manage drawer (live owner): update + trash', async () => {
    const s = spies();
    installFetch({
      '/bailey/api/workspaces/demo/update': { ndjson: [{ event: 'done' }] },
      '/bailey/api/workspaces/demo/trash': { json: {} },
    });
    render(<Host View={WorkspacesView} data={makeData({ workspaces: [liveWs()] })} extra={s} />);
    fireEvent.click(screen.getByTitle('Manage workspace'));
    fireEvent.click(screen.getByText('Update'));
    await waitFor(() => expect(s.toast).toHaveBeenCalledWith('Workspace containers updated', 'success'));
    fireEvent.click(screen.getByText('Trash'));
    await waitFor(() => expect(s.toast).toHaveBeenCalledWith('Workspace trashed', 'info'));
  });

  it('manage drawer (live trashed): restore', async () => {
    const s = spies();
    installFetch({ '/bailey/api/workspaces/demo/restore': { json: {} } });
    render(<Host View={WorkspacesView} data={makeData({ workspaces: [liveWs({ status: 'archived', isTrashed: true })] })} extra={s} />);
    fireEvent.click(screen.getByTitle('Manage workspace'));
    fireEvent.click(screen.getByText('Restore'));
    await waitFor(() => expect(s.toast).toHaveBeenCalledWith('Workspace restored', 'success'));
  });

  it('manage drawer (live): open editor + gitops', () => {
    const s = spies();
    render(<Host View={WorkspacesView} data={makeData({ workspaces: [liveWs()] })} extra={s} />);
    fireEvent.click(screen.getByTitle('Manage workspace'));
    fireEvent.click(screen.getByText('Open editor'));
    fireEvent.click(screen.getByText('Open gitops'));
    expect(s.openUrl).toHaveBeenCalledTimes(2);
  });

  it('manage drawer (live non-owner): trash/restore disabled, update hidden', () => {
    const s = spies();
    render(<Host View={WorkspacesView} data={makeData({ workspaces: [liveWs({ isOwner: false })] })} extra={s} />);
    fireEvent.click(screen.getByTitle('Manage workspace'));
    expect(screen.getByText('Shared with you')).toBeTruthy();
    expect(screen.queryByText('Update')).toBeNull();
    const trashBtn = screen.getByText('Trash').closest('button');
    expect(trashBtn.disabled).toBe(true);
  });
});
