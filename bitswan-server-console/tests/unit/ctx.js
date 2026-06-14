// ctx.js — builds the `ctx` object the console views read, plus a stateful
// wrapper so setData actually re-renders the view under test.
import React from 'react';
import { vi } from 'vitest';
import { SC_DATA } from './harness.js';

// A fully-loaded data slice (mirrors what App holds once the live lists land).
export function makeData(overrides = {}) {
  const D = SC_DATA;
  return {
    workspaces: D.WORKSPACES.map((w) => ({ ...w, members: [...w.members] })),
    myDevices: D.MY_DEVICES.map((d) => ({ ...d })),
    pending: D.PENDING_DEVICES.map((p) => ({ ...p })),
    users: D.USERS.map((u) => ({ ...u })),
    recovery: { ...D.RECOVERY, totpActive: false, recoveryCodes: [] },
    userDevices: {},
    me: { email: 'tomas@harmonum.ai', isAdmin: true },
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
  const toast = extra.toast || (() => {});
  const go = extra.go || (() => {});
  const openUrl = extra.openUrl || (() => {});
  const refresh = extra.refresh || (() => Promise.resolve());
  const currentUser = extra.currentUser || data.users.find((u) => u.id === 'tomas');
  const ctx = { data, setData, toast, go, openUrl, refresh, currentUser };
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
