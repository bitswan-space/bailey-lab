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
    '/bailey/api/workspaces': { json: { caller_email: 'tomas@h', workspaces: [{ name: 'ws1', is_owner: true, editor_url: 'http://e', gitops_url: 'http://g', is_trashed: false }] } },
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
    // "Link a device" is unique to the loaded Devices view (not the nav).
    await waitFor(() => expect(screen.getByText('Link a device')).toBeTruthy());
    fireEvent.click(screen.getByText('Security & recovery'));
    await waitFor(() => expect(screen.getByText(/Authenticator app/)).toBeTruthy());
    // approvals route
    fireEvent.click(screen.getByText('Device approvals'));
    await waitFor(() => expect(screen.getByText('Awaiting approval')).toBeTruthy());
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
