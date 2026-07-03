// views-people.test.jsx — UsersView + ApprovalsView (+ UserDevicesDrawer).
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SC_PEOPLE, installFetch } from './harness.js';
import { makeData, Host, spies } from './ctx.js';

const { UsersView, EndpointAccessView } = SC_PEOPLE;

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
    // The invite entry point (dialog opens from here).
    expect(screen.getByText('Invite person')).toBeTruthy();
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

  it('role is a styled dropdown; picking a new role persists it via the API', async () => {
    const s = spies();
    installFetch({ '/bailey/api/people/role': { json: { ok: true, email: 'tomas@h', role: 'user' } } });
    render(<Host View={UsersView} data={makeData({ people })} extra={s} />);
    // Open the first row's role menu (tomas = admin).
    fireEvent.click(screen.getAllByTitle('Change role')[0]);
    // Pick a different role from the open menu (the last 'User' is the menu item;
    // the earlier one is the static legend).
    const userOpts = screen.getAllByText('User');
    fireEvent.click(userOpts[userOpts.length - 1]);
    await waitFor(() => expect(s.toast).toHaveBeenCalledWith(expect.stringContaining('Role updated'), 'success'));
    expect(s.refresh).toHaveBeenCalledWith('people');
  });
});

// Device approvals are now part of UsersView: a pending device shows as a
// highlighted bar under the person it belongs to (or a synthetic "New" row for
// a first-time sign-in not yet in the roster).
describe('UsersView — device approvals', () => {
  const codeInput = () => document.querySelector('input[autocapitalize="characters"]');
  // Pending request for alex@h (in the roster, member, 0 devices) + a brand-new
  // person martin@h who isn't in the roster yet.
  function withPending(extraPending = []) {
    return makeData({
      people,
      pending: [
        { id: 'alex@h', userName: 'Alex', userEmail: 'alex@h', firstDevice: true, kind: 'laptop', deviceLabel: 'Chrome on macOS', requested: '4m ago', oauth: 'Keycloak SSO', code: '' },
        ...extraPending,
      ],
    });
  }

  it('shows a pending device as a highlighted bar under that person + a summary', () => {
    render(<Host View={UsersView} data={withPending()} />);
    expect(screen.getByText(/1 device awaiting approval/)).toBeTruthy();
    expect(screen.getByText('Device awaiting approval')).toBeTruthy();
    expect(screen.getByText('Trust this device')).toBeTruthy();
    // The device type + browser (from the User-Agent) is shown.
    expect(screen.getByText('Chrome on macOS')).toBeTruthy();
    // alex has no existing devices → framed as their first device.
    expect(screen.getByText(/first device on this server/)).toBeTruthy();
  });

  it('shows "Unknown device" when the User-Agent is unrecognized', () => {
    render(<Host View={UsersView} data={makeData({ people, pending: [
      { id: 'alex@h', userName: 'Alex', userEmail: 'alex@h', firstDevice: true, kind: 'unknown', deviceLabel: '', requested: '1m ago', oauth: 'sso', code: '' },
    ] })} />);
    expect(screen.getByText('Unknown device')).toBeTruthy();
  });

  it('frames an additional device when the person already has devices', () => {
    // tomas@h has 3 devices in the roster; a pending request is "additional".
    render(<Host View={UsersView} data={makeData({ people, pending: [
      { id: 'tomas@h', userName: 'Tomas', userEmail: 'tomas@h', firstDevice: false, kind: 'phone', requested: '2m ago', oauth: 'sso', code: '' },
    ] })} />);
    expect(screen.getByText('Additional device')).toBeTruthy();
    expect(screen.getByText(/already has 3 trusted devices/)).toBeTruthy();
  });

  it('surfaces a first-time sign-in (not yet in the roster) as a New row', () => {
    render(<Host View={UsersView} data={makeData({ people: [], pending: [
      { id: 'newbie@h', userName: 'newbie@h', userEmail: 'newbie@h', firstDevice: true, kind: 'laptop', requested: '1m ago', oauth: 'sso', code: '' },
    ] })} />);
    expect(screen.getByText('New')).toBeTruthy();
    expect(screen.getAllByText('newbie@h').length).toBeGreaterThan(0);
    expect(screen.getByText('Device awaiting approval')).toBeTruthy();
  });

  it('no pending → no approval bar or summary', () => {
    render(<Host View={UsersView} data={makeData({ people, pending: [] })} />);
    expect(screen.queryByText('Device awaiting approval')).toBeNull();
    expect(screen.queryByText(/awaiting approval/)).toBeNull();
  });

  it('approve success refreshes approvals + devices + people', async () => {
    const s = spies();
    installFetch({ '/2fa-gate/approve': { status: 200, text: 'ok' } });
    render(<Host View={UsersView} data={withPending()} extra={s} />);
    fireEvent.change(codeInput(), { target: { value: '123456' } });
    fireEvent.click(screen.getByText('Trust this device'));
    await waitFor(() => expect(s.toast).toHaveBeenCalledWith(expect.stringContaining('Device trusted'), 'success'));
    expect(s.refresh).toHaveBeenCalledWith('approvals');
    expect(s.refresh).toHaveBeenCalledWith('devices');
    expect(s.refresh).toHaveBeenCalledWith('people');
  });

  it('approve 401 shows the mismatch message', async () => {
    installFetch({ '/2fa-gate/approve': { status: 401, text: 'unauthorized' } });
    render(<Host View={UsersView} data={withPending()} />);
    fireEvent.change(codeInput(), { target: { value: '123456' } });
    fireEvent.click(screen.getByText('Trust this device'));
    await waitFor(() => expect(screen.getByText(/Code didn't match/)).toBeTruthy());
  });

  it('dismiss clears the request from view', () => {
    const s = spies();
    render(<Host View={UsersView} data={withPending()} extra={s} />);
    fireEvent.click(screen.getByText('Dismiss'));
    expect(s.toast).toHaveBeenCalledWith(expect.stringContaining('Dismissed request'), 'info');
  });
});

// Invites: the dialog lists AOC org users and creates a 48h invite; the
// pending strip manages outstanding invites (revoke / re-send). The email-
// delivery-failed paths surface the copyable invite_link fallback.
describe('UsersView — invites', () => {
  const ORG_USERS = { users: [
    { email: 'grace@h', username: 'Grace', verified: true, in_roster: false, invited: false },
    { email: 'tomas@h', username: 'Tomas', verified: true, in_roster: true, invited: false },
    { email: 'iva@h', username: 'Iva', verified: false, in_roster: false, invited: true },
  ] };
  const in47h = new Date(Date.now() + 47 * 3600 * 1000).toISOString();
  const INVITES = { invites: [
    { email: 'iva@h', role: 'member', created_by: 'tomas@h', created_at: 'x', expires_at: in47h, email_sent: true, expired: false },
    { email: 'old@h', role: 'admin', created_by: 'tomas@h', created_at: 'x', expires_at: '2020-01-01T00:00:00Z', email_sent: false, expired: true },
  ] };

  it('invite dialog: lists org users, disables in-roster rows, sends an invite', async () => {
    const s = spies();
    installFetch({
      '/bailey/api/people/invites': { json: { invites: [] } },
      '/bailey/api/people/org-users': { json: ORG_USERS },
      '/bailey/api/people/invite': { json: { ok: true, email_sent: true, invite_link: 'https://bailey-onboard.h/?invite=t' } },
    });
    render(<Host View={UsersView} data={makeData({ people })} extra={s} />);
    fireEvent.click(screen.getByText('Invite person'));
    await waitFor(() => expect(screen.getByText('grace@h')).toBeTruthy());
    // tomas is already in the roster → row disabled with a pill.
    expect(screen.getByText('Has access')).toBeTruthy();
    // iva has a live invite → flagged.
    expect(screen.getAllByText('Invited').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('grace@h'));
    fireEvent.click(screen.getByText('Send invite'));
    await waitFor(() => expect(s.toast).toHaveBeenCalledWith(expect.stringContaining('Invite sent to grace@h'), 'success'));
    expect(s.refresh).toHaveBeenCalledWith('people');
  });

  it('invite dialog: email failure keeps it open and shows the copyable link', async () => {
    installFetch({
      '/bailey/api/people/invites': { json: { invites: [] } },
      '/bailey/api/people/org-users': { json: ORG_USERS },
      '/bailey/api/people/invite': { json: { ok: true, email_sent: false, email_error: 'SMTP is not configured', invite_link: 'https://bailey-onboard.h/?invite=tok' } },
    });
    render(<Host View={UsersView} data={makeData({ people })} />);
    fireEvent.click(screen.getByText('Invite person'));
    await waitFor(() => expect(screen.getByText('grace@h')).toBeTruthy());
    fireEvent.click(screen.getByText('grace@h'));
    fireEvent.click(screen.getByText('Send invite'));
    await waitFor(() => expect(screen.getByText(/SMTP is not configured/)).toBeTruthy());
    expect(screen.getByText('Copy invite link')).toBeTruthy();
  });

  it('invite dialog: AOC unreachable surfaces the error banner', async () => {
    installFetch({
      '/bailey/api/people/invites': { json: { invites: [] } },
      '/bailey/api/people/org-users': { status: 502, json: { error: 'AOC not configured' } },
    });
    render(<Host View={UsersView} data={makeData({ people })} />);
    fireEvent.click(screen.getByText('Invite person'));
    await waitFor(() => expect(screen.getByText(/AOC not configured/)).toBeTruthy());
    expect(screen.getByText('Retry')).toBeTruthy();
  });

  it('pending strip: expiry, delivery hint, revoke and re-send', async () => {
    const s = spies();
    installFetch({
      '/bailey/api/people/invites': { json: INVITES },
      '/bailey/api/people/invites/revoke': { json: { ok: true } },
      '/bailey/api/people/invites/resend': { json: { ok: true, email_sent: true, invite_link: 'x' } },
    });
    render(<Host View={UsersView} data={makeData({ people })} extra={s} />);
    await waitFor(() => expect(screen.getByText('Pending invites')).toBeTruthy());
    expect(screen.getByText('iva@h')).toBeTruthy();
    expect(screen.getByText('expires in 46h')).toBeTruthy();
    expect(screen.getByText('expired')).toBeTruthy();
    expect(screen.getByText('email not delivered')).toBeTruthy();
    fireEvent.click(screen.getAllByText('Re-send')[0]);
    await waitFor(() => expect(s.toast).toHaveBeenCalledWith(expect.stringContaining('re-sent'), 'success'));
    fireEvent.click(screen.getAllByText('Revoke')[0]);
    await waitFor(() => expect(s.toast).toHaveBeenCalledWith(expect.stringContaining('revoked'), 'danger'));
  });

  it('pending strip: failed re-send delivery shows the fresh copyable link inline', async () => {
    installFetch({
      '/bailey/api/people/invites': { json: INVITES },
      '/bailey/api/people/invites/resend': { json: { ok: true, email_sent: false, email_error: 'send failed', invite_link: 'https://bailey-onboard.h/?invite=new' } },
    });
    render(<Host View={UsersView} data={makeData({ people })} />);
    await waitFor(() => expect(screen.getByText('Pending invites')).toBeTruthy());
    fireEvent.click(screen.getAllByText('Re-send')[0]);
    await waitFor(() => expect(screen.getByText(/send failed/)).toBeTruthy());
    expect(screen.getByText('Copy invite link')).toBeTruthy();
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
