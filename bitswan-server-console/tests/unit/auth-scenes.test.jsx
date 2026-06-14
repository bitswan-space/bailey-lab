// auth-scenes.test.jsx — BootstrapScene / ApprovalScene / RecoveryScene.
// The preview/design-preview mode has been removed — the scenes are now driven
// purely by the real gate APIs. These tests exercise the live paths (mocked
// fetch), tab switching, the shared "Why so complicated?" modal, and errors.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { SC_SCENES, installFetch } from './harness.js';

const { BootstrapScene, ApprovalScene, RecoveryScene } = SC_SCENES;

// followRedirect calls window.location.reload / assign — stub both so live
// success paths don't blow up jsdom (navigation is not implemented).
beforeEach(() => {
  Object.defineProperty(window, 'location', {
    value: { search: '', pathname: '/', hostname: 'bailey.example.test', assign: vi.fn(), reload: vi.fn() },
    configurable: true, writable: true,
  });
});
afterEach(() => { vi.useRealTimers(); });

function type(input, value) {
  fireEvent.change(input, { target: { value } });
}

describe('BootstrapScene', () => {
  it('live claim hits the claim API then reloads', async () => {
    installFetch({ '/bailey/api/claim': { json: {} } });
    render(<BootstrapScene onClaim={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Claim this server/ }));
    await waitFor(() => expect(window.location.reload).toHaveBeenCalled());
  });
  it('live claim surfaces the API error', async () => {
    installFetch({ '/bailey/api/claim': { status: 500, json: { error: 'no claim' } } });
    render(<BootstrapScene onClaim={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Claim this server/ }));
    await waitFor(() => expect(screen.getByText('no claim')).toBeTruthy());
  });
  it('opens the "Why so complicated?" modal', () => {
    render(<BootstrapScene onClaim={vi.fn()} />);
    fireEvent.click(screen.getByText('Why so complicated?'));
    expect(screen.getByText('End-to-end access control')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Close'));
  });
});

describe('ApprovalScene', () => {
  it('admin tab only (no TOTP enrolled) waits for an admin', async () => {
    installFetch({
      '/bailey/api/pending-pair': { json: { code: '4821-7K39' } },
      '/bailey/api/pending-pair/poll': { json: {} },
    });
    render(<ApprovalScene gateState={{ email: 'a@b' }} onApproved={vi.fn()} goConsole={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('4821-7K39')).toBeTruthy();
    expect(screen.getByText(/Waiting for an admin/)).toBeTruthy();
    // No authenticator tab when not enrolled.
    expect(screen.queryByText('Authenticator')).toBeNull();
  });
  it('authenticator tab can switch back to admin via the footer link', () => {
    installFetch({
      '/bailey/api/pending-pair': { json: { code: 'X' } },
      '/bailey/api/pending-pair/poll': { json: {} },
    });
    render(<ApprovalScene gateState={{ totp_enrolled: true }} onApproved={vi.fn()} goConsole={vi.fn()} />);
    fireEvent.click(screen.getByText('Authenticator'));
    // footer offers a way back to the admin-approval method
    fireEvent.click(screen.getByText('Ask an admin instead'));
    expect(screen.getByText(/Waiting for an admin/)).toBeTruthy();
  });
  it('live admin tab fetches the pairing code and polls', async () => {
    vi.useFakeTimers();
    installFetch({
      '/bailey/api/pending-pair': { json: { code: '4821-7K39' } },
      '/bailey/api/pending-pair/poll': { json: { approved: true, redirect_path: '/back' } },
    });
    render(<ApprovalScene gateState={{ email: 'a@b' }} onApproved={vi.fn()} goConsole={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('4821-7K39')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(2600); await Promise.resolve(); await Promise.resolve(); });
    expect(window.location.assign).toHaveBeenCalledWith('/back');
  });
  it('live pending-pair error surfaces a message', async () => {
    vi.useFakeTimers();
    installFetch({
      '/bailey/api/pending-pair': { status: 500, json: { error: 'no code' } },
      '/bailey/api/pending-pair/poll': { json: {} },
    });
    render(<ApprovalScene gateState={{ email: 'a@b' }} onApproved={vi.fn()} goConsole={vi.fn()} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText('no code')).toBeTruthy();
  });
  it('live self-trust success follows redirect', async () => {
    installFetch({
      '/bailey/api/pending-pair': { json: { code: 'X' } },
      '/bailey/api/pending-pair/poll': { json: {} },
      '/bailey/api/self-trust': { json: { redirect_path: '/in' } },
    });
    render(<ApprovalScene gateState={{ email: 'a@b', totp_enrolled: true }} onApproved={vi.fn()} goConsole={vi.fn()} />);
    fireEvent.click(screen.getByText('Authenticator'));
    type(document.querySelector('input'), '654321');
    fireEvent.click(screen.getByText('Verify & trust this device'));
    await waitFor(() => expect(window.location.assign).toHaveBeenCalledWith('/in'));
  });
  it('live self-trust failure shows the mismatch error', async () => {
    installFetch({
      '/bailey/api/pending-pair': { json: { code: 'X' } },
      '/bailey/api/pending-pair/poll': { json: {} },
      '/bailey/api/self-trust': { status: 401, json: { error: 'bad' } },
    });
    render(<ApprovalScene gateState={{ totp_enrolled: true }} onApproved={vi.fn()} goConsole={vi.fn()} />);
    fireEvent.click(screen.getByText('Authenticator'));
    type(document.querySelector('input'), '654321');
    fireEvent.click(screen.getByText('Verify & trust this device'));
    await waitFor(() => expect(screen.getByText(/didn't match/)).toBeTruthy());
  });
  it('goConsole sign-out link fires', () => {
    installFetch({
      '/bailey/api/pending-pair': { json: { code: 'X' } },
      '/bailey/api/pending-pair/poll': { json: {} },
    });
    const goConsole = vi.fn();
    render(<ApprovalScene onApproved={vi.fn()} goConsole={goConsole} />);
    fireEvent.click(screen.getByText('Sign out'));
    expect(goConsole).toHaveBeenCalled();
  });
});

describe('RecoveryScene', () => {
  it('opens the "Why so complicated?" modal from recovery', () => {
    render(<RecoveryScene gateState={{ totp_enrolled: true }} onRecovered={vi.fn()} goConsole={vi.fn()} />);
    fireEvent.click(screen.getByText('Why so complicated?'));
    expect(screen.getByText('End-to-end access control')).toBeTruthy();
  });
  it('switches to backup tab and submits (live)', async () => {
    installFetch({ '/bailey/api/recover': { json: { redirect_path: '/home' } } });
    render(<RecoveryScene gateState={{ totp_enrolled: true, backup_codes: true }} onRecovered={vi.fn()} goConsole={vi.fn()} />);
    fireEvent.click(screen.getByText('Use a backup code instead'));
    type(screen.getByPlaceholderText('XXXX-XXXX'), 'ABCD1234');
    fireEvent.click(screen.getByText('Use backup code'));
    await waitFor(() => expect(window.location.assign).toHaveBeenCalledWith('/home'));
  });
  it('backup too short shows error', () => {
    render(<RecoveryScene gateState={{ totp_enrolled: true, backup_codes: true }} onRecovered={vi.fn()} goConsole={vi.fn()} />);
    fireEvent.click(screen.getByText('Use a backup code instead'));
    type(screen.getByPlaceholderText('XXXX-XXXX'), 'AB');
    fireEvent.click(screen.getByText('Use backup code'));
    expect(screen.getByText(/wasn't accepted/)).toBeTruthy();
  });
  it('live totp recover follows redirect', async () => {
    installFetch({ '/bailey/api/recover': { json: { redirect_path: '/home' } } });
    render(<RecoveryScene gateState={{ totp_enrolled: true, backup_codes: false }} onRecovered={vi.fn()} goConsole={vi.fn()} />);
    type(document.querySelector('input'), '123456');
    fireEvent.click(screen.getByText('Verify & trust this device'));
    await waitFor(() => expect(window.location.assign).toHaveBeenCalledWith('/home'));
  });
  it('live recover error shows error', async () => {
    installFetch({ '/bailey/api/recover': { status: 401, json: { error: 'nope' } } });
    render(<RecoveryScene gateState={{ totp_enrolled: true }} onRecovered={vi.fn()} goConsole={vi.fn()} />);
    type(document.querySelector('input'), '123456');
    fireEvent.click(screen.getByText('Verify & trust this device'));
    await waitFor(() => expect(screen.getByText(/didn't match/)).toBeTruthy());
  });
  it('backup-only gate defaults to backup mode (no switch link)', () => {
    render(<RecoveryScene gateState={{ totp_enrolled: false, backup_codes: true }} onRecovered={vi.fn()} goConsole={vi.fn()} />);
    expect(screen.getByPlaceholderText('XXXX-XXXX')).toBeTruthy();
    expect(screen.queryByText('Use authenticator app instead')).toBeNull();
  });
  it('goConsole link fires', () => {
    const goConsole = vi.fn();
    render(<RecoveryScene gateState={{ totp_enrolled: true }} onRecovered={vi.fn()} goConsole={goConsole} />);
    fireEvent.click(screen.getByText('Back to sign in'));
    expect(goConsole).toHaveBeenCalled();
  });
});
