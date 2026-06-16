// views-people.test.jsx — UsersView + ApprovalsView (+ UserDevicesDrawer).
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SC_PEOPLE, installFetch } from './harness.js';
import { makeData, Host, spies } from './ctx.js';

const { UsersView, ApprovalsView, EndpointAccessView } = SC_PEOPLE;

const people = [
  { id: 'tomas@h', name: 'Tomas', email: 'tomas@h', role: 'admin', workspaceCount: 2, deviceCount: 3, lastActive: 'now', invited: false },
  { id: 'alex@h', name: 'Alex', email: 'alex@h', role: 'member', workspaceCount: 0, deviceCount: 0, lastActive: '', invited: true },
];

describe('UsersView', () => {
  it('renders the roster, opens the devices drawer with REAL devices, and revokes one', async () => {
    const s = spies();
    installFetch({
      '/bailey/api/admin/devices': { json: { users: [{ email: 'tomas@h', devices: [
        { id: 'dev1', name: 'Tomas Laptop', paired_at: '2026-01-01', last_seen: 'now', is_current: true, origin: 'root' },
        { id: 'dev2', name: 'Tomas Phone', paired_at: '2026-01-02', last_seen: 'yesterday', is_current: false, origin: 'linked' },
      ] }] } },
      '/bailey/api/admin/devices/remove': { json: { ok: true } },
    });
    render(<Host View={UsersView} data={makeData({ people })} extra={s} />);
    expect(screen.getByText('People & roles')).toBeTruthy();
    expect(screen.getByText('Invited')).toBeTruthy();
    // No invite button.
    expect(screen.queryByText('Invite person')).toBeNull();
    // Open the drawer; it loads the person's REAL devices (no seed).
    fireEvent.click(screen.getByTitle('Manage devices'));
    expect(screen.getByText("Tomas's devices")).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Tomas Laptop')).toBeTruthy());
    expect(screen.getByText('Tomas Phone')).toBeTruthy();
    // Revoke a device → admin remove endpoint + toast.
    fireEvent.click(screen.getAllByText('Sign out')[0]);
    await waitFor(() => expect(s.toast).toHaveBeenCalledWith(expect.stringContaining('Signed out'), 'danger'));
  });

  it('search filters to empty state', () => {
    render(<Host View={UsersView} data={makeData({ people })} />);
    fireEvent.change(screen.getByPlaceholderText('Search people…'), { target: { value: 'zzz' } });
    expect(screen.getByText('No people match')).toBeTruthy();
  });

  it('empty roster shows no-people state', () => {
    render(<Host View={UsersView} data={makeData({ people: [] })} />);
    expect(screen.getByText('No people yet')).toBeTruthy();
  });

  it('loading/error banner retries', () => {
    const s = spies();
    render(<Host View={UsersView} data={makeData({ people: null, load: { ...makeData().load, people: 'error' }, error: { people: 'x' } })} extra={s} />);
    fireEvent.click(screen.getByText('Retry'));
    expect(s.refresh).toHaveBeenCalledWith('people');
  });

  it('partial-enumeration warning renders above the roster', () => {
    render(<Host View={UsersView} data={makeData({ people, peopleWarning: 'kc down' })} />);
    expect(screen.getByText(/kc down/)).toBeTruthy();
  });

  it('role is a dropdown; changing it explains it is not wired yet (no fake change)', () => {
    const s = spies();
    render(<Host View={UsersView} data={makeData({ people })} extra={s} />);
    // A real <select> of roles (Admin/Auditor/Member/User), not a static pill.
    const roleSelect = screen.getAllByRole('combobox')[0];
    expect(roleSelect).toBeTruthy();
    fireEvent.change(roleSelect, { target: { value: 'auditor' } });
    expect(s.toast).toHaveBeenCalledWith(expect.stringContaining("isn't available yet"), 'info');
  });
});

describe('ApprovalsView', () => {
  function withPending() {
    return makeData({
      pending: [
        { id: 'alex@h', userName: 'Alex Mraz', userEmail: 'alex@h', firstDevice: true, kind: 'laptop', requested: '4m ago', oauth: 'Keycloak SSO', code: '' },
        { id: 'martin@h', userName: 'Martin Kral', userEmail: 'martin@h', firstDevice: false, kind: 'phone', requested: '22m ago', oauth: 'Keycloak SSO', code: '' },
      ],
    });
  }

  it('renders the queue and selects between pending devices', () => {
    render(<Host View={ApprovalsView} data={withPending()} />);
    expect(screen.getByText('New user approvals')).toBeTruthy();
    fireEvent.click(screen.getByText('Martin Kral'));
    expect(screen.getAllByText(/Martin Kral/).length).toBeGreaterThan(0);
  });

  it('shows empty state when nothing pending', () => {
    render(<Host View={ApprovalsView} data={makeData({ pending: [] })} />);
    expect(screen.getByText('Nothing pending')).toBeTruthy();
    expect(screen.getByText('No device selected')).toBeTruthy();
  });

  it('approve success refreshes approvals + devices', async () => {
    const s = spies();
    installFetch({ '/2fa-gate/approve': { status: 200, text: 'ok' } });
    render(<Host View={ApprovalsView} data={withPending()} extra={s} />);
    const codeInput = document.querySelector('input');
    fireEvent.change(codeInput, { target: { value: '123456' } });
    fireEvent.click(screen.getByText('Trust this device'));
    await waitFor(() => expect(s.toast).toHaveBeenCalledWith(expect.stringContaining('Device trusted'), 'success'));
    expect(s.refresh).toHaveBeenCalledWith('approvals');
    expect(s.refresh).toHaveBeenCalledWith('devices');
  });

  it('approve 401 shows mismatch message', async () => {
    installFetch({ '/2fa-gate/approve': { status: 401, text: 'unauthorized' } });
    render(<Host View={ApprovalsView} data={withPending()} />);
    fireEvent.change(document.querySelector('input'), { target: { value: '123456' } });
    fireEvent.click(screen.getByText('Trust this device'));
    await waitFor(() => expect(screen.getByText(/Code didn't match/)).toBeTruthy());
  });

  it('approve non-401 error shows the generic message', async () => {
    installFetch({ '/2fa-gate/approve': { status: 500, json: { error: 'server boom' } } });
    render(<Host View={ApprovalsView} data={withPending()} />);
    fireEvent.change(document.querySelector('input'), { target: { value: '123456' } });
    fireEvent.click(screen.getByText('Trust this device'));
    await waitFor(() => expect(screen.getByText('server boom')).toBeTruthy());
  });

  it('dismiss removes the request and re-focuses', () => {
    const s = spies();
    render(<Host View={ApprovalsView} data={withPending()} extra={s} />);
    fireEvent.click(screen.getByText('Dismiss'));
    expect(s.toast).toHaveBeenCalledWith(expect.stringContaining('Dismissed request'), 'info');
  });
});

describe('EndpointAccessView', () => {
  it('renders the endpoint tree read-only: owners, grants, nested by parent', async () => {
    installFetch({ '/bailey/api/admin/acl': { json: { endpoints: [
      { hostname: 'acme-dashboard.d', display_name: 'acme (dashboard)', kind: 'workspace', stage: '', parent: '', owner_email: 'jane@x', grants: [{ principal_type: 'email', principal_value: 'bob@x', role: 'access' }] },
      { hostname: 'acme-gitops.d', display_name: 'acme (gitops)', kind: 'service', stage: '', parent: 'acme-dashboard.d', owner_email: 'jane@x', grants: [] },
    ] } } });
    render(<Host View={EndpointAccessView} data={makeData()} />);
    await waitFor(() => expect(screen.getByText('acme-dashboard.d')).toBeTruthy());
    expect(screen.getByText('acme-gitops.d')).toBeTruthy();          // child endpoint
    expect(screen.getAllByText('jane@x').length).toBeGreaterThan(0); // owner
    expect(screen.getByText('bob@x')).toBeTruthy();                  // grant
    // Read-only: no member-editing controls.
    expect(screen.queryByPlaceholderText('person@example.com')).toBeNull();
  });

  it('surfaces an error and retries', async () => {
    installFetch({ '/bailey/api/admin/acl': { status: 500, json: { error: 'acl boom' } } });
    render(<Host View={EndpointAccessView} data={makeData()} />);
    await waitFor(() => expect(screen.getByText('acl boom')).toBeTruthy());
  });

  it('groups public and all-users endpoints into their own sections', async () => {
    installFetch({ '/bailey/api/admin/acl': { json: { endpoints: [
      { hostname: 'bailey-onboard.d', kind: '', stage: '', parent: '', owner_email: 'x@y', grants: [], access: 'public' },
      { hostname: 'bailey.d', kind: '', stage: '', parent: '', owner_email: 'admin@y', grants: [], access: 'all-users' },
      { hostname: 'acme-dashboard.d', kind: 'workspace', stage: '', parent: '', owner_email: 'jane@x', grants: [], access: 'owned' },
    ] } } });
    render(<Host View={EndpointAccessView} data={makeData()} />);
    await waitFor(() => expect(screen.getByText('Public endpoints')).toBeTruthy());
    expect(screen.getByText('Available to all signed-in users')).toBeTruthy();
    expect(screen.getByText('Workspaces & apps')).toBeTruthy();
    expect(screen.getByText('bailey-onboard.d')).toBeTruthy();
    expect(screen.getByText('bailey.d')).toBeTruthy();
    expect(screen.getByText('acme-dashboard.d')).toBeTruthy();
  });
});
