import React from 'react';
// views-backups.jsx — admin "Backups": the server-level backup made nightly by
// the daemon (every workspace's full tree INCLUDING secrets, per-stage DB
// dumps, and the server's own state, into one restic repo per server via the
// AOC proxy). This panel is status + run-now + retention + key custody; the
// key decrypts secrets, so it surfaces only here (admin console) and in the
// host CLI — never in a workspace dashboard.

const { C: WC, Icon: WIcon, Pill: WPill, Btn: WBtn } = window.WD_SHELL;
const { Card: WCard, PageHeader: WPageHeader, LiveState: WLiveState } = window.SC_UI;
const { Api: BApi } = window.SC_API;
const { useState: useBS, useEffect: useBE, useRef: useBR } = React;

// Server-rendered save page (bailey_key_save_page.go). Opened top-level, never
// fetched or framed: a password manager only offers to save from a real
// document with a real navigating form submit.
const KEY_SAVE_PATH = '/bailey/key-save';

function fmtWhen(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch (e) { return iso; }
}

const STEP_LABELS = {
  files: 'Files',
  postgres: 'Postgres',
  couchdb: 'CouchDB',
  garage: 'Object storage',
  state: 'Server state',
  images: 'Business-process images',
  retention: 'Retention',
};

// A run's steps, grouped so the automation server's own work is not interleaved
// with the workspaces'. A run over a dozen workspaces is otherwise a fifty-row
// flat table in which one red cell is easy to miss.
//
// Ordered by failure, twice over: groups that failed come first, and inside a
// group the failed steps come first. Opening the panel therefore puts the
// problem at the top without anyone scanning for it.
function runGroups(lastRun) {
  const groups = [];

  const serverSteps = [];
  for (const [name, result] of [
    ['state', lastRun.server_state],
    ['images', lastRun.images],
    ['retention', lastRun.retention],
  ]) {
    if (result) serverSteps.push({ name, result });
  }
  if (serverSteps.length) {
    groups.push({ key: 'server', title: 'Automation server', icon: 'server', steps: serverSteps });
  }

  for (const ws of Object.keys(lastRun.workspaces || {}).sort()) {
    const report = lastRun.workspaces[ws] || {};
    const steps = Object.keys(report).sort().map(name => ({ name, result: report[name] }));
    if (steps.length) groups.push({ key: `ws:${ws}`, title: ws, icon: 'folder', steps });
  }

  for (const g of groups) {
    g.failed = g.steps.filter(s => !s.result || !s.result.success).length;
    g.steps.sort((a, b) =>
      (Number(!!(a.result && a.result.success)) - Number(!!(b.result && b.result.success)))
      || a.name.localeCompare(b.name));
  }
  // Stable sort, so ties keep insertion order: the server group stays ahead of
  // the workspaces within each failure class.
  return groups.sort((a, b) => (b.failed > 0) - (a.failed > 0));
}

function StepRow({ name, result }) {
  const ok = !!(result && result.success);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '5px 0 5px 30px' }}>
      <WIcon name={ok ? 'check' : 'alert-triangle'} size={13} color={ok ? WC.green : WC.red}
        style={{ marginTop: 2 }} />
      <span style={{ fontSize: 12.5, color: WC.fg, flex: '0 0 168px' }}>
        {STEP_LABELS[name] || name}
      </span>
      <span style={{ fontSize: 12, color: ok ? WC.muted : WC.red, flex: 1, wordBreak: 'break-word' }}>
        {(result && result.output) || (ok ? '' : 'failed')}
      </span>
    </div>
  );
}

function RunGroup({ group }) {
  // Open iff something in it failed. A clean group is a line and a count; the
  // detail only earns its space when there is something wrong in it.
  const [open, setOpen] = useBS(group.failed > 0);
  return (
    <div style={{ borderTop: `1px solid ${WC.surface2}` }}>
      <button type="button" onClick={() => setOpen(!open)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '9px 0',
          background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
          textAlign: 'left' }}>
        <WIcon name={open ? 'chevron-down' : 'chevron-right'} size={14} color={WC.mutedFg} />
        <WIcon name={group.icon} size={14} color={WC.muted} />
        <span style={{ fontSize: 13, fontWeight: 600, color: WC.fg }}>{group.title}</span>
        <span style={{ flex: 1 }} />
        {group.failed > 0
          ? <WPill tone="danger">{group.failed} failed</WPill>
          : <WPill tone="success">{group.steps.length} ok</WPill>}
      </button>
      {open && (
        <div style={{ paddingBottom: 8 }}>
          {group.steps.map(s => <StepRow key={s.name} name={s.name} result={s.result} />)}
        </div>
      )}
    </div>
  );
}

// The last run, collapsed to a single status line until asked for. Backups are
// something you check rather than read: the answer is almost always "fine", and
// the breakdown is only interesting when it is not.
function LastRunPanel({ lastRun }) {
  const [open, setOpen] = useBS(false);
  if (!lastRun) {
    return (
      <div style={{ fontSize: 13, color: WC.muted, padding: '10px 0' }}>
        No backup has run yet. The nightly run happens at 02:00 UTC; use “Run backup now” to make the first one.
      </div>
    );
  }
  const groups = runGroups(lastRun);
  const total = groups.reduce((n, g) => n + g.steps.length, 0);
  const failed = groups.reduce((n, g) => n + g.failed, 0);

  return (
    <div style={{ borderTop: `1px solid ${WC.surface2}`, marginTop: 4 }}>
      <button type="button" onClick={() => setOpen(!open)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '11px 0',
          background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
          textAlign: 'left', flexWrap: 'wrap' }}>
        <WIcon name={open ? 'chevron-down' : 'chevron-right'} size={15} color={WC.mutedFg} />
        {failed > 0
          ? <WPill tone="danger">finished with errors</WPill>
          : <WPill tone="success">completed</WPill>}
        <span style={{ fontSize: 12.5, color: failed > 0 ? WC.red : WC.muted, fontWeight: failed > 0 ? 600 : 400 }}>
          {failed > 0 ? `${failed} of ${total} steps failed` : `all ${total} steps ok`}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12.5, color: WC.muted }}>finished {fmtWhen(lastRun.finished_at)}</span>
      </button>
      {open && <div>{groups.map(g => <RunGroup key={g.key} group={g} />)}</div>}
    </div>
  );
}

function BackupsView({ ctx }) {
  const { data, toast, refresh } = ctx;
  const backups = data.backups; // GET /bailey/api/admin/backups
  const [busy, setBusy] = useBS('');
  const [daily, setDaily] = useBS(null);
  const [monthly, setMonthly] = useBS(null);
  const pollRef = useBR(null);

  // While a run is in flight, poll status in the background until it lands.
  useBE(() => {
    if (!(backups && backups.running)) return undefined;
    pollRef.current = setInterval(() => refresh('backups', { background: true }), 5000);
    return () => clearInterval(pollRef.current);
  }, [backups && backups.running]);

  const runNow = async () => {
    setBusy('run');
    try {
      await BApi.backupsRun();
      toast('Backup run started — this page tracks it live.');
      await refresh('backups', { background: true });
    } catch (e) { toast(`Could not start backup: ${e.message}`, 'danger'); }
    setBusy('');
  };

  const saveRetention = async () => {
    setBusy('retention');
    try {
      await BApi.backupsRetention(
        daily != null ? daily : backups.retention.daily,
        monthly != null ? monthly : backups.retention.monthly,
      );
      toast('Retention policy saved', 'success');
      setDaily(null); setMonthly(null);
      await refresh('backups', { background: true });
    } catch (e) { toast(`Could not save retention: ${e.message}`, 'danger'); }
    setBusy('');
  };

  const setEnabled = async (enabled) => {
    setBusy('enabled');
    try {
      await BApi.backupsEnabled(enabled);
      toast(enabled ? 'Backups enabled' : 'Backups disabled', enabled ? 'success' : 'info');
      await refresh('backups', { background: true });
    } catch (e) { toast(`Could not change setting: ${e.message}`, 'danger'); }
    setBusy('');
  };

  const downloadKey = async () => {
    setBusy('key');
    try {
      const r = await BApi.backupsKey();
      const blob = new Blob([r.key], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'backup-encryption-key.txt';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast('Key downloaded — store it somewhere safe, OFF this server.', 'success');
    } catch (e) { toast(`Could not fetch key: ${e.message}`, 'danger'); }
    setBusy('');
  };

  // Opening the save page in a TOP-LEVEL window, which is the whole point.
  //
  // The console runs on the inner host inside a cross-origin iframe, and there a
  // browser will not offer to save a credential at all: navigator.credentials
  // .store() rejects outside a top-level browsing context, and native save
  // prompts are suppressed in cross-origin frames. An in-page form here produced
  // nothing in Firefox, and nothing in Chrome until the form later unmounted and
  // tripped an unrelated heuristic. The page this opens is server-rendered with a
  // real form that really navigates on submit — see bailey_key_save_page.go.
  const openKeySavePage = () => {
    const win = window.open(KEY_SAVE_PATH, 'bitswan-save-backup-key');
    if (!win) {
      toast('Your browser blocked the popup — allow popups for this site, or use Download.', 'danger');
      return;
    }
    win.focus();
  };

  // With no escrow the key exists only on this server, so the operator
  // confirming they stored a copy is the only signal that it exists anywhere
  // else. Saving it to a password manager (or downloading) is what makes that
  // true; this records it.
  const acknowledgeKey = async () => {
    const ok = window.confirm(
      'Confirm that you have stored the encryption key somewhere safe, OFF this server.\n\n' +
      'It is not saved anywhere else. If this server is lost without your copy, every backup ' +
      'is permanently unreadable.',
    );
    if (!ok) return;
    setBusy('ack');
    try {
      await BApi.backupsKeyAcknowledge();
      toast('Recorded that the key is saved off-server', 'success');
      await refresh('backups', { background: true });
    } catch (e) { toast(`Could not record it: ${e.message}`, 'danger'); }
    setBusy('');
  };

  return (
    <div style={{ padding: 24, maxWidth: 980 }}>
      <WPageHeader
        icon="database-backup"
        title="Backups"
        subtitle="Nightly server-level backup: every workspace's full state (including secrets), database dumps per stage, and the server's own configuration — one encrypted repository per server, stored off-site through the AOC."
      />
      <WLiveState status={data.load.backups} error={data.error.backups} label="backup status" onRetry={() => refresh('backups')} />

      {backups && (<>
        {!backups.aoc_connected && (
          <WCard style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, color: WC.muted, padding: '6px 0' }}>
              This server is not connected to an AOC — there is nowhere to store off-site backups.
              Register the server (<code>bitswan register</code>) to enable them.
            </div>
          </WCard>
        )}

        {backups.aoc_connected && (<>
          <WCard title="Status" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '4px 0 10px' }}>
              {backups.enabled
                ? <WPill tone="success" leftIcon="check">enabled</WPill>
                : <WPill tone="danger" leftIcon="pause">disabled</WPill>}
              {backups.running && <WPill tone="info">backing up…</WPill>}
              {/* On by default and the largest single thing in the repo, so an
                  operator surprised by their storage should be able to see it
                  without reading backup/config.json over SSH. */}
              {backups.images
                ? <WPill tone="neutral">+ BP images</WPill>
                : <WPill tone="neutral">images excluded</WPill>}
              <span style={{ flex: 1 }} />
              {backups.enabled
                ? <WBtn variant="ghost" size="sm" disabled={busy !== ''} onClick={() => setEnabled(false)}>Disable</WBtn>
                : <WBtn variant="primary" size="sm" disabled={busy !== ''} onClick={() => setEnabled(true)}>Enable</WBtn>}
              <WBtn variant="primary" size="sm" leftIcon="play"
                disabled={busy !== '' || backups.running || !backups.enabled || !backups.has_key}
                onClick={runNow}>
                {backups.running ? 'Backing up…' : 'Run backup now'}
              </WBtn>
            </div>
            {backups.reason && !backups.running && (
              <div style={{ fontSize: 12.5, color: WC.muted, paddingBottom: 8 }}>{backups.reason}</div>
            )}
            <LastRunPanel lastRun={backups.last_run} />
          </WCard>

          <WCard title="Encryption key" style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12.5, color: WC.muted, padding: '2px 0 10px' }}>
              Backups include workspace secrets, so this key is the whole ballgame. It is stored
              <strong> nowhere but this server</strong> — there is no escrow. Save it to your password
              manager: without your copy, losing this server makes every backup permanently
              unreadable.
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {backups.has_key && backups.key_acknowledged && (
                <WPill tone="success" leftIcon="check">saved off-server</WPill>
              )}
              {backups.has_key && !backups.key_acknowledged && (
                <WPill tone="danger" leftIcon="alert-triangle">NOT SAVED — backups are unrecoverable if this server is lost</WPill>
              )}
              {!backups.has_key && <WPill tone="neutral">no key yet — generated on the first run</WPill>}
              <span style={{ flex: 1 }} />
              <WBtn variant="primary" size="sm" leftIcon="key-round" disabled={!backups.has_key} onClick={openKeySavePage}>
                Save to password manager
              </WBtn>
              <WBtn variant="ghost" size="sm" leftIcon="download" disabled={busy !== '' || !backups.has_key} onClick={downloadKey}>Download</WBtn>
              {backups.has_key && !backups.key_acknowledged && (
                <WBtn variant="ghost" size="sm" leftIcon="check" disabled={busy !== ''} onClick={acknowledgeKey}>I have saved it</WBtn>
              )}
            </div>

          </WCard>

          <WCard title="Retention">
            <div style={{ fontSize: 12.5, color: WC.muted, padding: '2px 0 10px' }}>
              How many backups to keep, per workspace × service × stage series. Pruned after each nightly run.
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, flexWrap: 'wrap' }}>
              {[['Daily', daily, setDaily, 'daily'], ['Monthly', monthly, setMonthly, 'monthly']].map(([label, val, setVal, key]) => (
                <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, color: WC.muted }}>
                  {label}
                  <input
                    type="number" min={key === 'daily' ? 1 : 0} max={3650}
                    value={val != null ? val : (backups.retention ? backups.retention[key] : '')}
                    onChange={e => setVal(Math.max(0, parseInt(e.target.value || '0', 10)))}
                    style={{ width: 90, padding: '7px 9px', borderRadius: 8, border: `1px solid ${WC.surface2}`,
                      background: WC.bg, color: WC.fg, fontSize: 13 }}
                  />
                </label>
              ))}
              <WBtn variant="primary" size="sm" disabled={busy !== '' || (daily == null && monthly == null)} onClick={saveRetention}>
                Save retention
              </WBtn>
            </div>
          </WCard>
        </>)}
      </>)}
    </div>
  );
}

window.SC_BACKUPS = { BackupsView };
