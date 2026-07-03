// console-app.test.jsx — drives the App shell (window.SC_APP): gate-state →
// scene selection, the live-data loaders + adapters, nav routing, and the
// gate-error banner. The design-preview scene menu has been removed — scene
// selection is driven SOLELY by gate-state. pickScene/hasRecoverIntent and the
// DTO adapters are module-private, so they're exercised through <App/>.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SC_APP, installFetch } from './harness.js';

const App = SC_APP;

function setLocation({ search = '', pathname = '/' } = {}) {
  Object.defineProperty(window, 'location', {
    value: { search, pathname, hostname: 'bailey.example.test', assign: vi.fn(), reload: vi.fn() },
    configurable: true, writable: true,
  });
}

// A full router covering every list endpoint App loads once the gate clears.
function fullRoutes(extra = {}) {
  return {
    '/bailey/api/gate-state': { json: { trusted: true, claimed: true, totp_enrolled: true } },
    '/bailey/api/whoami': { json: { is_admin: true, headers: { 'X-Forwarded-Email': 'tomas@h' } } },
    '/bailey/api/devices': { json: { devices: [{ id: 'd1', name: 'Mac', is_current: true, last_seen: '2026-01-01T00:00:00Z', paired_at: '2026-01-01T00:00:00Z' }] } },
    '/bailey/api/approvals': { json: { pending: [{ email: 'a@h', age_seconds: 120 }] } },
    '/bailey/api/workspaces': { json: { caller_email: 'tomas@h', workspaces: [{ name: 'ws1', is_owner: true, dashboard_url: 'http://d', editor_url: 'http://e', gitops_url: 'http://g', is_trashed: false }] } },
    '/bailey/api/overview': { json: {
      counts: { workspaces: 1, people: 2, trusted_devices: 1, pending_approvals: 1 },
      identity: { claimed_by: 'tomas@h', claimed_at: '2026-01-01T00:00:00Z', version: 'v1', online: true, region: 'eu', uptime_sec: 90061, start_time: 's' },
      activity: [
        { ts: '2026-01-01T00:00:00Z', actor: 'tomas@h', action: 'device.approve', target: 'a@h' },
        { ts: '2026-01-01T00:00:00Z', actor: 'tomas@h', action: 'unknown.action', target: '' },
      ],
    } },
    '/bailey/api/people': { json: { people: [{ email: 'tomas@h', role: 'admin', workspace_count: 1, device_count: 2, last_active: '2026-01-01T00:00:00Z' }], error: 'partial' } },
    ...extra,
  };
}

beforeEach(() => setLocation());
afterEach(() => vi.useRealTimers());

describe('App gate-state scene selection', () => {
  it('loading → spinner, then trusted → console (workspaces)', async () => {
    installFetch(fullRoutes());
    render(<App />);
    // "Server overview" is a unique nav item only present in the loaded console.
    await waitFor(() => expect(screen.getByText('Server overview')).toBeTruthy());
    expect(screen.getAllByText('Workspaces').length).toBeGreaterThan(0);
  });

  it('unclaimed + can_claim → bootstrap scene', async () => {
    installFetch({ '/bailey/api/gate-state': { json: { trusted: false, claimed: false, can_claim: true } } });
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Claim this server/ })).toBeTruthy());
  });

  it('unclaimed + !can_claim → waiting scene', async () => {
    installFetch({ '/bailey/api/gate-state': { json: { trusted: false, claimed: false, can_claim: false } } });
    render(<App />);
    await waitFor(() => expect(screen.getByText('Waiting to be claimed')).toBeTruthy());
  });

  it('claimed + untrusted → approval scene', async () => {
    installFetch({ '/bailey/api/gate-state': { json: { trusted: false, claimed: true, email: 'a@h' } } });
    render(<App />);
    await waitFor(() => expect(screen.getByText('Trust this device')).toBeTruthy());
  });

  it('?recover query → recovery scene', async () => {
    setLocation({ search: '?recover' });
    installFetch({ '/bailey/api/gate-state': { json: { trusted: true, claimed: true } } });
    render(<App />);
    await waitFor(() => expect(screen.getByText('Recover your account')).toBeTruthy());
  });

  it('gate-state error → console with the error banner', async () => {
    installFetch({ '/bailey/api/gate-state': { status: 500, json: { error: 'gate down' } } });
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Couldn't load device-trust state/)).toBeTruthy());
  });
});

describe('App live-data loading + adapters + routing', () => {
  it('loads all lists and renders the overview after navigating', async () => {
    installFetch(fullRoutes());
    render(<App />);
    await waitFor(() => expect(screen.getByText('Server overview')).toBeTruthy());
    fireEvent.click(screen.getByText('Server overview'));
    // adapted activity: known + unknown action both rendered
    await waitFor(() => expect(screen.getByText(/approved a device for/)).toBeTruthy());
    // navigate to people (adaptPerson + partial warning)
    fireEvent.click(screen.getByText('People & roles'));
    await waitFor(() => expect(screen.getByText(/couldn't be enumerated/)).toBeTruthy());
    // devices + security routes
    fireEvent.click(screen.getByText('Your devices'));
    // The page-header subtitle is unique to the loaded Devices view (not the nav).
    await waitFor(() => expect(screen.getByText(/Trust spreads device-to-device/)).toBeTruthy());
    fireEvent.click(screen.getByText('Security & recovery'));
    await waitFor(() => expect(screen.getByText(/Authenticator app/)).toBeTruthy());
    // approvals are merged into People & roles — the pending device shows as a
    // highlighted bar under the person (no separate "New user approvals" nav).
    expect(screen.queryByText('New user approvals')).toBeNull();
    fireEvent.click(screen.getByText('People & roles'));
    await waitFor(() => expect(screen.getByText('Device awaiting approval')).toBeTruthy());
  });

  it('focusing the tab refreshes in the background without reloading the overview', async () => {
    setLocation({ pathname: '/overview' });
    installFetch(fullRoutes({
      '/bailey/api/admin/siem': { json: { enabled: false, protocol: 'otlp-http', endpoint: '', has_auth_token: false, connected: false } },
    }));
    render(<App />);
    await waitFor(() => expect(screen.getByText('Recent security activity')).toBeTruthy());
    // A tab focus fires the background poll. The overview must NOT drop to its
    // loading state — doing so unmounts the content and reads as a page reload.
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(screen.queryByText('Loading server overview…')).toBeNull();
    expect(screen.getByText('Recent security activity')).toBeTruthy();
  });

  it('derives the initial view from the URL (/devices → devices view)', async () => {
    setLocation({ pathname: '/devices' });
    installFetch(fullRoutes());
    render(<App />);
    // No nav click: the URL alone selects the view (so refresh / a shared link
    // lands here).
    await waitFor(() => expect(screen.getByText(/Trust spreads device-to-device/)).toBeTruthy());
  });

  it('opens a workspace drawer straight from the URL (/workspaces/:name)', async () => {
    setLocation({ pathname: '/workspaces/ws1' });
    installFetch(fullRoutes());
    render(<App />);
    // The manage drawer for ws1 is open on load — no click needed. "Ownership"
    // only exists inside the drawer (owner view).
    await waitFor(() => expect(screen.getByText('Ownership')).toBeTruthy());
  });

  it('navigation pushes a canonical URL', async () => {
    setLocation({ pathname: '/' });
    const push = vi.spyOn(window.history, 'pushState');
    installFetch(fullRoutes());
    render(<App />);
    await waitFor(() => expect(screen.getByText('Your devices')).toBeTruthy());
    fireEvent.click(screen.getByText('Your devices'));
    await waitFor(() => expect(push).toHaveBeenCalledWith(expect.anything(), '', '/devices'));
    push.mockRestore();
  });

  it('non-admin whoami hides the Admin nav section', async () => {
    installFetch(fullRoutes({
      '/bailey/api/whoami': { json: { is_admin: false, headers: {} } },
      '/bailey/api/overview': { status: 403, json: { error: 'forbidden' } },
      '/bailey/api/people': { status: 403, json: { error: 'forbidden' } },
    }));
    render(<App />);
    // Workspaces nav loads for everyone; the Admin section is hidden for non-admins.
    await waitFor(() => expect(screen.getByText('Your devices')).toBeTruthy());
    await waitFor(() => expect(screen.queryByText('Server overview')).toBeNull());
  });
});

describe('No design-preview scene menu (removed)', () => {
  it('the loaded console never renders the "Preview sign-in states" control', async () => {
    installFetch(fullRoutes());
    render(<App />);
    await waitFor(() => expect(screen.getByText('Server overview')).toBeTruthy());
    // The wireframe-navigation device must be gone — scene is gate-driven only.
    expect(screen.queryByText('Preview sign-in states')).toBeNull();
    expect(screen.queryByText('First-admin claim')).toBeNull();
    expect(screen.queryByText('Awaiting approval')).toBeNull();
    expect(screen.queryByText('Account recovery')).toBeNull();
  });
});

// Invite intent: pickScene's invite rule + the token stash/strip helpers
// (exposed via window.SC_HELPERS, like serverHost/pickScene already are).
describe('invite intent', () => {
  const { pickScene, getInviteToken, clearInviteToken } = window.SC_HELPERS;

  beforeEach(() => {
    sessionStorage.clear();
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
  });

  it('pickScene: token + claimed + untrusted → invite; trusted and recovery win', () => {
    expect(pickScene({ claimed: true, trusted: false }, false, 'tok')).toBe('invite');
    expect(pickScene({ claimed: true, trusted: true }, false, 'tok')).toBe('console');
    expect(pickScene({ claimed: true, trusted: false }, true, 'tok')).toBe('recovery');
    // Unclaimed: falls through to bootstrap/waiting — never invite.
    expect(pickScene({ claimed: false, can_claim: true }, false, 'tok')).toBe('bootstrap');
    expect(pickScene({ claimed: false, can_claim: false }, false, 'tok')).toBe('waiting');
    expect(pickScene({ claimed: true, trusted: false }, false, '')).toBe('approval');
  });

  it('getInviteToken parses ?invite=, stashes it, and strips the URL', () => {
    setLocation({ search: '?invite=tok123', pathname: '/' });
    expect(getInviteToken()).toBe('tok123');
    expect(sessionStorage.getItem('bailey_invite_token')).toBe('tok123');
    expect(window.history.replaceState).toHaveBeenCalledWith({}, '', '/');
    // Subsequent calls (URL already stripped) read the stash.
    setLocation({ search: '', pathname: '/' });
    expect(getInviteToken()).toBe('tok123');
    clearInviteToken();
    expect(getInviteToken()).toBe('');
  });

  it('getInviteToken recovers a token embedded in ?return= (old console-host links)', () => {
    setLocation({ search: '?return=' + encodeURIComponent('https://bailey.example.test/?invite=embedded1'), pathname: '/' });
    expect(getInviteToken()).toBe('embedded1');
    expect(sessionStorage.getItem('bailey_invite_token')).toBe('embedded1');
  });

  it('a trusted gate-state with a stale stashed token lands in the console and drops the stash', async () => {
    sessionStorage.setItem('bailey_invite_token', 'stale');
    setLocation({ search: '', pathname: '/' });
    installFetch(fullRoutes());
    render(<App />);
    await waitFor(() => expect(screen.getByText('Server overview')).toBeTruthy());
    await waitFor(() => expect(sessionStorage.getItem('bailey_invite_token')).toBeNull());
  });

  it('untrusted + stashed token renders the invite scene (redeem in flight)', async () => {
    sessionStorage.setItem('bailey_invite_token', 'tok');
    setLocation({ search: '', pathname: '/' });
    installFetch({
      '/bailey/api/gate-state': { json: { trusted: false, claimed: true, email: 'grace@h' } },
      '/bailey/api/invite/redeem': { status: 410, json: { error: 'gone', code: 'expired' } },
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText('This invite has expired')).toBeTruthy());
    // The fallback drops into the standard approval flow.
    installFetch({
      '/bailey/api/gate-state': { json: { trusted: false, claimed: true, email: 'grace@h' } },
      '/bailey/api/pending-pair': { json: { code: '111222' } },
      '/bailey/api/pending-pair/poll': { json: {} },
    });
    fireEvent.click(screen.getByRole('button', { name: /Continue to device approval/ }));
    await waitFor(() => expect(screen.getByText('Trust this device')).toBeTruthy());
    expect(sessionStorage.getItem('bailey_invite_token')).toBeNull();
  });
});
