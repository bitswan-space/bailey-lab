// console-app.test.jsx — drives the App shell (window.SC_APP): gate-state →
// scene selection, the live-data loaders + adapters, nav routing, and the
// gate-error banner. The design-preview scene menu has been removed — scene
// selection is driven SOLELY by gate-state. pickScene/hasRecoverIntent and the
// DTO adapters are module-private, so they're exercised through <App/>.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SC_APP, installFetch } from './harness.js';
import { setConsoleMode } from './setup.js';

const App = SC_APP;

function setLocation({ search = '', pathname = '/' } = {}) {
  Object.defineProperty(window, 'location', {
    value: { search, pathname, protocol: 'https:', hostname: 'bailey.example.test', assign: vi.fn(), replace: vi.fn(), reload: vi.fn() },
    configurable: true, writable: true,
  });
}

// A full router covering every list endpoint App loads once the gate clears.
function fullRoutes(extra = {}) {
  return {
    '/bailey/api/gate-state': { json: { trusted: true, claimed: true, totp_enrolled: true, leave_to: 'https://bailey.example.test/' } },
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

  // #403: a gate-state read that fails leaves device trust UNKNOWN. This used
  // to render the console with an error banner over it — fail-open, and the
  // reported symptom on the public onboarding host. Unknown must mean no app.
  it('gate-state error → blocking "can\'t verify" scene, never the console', async () => {
    installFetch({ '/bailey/api/gate-state': { status: 500, json: { error: 'gate down' } } });
    render(<App />);
    await waitFor(() => expect(screen.getByText("Can't verify this device")).toBeTruthy());
    expect(screen.queryByText('Server overview')).toBeNull();
    expect(screen.queryByText('Workspaces')).toBeNull();
  });

  it('gate-state error → retry re-reads gate-state and opens the console', async () => {
    // Fail once, then succeed: the scene must be recoverable, not a dead end.
    let calls = 0;
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/bailey/api/gate-state')) {
        calls += 1;
        if (calls === 1) return { ok: false, status: 500, json: async () => ({ error: 'gate down' }) };
        return { ok: true, status: 200, json: async () => ({ trusted: true, claimed: true }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    global.fetch = fetchMock;
    render(<App />);
    await waitFor(() => expect(screen.getByText("Can't verify this device")).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    await waitFor(() => expect(screen.queryByText("Can't verify this device")).toBeNull());
    expect(calls).toBeGreaterThan(1);
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
    // The manage drawer for ws1 is open on load — no click needed. "People &
    // roles" only exists inside the drawer.
    await waitFor(() => expect(screen.getByText('People with access')).toBeTruthy());
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

  // #331: approving a device left the console stale — the pending bar cleared
  // only on reload, and the roster's device count never caught up because the
  // trusted device record is minted a couple of seconds AFTER the approve call
  // (when the user's device claims the approval on its next poll). The console
  // must converge on its own: badge + bar clear immediately, and the count
  // updates once the delayed re-sync sees the claimed device — no page reload.
  it('approving a device updates the pending bar, badge, and device count without a reload (#331)', async () => {
    let approved = false;
    let peopleFetchesAfterApprove = 0;
    setLocation({ pathname: '/users' });
    installFetch(fullRoutes({
      '/bailey/api/people/invites': { json: { invites: [] } },
      '/bailey/api/approvals': () => ({ json: { pending: approved ? [] : [{ email: 'a@h', age_seconds: 120 }] } }),
      '/2fa-gate/approve': () => { approved = true; return { status: 200, text: 'ok' }; },
      '/bailey/api/people': () => {
        // The device record exists only after the user's device claims the
        // approval — the refetch fired right after approve still sees count 0.
        const claimed = approved && ++peopleFetchesAfterApprove > 1;
        return { json: { people: [
          { email: 'tomas@h', role: 'admin', workspace_count: 1, device_count: 2, last_active: '2026-01-01T00:00:00Z' },
          { email: 'a@h', role: 'member', workspace_count: 0, device_count: claimed ? 1 : 0 },
        ] } };
      },
    }));
    render(<App />);
    await waitFor(() => expect(screen.getByText('Device awaiting approval')).toBeTruthy());
    // Sidebar badge counts the pending approval; a@h has no devices yet.
    // ("People & roles" is both the nav label and the page <h1> — the nav
    // one is the only match inside a button.)
    const navItem = () => screen.getAllByText('People & roles').map((el) => el.closest('button')).find((b) => b);
    expect(navItem().textContent).toContain('1');
    expect(screen.getAllByTitle('Manage devices').length).toBe(1); // tomas only
    // Approve with the code read off the user's screen.
    fireEvent.change(document.querySelector('input[autocapitalize="characters"]'), { target: { value: '123456' } });
    fireEvent.click(screen.getByText('Trust this device'));
    // The pending bar and the badge clear right away (approvals refetch)…
    await waitFor(() => expect(screen.queryByText('Device awaiting approval')).toBeNull());
    expect(navItem().textContent).not.toContain('1');
    // …and the roster count converges once the claim lands (the delayed
    // re-sync), while the roster itself stays rendered the whole time.
    await waitFor(() => {
      expect(screen.queryByText('Loading people…')).toBeNull();
      expect(screen.getAllByTitle('Manage devices').length).toBe(2);
    }, { timeout: 8000 });
  }, 15000);

  // #248: the sidebar card is an IDENTITY slot — it used to spell the role
  // ("Administrator") under the name, which read as "who am I?" answered with
  // "what am I?". The email is the second line now; the role is just a badge.
  it('sidebar card shows the signed-in email, with the role as a badge', async () => {
    installFetch(fullRoutes({
      '/bailey/api/whoami': { json: { is_admin: true, headers: { 'X-Forwarded-Email': 'tim@sandbox.test' } } },
      'https://api.example.test/api/frontend/directory?email=tim@sandbox.test': { json: { name: 'Timothy Hobbs' } },
    }));
    render(<App />);
    await waitFor(() => expect(screen.getByText('Timothy Hobbs')).toBeTruthy());
    // The email is truncated in the narrow sidebar, so the full address must
    // stay recoverable from the title attribute.
    const email = await screen.findByText('tim@sandbox.test');
    expect(email.getAttribute('title')).toBe('tim@sandbox.test');
    // The role badge sits on that same line ("Admin" alone is ambiguous — the
    // nav has an Admin section header too, so assert within the card).
    expect(email.parentElement.textContent).toContain('Admin');
    expect(screen.queryByText('Administrator')).toBeNull();
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

describe('Handbook view links (issue #45)', () => {
  // The console runs on the inner subdomain inside the chrome-wrap iframe. The
  // "Read the handbook" tab must open the PUBLIC (outer) host so the daemon
  // dresses it with the Bailey chrome — a relative href would surface the bare
  // inner origin. The PDF download stays inner-relative (the outer host 404s
  // non-HTML GETs).
  it('points the HTML link at the outer host and keeps the PDF inner-relative', async () => {
    Object.defineProperty(window, 'location', {
      value: {
        search: '', pathname: '/handbook', hostname: 'bailey--inner.example.test',
        protocol: 'https:', port: '', assign: vi.fn(), reload: vi.fn(),
      },
      configurable: true, writable: true,
    });
    installFetch(fullRoutes());
    render(<App />);
    const read = await screen.findByText('Read the handbook');
    expect(read.closest('a').getAttribute('href'))
      .toBe('https://bailey.example.test/handbook/handbook.html');
    const pdf = screen.getByText('Download PDF').closest('a');
    expect(pdf.getAttribute('href')).toBe('/handbook/handbook.pdf');
    expect(pdf.hasAttribute('download')).toBe(true);
  });

  it('keeps a non-standard port when building the outer URL', async () => {
    Object.defineProperty(window, 'location', {
      value: {
        search: '', pathname: '/handbook', hostname: 'bailey--inner.example.test',
        protocol: 'https:', port: '8443', assign: vi.fn(), reload: vi.fn(),
      },
      configurable: true, writable: true,
    });
    installFetch(fullRoutes());
    render(<App />);
    const read = await screen.findByText('Read the handbook');
    expect(read.closest('a').getAttribute('href'))
      .toBe('https://bailey.example.test:8443/handbook/handbook.html');
  });
});

// ─── #403: the PUBLIC onboarding host has no console ────────────────────────
//
// bailey-onboard.<domain> is reachable without device trust — it is where an
// untrusted device goes to pair. It must therefore deliver the device-trust
// scenes and NOTHING else. The reported failure was the /workspaces admin page
// rendering there (no bottom bar, no data). Two independent rules keep that
// state unreachable, and both are asserted here:
//
//   1. the console component never mounts in onboarding mode, whatever
//      gate-state says; and
//   2. an unidentified document (no mode meta) is treated as onboarding, so a
//      shell that somehow escapes the daemon's injection fails CLOSED.
describe('#403 onboarding host never renders the console', () => {
  const { pickScene, consoleMode } = window.SC_HELPERS;

  // LeavingScene latches its single reload in sessionStorage; without a reset
  // the first hand-off test would leave the latch set for the next one.
  beforeEach(() => sessionStorage.clear());

  it('pickScene: trusted resolves to leave, not console, in onboarding mode', () => {
    expect(pickScene({ trusted: true, claimed: true }, false, '', 'onboarding')).toBe('leave');
    expect(pickScene({ trusted: true, claimed: true }, false, '', 'console')).toBe('console');
  });

  it('pickScene: an unreadable gate-state is never the console, in either mode', () => {
    expect(pickScene(null, false, '', 'onboarding')).toBe('unknown');
    expect(pickScene(null, false, '', 'console')).toBe('unknown');
  });

  it('pickScene: the pairing scenes still work in onboarding mode', () => {
    expect(pickScene({ claimed: false, can_claim: true }, false, '', 'onboarding')).toBe('bootstrap');
    expect(pickScene({ claimed: false, can_claim: false }, false, '', 'onboarding')).toBe('waiting');
    expect(pickScene({ claimed: true, trusted: false }, false, '', 'onboarding')).toBe('approval');
    expect(pickScene({ claimed: true, trusted: false }, false, 'tok', 'onboarding')).toBe('invite');
  });

  it('consoleMode: absent or unrecognised meta fails closed to onboarding', () => {
    setConsoleMode(null);
    expect(consoleMode()).toBe('onboarding');
    setConsoleMode('');
    expect(consoleMode()).toBe('onboarding');
    setConsoleMode('CONSOLE-ish');
    expect(consoleMode()).toBe('onboarding');
    setConsoleMode('console');
    expect(consoleMode()).toBe('console');
    setConsoleMode('onboarding');
    expect(consoleMode()).toBe('onboarding');
  });

  it('a trusted device on the onboarding host gets no console surface at all', async () => {
    setConsoleMode('onboarding');
    setLocation({ pathname: '/workspaces' });
    installFetch(fullRoutes()); // gate-state says trusted, every list would load
    render(<App />);
    await waitFor(() => expect(screen.getByText('This device is trusted')).toBeTruthy());
    // None of the console chrome may exist — not the nav, not the admin views.
    expect(screen.queryByText('Server overview')).toBeNull();
    expect(screen.queryByText('Workspaces')).toBeNull();
    expect(screen.queryByText('People & roles')).toBeNull();
    // It hands off to the target the server chose, never to a reload of the
    // page it is already on (#425).
    await waitFor(() =>
      expect(window.location.replace).toHaveBeenCalledWith('https://bailey.example.test/'),
    );
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it('a trusted device is sent to the origin it was bounced from, not just the console', async () => {
    setConsoleMode('onboarding');
    setLocation({ pathname: '/' });
    installFetch(fullRoutes({
      '/bailey/api/gate-state': { json: {
        trusted: true, claimed: true, totp_enrolled: true,
        leave_to: 'https://app.example.test/secret',
      } },
    }));
    render(<App />);
    await waitFor(() =>
      expect(window.location.replace).toHaveBeenCalledWith('https://app.example.test/secret'),
    );
  });

  it('never dead-ends on the onboarding host when the server names no target', async () => {
    setConsoleMode('onboarding');
    setLocation({ pathname: '/' });
    installFetch(fullRoutes({
      '/bailey/api/gate-state': { json: { trusted: true, claimed: true, totp_enrolled: true } },
    }));
    render(<App />);
    await waitFor(() => expect(screen.getByText('This device is trusted')).toBeTruthy());
    // No console surface leaks, and the operator is never told to give up and
    // find the console themselves — the old failure this issue is about.
    expect(screen.queryByText('This device is already set up')).toBeNull();
    expect(screen.queryByText('Workspaces')).toBeNull();
  });

  it('an unreadable gate-state on the onboarding host shows no console either', async () => {
    setConsoleMode('onboarding');
    setLocation({ pathname: '/workspaces' });
    installFetch({ '/bailey/api/gate-state': { status: 500, json: { error: 'gate down' } } });
    render(<App />);
    await waitFor(() => expect(screen.getByText("Can't verify this device")).toBeTruthy());
    expect(screen.queryByText('Server overview')).toBeNull();
    expect(screen.queryByText('Workspaces')).toBeNull();
  });
});
