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

function fmtWhen(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch (e) { return iso; }
}

function stepRow(ws, step, result) {
  return (
    <tr key={`${ws}/${step}`}>
      <td style={{ padding: '7px 12px', fontSize: 12.5, color: WC.fg, fontFamily: 'Geist Mono, monospace' }}>{ws}</td>
      <td style={{ padding: '7px 12px', fontSize: 12.5, color: WC.muted }}>{step}</td>
      <td style={{ padding: '7px 12px' }}>
        {result.success
          ? <WPill tone="success">ok</WPill>
          : <WPill tone="danger">failed</WPill>}
      </td>
      <td style={{ padding: '7px 12px', fontSize: 12, color: result.success ? WC.muted : WC.red,
        maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={result.output}>
        {result.output || ''}
      </td>
    </tr>
  );
}

function LastRunTable({ lastRun }) {
  if (!lastRun) {
    return (
      <div style={{ fontSize: 13, color: WC.muted, padding: '10px 0' }}>
        No backup has run yet. The nightly run happens at 02:00 UTC; use “Run backup now” to make the first one.
      </div>
    );
  }
  const workspaces = Object.keys(lastRun.workspaces || {}).sort();
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0 10px' }}>
        {lastRun.ok
          ? <WPill tone="success" leftIcon="check">completed</WPill>
          : <WPill tone="danger" leftIcon="alert-triangle">finished with errors</WPill>}
        <span style={{ fontSize: 12.5, color: WC.muted }}>finished {fmtWhen(lastRun.finished_at)}</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${WC.surface2}` }}>
              {['Workspace', 'Step', 'Result', 'Detail'].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '6px 12px', fontSize: 11.5, color: WC.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {workspaces.flatMap(ws => {
              const report = lastRun.workspaces[ws] || {};
              return Object.keys(report).sort().map(step => stepRow(ws, step, report[step]));
            })}
            {lastRun.server_state ? stepRow('(server)', 'state', lastRun.server_state) : null}
            {lastRun.retention ? stepRow('(repo)', 'retention', lastRun.retention) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

function BackupsView({ ctx }) {
  const { data, toast, refresh } = ctx;
  const backups = data.backups; // GET /bailey/api/admin/backups
  const [busy, setBusy] = useBS('');
  const [daily, setDaily] = useBS(null);
  const [monthly, setMonthly] = useBS(null);
  // The key is fetched on demand and held here only while the manual save form
  // is open, then dropped — it is never in component state at rest.
  const [pmKey, setPmKey] = useBS('');
  const [pmReveal, setPmReveal] = useBS(false);
  const pollRef = useBR(null);
  const pmFormRef = useBR(null);

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

  // pmIdentity is the username the key is filed under. The hostname is already
  // implicit in the origin a manager binds the entry to; spelling it out just
  // makes the vault entry legible when an operator looks for it years later,
  // under pressure, next to entries for every other server they run.
  const pmIdentity = () => `backup-key@${window.location.hostname}`;

  // Saving the key into the operator's own password manager — the custody path
  // that replaces "download a .txt and remember where you put it".
  //
  // Two mechanisms, because the programmatic one is Chrome/Edge-only:
  // navigator.credentials.store() raises the browser's own save prompt, and
  // everywhere else the only reliable trigger is a real form with login
  // semantics that a manager recognises, so we render one.
  //
  // Deliberately does NOT acknowledge. store() resolves whether the operator
  // accepted the prompt or dismissed it, and no API reports which — so
  // treating it as proof of custody would record a copy that may not exist.
  // Confirming stays a separate, explicit claim by the operator.
  const saveKeyToPasswordManager = async () => {
    setBusy('key');
    let key = '';
    try {
      key = (await BApi.backupsKey()).key;
    } catch (e) {
      toast(`Could not fetch key: ${e.message}`, 'danger');
      setBusy('');
      return;
    }
    if (window.PasswordCredential && navigator.credentials && navigator.credentials.store) {
      try {
        await navigator.credentials.store(new window.PasswordCredential({
          id: pmIdentity(),
          password: key,
          name: `Bitswan backup encryption key — ${window.location.hostname}`,
        }));
        toast('Your browser should now offer to save the key — accept it, then confirm below.', 'success');
        setBusy('');
        return;
      } catch (e) {
        // Fall through to the form. A refused store() (browser policy, lost
        // user gesture, no manager configured) is not a reason to leave the
        // operator with no way to save the key.
      }
    }
    setPmReveal(false);
    setPmKey(key);
    setBusy('');
  };

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(pmKey);
      toast('Key copied to clipboard', 'success');
    } catch (e) {
      toast('Could not copy — reveal the key and select it by hand', 'danger');
    }
  };

  // Btn renders type="button", so nothing here submits by accident; the save
  // action asks the form to submit explicitly. onSubmit preventDefaults, so the
  // page never navigates — the submit event exists purely because that is what
  // extension-based managers watch for to offer saving.
  const offerToSave = () => {
    const form = pmFormRef.current;
    if (form && form.requestSubmit) form.requestSubmit();
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
              {backups.running && <WPill tone="info" leftIcon="loader">backing up…</WPill>}
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
            <LastRunTable lastRun={backups.last_run} />
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
              <WBtn variant="primary" size="sm" leftIcon="key-round" disabled={busy !== '' || !backups.has_key} onClick={saveKeyToPasswordManager}>
                Save to password manager
              </WBtn>
              <WBtn variant="ghost" size="sm" leftIcon="download" disabled={busy !== '' || !backups.has_key} onClick={downloadKey}>Download</WBtn>
              {backups.has_key && !backups.key_acknowledged && (
                <WBtn variant="ghost" size="sm" leftIcon="check" disabled={busy !== ''} onClick={acknowledgeKey}>I have saved it</WBtn>
              )}
            </div>

            {pmKey && (
              <div style={{ marginTop: 14, padding: 12, borderRadius: 8, border: `1px solid ${WC.surface2}`, background: WC.bg }}>
                <div style={{ fontSize: 12.5, color: WC.muted, paddingBottom: 10 }}>
                  Your password manager should offer to save this once you press <strong>Offer to save</strong>.
                  If it does not, copy the key and add it by hand — then confirm you have saved it.
                </div>
                <form ref={pmFormRef} onSubmit={e => e.preventDefault()}
                  style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 520 }}>
                  <input
                    type="text" name="username" autoComplete="username" readOnly
                    aria-label="Password manager entry name" value={pmIdentity()}
                    style={{ padding: '7px 9px', borderRadius: 8, border: `1px solid ${WC.surface2}`,
                      background: WC.surface2, color: WC.muted, fontSize: 13 }}
                  />
                  <input
                    type={pmReveal ? 'text' : 'password'} name="password" autoComplete="new-password" readOnly
                    aria-label="Backup encryption key" value={pmKey}
                    style={{ padding: '7px 9px', borderRadius: 8, border: `1px solid ${WC.surface2}`,
                      background: WC.bg, color: WC.fg, fontSize: 13, fontFamily: 'Geist Mono, monospace' }}
                  />
                </form>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  <WBtn variant="primary" size="sm" onClick={offerToSave}>Offer to save</WBtn>
                  <WBtn variant="ghost" size="sm" leftIcon="copy" onClick={copyKey}>Copy</WBtn>
                  <WBtn variant="ghost" size="sm" onClick={() => setPmReveal(!pmReveal)}>{pmReveal ? 'Hide' : 'Reveal'}</WBtn>
                  <span style={{ flex: 1 }} />
                  <WBtn variant="ghost" size="sm" onClick={() => { setPmKey(''); setPmReveal(false); }}>Done</WBtn>
                </div>
              </div>
            )}
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
