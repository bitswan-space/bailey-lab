import React from 'react';
// views-updates.jsx — admin "Updates": what's behind on this server, plus an
// audit log of who updated what to which version and when. Both workspace
// updates and the server binary apply from here; each update is recorded in the
// version ledger, and the last few versions can be rolled back to from the
// history list (bounded server-side — no CLI needed).

const { C: WC, Icon: WIcon, Pill: WPill, Btn: WBtn } = window.WD_SHELL;
const { Card: WCard, PageHeader: WPageHeader, UpdateBar: WUpdateBar, Modal: WModal } = window.SC_UI;
const { Api: UApi } = window.SC_API;
const { useState: useUS } = React;

// Absolute local timestamp — unambiguous for an audit trail.
function fmtWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleString();
}

function UpdatesView({ ctx }) {
  const { data, toast, refresh } = ctx;
  const upd = data.updates; // { server, workspaces, count, history, rollback_depth }
  const [busy, setBusy] = useUS('');
  const [prog, setProg] = useUS(null); // { fraction, label } for the workspace being updated
  const [srvBusy, setSrvBusy] = useUS(false);
  const [srvProg, setSrvProg] = useUS(null);
  const [rbId, setRbId] = useUS(0);       // update-history id currently being rolled back
  const [confirm, setConfirm] = useUS(null); // history entry pending rollback confirmation

  // Drive a server-binary op (update OR rollback): both swap the host binary and
  // restart the daemon, so the NDJSON stream ends at 'restarting' and we poll the
  // version until it flips. `run` is the API call taking (onEvent).
  const runServerOp = async (run, okMsg) => {
    setSrvBusy(true);
    setSrvProg({ fraction: 0, label: 'Starting…' });
    const before = (upd && upd.server && upd.server.current) || '';
    let sawError = false;
    try {
      await run((ev) => {
        if (!ev) return;
        if (ev.event === 'error') sawError = true;
        if (typeof ev.fraction === 'number') setSrvProg({ fraction: ev.fraction, label: ev.message || '' });
        else if (ev.message) setSrvProg(p => ({ fraction: (p && p.fraction) || 0, label: ev.message }));
      });
    } catch (e) {
      // An in-stream error (nothing swapped) is real; any other drop is the
      // daemon restarting onto the new binary — fall through to version polling.
      if (sawError) {
        toast(`Server update failed: ${e.message}`, 'danger');
        setSrvBusy(false); setSrvProg(null); setRbId(0);
        return;
      }
    }
    setSrvProg({ fraction: 0.96, label: 'Restarting server…' });
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const r2 = await UApi.adminUpdates();
        if (r2 && r2.server && r2.server.current && r2.server.current !== before) {
          toast(okMsg, 'success');
          await refresh('updates');
          setSrvBusy(false); setSrvProg(null); setRbId(0);
          return;
        }
      } catch (e) { /* still restarting — keep polling */ }
    }
    toast('Server is restarting — refresh in a moment.');
    setSrvBusy(false); setSrvProg(null); setRbId(0);
  };

  const doServerUpdate = () => runServerOp(UApi.serverUpdate, 'Server updated');
  const doServerRollback = (entry) => {
    setRbId(entry.id);
    return runServerOp((onEvent) => UApi.serverRollback(entry.id, onEvent), `Rolled back to ${entry.from_version}`);
  };

  // Drive a workspace op (update OR rollback) — determinate NDJSON progress.
  const runWorkspaceOp = async (name, run, okMsg) => {
    setBusy(name);
    setProg({ fraction: 0, label: 'Starting…' });
    try {
      await run((ev) => {
        if (!ev) return;
        if (typeof ev.fraction === 'number') setProg({ fraction: ev.fraction, label: ev.message || '' });
        else if (ev.message) setProg(p => ({ fraction: (p && p.fraction) || 0, label: ev.message }));
      });
      toast(okMsg, 'success');
      await refresh('updates');
      await refresh('workspaces');
    } catch (e) {
      toast(`Couldn't update ${name}: ${e.message}`, 'danger');
    } finally { setBusy(''); setProg(null); setRbId(0); }
  };

  const doUpgrade = (name) => runWorkspaceOp(name, (onEvent) => UApi.upgradeWorkspace(name, onEvent), `${name} updated`);
  const doWorkspaceRollback = (entry) => {
    setRbId(entry.id);
    return runWorkspaceOp(entry.target_name,
      (onEvent) => UApi.rollbackWorkspace(entry.target_name, entry.id, onEvent),
      `${entry.target_name} rolled back to ${entry.from_version}`);
  };

  // A rollback is a real change — the server restarts (the console reconnects),
  // a workspace recreates its containers — so it goes through an explicit
  // confirm dialog rather than firing on the first click.
  const confirmRollback = () => {
    const h = confirm;
    if (!h) return;
    setConfirm(null);
    if (h.target_kind === 'server') doServerRollback(h);
    else doWorkspaceRollback(h);
  };

  const history = (upd && upd.history) || [];
  const depth = (upd && upd.rollback_depth) || 3;
  const anyBusy = srvBusy || !!busy;

  // One audit-log / rollback row.
  const HistoryRow = (h, i) => {
    const isServer = h.target_kind === 'server';
    const label = isServer ? 'Automation server' : h.target_name;
    const verb = h.is_rollback ? 'rolled back' : 'updated';
    const rolling = rbId === h.id;
    return (
      <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0',
        borderTop: i === 0 ? 'none' : `1px solid ${WC.border}` }}>
        <WIcon name={isServer ? 'server' : 'layout-grid'} size={15} color={WC.muted} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, color: WC.fg, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600 }}>{label}</span>
            {h.is_rollback && <WPill tone="warning" size="xs">rollback</WPill>}
          </div>
          <div style={{ fontSize: 11.5, color: WC.muted, fontFamily: 'monospace' }}>
            {h.from_version || '?'} → {h.to_version || '?'}
          </div>
          <div style={{ fontSize: 11.5, color: WC.muted, marginTop: 1 }}>
            {(h.actor || 'system')} {verb} · {fmtWhen(h.ts)}
          </div>
        </div>
        {rolling ? (
          isServer ? <WUpdateBar prog={srvProg} /> : <WUpdateBar prog={prog} />
        ) : (
          <WBtn variant="ghost" size="xs" leftIcon="rotate-ccw" disabled={anyBusy}
            title={`Roll back to ${h.from_version}`}
            onClick={() => setConfirm(h)}>
            Roll back to {h.from_version}
          </WBtn>
        )}
      </div>
    );
  };

  return (
    <div>
      <WPageHeader title="Updates" subtitle="Keep this Bailey server and its workspaces on the latest release." />
      {!upd ? (
        <WCard><p style={{ color: WC.muted, fontSize: 13 }}>Loading…</p></WCard>
      ) : (
        <>
          <WCard>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <WIcon name="server" size={18} color={WC.fg} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, color: WC.fg }}>Automation server</div>
                <div style={{ fontSize: 12, color: WC.muted, fontFamily: 'monospace' }}>
                  {upd.server.current}{upd.server.latest ? `  →  ${upd.server.latest}` : ''}
                </div>
              </div>
              {upd.server.update_available ? (
                srvBusy && !rbId
                  ? <WUpdateBar prog={srvProg} />
                  : <WBtn variant="primary" size="sm" leftIcon="arrow-up-circle" disabled={anyBusy} onClick={doServerUpdate}>Update available</WBtn>
              ) : (
                <WPill tone="success" size="xs">Up to date</WPill>
              )}
            </div>
            {upd.server.update_available && !srvBusy && (
              <div style={{ marginTop: 10, fontSize: 12, color: WC.muted }}>
                Downloads the official binary from the AOC, swaps it in on the host, and
                restarts the server — the console will reconnect on the new version.
              </div>
            )}
          </WCard>

          <WCard style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 700, color: WC.fg, marginBottom: 8 }}>Workspaces</div>
            {(!upd.workspaces || upd.workspaces.length === 0) ? (
              <p style={{ color: WC.muted, fontSize: 13, margin: 0 }}>All workspaces are up to date.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {upd.workspaces.map((ws, i) => (
                  <div key={ws.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderTop: i === 0 ? 'none' : `1px solid ${WC.border}` }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, color: WC.fg }}>{ws.name}</div>
                      <div style={{ fontSize: 11, color: WC.muted, fontFamily: 'monospace' }}>
                        {ws.versions.gitops ? `gitops ${ws.versions.gitops} → ${ws.versions.latest_gitops || '?'}` : ''}
                      </div>
                    </div>
                    {busy === ws.name && !rbId ? (
                      <WUpdateBar prog={prog} />
                    ) : (
                      <WBtn variant="primary" size="sm" leftIcon="arrow-up-circle" disabled={anyBusy} onClick={() => doUpgrade(ws.name)}>
                        Update
                      </WBtn>
                    )}
                  </div>
                ))}
              </div>
            )}
          </WCard>

          <WCard style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 700, color: WC.fg, marginBottom: 2 }}>Update history</div>
            <div style={{ fontSize: 12, color: WC.muted, marginBottom: history.length ? 8 : 0 }}>
              Who updated what, to which version, and when. Roll back to any of the last {depth} versions.
            </div>
            {history.length === 0 ? (
              <p style={{ color: WC.muted, fontSize: 13, margin: 0 }}>No updates recorded yet.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {history.map(HistoryRow)}
              </div>
            )}
          </WCard>
        </>
      )}

      {/* Confirm before rolling back — it's a real change, not an undo. */}
      <WModal open={!!confirm} onClose={() => setConfirm(null)} icon="rotate-ccw"
        title={confirm
          ? (confirm.target_kind === 'server'
            ? `Roll the automation server back to ${confirm.from_version}?`
            : `Roll ${confirm.target_name} back to ${confirm.from_version}?`)
          : ''}
        subtitle={confirm
          ? (confirm.target_kind === 'server'
            ? `The server binary is restored to ${confirm.from_version} and the server restarts — the console will reconnect on the older version. This is recorded, and reversible to any of the last ${depth} versions.`
            : `${confirm.target_name}'s deployment is restored to ${confirm.from_version} and its containers are recreated. This is recorded, and reversible to any of the last ${depth} versions.`)
          : ''}
        footer={<>
          <WBtn variant="ghost" onClick={() => setConfirm(null)}>Cancel</WBtn>
          <WBtn variant="primary" leftIcon="rotate-ccw" onClick={confirmRollback}>Roll back</WBtn>
        </>} />
    </div>
  );
}

window.SC_UPDATES = { UpdatesView };
