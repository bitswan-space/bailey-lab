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
    expect(s.go).toHaveBeenCalledWith('users'); // approvals merged into People & roles
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
  it('renders the live system-resources panel (memory / disk / CPU)', () => {
    const sys = {
      mem_total_bytes: 16 * 1024 ** 3, mem_used_bytes: 8 * 1024 ** 3, mem_free_bytes: 8 * 1024 ** 3, mem_used_pct: 50,
      disk_total_bytes: 100 * 1024 ** 3, disk_used_bytes: 40 * 1024 ** 3, disk_free_bytes: 60 * 1024 ** 3, disk_used_pct: 40, disk_path: '/host',
      cpu_count: 4, cpu_used_pct: 12.5, load1: 0.7,
    };
    render(<Host View={OverviewView} data={makeData({ overview: { ...overview, system: sys } })} />);
    expect(screen.getByText('System resources')).toBeTruthy();
    expect(screen.getByText('Memory')).toBeTruthy();
    expect(screen.getByText('Disk')).toBeTruthy();
    expect(screen.getByText('CPU')).toBeTruthy();
    expect(screen.getByText(/8 GiB free of 16 GiB/)).toBeTruthy();
    expect(screen.getByText(/4 cores · load 0.7/)).toBeTruthy();
  });
  it('shows an honest error when host stats are unavailable', () => {
    render(<Host View={OverviewView} data={makeData({ overview: { ...overview, systemError: 'no /proc' } })} />);
    expect(screen.getByText(/Couldn't read host stats: no \/proc/)).toBeTruthy();
  });
  it('SIEM card: starts disconnected, configures an ingestor, shows connected', async () => {
    const s = spies();
    let saved = null;
    installFetch({
      '/bailey/api/admin/siem': (url, init) => {
        if (init && init.method === 'POST') { saved = JSON.parse(init.body); return { json: { enabled: true, protocol: 'otlp-http', endpoint: saved.endpoint, has_auth_token: true, connected: true, last_event_at: '2026-06-16T10:00:00Z' } }; }
        return { json: { enabled: false, protocol: 'otlp-http', endpoint: '', has_auth_token: false, connected: false } };
      },
    });
    render(<Host View={OverviewView} data={makeData({ overview })} extra={s} />);
    // Starts disconnected with a Configure affordance.
    await waitFor(() => expect(screen.getByText('SIEM forwarding')).toBeTruthy());
    expect(screen.getByText('○ Disconnected')).toBeTruthy();
    fireEvent.click(screen.getByText('Configure ingestor'));
    fireEvent.change(screen.getByPlaceholderText('https://collector.example.com'), { target: { value: 'https://collector.acme.test' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 4318'), { target: { value: '4318' } });
    fireEvent.click(screen.getByText('Save & connect'));
    await waitFor(() => expect(screen.getByText('● Connected')).toBeTruthy());
    expect(saved).toMatchObject({ enabled: true, protocol: 'otlp-http', endpoint: 'https://collector.acme.test', port: 4318 });
    expect(s.toast).toHaveBeenCalledWith(expect.stringContaining('connected'), 'success');
  });

  it('SIEM card: surfaces a connectivity failure without claiming connected', async () => {
    const s = spies();
    installFetch({
      '/bailey/api/admin/siem': (url, init) => (init && init.method === 'POST')
        ? { json: { enabled: true, protocol: 'otlp-http', endpoint: 'http://x', has_auth_token: false, connected: false, last_error: 'connection refused' } }
        : { json: { enabled: false, protocol: 'otlp-http', endpoint: '', has_auth_token: false, connected: false } },
    });
    render(<Host View={OverviewView} data={makeData({ overview })} extra={s} />);
    await waitFor(() => expect(screen.getByText('Configure ingestor')).toBeTruthy());
    fireEvent.click(screen.getByText('Configure ingestor'));
    fireEvent.change(screen.getByPlaceholderText('https://collector.example.com'), { target: { value: 'http://x' } });
    fireEvent.click(screen.getByText('Save & connect'));
    await waitFor(() => expect(screen.getByText(/connection refused/)).toBeTruthy());
  });

  it('region is editable: save persists via the API and refreshes', async () => {
    const s = spies();
    installFetch({ '/bailey/api/admin/region': { json: { ok: true, region: 'us-east' } } });
    render(<Host View={OverviewView} data={makeData({ overview })} extra={s} />);
    fireEvent.click(screen.getByTitle('Set region'));      // 'eu' → edit mode
    fireEvent.change(screen.getByPlaceholderText('e.g. eu-west'), { target: { value: 'us-east' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(s.toast).toHaveBeenCalledWith(expect.stringContaining('Region set to us-east'), 'success'));
    expect(s.refresh).toHaveBeenCalledWith('overview');
  });
});

describe('WorkspacesView', () => {
  function liveWs(over = {}) {
    return {
      id: 'demo', name: 'demo', owner: 'tomas@harmonum.ai', members: [], processes: 0, automations: 0,
      created: '', activity: '', status: 'active', dashboard: '#', editorUrl: 'http://e', gitopsUrl: 'http://g',
      // True dashboard ownership drives the manage controls (matches the
      // owner-only share API). ownerEmail is shown to every member.
      isOwner: true, dashboardRole: 'owner', ownerEmail: 'me@example.test',
      isTrashed: false, apps: [], live: true, ...over,
    };
  }

  it('Open launches the workspace dashboard, not gitops', () => {
    const s = spies();
    const data = makeData({ workspaces: [liveWs({ dashboard: 'http://dash', gitopsUrl: 'http://g' })] });
    render(<Host View={WorkspacesView} data={data} extra={s} />);
    fireEvent.click(screen.getByText('Open'));
    expect(s.openUrl).toHaveBeenCalledWith('http://dash', expect.anything());
  });

  it('renders a live workspace list, opens it, opens the manage drawer (owner: real members)', async () => {
    const s = spies();
    installFetch({ '/2fa-gate/api/share/dash.example.test': { json: { owner_email: 'me@example.test', grants: [{ principal_type: 'email', principal_value: 'bob@x', role: 'access' }] } } });
    const data = makeData({ workspaces: [liveWs({ dashboard: 'https://dash.example.test/' })] });
    render(<Host View={WorkspacesView} data={data} extra={s} />);
    expect(screen.getByText('Workspaces')).toBeTruthy();
    fireEvent.click(screen.getByText('Open'));
    expect(s.openUrl).toHaveBeenCalled();
    fireEvent.click(screen.getByTitle('Manage workspace'));
    // Wireframe drawer: Ownership + Members (real, from the share API).
    expect(screen.getByText('Ownership')).toBeTruthy();
    expect(screen.getByText('Members')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('me@example.test')).toBeTruthy()); // owner
    await waitFor(() => expect(screen.getByText('bob@x')).toBeTruthy());           // member
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

  it('manage drawer (owner): add then remove a member via the share API', async () => {
    const s = spies();
    installFetch({
      '/2fa-gate/api/share/dash.example.test': (url, init) => (init && init.method === 'POST')
        ? { json: { owner_email: 'me@example.test', grants: [{ principal_type: 'email', principal_value: 'new@x', role: 'access' }] } }
        : { json: { owner_email: 'me@example.test', grants: [] } },
    });
    render(<Host View={WorkspacesView} data={makeData({ workspaces: [liveWs({ dashboard: 'https://dash.example.test/' })] })} extra={s} />);
    fireEvent.click(screen.getByTitle('Manage workspace'));
    await waitFor(() => expect(screen.getByText(/No members yet/)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('person@example.com'), { target: { value: 'new@x' } });
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() => expect(s.toast).toHaveBeenCalledWith(expect.stringContaining('added'), 'success'));
    await waitFor(() => expect(screen.getByText('new@x')).toBeTruthy());
  });

  it('manage drawer (non-owner): sees owner + members read-only, no add box', () => {
    const s = spies();
    render(<Host View={WorkspacesView} data={makeData({ workspaces: [liveWs({
      isOwner: false, dashboardRole: 'access', ownerEmail: 'owner@x',
      members: ['owner@x', 'mate@x'], dashboard: 'https://dash.example.test/',
    })] })} extra={s} />);
    fireEvent.click(screen.getByTitle('Manage workspace'));
    // Members can SEE who owns it and who's in it…
    expect(screen.getByText("You're a member of this workspace")).toBeTruthy();
    expect(screen.getByText('Ownership')).toBeTruthy();
    expect(screen.getByText('owner@x')).toBeTruthy();        // the owner
    expect(screen.getByText('mate@x')).toBeTruthy();         // a fellow member
    expect(screen.getByText(/Only its owner can add or remove/)).toBeTruthy();
    // …but get no controls to change membership.
    expect(screen.queryByPlaceholderText('person@example.com')).toBeNull();
    expect(screen.queryByText('Add')).toBeNull();
  });

  it('workspace card shows member avatars (initials from emails)', () => {
    render(<Host View={WorkspacesView} data={makeData({ workspaces: [liveWs({ members: ['jane@x', 'bob@y'] })] })} />);
    expect(screen.getByText('JX')).toBeTruthy(); // jane@x → JX
    expect(screen.getByText('BY')).toBeTruthy(); // bob@y  → BY
  });

  it('shows "Apps you can access" from accessible frontends (links, services excluded)', async () => {
    const s = spies();
    installFetch({ '/bailey/api/endpoints': { json: { endpoints: [
      { hostname: 'shiny-app.d', display_name: 'Shiny App', kind: 'frontend', stage: 'production', caller_role: 'access' },
      { hostname: 'svc.d', display_name: 'gitops', kind: 'service', stage: '', caller_role: 'access' },
    ] } } });
    render(<Host View={WorkspacesView} data={makeData()} extra={s} />);
    await waitFor(() => expect(screen.getByText('Apps you can access')).toBeTruthy());
    expect(screen.getByText('Shiny App')).toBeTruthy();
    expect(screen.queryByText('gitops')).toBeNull(); // services aren't listed as apps
    fireEvent.click(screen.getByText('Shiny App'));
    expect(s.openUrl).toHaveBeenCalled();
  });
});
