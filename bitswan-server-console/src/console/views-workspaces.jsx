import React from 'react';
// views-workspaces.jsx — Overview + Workspaces (list, create, ownership/members)

const { C: WC, Icon: WIcon, Btn: WBtn, Pill: WPill } = window.WD_SHELL;
const {
  Avatar: WAvatar, Card: WCard, PageHeader: WPageHeader, Field: WField, TextInput: WTextInput,
  Modal: WModal, Toggle: WToggle, EmptyState: WEmpty, Stat: WStat, Drawer: WDrawer,
  Select: WSelect, AvatarStack: WAvatarStack, LiveState: WLiveState,
} = window.SC_UI;
const { Api: WApi } = window.SC_API;
const { useState: useWS } = React;

const ROLE_TONE = { admin: 'primary', auditor: 'info', member: 'neutral', viewer: 'outline' };

// app kind → presentation
const APP_KIND = {
  public:   { label: 'Public',   icon: 'globe', color: '#2563eb', soft: '#dbeafe' },
  internal: { label: 'Internal', icon: 'lock',  color: '#7c3aed', soft: '#ede9fe' },
};
const APP_STATUS = {
  healthy:  { tone: 'success', dot: '#16a34a', label: 'Healthy' },
  degraded: { tone: 'warning', dot: '#f59e0b', label: 'Degraded' },
  down:     { tone: 'danger',  dot: '#dc2626', label: 'Down' },
};

// Launchable production-app tile — compact vertical card
function AppLaunchTile({ app, onOpen }) {
  const k = APP_KIND[app.kind];
  const [h, setH] = useWS(false);
  return (
    <button onClick={onOpen} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)} style={{
      display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 9, width: '100%', textAlign: 'left',
      padding: '14px 14px 13px', border: `1px solid ${h ? WC.borderHi : WC.border}`, borderRadius: 11,
      background: h ? WC.surface : '#fff', cursor: 'pointer',
      boxShadow: h ? '0 4px 14px rgba(0,0,0,0.06)' : 'none',
      transform: h ? 'translateY(-1px)' : 'none', transition: 'all 140ms', fontFamily: 'inherit' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
        <span style={{ width: 36, height: 36, borderRadius: 9, flex: '0 0 auto', background: k.soft,
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <WIcon name={k.icon} size={18} color={k.color} />
        </span>
        <WPill tone={app.kind === 'public' ? 'info' : 'neutral'} size="xs">{k.label}</WPill>
      </div>
      <div style={{ width: '100%', minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: WC.fg, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{app.name}</div>
        <div style={{ fontSize: 11.5, color: WC.muted, fontFamily: 'Geist Mono, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
          {app.url.replace('https://', '')}
        </div>
      </div>
    </button>
  );
}

// ─── OVERVIEW ───────────────────────────────────────────────────────────────
// Stat tiles use live counts (workspaces, devices, pending) from the APIs.
// TODO(api): no backend endpoint yet — the People count, the server-identity
// card (region/version/uptime/claimed*), and the "Recent security activity"
// feed have no endpoints, so they stay on seed data (window.SC_DATA.SERVER /
// .ACTIVITY and the seed user list).
function OverviewView({ ctx }) {
  const { data, currentUser, go } = ctx;
  const S = window.SC_DATA.SERVER;
  const pending = data.pending.length;
  const trustedDevices = data.myDevices.length;
  const idRow = (label, value, mono) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, padding: '9px 0', borderBottom: `1px solid ${WC.surface2}` }}>
      <span style={{ fontSize: 12.5, color: WC.muted, whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 500, color: WC.fg, fontFamily: mono ? 'Geist Mono, monospace' : 'inherit', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
    </div>
  );

  return (
    <div>
      <WPageHeader title="Server overview"
        subtitle={`${S.host} — manage workspaces, people, and the devices this server trusts.`} />

      {/* Stat tiles */}
      <div style={{ display: 'flex', gap: 14, marginBottom: 20 }}>
        <WStat label="Workspaces" value={data.workspaces.filter(w => w.status === 'active').length} icon="layout-grid" onClick={() => go('workspaces')} />
        <WStat label="People" value={data.users.length} icon="users" onClick={() => go('users')} />
        <WStat label="Devices" value={trustedDevices} icon="laptop" tone="success" onClick={() => go('devices')} />
        <WStat label="Pending" value={pending} icon="shield-alert" tone={pending ? 'warning' : 'neutral'}
          sub={pending ? 'Needs your review' : 'All clear'} onClick={() => go('approvals')} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 18, alignItems: 'start' }}>
        {/* Left: attention + identity */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {pending > 0 && (
            <div style={{
              border: `1px solid ${WC.amber}55`, background: '#fffbeb', borderRadius: 12, padding: 18,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <WIcon name="shield-alert" size={18} color="#b45309" />
                <span style={{ fontSize: 14, fontWeight: 600, color: '#92400e' }}>
                  {pending} device{pending > 1 ? 's' : ''} awaiting approval
                </span>
              </div>
              <p style={{ margin: '0 0 12px', fontSize: 13, color: '#92400e', lineHeight: '19px' }}>
                A signed-in user can't reach this server until you confirm the code shown on their device.
              </p>
              <WBtn variant="primary" size="sm" leftIcon="arrow-right" onClick={() => go('approvals')}>Review approvals</WBtn>
            </div>
          )}

          <WCard pad={0}>
            <div style={{ padding: '16px 20px 12px', display: 'flex', alignItems: 'center', gap: 11, borderBottom: `1px solid ${WC.border}` }}>
              <div style={{ width: 36, height: 36, borderRadius: 9, background: WC.fg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <WIcon name="server" size={18} color="#fff" />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: WC.fg, whiteSpace: 'nowrap' }}>{S.name}</div>
                <div style={{ fontSize: 12, color: WC.muted, fontFamily: 'Geist Mono, monospace', whiteSpace: 'nowrap' }}>{S.host}</div>
              </div>
              <span style={{ marginLeft: 'auto' }}><WPill tone="success" size="xs">● Online</WPill></span>
            </div>
            <div style={{ padding: '4px 20px 14px' }}>
              {idRow('Region', S.region)}
              {idRow('Version', S.version, true)}
              {idRow('Claimed by', S.claimedBy, true)}
              {idRow('Claimed', S.claimedAt)}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0' }}>
                <span style={{ fontSize: 12.5, color: WC.muted }}>Uptime</span>
                <span style={{ fontSize: 13, fontWeight: 500, color: WC.fg }}>{S.uptime}</span>
              </div>
            </div>
          </WCard>
        </div>

        {/* Right: activity feed */}
        <WCard pad={0}>
          <div style={{ padding: '14px 20px', borderBottom: `1px solid ${WC.border}`, fontSize: 13, fontWeight: 600, color: WC.fg }}>
            Recent security activity
          </div>
          <div style={{ padding: '6px 10px 10px' }}>
            {window.SC_DATA.ACTIVITY.map((a, i) => {
              const tones = { success: '#16a34a', primary: WC.primary, danger: WC.red, warning: WC.amber, neutral: WC.muted };
              return (
                <div key={i} style={{ display: 'flex', gap: 11, padding: '10px', borderRadius: 8, alignItems: 'flex-start' }}>
                  <span style={{ width: 28, height: 28, borderRadius: 8, background: WC.surface2, flex: '0 0 auto',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
                    <WIcon name={a.icon} size={14} color={tones[a.tone]} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: WC.fg, lineHeight: '18px' }}>
                      <span style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}>{a.who}</span> {a.text}
                    </div>
                    <div style={{ fontSize: 11.5, color: WC.mutedFg, marginTop: 2 }}>{a.when}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </WCard>
      </div>
    </div>
  );
}

// ─── WORKSPACES — workspace cards with launch + live apps + management ──────
function WorkspacesView({ ctx }) {
  const { data, setData, toast, currentUser, openUrl, go, refresh } = ctx;
  const [query, setQuery] = useWS('');
  const [createOpen, setCreateOpen] = useWS(false);
  const [manageId, setManageId] = useWS(null);
  const [emptyOpen, setEmptyOpen] = useWS(false);
  const [emptyBusy, setEmptyBusy] = useWS(false);

  const usersById = id => data.users.find(u => u.id === id);
  const manageWs = data.workspaces.find(w => w.id === manageId);
  const noTotp = !data.recovery.totpActive;
  const trashedCount = data.workspaces.filter(w => w.isTrashed).length;

  // Live: POST /bailey/api/workspaces/empty-trash (NDJSON; requires the
  // exact "empty trash" confirmation, sent by the api helper).
  const doEmptyTrash = async () => {
    setEmptyBusy(true);
    try {
      await WApi.emptyTrash(() => {});
      toast('Trash emptied', 'success');
      setEmptyOpen(false);
      await refresh('workspaces');
    } catch (e) {
      toast(`Couldn't empty trash: ${e.message}`, 'danger');
    } finally { setEmptyBusy(false); }
  };

  const matchesQuery = w =>
    w.name.toLowerCase().includes(query.toLowerCase()) ||
    (w.apps || []).some(a => a.name.toLowerCase().includes(query.toLowerCase()) || a.url.toLowerCase().includes(query.toLowerCase()));
  // The backend already filters /bailey/api/workspaces to the workspaces
  // the caller can access, so show all of them. (Seed workspaces have a
  // members[] for the prototype; live ones don't — don't filter on it.)
  const mine = data.workspaces;
  const list = mine
    .filter(matchesQuery)
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1));

  return (
    <div>
      <WPageHeader title="Workspaces"
        subtitle="Each workspace is an isolated set of processes and automations. Jump into a dashboard, open its live apps, or manage who's in it."
        actions={<div style={{ display: 'flex', gap: 8 }}>
          {trashedCount > 0 && (
            <WBtn variant="default" leftIcon="trash-2" onClick={() => setEmptyOpen(true)}>Empty trash ({trashedCount})</WBtn>
          )}
          <WBtn variant="primary" leftIcon="plus" onClick={() => setCreateOpen(true)}>New workspace</WBtn>
        </div>} />

      {data.load.workspaces !== 'ok' && (
        <WLiveState status={data.load.workspaces} error={data.error.workspaces}
          label="Loading workspaces…" onRetry={() => refresh('workspaces')} />
      )}

      {noTotp && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', marginBottom: 18,
          border: `1px solid ${WC.amber}55`, background: '#fffbeb', borderRadius: 12 }}>
          <WIcon name="key-round" size={17} color="#b45309" />
          <span style={{ flex: 1, fontSize: 13, color: '#92400e' }}>
            You haven't set up authenticator recovery. If you lose your trusted devices, you'll be locked out.
          </span>
          <WBtn variant="default" size="sm" onClick={() => go('security')}>Set up recovery</WBtn>
        </div>
      )}

      {mine.length > 3 && (
        <div style={{ position: 'relative', width: 300, marginBottom: 18 }}>
          <WIcon name="search" size={14} color={WC.mutedFg} style={{ position: 'absolute', left: 11, top: 11 }} />
          <WTextInput value={query} onChange={setQuery} placeholder="Search workspaces & apps…" style={{ paddingLeft: 32 }} />
        </div>
      )}

      {list.length === 0 ? (
        <WCard><WEmpty icon="layout-grid"
          title={query ? 'No workspaces match' : "You're not in any workspace yet"}
          text={query ? 'Try a different search term.' : 'Create one to get started, or ask an admin to add you to theirs.'}
          action={!query && <WBtn variant="primary" leftIcon="plus" onClick={() => setCreateOpen(true)}>New workspace</WBtn>} /></WCard>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {list.map(w => {
            const owner = usersById(w.owner);
            const members = (w.members || []).map(usersById).filter(Boolean);
            // Live workspaces carry isOwner from the backend; seed ones
            // derive it from the owner id.
            const isOwner = w.isOwner != null ? w.isOwner : (w.owner === currentUser.id);
            const isMember = (w.members || []).includes(currentUser.id);
            const archived = w.status === 'archived';
            return (
              <WCard key={w.id} pad={0} hover={!archived} style={{ opacity: archived ? 0.7 : 1 }}>
                {/* header */}
                <div style={{ padding: '16px 18px', borderBottom: (w.apps && w.apps.length) ? `1px solid ${WC.surface2}` : 'none',
                  display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                  <span style={{ width: 40, height: 40, borderRadius: 10, flex: '0 0 auto',
                    background: archived ? WC.surface2 : WC.primarySoft, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <WIcon name={archived ? 'archive' : 'layout-grid'} size={19} color={archived ? WC.mutedFg : WC.primary} />
                  </span>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 15.5, fontWeight: 700, color: WC.fg, whiteSpace: 'nowrap' }}>{w.name}</span>
                      {isOwner ? <WPill tone="primary" size="xs">Owner</WPill>
                        : isMember ? <WPill tone="neutral" size="xs">Member</WPill> : null}
                      {archived && <WPill tone="neutral" size="xs">archived</WPill>}
                    </div>
                  </div>
                  <WAvatarStack users={members} size={26} />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {!archived && (
                      <WBtn variant="primary" size="sm" leftIcon="external-link" onClick={() => openUrl(w.gitopsUrl || w.dashboard, `${w.name} dashboard`)}>Open</WBtn>
                    )}
                    <button onClick={() => setManageId(w.id)} title="Manage workspace" style={{ width: 32, height: 32, border: `1px solid ${WC.border}`, background: '#fff', borderRadius: 8, cursor: 'pointer', color: WC.muted, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      onMouseEnter={e => { e.currentTarget.style.background = WC.surface2; e.currentTarget.style.color = WC.fg; }}
                      onMouseLeave={e => { e.currentTarget.style.background = '#fff'; e.currentTarget.style.color = WC.muted; }}>
                      <WIcon name="settings-2" size={15} />
                    </button>
                  </div>
                </div>
                {/* apps */}
                {w.apps && w.apps.length > 0 && (
                  <div style={{ padding: '14px 18px 16px' }}>
                    <div style={{ fontSize: 10.5, fontWeight: 600, color: WC.mutedFg, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 10 }}>Live apps</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 220px))', gap: 10 }}>
                      {w.apps.map(a => <AppLaunchTile key={a.id} app={a} onOpen={() => openUrl(a.url, a.name)} />)}
                    </div>
                  </div>
                )}
              </WCard>
            );
          })}
        </div>
      )}

      <CreateWorkspaceModal open={createOpen} onClose={() => setCreateOpen(false)} data={data} setData={setData} toast={toast} currentUser={currentUser} refresh={refresh} />
      <ManageWorkspaceDrawer ws={manageWs} onClose={() => setManageId(null)} data={data} setData={setData} toast={toast} openUrl={openUrl} refresh={refresh} />

      <WModal open={emptyOpen} onClose={emptyBusy ? () => {} : () => setEmptyOpen(false)} icon="trash-2" title="Empty trash?"
        subtitle="This permanently deletes every trashed workspace you own — containers and data. This can't be undone."
        footer={<>
          <WBtn variant="default" disabled={emptyBusy} onClick={() => setEmptyOpen(false)}>Cancel</WBtn>
          <WBtn variant="primary" disabled={emptyBusy} style={{ background: WC.red, borderColor: WC.red }} onClick={doEmptyTrash}>
            {emptyBusy ? 'Emptying…' : 'Permanently delete'}
          </WBtn>
        </>} />
    </div>
  );
}

// ─── CREATE WORKSPACE MODAL ─────────────────────────────────────────────────
function CreateWorkspaceModal({ open, onClose, data, setData, toast, currentUser, refresh }) {
  const [name, setName] = useWS('');
  const [busy, setBusy] = useWS(false);
  const [err, setErr] = useWS('');
  const [log, setLog] = useWS([]);
  React.useEffect(() => { if (open) { setName(''); setBusy(false); setErr(''); setLog([]); } }, [open]);

  // Backend name rule (workspaces_baileyadmin.go nameRe): lowercase, starts
  // with a letter, letters/digits/hyphens, 2-33 chars.
  const nameOk = /^[a-z][a-z0-9-]{1,32}$/.test(name.trim());

  // Live: POST /bailey/api/workspaces streams NDJSON progress events; show
  // them live, then re-fetch the list on done.
  const create = async () => {
    if (!nameOk) return;
    setBusy(true); setErr(''); setLog([]);
    try {
      await WApi.createWorkspace(name.trim(), (ev) => {
        if (ev.event === 'log' || ev.event === 'start') {
          setLog(l => [...l, ev.message].slice(-40));
        }
      });
      toast(`Workspace “${name.trim()}” created`, 'success');
      await refresh('workspaces');
      onClose();
    } catch (e) {
      setErr(e.message || 'Workspace creation failed.');
    } finally { setBusy(false); }
  };

  return (
    <WModal open={open} onClose={busy ? () => {} : onClose} icon="folder-plus" title="New workspace"
      subtitle="Create an isolated space for a set of business processes. You become its owner."
      footer={<>
        <WBtn variant="default" disabled={busy} onClick={onClose}>Cancel</WBtn>
        <WBtn variant="primary" disabled={!nameOk || busy} onClick={create}>{busy ? 'Creating…' : 'Create workspace'}</WBtn>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <WField label="Workspace name" hint="Lowercase letters, digits and hyphens; starts with a letter (2–33 chars).">
          <WTextInput value={name} onChange={setName} placeholder="e.g. payroll-automation" autoFocus />
        </WField>
        {name.trim() && !nameOk && (
          <div style={{ fontSize: 12, color: WC.red }}>That name doesn't match the allowed format.</div>
        )}
        {err && (
          <div style={{ display: 'flex', gap: 8, padding: 11, borderRadius: 9, background: WC.redSoft, border: `1px solid ${WC.red}55` }}>
            <WIcon name="alert-triangle" size={15} color={WC.red} style={{ flex: '0 0 auto' }} />
            <span style={{ fontSize: 12.5, color: WC.red, lineHeight: '17px' }}>{err}</span>
          </div>
        )}
        {log.length > 0 && (
          <div style={{ maxHeight: 160, overflow: 'auto', padding: 10, borderRadius: 9, background: WC.surface,
            border: `1px solid ${WC.border}`, fontFamily: 'Geist Mono, monospace', fontSize: 11.5, color: WC.muted, whiteSpace: 'pre-wrap' }}>
            {log.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
      </div>
    </WModal>
  );
}

// ─── MANAGE WORKSPACE DRAWER (ownership + members) ──────────────────────────
function ManageWorkspaceDrawer({ ws, onClose, data, setData, toast, openUrl, refresh }) {
  const [transferTo, setTransferTo] = useWS(null);
  const [busy, setBusy] = useWS(false);
  React.useEffect(() => { setTransferTo(null); }, [ws?.id]);
  if (!ws) return null;
  const usersById = id => data.users.find(u => u.id === id);
  const owner = usersById(ws.owner);
  const members = (ws.members || []).map(usersById).filter(Boolean);
  const nonMembers = data.users.filter(u => u.status === 'active' && !(ws.members || []).includes(u.id));
  // Live workspaces have no membership data and management of grants
  // happens on /2fa-gate/share/<host>; only seed workspaces show the
  // member/transfer UI here.
  const isLive = !!ws.live;

  const patch = fn => setData(d => ({ ...d, workspaces: d.workspaces.map(w => w.id === ws.id ? fn(w) : w) }));
  // TODO(api): no backend endpoint yet — workspace membership + ownership
  // transfer aren't exposed by /bailey/api/workspaces (grants are managed
  // via the gate's /2fa-gate/share/<host> page). Seed-only below.
  const addMember = id => patch(w => ({ ...w, members: [...w.members, id] }));
  const removeMember = id => patch(w => ({ ...w, members: w.members.filter(m => m !== id) }));
  const doTransfer = () => {
    const u = usersById(transferTo);
    patch(w => ({ ...w, owner: transferTo, members: Array.from(new Set([transferTo, ...w.members])) }));
    toast(`Ownership transferred to ${u.name}`, 'success');
    setTransferTo(null);
  };
  // Live: trash → POST /workspaces/<name>/trash, restore → /restore.
  // Re-fetch the list after so the card moves section.
  const toggleArchive = async () => {
    if (!isLive) {
      patch(w => ({ ...w, status: w.status === 'active' ? 'archived' : 'active' }));
      toast(ws.status === 'active' ? 'Workspace archived' : 'Workspace restored', 'info');
      return;
    }
    setBusy(true);
    try {
      if (ws.status === 'active') { await WApi.trashWorkspace(ws.name); toast('Workspace trashed', 'info'); }
      else { await WApi.restoreWorkspace(ws.name); toast('Workspace restored', 'success'); }
      await refresh('workspaces');
      onClose();
    } catch (e) {
      toast(`Couldn't ${ws.status === 'active' ? 'trash' : 'restore'} workspace: ${e.message}`, 'danger');
    } finally { setBusy(false); }
  };
  // Live: update → POST /workspaces/<name>/update (NDJSON; owner-only).
  const doUpdate = async () => {
    setBusy(true);
    try {
      await WApi.updateWorkspace(ws.name, () => {});
      toast('Workspace containers updated', 'success');
    } catch (e) {
      toast(`Update failed: ${e.message}`, 'danger');
    } finally { setBusy(false); }
  };

  return (
    <WDrawer open={!!ws} onClose={onClose} icon="layout-grid" title={ws.name}
      subtitle={isLive ? (ws.isOwner ? 'You own this workspace' : 'Shared with you') : `${ws.processes} processes · created ${ws.created}`}
      footer={<>
        {isLive && ws.status === 'active' && ws.isOwner && (
          <WBtn variant="default" disabled={busy} leftIcon="refresh-cw" onClick={doUpdate}>Update</WBtn>
        )}
        <WBtn variant={ws.status === 'active' ? 'default' : 'primary'} disabled={busy || (isLive && !ws.isOwner)}
          leftIcon={ws.status === 'active' ? 'archive' : 'archive-restore'} onClick={toggleArchive}>
          {ws.status === 'active' ? (isLive ? 'Trash' : 'Archive') : 'Restore'}
        </WBtn>
        <WBtn variant="primary" disabled={busy} onClick={onClose}>Done</WBtn>
      </>}>
      {isLive && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
          {ws.editorUrl && (
            <WBtn variant="default" leftIcon="external-link" onClick={() => openUrl(ws.editorUrl, `${ws.name} editor`)}>Open editor</WBtn>
          )}
          {ws.gitopsUrl && (
            <WBtn variant="default" leftIcon="external-link" onClick={() => openUrl(ws.gitopsUrl, `${ws.name} gitops`)}>Open gitops</WBtn>
          )}
          <div style={{ display: 'flex', gap: 9, padding: 12, borderRadius: 10, background: WC.surface, border: `1px solid ${WC.border}` }}>
            <WIcon name="info" size={15} color={WC.muted} style={{ marginTop: 1, flex: '0 0 auto' }} />
            <span style={{ fontSize: 12, color: WC.muted, lineHeight: '17px' }}>
              Members &amp; access for this workspace are managed per-endpoint on its share page (not from here).
            </span>
          </div>
        </div>
      )}
      {/* Ownership + members — seed workspaces only (no backend endpoint). */}
      {!isLive && (<>
      {/* Ownership */}
      <div style={{ fontSize: 11, fontWeight: 600, color: WC.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 10 }}>Ownership</div>
      <div style={{ border: `1px solid ${WC.border}`, borderRadius: 10, padding: 14, marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <WAvatar user={owner} size={36} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: WC.fg }}>{owner?.name} <WPill tone="primary" size="xs">Owner</WPill></div>
            <div style={{ fontSize: 12, color: WC.muted, fontFamily: 'Geist Mono, monospace' }}>{owner?.email}</div>
          </div>
        </div>
        {transferTo === null ? (
          <button onClick={() => setTransferTo(members.find(m => m.id !== ws.owner)?.id || nonMembers[0]?.id || '')} style={{
            marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 11px',
            border: `1px solid ${WC.border}`, borderRadius: 7, background: '#fff', cursor: 'pointer', fontSize: 12.5, color: WC.fg, fontWeight: 500 }}>
            <WIcon name="arrow-left-right" size={13} color={WC.muted} /> Transfer ownership
          </button>
        ) : (
          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
            <WSelect value={transferTo} onChange={setTransferTo} style={{ flex: 1 }}
              options={data.users.filter(u => u.status === 'active' && u.id !== ws.owner).map(u => ({ value: u.id, label: u.name }))} />
            <WBtn variant="primary" size="sm" onClick={doTransfer}>Transfer</WBtn>
            <WBtn variant="ghost" size="sm" onClick={() => setTransferTo(null)}>Cancel</WBtn>
          </div>
        )}
      </div>

      {/* Members */}
      <div style={{ fontSize: 11, fontWeight: 600, color: WC.muted, textTransform: 'uppercase', letterSpacing: 0.4, margin: '20px 0 10px',
        display: 'flex', justifyContent: 'space-between' }}>
        <span>Members</span><span>{members.length}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {members.map(m => (
          <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '8px 6px', borderRadius: 8 }}>
            <WAvatar user={m} size={30} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: WC.fg }}>{m.name}</div>
              <div style={{ fontSize: 11.5, color: WC.muted, fontFamily: 'Geist Mono, monospace' }}>{m.email}</div>
            </div>
            {m.id === ws.owner
              ? <WPill tone="primary" size="xs">Owner</WPill>
              : <button onClick={() => removeMember(m.id)} title="Remove from workspace" style={{
                  width: 28, height: 28, border: 0, background: 'transparent', borderRadius: 6, cursor: 'pointer',
                  color: WC.mutedFg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onMouseEnter={e => { e.currentTarget.style.background = WC.redSoft; e.currentTarget.style.color = WC.red; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = WC.mutedFg; }}>
                  <WIcon name="user-minus" size={15} />
                </button>}
          </div>
        ))}
      </div>

      {nonMembers.length > 0 && (
        <>
          <div style={{ fontSize: 11, fontWeight: 600, color: WC.muted, textTransform: 'uppercase', letterSpacing: 0.4, margin: '20px 0 10px' }}>Add members</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {nonMembers.map(u => (
              <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '8px 6px', borderRadius: 8 }}>
                <WAvatar user={u} size={30} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: WC.fg }}>{u.name}</div>
                  <div style={{ fontSize: 11.5, color: WC.muted, fontFamily: 'Geist Mono, monospace' }}>{u.email}</div>
                </div>
                <WBtn variant="default" size="xs" leftIcon="plus" onClick={() => addMember(u.id)}>Add</WBtn>
              </div>
            ))}
          </div>
        </>
      )}
      </>)}
    </WDrawer>
  );
}

window.SC_WORKSPACES = { OverviewView, WorkspacesView, ROLE_TONE };