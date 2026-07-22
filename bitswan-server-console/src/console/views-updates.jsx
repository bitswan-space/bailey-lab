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
              {upd.server.update_available
                ? <WPill tone="warning" size="xs">Update available</WPill>
                : <WPill tone="success" size="xs">Up to date</WPill>}
            </div>
            {upd.server.update_available && (
              <div style={{ marginTop: 12, fontSize: 13, color: WC.fg }}>
                Update the server from its host — the daemon can&apos;t replace its own
                running binary from the browser, so run:
                <div style={{ display: 'flex', alignItems: 'stretch', marginTop: 8, border: `1px solid ${WC.border}`, borderRadius: 6, overflow: 'hidden' }}>
                  <code style={{ flex: 1, padding: '8px 10px', fontFamily: 'monospace', fontSize: 13 }}>{upd.server_update_cmd}</code>
                  <button onClick={() => copyCmd(upd.server_update_cmd)} title="Copy"
                    style={{ width: 38, border: 'none', borderLeft: `1px solid ${WC.border}`, background: '#fff', cursor: 'pointer', color: WC.muted }}>
                    <WIcon name="copy" size={15} />
                  </button>
                </div>
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
