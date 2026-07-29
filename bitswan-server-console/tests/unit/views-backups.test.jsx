// views-backups.test.jsx — BackupsView: status + last-run table, run-now,
// retention save, key custody (escrow states + the destructive remove-escrow
// confirm), and the not-AOC-connected empty state.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SC_BACKUPS, installFetch } from './harness.js';
import { makeData, Host, spies } from './ctx.js';

const { BackupsView } = SC_BACKUPS;

afterEach(() => vi.restoreAllMocks());

// A live-shaped GET /bailey/api/admin/backups payload.
function makeBackups(overrides = {}) {
  return {
    aoc_connected: true,
    enabled: true,
    configured: true,
    has_key: true,
    key_mirrored: true,
    running: false,
    retention: { daily: 30, monthly: 12 },
    last_run: {
      started_at: '2026-07-29T02:00:00Z',
      finished_at: '2026-07-29T02:04:00Z',
      ok: true,
      workspaces: {
        'tenant-a': {
          files: { success: true, output: 'snapshot abc saved' },
          postgres: { success: true, output: 'production: ok' },
          couchdb: { success: true, output: 'couchdb not enabled on any stage, skipped' },
          garage: { success: false, output: 'no _system Garage key for stage production' },
        },
      },
      server_state: { success: true, output: 'snapshot def saved' },
      retention: { success: true, output: 'done' },
    },
    ...overrides,
  };
}

function dataWith(backups, extra = {}) {
  const base = makeData();
  return {
    ...base,
    backups,
    load: { ...base.load, backups: 'ok' },
    ...extra,
  };
}

describe('BackupsView', () => {
  it('renders the last-run breakdown with per-step outcomes', () => {
    render(<Host View={BackupsView} data={dataWith(makeBackups())} />);
    expect(screen.getByText('Backups')).toBeTruthy();
    expect(screen.getAllByText('tenant-a', { selector: 'td' }).length).toBe(4); // one row per step
    // The failed garage step surfaces its reason.
    expect(screen.getByText(/no _system Garage key/)).toBeTruthy();
    expect(screen.getByText('escrowed at AOC')).toBeTruthy();
  });

  it('shows the not-connected state without any controls', () => {
    render(<Host View={BackupsView} data={dataWith(makeBackups({ aoc_connected: false }))} />);
    expect(screen.getByText(/not connected to an AOC/)).toBeTruthy();
    expect(screen.queryByText('Run backup now')).toBeNull();
  });

  it('error banner retries the backups load', () => {
    const s = spies();
    const base = makeData();
    render(<Host View={BackupsView} data={{ ...base, backups: null, load: { ...base.load, backups: 'error' }, error: { backups: 'boom' } }} extra={s} />);
    fireEvent.click(screen.getByText('Retry'));
    expect(s.refresh).toHaveBeenCalledWith('backups');
  });

  it('run-now posts and starts tracking', async () => {
    const s = spies();
    installFetch({ '/bailey/api/admin/backups/run': { status: 202, json: { started: true } } });
    render(<Host View={BackupsView} data={dataWith(makeBackups())} extra={s} />);
    fireEvent.click(screen.getByText('Run backup now'));
    await waitFor(() => expect(s.toast).toHaveBeenCalledWith(expect.stringContaining('Backup run started')));
    expect(s.refresh).toHaveBeenCalledWith('backups', { background: true });
  });

  it('saving retention posts the edited values', async () => {
    const s = spies();
    const fetchMock = installFetch({ '/bailey/api/admin/backups/retention': { json: { enabled: true } } });
    render(<Host View={BackupsView} data={dataWith(makeBackups())} extra={s} />);
    const inputs = document.querySelectorAll('input[type="number"]');
    fireEvent.change(inputs[0], { target: { value: '14' } });
    fireEvent.click(screen.getByText('Save retention'));
    await waitFor(() => expect(s.toast).toHaveBeenCalledWith('Retention policy saved', 'success'));
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/retention'));
    expect(JSON.parse(call[1].body)).toEqual({ daily: 14, monthly: 12 });
  });

  it('local-only key warns and offers escrow; removing escrow demands confirm', async () => {
    const s = spies();
    installFetch({ '/bailey/api/admin/backups/key/mirror': { json: { mirrored: true } } });
    render(<Host View={BackupsView} data={dataWith(makeBackups({ key_mirrored: false }))} extra={s} />);
    expect(screen.getByText(/local only/)).toBeTruthy();
    fireEvent.click(screen.getByText('Escrow at AOC'));
    await waitFor(() => expect(s.toast).toHaveBeenCalledWith('Key escrowed at AOC', 'success'));
  });

  it('remove-escrow is cancellable via the confirm dialog', () => {
    const s = spies();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetchMock = installFetch({});
    render(<Host View={BackupsView} data={dataWith(makeBackups({ key_mirrored: true }))} extra={s} />);
    fireEvent.click(screen.getByText('Remove escrow'));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('permanently unrecoverable'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('disable/enable toggles post the flag', async () => {
    const s = spies();
    const fetchMock = installFetch({ '/bailey/api/admin/backups/enabled': { json: { enabled: false } } });
    render(<Host View={BackupsView} data={dataWith(makeBackups())} extra={s} />);
    fireEvent.click(screen.getByText('Disable'));
    await waitFor(() => expect(s.toast).toHaveBeenCalledWith('Backups disabled', 'info'));
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/enabled'));
    expect(JSON.parse(call[1].body)).toEqual({ enabled: false });
  });
});
