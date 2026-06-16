// views-people.test.jsx — UsersView + ApprovalsView (+ UserDevicesDrawer).
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SC_PEOPLE, installFetch } from './harness.js';
import { makeData, Host, spies } from './ctx.js';

const { UsersView, ApprovalsView } = SC_PEOPLE;

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
    fireEvent.change(codeInput, { target: { value: 'ABCD1234' } });
    fireEvent.click(screen.getByText('Trust this device'));
    await waitFor(() => expect(s.toast).toHaveBeenCalledWith(expect.stringContaining('Device trusted'), 'success'));
    expect(s.refresh).toHaveBeenCalledWith('approvals');
    expect(s.refresh).toHaveBeenCalledWith('devices');
  });

  it('approve 401 shows mismatch message', async () => {
    installFetch({ '/2fa-gate/approve': { status: 401, text: 'unauthorized' } });
    render(<Host View={ApprovalsView} data={withPending()} />);
    fireEvent.change(document.querySelector('input'), { target: { value: 'ABCD1234' } });
    fireEvent.click(screen.getByText('Trust this device'));
    await waitFor(() => expect(screen.getByText(/Code didn't match/)).toBeTruthy());
  });

  it('approve non-401 error shows the generic message', async () => {
    installFetch({ '/2fa-gate/approve': { status: 500, json: { error: 'server boom' } } });
    render(<Host View={ApprovalsView} data={withPending()} />);
    fireEvent.change(document.querySelector('input'), { target: { value: 'ABCD1234' } });
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
