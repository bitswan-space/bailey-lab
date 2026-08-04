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
    key_acknowledged: true,
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
    expect(screen.getByText('saved off-server')).toBeTruthy();
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

  it('an unsaved key warns loudly and offers acknowledgement', async () => {
    const s2 = spies();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    installFetch({ '/bailey/api/admin/backups/key/acknowledge': { json: { acknowledged: true } } });
    render(<Host View={BackupsView} data={dataWith(makeBackups({ key_acknowledged: false }))} extra={s2} />);
    expect(screen.getByText(/NOT SAVED/)).toBeTruthy();
    fireEvent.click(screen.getByText('I have saved it'));
    await waitFor(() => expect(s2.toast).toHaveBeenCalledWith('Recorded that the key is saved off-server', 'success'));
  });

  it('acknowledgement is cancellable and posts nothing', () => {
    const s2 = spies();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetchMock = installFetch({});
    render(<Host View={BackupsView} data={dataWith(makeBackups({ key_acknowledged: false }))} extra={s2} />);
    fireEvent.click(screen.getByText('I have saved it'));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('permanently unreadable'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an acknowledged key offers no acknowledge button', () => {
    render(<Host View={BackupsView} data={dataWith(makeBackups())} />);
    expect(screen.queryByText('I have saved it')).toBeNull();
  });

  // Saving the key into the operator's password manager. jsdom has neither
  // PasswordCredential nor navigator.credentials, so each test installs exactly
  // the capability it is exercising and removes it again.
  describe('save to password manager', () => {
    const KEY = 'SUPER-SECRET-KEY-abc123';

    function withCredentialStore(store) {
      window.PasswordCredential = class {
        constructor(opts) { Object.assign(this, opts); }
      };
      Object.defineProperty(navigator, 'credentials', {
        value: { store }, configurable: true, writable: true,
      });
    }

    afterEach(() => {
      delete window.PasswordCredential;
      delete navigator.credentials;
      delete navigator.clipboard;
    });

    it('hands the key to the browser credential store when available', async () => {
      const s = spies();
      const store = vi.fn().mockResolvedValue(undefined);
      withCredentialStore(store);
      const fetchMock = installFetch({ '/bailey/api/admin/backups/key': { json: { key: KEY } } });
      render(<Host View={BackupsView} data={dataWith(makeBackups({ key_acknowledged: false }))} extra={s} />);

      fireEvent.click(screen.getByText('Save to password manager'));
      await waitFor(() => expect(store).toHaveBeenCalled());
      expect(store.mock.calls[0][0].password).toBe(KEY);
      expect(store.mock.calls[0][0].id).toContain('backup-key@');

      // The browser prompt was raised, so the manual form stays away.
      expect(screen.queryByLabelText('Backup encryption key')).toBeNull();
      // store() resolves whether or not the operator accepted, so custody must
      // NOT be recorded off the back of it.
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/key/acknowledge'))).toBe(false);
      expect(screen.getByText(/NOT SAVED/)).toBeTruthy();
    });

    it('falls back to a manager-readable form when the browser has no credential store', async () => {
      installFetch({ '/bailey/api/admin/backups/key': { json: { key: KEY } } });
      render(<Host View={BackupsView} data={dataWith(makeBackups())} />);

      fireEvent.click(screen.getByText('Save to password manager'));
      const field = await waitFor(() => screen.getByLabelText('Backup encryption key'));

      // The semantics are the whole point: managers key off a form holding a
      // username and a new-password field, so assert them rather than the look.
      expect(field.value).toBe(KEY);
      expect(field.getAttribute('autocomplete')).toBe('new-password');
      expect(field.type).toBe('password');
      expect(field.closest('form')).toBeTruthy();
      const user = screen.getByLabelText('Password manager entry name');
      expect(user.getAttribute('autocomplete')).toBe('username');
      expect(field.closest('form')).toBe(user.closest('form'));
    });

    it('falls back to the form when the credential store refuses', async () => {
      withCredentialStore(vi.fn().mockRejectedValue(new Error('policy')));
      installFetch({ '/bailey/api/admin/backups/key': { json: { key: KEY } } });
      render(<Host View={BackupsView} data={dataWith(makeBackups())} />);

      fireEvent.click(screen.getByText('Save to password manager'));
      const field = await waitFor(() => screen.getByLabelText('Backup encryption key'));
      expect(field.value).toBe(KEY);
    });

    it('reveal unmasks the key and Done drops it from the page', async () => {
      installFetch({ '/bailey/api/admin/backups/key': { json: { key: KEY } } });
      render(<Host View={BackupsView} data={dataWith(makeBackups())} />);
      fireEvent.click(screen.getByText('Save to password manager'));
      await waitFor(() => screen.getByLabelText('Backup encryption key'));

      fireEvent.click(screen.getByText('Reveal'));
      expect(screen.getByLabelText('Backup encryption key').type).toBe('text');
      fireEvent.click(screen.getByText('Hide'));
      expect(screen.getByLabelText('Backup encryption key').type).toBe('password');

      fireEvent.click(screen.getByText('Done'));
      expect(screen.queryByLabelText('Backup encryption key')).toBeNull();
    });

    it('copy puts the key on the clipboard', async () => {
      const s = spies();
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText }, configurable: true, writable: true,
      });
      installFetch({ '/bailey/api/admin/backups/key': { json: { key: KEY } } });
      render(<Host View={BackupsView} data={dataWith(makeBackups())} extra={s} />);
      fireEvent.click(screen.getByText('Save to password manager'));
      await waitFor(() => screen.getByLabelText('Backup encryption key'));

      fireEvent.click(screen.getByText('Copy'));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(KEY));
      expect(s.toast).toHaveBeenCalledWith('Key copied to clipboard', 'success');
    });

    it('a failed key fetch surfaces the error and shows no form', async () => {
      const s = spies();
      installFetch({ '/bailey/api/admin/backups/key': { status: 500, json: { error: 'boom' } } });
      render(<Host View={BackupsView} data={dataWith(makeBackups())} extra={s} />);
      fireEvent.click(screen.getByText('Save to password manager'));
      await waitFor(() => expect(s.toast).toHaveBeenCalledWith(expect.stringContaining('Could not fetch key'), 'danger'));
      expect(screen.queryByLabelText('Backup encryption key')).toBeNull();
    });
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
