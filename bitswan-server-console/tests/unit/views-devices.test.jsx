// views-devices.test.jsx — DevicesView (+ LinkDeviceModal) + SecurityView
// (+ SetupTotpModal). Covers revoke, the link modal's honest "not available
// yet" state, TOTP enrolment steps, backup-code regeneration.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SC_DEVICES, installFetch } from './harness.js';
import { makeData, Host, spies } from './ctx.js';

const { DevicesView, SecurityView } = SC_DEVICES;

afterEach(() => vi.useRealTimers());

describe('DevicesView', () => {
  it('renders devices, the recovery hint link, and empty state', () => {
    const s = spies();
    render(<Host View={DevicesView} data={makeData()} extra={s} />);
    expect(screen.getByText('Your devices')).toBeTruthy();
    fireEvent.click(screen.getByText('authenticator recovery'));
    expect(s.go).toHaveBeenCalledWith('security');
  });

  it('shows empty state when no devices', () => {
    render(<Host View={DevicesView} data={makeData({ myDevices: [] })} />);
    expect(screen.getByText('No trusted devices')).toBeTruthy();
  });

  it('loading/error banner retries', () => {
    const s = spies();
    render(<Host View={DevicesView} data={makeData({ load: { ...makeData().load, devices: 'error' }, error: { devices: 'd-err' } })} extra={s} />);
    fireEvent.click(screen.getByText('Retry'));
    expect(s.refresh).toHaveBeenCalledWith('devices');
  });

  it('revoke a non-current device: confirm + remove', async () => {
    const s = spies();
    installFetch({ '/bailey/api/devices/remove': { json: {} } });
    render(<Host View={DevicesView} data={makeData()} extra={s} />);
    fireEvent.click(screen.getAllByText('Sign out')[0]);
    fireEvent.click(screen.getByText('Sign out device'));
    await waitFor(() => expect(s.toast).toHaveBeenCalledWith(expect.stringContaining('signed out and removed'), 'danger'));
    expect(s.refresh).toHaveBeenCalledWith('devices');
  });

  it('revoke error path surfaces a toast', async () => {
    const s = spies();
    installFetch({ '/bailey/api/devices/remove': { status: 500, json: { error: 'nope' } } });
    render(<Host View={DevicesView} data={makeData()} extra={s} />);
    fireEvent.click(screen.getAllByText('Sign out')[0]);
    fireEvent.click(screen.getByText('Sign out device'));
    await waitFor(() => expect(s.toast).toHaveBeenCalledWith(expect.stringContaining("Couldn't remove device"), 'danger'));
  });

  it('link device modal: shows the honest "not available yet" state with a disabled control', () => {
    const s = spies();
    render(<Host View={DevicesView} data={makeData()} extra={s} />);
    fireEvent.click(screen.getByText('Link a device'));
    // No mock PIN/QR/"Simulate scan"; the real flow is explained and the
    // unbuilt direct-link control is disabled.
    expect(screen.getByText(/isn't available yet/)).toBeTruthy();
    expect(screen.queryByText('Simulate scan')).toBeNull();
    const linkBtn = screen.getByText('Link with a PIN').closest('button');
    expect(linkBtn.disabled).toBe(true);
    // No fake device gets added.
    expect(s.toast).not.toHaveBeenCalledWith('New device linked and trusted', 'success');
  });
});

describe('SecurityView', () => {
  it('not-set-up state opens the setup modal and walks all 3 steps', async () => {
    const s = spies();
    installFetch({
      '/bailey/api/totp/enroll': { json: { secret: 'JBSWY3DP', otpauth_url: 'otpauth://totp/x' } },
      '/bailey/api/totp/verify': { json: { backup_codes: ['AAAA-1111', 'BBBB-2222'] } },
    });
    render(<Host View={SecurityView} data={makeData()} extra={s} />);
    expect(screen.getByText('Not set up')).toBeTruthy();
    fireEvent.click(screen.getByText('Set up'));
    // wait for enroll to resolve so the secret chip + continue enable
    await waitFor(() => expect(screen.getByText('JBSWY3DP')).toBeTruthy());
    fireEvent.click(screen.getByText("I've added it — continue"));
    fireEvent.change(document.querySelector('input'), { target: { value: '123456' } });
    fireEvent.click(screen.getByText('Verify'));
    await waitFor(() => expect(screen.getByText('Recovery is on')).toBeTruthy());
    fireEvent.click(screen.getByText('Done'));
    expect(s.toast).toHaveBeenCalledWith('Authenticator recovery enabled', 'success');
  });

  it('setup modal: enroll error shows the message', async () => {
    installFetch({ '/bailey/api/totp/enroll': { status: 500, json: { error: 'enroll boom' } } });
    render(<Host View={SecurityView} data={makeData()} />);
    fireEvent.click(screen.getByText('Set up'));
    await waitFor(() => expect(screen.getByText('enroll boom')).toBeTruthy());
  });

  it('setup modal: verify failure shows error, then back navigates', async () => {
    installFetch({
      '/bailey/api/totp/enroll': { json: { secret: 'S', otpauth_url: 'otpauth://x' } },
      '/bailey/api/totp/verify': { status: 401, json: { error: 'bad code' } },
    });
    render(<Host View={SecurityView} data={makeData()} />);
    fireEvent.click(screen.getByText('Set up'));
    await waitFor(() => expect(screen.getByText("I've added it — continue")).toBeTruthy());
    fireEvent.click(screen.getByText("I've added it — continue"));
    fireEvent.change(document.querySelector('input'), { target: { value: '123456' } });
    fireEvent.click(screen.getByText('Verify'));
    await waitFor(() => expect(screen.getByText('bad code')).toBeTruthy());
    fireEvent.click(screen.getByText('Back'));
  });

  it('active TOTP: shows/hides codes, regenerate, and remove', async () => {
    const s = spies();
    installFetch({ '/bailey/api/backup-codes/regenerate': { json: { backup_codes: ['XXXX-9999'] } } });
    const data = makeData({ recovery: { totpActive: true, recoveryCodes: ['OLD1-2222'] } });
    render(<Host View={SecurityView} data={data} extra={s} />);
    expect(screen.getByText('● Active')).toBeTruthy();
    fireEvent.click(screen.getByText(/Show.*codes/));
    expect(screen.getByText('OLD1-2222')).toBeTruthy();
    fireEvent.click(screen.getByText('Regenerate'));
    await waitFor(() => expect(s.toast).toHaveBeenCalledWith('New recovery codes generated', 'success'));
    fireEvent.click(screen.getByText('Remove'));
    expect(s.toast).toHaveBeenCalledWith(expect.stringContaining('account settings'), 'info');
  });

  it('active TOTP with no session codes: generate-new branch + error', async () => {
    const s = spies();
    installFetch({ '/bailey/api/backup-codes/regenerate': { status: 500, json: { error: 'regen fail' } } });
    const data = makeData({ recovery: { totpActive: true, recoveryCodes: [] } });
    render(<Host View={SecurityView} data={data} extra={s} />);
    fireEvent.click(screen.getByText(/Show.*codes/));
    expect(screen.getByText(/shown only once/)).toBeTruthy();
    fireEvent.click(screen.getByText('Generate new codes'));
    await waitFor(() => expect(s.toast).toHaveBeenCalledWith('regen fail', 'error'));
  });
});
