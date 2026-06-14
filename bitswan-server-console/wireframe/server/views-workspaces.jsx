// views-workspaces.jsx — Overview + Workspaces (list, create, ownership/members)

const { C: WC, Icon: WIcon, Btn: WBtn, Pill: WPill } = window.WD_SHELL;
const {
  Avatar: WAvatar, Card: WCard, PageHeader: WPageHeader, Field: WField, TextInput: WTextInput,
  Modal: WModal, Toggle: WToggle, EmptyState: WEmpty, Stat: WStat, Drawer: WDrawer,
  Select: WSelect, AvatarStack: WAvatarStack,
} = window.SC_UI;
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
  const { data, setData, toast, currentUser, openUrl, go } = ctx;
  const [query, setQuery] = useWS('');
  const [createOpen, setCreateOpen] = useWS(false);
  const [manageId, setManageId] = useWS(null);

  const usersById = id => data.users.find(u => u.id === id);
  const manageWs = data.workspaces.find(w => w.id === manageId);
  const noTotp = !data.recovery.totpActive;

  const matchesQuery = w =>
    w.name.toLowerCase().includes(query.toLowerCase()) ||
    (w.apps || []).some(a => a.name.toLowerCase().includes(query.toLowerCase()) || a.url.toLowerCase().includes(query.toLowerCase()));
  // You only ever see workspaces you're a member of.
  const mine = data.workspaces.filter(w => w.members.includes(currentUser.id));
  const list = mine
    .filter(matchesQuery)
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1));

  return (
    <div>
      <WPageHeader title="Workspaces"
        subtitle="Each workspace is an isolated set of processes and automations. Jump into a dashboard, open its live apps, or manage who's in it."
        actions={<WBtn variant="primary" leftIcon="plus" onClick={() => setCreateOpen(true)}>New workspace</WBtn>} />


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
            const members = w.members.map(usersById).filter(Boolean);
            const isOwner = w.owner === currentUser.id;
            const isMember = w.members.includes(currentUser.id);
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
                      <WBtn variant="primary" size="sm" leftIcon="external-link" onClick={() => openUrl(w.dashboard, `${w.name} dashboard`)}>Create</WBtn>
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

      <CreateWorkspaceModal open={createOpen} onClose={() => setCreateOpen(false)} data={data} setData={setData} toast={toast} currentUser={currentUser} />
      <ManageWorkspaceDrawer ws={manageWs} onClose={() => setManageId(null)} data={data} setData={setData} toast={toast} openUrl={openUrl} />
    </div>
  );
}

// ─── CREATE WORKSPACE MODAL ─────────────────────────────────────────────────
function CreateWorkspaceModal({ open, onClose, data, setData, toast, currentUser }) {
  const [name, setName] = useWS('');
  const [owner, setOwner] = useWS(currentUser.id);
  const [picked, setPicked] = useWS([]);
  React.useEffect(() => { if (open) { setName(''); setOwner(currentUser.id); setPicked([]); } }, [open]);

  const togglePick = id => setPicked(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);
  const create = () => {
    const id = 'ws-' + Math.random().toString(36).slice(2, 7);
    const members = Array.from(new Set([owner, ...picked]));
    setData(d => ({ ...d, workspaces: [
      { id, name: name.trim(), owner, members, processes: 0, automations: 0,
        created: 'Just now', activity: 'Just now', status: 'active' },
      ...d.workspaces ] }));
    toast(`Workspace “${name.trim()}” created`, 'success');
    onClose();
  };

  return (
    <WModal open={open} onClose={onClose} icon="folder-plus" title="New workspace"
      subtitle="Create an isolated space for a set of business processes."
      footer={<>
        <WBtn variant="default" onClick={onClose}>Cancel</WBtn>
        <WBtn variant="primary" disabled={!name.trim()} onClick={create}>Create workspace</WBtn>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <WField label="Workspace name">
          <WTextInput value={name} onChange={setName} placeholder="e.g. Payroll Automation" autoFocus />
        </WField>
        <WField label="Owner" hint="The owner has full control and can transfer ownership later.">
          <WSelect value={owner} onChange={setOwner}
            options={data.users.filter(u => u.status === 'active').map(u => ({ value: u.id, label: `${u.name} · ${u.email}` }))} />
        </WField>
        <WField label="Add members" hint="You can add or change members any time.">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, border: `1px solid ${WC.border}`, borderRadius: 8, padding: 6, maxHeight: 180, overflow: 'auto' }}>
            {data.users.filter(u => u.id !== owner && u.status === 'active').map(u => {
              const on = picked.includes(u.id);
              return (
                <button key={u.id} onClick={() => togglePick(u.id)} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px', borderRadius: 7,
                  border: 0, background: on ? WC.primarySoft : 'transparent', cursor: 'pointer', textAlign: 'left',
                }}>
                  <WAvatar user={u} size={26} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: WC.fg }}>{u.name}</div>
                    <div style={{ fontSize: 11.5, color: WC.muted, fontFamily: 'Geist Mono, monospace' }}>{u.email}</div>
                  </div>
                  <span style={{ width: 20, height: 20, borderRadius: 6, border: `1.5px solid ${on ? WC.primary : WC.borderHi}`,
                    background: on ? WC.primary : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {on && <WIcon name="check" size={13} color="#fff" />}
                  </span>
                </button>
              );
            })}
          </div>
        </WField>
      </div>
    </WModal>
  );
}

// ─── MANAGE WORKSPACE DRAWER (ownership + members) ──────────────────────────
function ManageWorkspaceDrawer({ ws, onClose, data, setData, toast, openUrl }) {
  const [transferTo, setTransferTo] = useWS(null);
  React.useEffect(() => { setTransferTo(null); }, [ws?.id]);
  if (!ws) return null;
  const usersById = id => data.users.find(u => u.id === id);
  const owner = usersById(ws.owner);
  const members = ws.members.map(usersById).filter(Boolean);
  const nonMembers = data.users.filter(u => u.status === 'active' && !ws.members.includes(u.id));

  const patch = fn => setData(d => ({ ...d, workspaces: d.workspaces.map(w => w.id === ws.id ? fn(w) : w) }));
  const addMember = id => patch(w => ({ ...w, members: [...w.members, id] }));
  const removeMember = id => patch(w => ({ ...w, members: w.members.filter(m => m !== id) }));
  const doTransfer = () => {
    const u = usersById(transferTo);
    patch(w => ({ ...w, owner: transferTo, members: Array.from(new Set([transferTo, ...w.members])) }));
    toast(`Ownership transferred to ${u.name}`, 'success');
    setTransferTo(null);
  };
  const toggleArchive = () => {
    patch(w => ({ ...w, status: w.status === 'active' ? 'archived' : 'active' }));
    toast(ws.status === 'active' ? 'Workspace archived' : 'Workspace restored', 'info');
  };

  return (
    <WDrawer open={!!ws} onClose={onClose} icon="layout-grid" title={ws.name}
      subtitle={`${ws.processes} processes · created ${ws.created}`}
      footer={<>
        <WBtn variant={ws.status === 'active' ? 'default' : 'primary'} leftIcon={ws.status === 'active' ? 'archive' : 'archive-restore'} onClick={toggleArchive}>
          {ws.status === 'active' ? 'Archive' : 'Restore'}
        </WBtn>
        <WBtn variant="primary" onClick={onClose}>Done</WBtn>
      </>}>
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
    </WDrawer>
  );
}

window.SC_WORKSPACES = { OverviewView, WorkspacesView, ROLE_TONE };
