import React from 'react';
// views-updates.jsx — admin "Updates": what's behind on this server. Workspace
// updates apply from here (the daemon can pull those containers); the server's
// own binary is updated host-side (`bitswan self-update`) since the daemon runs
// from a read-only bind-mount of the host binary and can't replace itself — so
// that one is shown with the command, not a button. Rollback is CLI-only.

const { C: WC, Icon: WIcon, Pill: WPill, Btn: WBtn } = window.WD_SHELL;
const { Card: WCard, PageHeader: WPageHeader, UpdateBar: WUpdateBar } = window.SC_UI;
const { Api: UApi } = window.SC_API;
const { useState: useUS } = React;

function UpdatesView({ ctx }) {
  const { data, toast, refresh } = ctx;
  const upd = data.updates; // { server, workspaces, count, server_update_cmd }
  const [busy, setBusy] = useUS('');
  const [prog, setProg] = useUS(null); // { fraction, label } for the workspace being updated
  const [srvBusy, setSrvBusy] = useUS(false);
  const [srvProg, setSrvProg] = useUS(null);

  // Update the automation-server binary itself from the browser: the daemon
  // downloads the official binary from the AOC, swaps it on the host, and
  // restarts its own container. The stream ends at the 'restarting' event (the
  // connection drops with the daemon); we then poll until the version flips.
  const doServerUpdate = async () => {
    setSrvBusy(true);
    setSrvProg({ fraction: 0, label: 'Starting…' });
    const before = (upd && upd.server && upd.server.current) || '';
    let restarting = false;
    try {
      await UApi.serverUpdate((ev) => {
        if (!ev) return;
        if (ev.event === 'restarting') restarting = true;
        if (typeof ev.fraction === 'number') setSrvProg({ fraction: ev.fraction, label: ev.message || '' });
        else if (ev.message) setSrvProg(p => ({ fraction: (p && p.fraction) || 0, label: ev.message }));
      });
    } catch (e) {
      if (!restarting) {
        toast(`Server update failed: ${e.message}`, 'danger');
        setSrvBusy(false); setSrvProg(null);
        return;
      }
      // else: expected — the daemon is being replaced and the stream dropped.
    }
    setSrvProg({ fraction: 0.96, label: 'Restarting server…' });
    // Poll for the daemon to come back on the new version (bounded ~2 min).
    // Can't subscribe to a server that's mid-restart, so polling is the only
    // signal available to the browser here.
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const r2 = await UApi.adminUpdates();
        if (r2 && r2.server && r2.server.current && r2.server.current !== before) {
          toast('Server updated', 'success');
          await refresh('updates');
          setSrvBusy(false); setSrvProg(null);
          return;
        }
      } catch (e) { /* still restarting — keep polling */ }
    }
    toast('Server is restarting — refresh in a moment.');
    setSrvBusy(false); setSrvProg(null);
  };

  const doUpgrade = async (name) => {
    setBusy(name);
    setProg({ fraction: 0, label: 'Starting…' });
    try {
      await UApi.upgradeWorkspace(name, (ev) => {
        if (!ev) return;
        if (typeof ev.fraction === 'number') setProg({ fraction: ev.fraction, label: ev.message || '' });
        else if (ev.message) setProg(p => ({ fraction: (p && p.fraction) || 0, label: ev.message }));
      });
      toast(`${name} updated`, 'success');
      await refresh('updates');
      await refresh('workspaces');
    } catch (e) {
      toast(`Couldn't update ${name}: ${e.message}`, 'danger');
    } finally { setBusy(''); setProg(null); }
  };

  const copyCmd = (cmd) => {
    try { navigator.clipboard.writeText(cmd); toast('Copied to clipboard', 'success'); } catch (e) {}
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
                srvBusy
                  ? <WUpdateBar prog={srvProg} />
                  : <WBtn variant="primary" size="sm" leftIcon="arrow-up-circle" onClick={doServerUpdate}>Update available</WBtn>
              ) : (
                <WPill tone="success" size="xs">Up to date</WPill>
              )}
            </div>
            {upd.server.update_available && !srvBusy && (
              <div style={{ marginTop: 10, fontSize: 12, color: WC.muted }}>
                Downloads the official binary from the AOC, swaps it in on the host, and
                restarts the server — the console will reconnect on the new version.
                {upd.server_update_cmd ? (
                  <> You can also run <code style={{ fontFamily: 'monospace' }}>{upd.server_update_cmd}</code> from the host.</>
                ) : null}
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
                    {busy === ws.name ? (
                      <WUpdateBar prog={prog} />
                    ) : (
                      <WBtn variant="primary" size="sm" leftIcon="arrow-up-circle" onClick={() => doUpgrade(ws.name)}>
                        Update
                      </WBtn>
                    )}
                  </div>
                ))}
              </div>
            )}
          </WCard>

          <p style={{ fontSize: 12, color: WC.muted, marginTop: 12 }}>
            To roll back an update, use the CLI: <code style={{ fontFamily: 'monospace' }}>bitswan rollback &lt;workspace&gt;</code>
            {' '}or <code style={{ fontFamily: 'monospace' }}>bitswan self-update --rollback</code> for the server.
          </p>
        </>
      )}
    </div>
  );
}

window.SC_UPDATES = { UpdatesView };
