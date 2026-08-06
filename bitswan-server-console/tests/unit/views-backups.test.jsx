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
    images: true,
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
  // The last run collapses to one status line. A backup report is something you
  // check, not read: the answer is nearly always "fine", and a run over a dozen
  // workspaces was a fifty-row flat table where one red cell was easy to miss.
  it('collapses the last run to a status line', () => {
    render(<Host View={BackupsView} data={dataWith(makeBackups())} />);
    expect(screen.getByText('Backups')).toBeTruthy();

    // The status is visible without opening anything, failure count included —
    // collapsing must not hide the one thing worth knowing at a glance.
    expect(screen.getByText('finished with errors')).toBeTruthy();
    expect(screen.getByText('1 of 6 steps failed')).toBeTruthy();

    // ...and the breakdown is not rendered until asked for.
    expect(screen.queryByText('Automation server')).toBeNull();
    expect(screen.queryByText(/no _system Garage key/)).toBeNull();
  });

  it('separates the automation server from the workspaces, failures first', () => {
    // 'aaa-clean' sorts before 'tenant-a' alphabetically, so if it appears second
    // the ordering is being driven by failure rather than by name.
    const backups = makeBackups();
    backups.last_run.workspaces['aaa-clean'] = {
      files: { success: true, output: 'snapshot ok' },
    };
    render(<Host View={BackupsView} data={dataWith(backups)} />);

    fireEvent.click(screen.getByText('1 of 7 steps failed'));

    const headings = screen.getAllByRole('button')
      .map(b => b.textContent)
      .filter(t => /Automation server|tenant-a|aaa-clean/.test(t));
    expect(headings[0]).toMatch(/tenant-a/);   // the only group with a failure
    expect(headings.slice(1).join(' ')).toMatch(/Automation server/);
    expect(headings.slice(1).join(' ')).toMatch(/aaa-clean/);
  });

  it('opens the group that failed and leaves the clean ones shut', () => {
    const backups = makeBackups();
    backups.last_run.workspaces['aaa-clean'] = {
      files: { success: true, output: 'snapshot ok' },
    };
    render(<Host View={BackupsView} data={dataWith(backups)} />);
    fireEvent.click(screen.getByText('1 of 7 steps failed'));

    // The failing workspace is already expanded, reason showing: the point is
    // that a problem needs no hunting for.
    expect(screen.getByText(/no _system Garage key/)).toBeTruthy();
    // The clean groups stay collapsed to a count.
    expect(screen.queryByText('snapshot ok')).toBeNull();
    expect(screen.getByText('1 ok')).toBeTruthy();

    fireEvent.click(screen.getByText('aaa-clean'));
    expect(screen.getByText('snapshot ok')).toBeTruthy();
  });

  it('says all clear when nothing failed', () => {
    const backups = makeBackups();
    backups.last_run.workspaces['tenant-a'].garage = { success: true, output: 'ok' };
    render(<Host View={BackupsView} data={dataWith(backups)} />);
    expect(screen.getByText('completed')).toBeTruthy();
    expect(screen.getByText('all 6 steps ok')).toBeTruthy();
  });

  it('groups the images step under the automation server, not a workspace', () => {
    // Image archives are the server's own work; before grouping they sat in the
    // same flat list as every workspace's files/postgres/garage rows.
    const backups = makeBackups();
    backups.last_run.images = { success: true, output: '30 image(s), 105 tag(s)' };
    render(<Host View={BackupsView} data={dataWith(backups)} />);
    fireEvent.click(screen.getByText('1 of 7 steps failed'));
    fireEvent.click(screen.getByText('Automation server'));
    expect(screen.getByText('30 image(s), 105 tag(s)')).toBeTruthy();
  });

  // Image archives are on by default and are the biggest thing in the repo, so
  // the status has to say whether they are being made — otherwise the only way to
  // find out is reading backup/config.json over SSH.
  it('says whether business-process images are included', () => {
    render(<Host View={BackupsView} data={dataWith(makeBackups())} />);
    expect(screen.getByText('+ BP images')).toBeTruthy();
  });

  it('says so when image archives are switched off', () => {
    render(<Host View={BackupsView} data={dataWith(makeBackups({ images: false }))} />);
    expect(screen.getByText('images excluded')).toBeTruthy();
    expect(screen.queryByText('+ BP images')).toBeNull();
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

  // Saving the key into the operator's password manager.
  //
  // The console lives on the inner host inside a cross-origin iframe, where no
  // browser will offer to save a credential: navigator.credentials.store()
  // rejects outside a top-level browsing context and native prompts are
  // suppressed in cross-origin frames. An in-page form was tried and produced
  // nothing in Firefox and nothing in Chrome until it later unmounted. So the
  // only thing this button may do is open the server-rendered page TOP-LEVEL.
  describe('save to password manager', () => {
    it('opens the server-rendered save page in a top-level window', () => {
      const open = vi.fn().mockReturnValue({ focus: vi.fn() });
      vi.stubGlobal('open', open);
      render(<Host View={BackupsView} data={dataWith(makeBackups())} />);

      fireEvent.click(screen.getByText('Save to password manager'));

      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0][0]).toBe('/bailey/key-save');
      // A named target, so repeated clicks reuse the tab rather than stacking
      // windows that each hold the key.
      expect(open.mock.calls[0][1]).toBe('bitswan-save-backup-key');
    });

    it('never renders the key inside the console itself', async () => {
      // The iframe is why the in-page form could not work; putting the key back
      // into this document would reintroduce it without the button changing.
      const open = vi.fn().mockReturnValue({ focus: vi.fn() });
      vi.stubGlobal('open', open);
      const fetchMock = installFetch({ '/bailey/api/admin/backups/key': { json: { key: 'SECRET' } } });
      const { container } = render(<Host View={BackupsView} data={dataWith(makeBackups())} />);

      fireEvent.click(screen.getByText('Save to password manager'));

      expect(container.querySelector('input[type="password"]')).toBeNull();
      expect(container.textContent).not.toContain('SECRET');
      // It must not even fetch the key: the save page loads it server-side.
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/backups/key'))).toBe(false);
    });

    it('says so when the popup is blocked', async () => {
      const s = spies();
      vi.stubGlobal('open', vi.fn().mockReturnValue(null));
      render(<Host View={BackupsView} data={dataWith(makeBackups())} extra={s} />);

      fireEvent.click(screen.getByText('Save to password manager'));

      await waitFor(() => expect(s.toast).toHaveBeenCalledWith(
        expect.stringContaining('blocked the popup'), 'danger'));
    });

    it('is disabled until a key exists', () => {
      render(<Host View={BackupsView} data={dataWith(makeBackups({ has_key: false }))} />);
      expect(screen.getByText('Save to password manager').closest('button').disabled).toBe(true);
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
