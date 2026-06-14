// views-workspaces.test.jsx — OverviewView + WorkspacesView (+ create modal,
// manage drawer, empty-trash). Covers loaded/loading/error states, search,
// create (success + invalid + error), trash/restore/update, member edits.
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

  it('renders list, opens a workspace, opens manage drawer', () => {
    const s = spies();
    render(<Host View={WorkspacesView} data={makeData()} extra={s} />);
    expect(screen.getByText('Workspaces')).toBeTruthy();
    // seed workspaces have apps + Open buttons
    fireEvent.click(screen.getAllByText('Open')[0]);
    expect(s.openUrl).toHaveBeenCalled();
    fireEvent.click(screen.getAllByTitle('Manage workspace')[0]);
    expect(screen.getByText('Ownership')).toBeTruthy();
  });

  it('search filters the list (>3 workspaces)', () => {
    render(<Host View={WorkspacesView} data={makeData()} />);
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
    fireEvent.click(screen.getByText('New workspace'));
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
    fireEvent.click(screen.getByText('New workspace'));
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

  it('manage drawer (seed): archive, add/remove member, transfer ownership', () => {
    const s = spies();
    render(<Host View={WorkspacesView} data={makeData()} extra={s} />);
    // HR Platform is the first seed card
    fireEvent.click(screen.getAllByTitle('Manage workspace')[0]);
    // archive (seed path)
    fireEvent.click(screen.getByText('Archive'));
    expect(s.toast).toHaveBeenCalledWith('Workspace archived', 'info');
    // reopen drawer (status changed → re-render); transfer ownership
    fireEvent.click(screen.getByText('Transfer ownership'));
    fireEvent.click(screen.getByText('Transfer'));
    expect(s.toast).toHaveBeenCalledWith(expect.stringContaining('Ownership transferred'), 'success');
  });

  it('manage drawer (seed): remove a member + add a member + cancel transfer', () => {
    const s = spies();
    render(<Host View={WorkspacesView} data={makeData()} extra={s} />);
    fireEvent.click(screen.getAllByTitle('Manage workspace')[0]);
    const removeBtns = screen.getAllByTitle('Remove from workspace');
    fireEvent.click(removeBtns[0]);
    const addBtns = screen.getAllByText('Add');
    fireEvent.click(addBtns[0]);
    fireEvent.click(screen.getByText('Transfer ownership'));
    fireEvent.click(screen.getByText('Cancel'));
  });
});
