// ctx.js — builds the `ctx` object the console views read, plus a stateful
// wrapper so setData actually re-renders the view under test.
//
// The console no longer ships any seed/mock data (console-data.jsx is empty),
// so the test fixtures live HERE — live-API-shaped objects that mirror what
// App holds once the real lists land. Nothing here is rendered in production;
// it only feeds the unit tests.
import React from 'react';
import { vi } from 'vitest';

// A couple of live-shaped device records (the shape adaptDevice produces).
export const FIXTURE_DEVICES = [
  { id: 'd-cur', name: 'This Mac', kind: 'laptop', current: true, browser: '', os: '', ip: '', location: '',
    lastActive: 'Active now', added: 'Jan 01, 2026', trustOrigin: 'root' },
  { id: 'd-other', name: 'Other Phone', kind: 'phone', current: false, browser: '', os: '', ip: '', location: '',
    lastActive: '20m ago', added: 'Jan 02, 2026', trustOrigin: 'linked' },
];

// A fully-loaded data slice (mirrors what App holds once the live lists land).
// Every list defaults empty/live-shaped — never seed identities.
export function makeData(overrides = {}) {
  return {
    workspaces: [],
    myDevices: FIXTURE_DEVICES.map((d) => ({ ...d })),
    pending: [],
    recovery: { totpActive: false, recoveryCodes: [] },
    me: { email: 'me@example.test', isAdmin: true },
    overview: null,
    people: null,
    peopleWarning: null,
    load: { devices: 'ok', approvals: 'ok', workspaces: 'ok', whoami: 'ok', overview: 'ok', people: 'ok' },
    error: {},
    ...overrides,
  };
}

// Stateful host: renders <View ctx={...}/> with a live data state so setData
// re-renders. Exposes the spies for assertions.
export function Host({ View, data: initial, extra = {} }) {
  const [data, setData] = React.useState(initial);
  // Mirror the real router: route + open-drawer param live in state so the
  // views' URL-driven drawers (ctx.routeParam / ctx.navigate) work in tests.
  const [loc, setLoc] = React.useState({ route: extra.route || 'workspaces', param: extra.routeParam ?? null });
  const toast = extra.toast || (() => {});
  const navigate = extra.navigate || ((r, p) => setLoc({ route: r, param: p ?? null }));
  const go = extra.go || ((r) => navigate(r));
  const openUrl = extra.openUrl || (() => {});
  const refresh = extra.refresh || (() => Promise.resolve());
  const currentUser = extra.currentUser
    || { id: data.me?.email || '', email: data.me?.email || '', name: data.me?.email || '', role: 'admin', isAdmin: true };
  const ctx = { data, setData, toast, go, openUrl, refresh, currentUser, navigate, route: loc.route, routeParam: loc.param };
  return React.createElement(View, { ctx });
}

export function spies() {
  return {
    toast: vi.fn(),
    go: vi.fn(),
    openUrl: vi.fn(),
    refresh: vi.fn(() => Promise.resolve()),
  };
}
