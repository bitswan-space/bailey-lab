// views-people.jsx — Users & roles + Device approvals (admin types the code)

const { C: PC, Icon: PIcon, Btn: PBtn, Pill: PPill } = window.WD_SHELL;
const {
  Avatar: PAvatar, Card: PCard, PageHeader: PPageHeader, Field: PField, TextInput: PTextInput,
  Modal: PModal, EmptyState: PEmpty, Drawer: PDrawer, Select: PSelect,
  SegmentedCode: PSeg, DeviceIcon: PDeviceIcon, ProtoHint: PProtoHint,
} = window.SC_UI;
const { useState: useP } = React;

const P_ROLE_TONE = { admin: 'primary', auditor: 'info', member: 'neutral', viewer: 'outline' };

// ─── USERS & ROLES ──────────────────────────────────────────────────────────
function UsersView({ ctx }) {
  const { data, setData, toast, go, currentUser } = ctx;
  const [query, setQuery] = useP('');
  const [inviteOpen, setInviteOpen] = useP(false);
  const [roleEditId, setRoleEditId] = useP(null);
  const [devicesUserId, setDevicesUserId] = useP(null);

  const ROLES = window.SC_DATA.ROLES;
  const getDevices = u => (u.id === currentUser.id ? data.myDevices : (data.userDevices[u.id] || []));
  const list = data.users.filter(u =>
    u.name.toLowerCase().includes(query.toLowerCase()) || u.email.toLowerCase().includes(query.toLowerCase()));
  const wsCountFor = id => data.workspaces.filter(w => w.members.includes(id)).length;

  const setRole = (id, role) => {
    setData(d => ({ ...d, users: d.users.map(u => u.id === id ? { ...u, role } : u) }));
    setRoleEditId(null);
    toast('Role updated', 'success');
  };
  const setStatus = (id, status) => {
    setData(d => ({ ...d, users: d.users.map(u => u.id === id ? { ...u, status } : u) }));
    toast(status === 'suspended' ? 'User suspended' : 'User reactivated', 'info');
  };

  return (
    <div>
      <PPageHeader title="People &amp; roles"
        subtitle="Everyone with access to this server. Roles govern what they can do; devices govern where they can do it from."
        actions={<PBtn variant="primary" leftIcon="user-plus" onClick={() => setInviteOpen(true)}>Invite person</PBtn>} />

      {/* role legend */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 }}>
        {ROLES.map(r => (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 13px',
            border: `1px solid ${PC.border}`, borderRadius: 10, background: '#fff', flex: '1 1 200px', minWidth: 200 }}>
            <PPill tone={r.tone} size="xs">{r.label}</PPill>
            <span style={{ fontSize: 11.5, color: PC.muted, lineHeight: '15px' }}>{r.desc}</span>
          </div>
        ))}
      </div>

      <div style={{ position: 'relative', maxWidth: 320, marginBottom: 14 }}>
        <PIcon name="search" size={14} color={PC.mutedFg} style={{ position: 'absolute', left: 11, top: 11 }} />
        <PTextInput value={query} onChange={setQuery} placeholder="Search people…" style={{ paddingLeft: 32 }} />
      </div>

      <PCard pad={0}>
        <div style={{ display: 'grid', gridTemplateColumns: '2.2fr 1fr 1fr 1fr 0.9fr 40px', gap: 12,
          padding: '11px 18px', borderBottom: `1px solid ${PC.border}`, background: PC.surface,
          fontSize: 11, fontWeight: 600, color: PC.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
          <span>Person</span><span>Role</span><span>Workspaces</span><span>Devices</span><span>Last active</span><span></span>
        </div>
        {list.map(u => (
          <div key={u.id} style={{ display: 'grid', gridTemplateColumns: '2.2fr 1fr 1fr 1fr 0.9fr 40px', gap: 12,
            padding: '12px 18px', borderBottom: `1px solid ${PC.surface2}`, alignItems: 'center',
            opacity: u.status === 'suspended' ? 0.6 : 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
              <PAvatar user={u} size={32} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: PC.fg, display: 'flex', alignItems: 'center', gap: 7 }}>
                  {u.name}
                  {u.root && <span title="First admin (root)"><PIcon name="crown" size={13} color={PC.amber} /></span>}
                  {u.status === 'invited' && <PPill tone="warning" size="xs">Invited</PPill>}
                  {u.status === 'suspended' && <PPill tone="danger" size="xs">Suspended</PPill>}
                </div>
                <div style={{ fontSize: 11.5, color: PC.muted, fontFamily: 'Geist Mono, monospace' }}>{u.email}</div>
              </div>
            </div>
            <div>
              {roleEditId === u.id ? (
                <PSelect value={u.role} onChange={v => setRole(u.id, v)}
                  options={ROLES.map(r => ({ value: r.id, label: r.label }))} style={{ maxWidth: 130 }} />
              ) : (
                <button onClick={() => u.root ? null : setRoleEditId(u.id)} title={u.root ? 'Root admin role is fixed' : 'Change role'}
                  style={{ border: 0, background: 'transparent', cursor: u.root ? 'default' : 'pointer', padding: 0 }}>
                  <PPill tone={P_ROLE_TONE[u.role]} size="xs">{u.role}</PPill>
                </button>
              )}
            </div>
            <span style={{ fontSize: 13, color: PC.fg }}>{wsCountFor(u.id)}</span>
            {(() => { const n = getDevices(u).length; return (
              <button onClick={() => n > 0 && setDevicesUserId(u.id)} title={n ? 'Manage devices' : 'No devices'}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 9px', borderRadius: 7,
                  border: `1px solid ${n ? PC.border : 'transparent'}`, background: n ? '#fff' : 'transparent',
                  cursor: n ? 'pointer' : 'default', fontFamily: 'inherit', fontSize: 13, color: n ? PC.fg : PC.mutedFg, fontWeight: 500, width: 'fit-content' }}
                onMouseEnter={e => { if (n) e.currentTarget.style.background = PC.surface2; }}
                onMouseLeave={e => { if (n) e.currentTarget.style.background = '#fff'; }}>
                <PIcon name="laptop" size={13} color={PC.mutedFg} />{n}
                {n > 0 && <PIcon name="chevron-right" size={12} color={PC.mutedFg} />}
              </button>
            ); })()}
            <span style={{ fontSize: 12.5, color: PC.muted }}>{u.lastActive}</span>
            {u.root ? <span /> : (
              <button onClick={() => setStatus(u.id, u.status === 'suspended' ? 'active' : 'suspended')}
                title={u.status === 'suspended' ? 'Reactivate' : 'Suspend'}
                style={{ width: 28, height: 28, border: 0, background: 'transparent', borderRadius: 6, cursor: 'pointer',
                  color: PC.mutedFg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseEnter={e => e.currentTarget.style.background = PC.surface2}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                <PIcon name={u.status === 'suspended' ? 'user-check' : 'user-x'} size={15} />
              </button>
            )}
          </div>
        ))}
      </PCard>

      <InvitePersonModal open={inviteOpen} onClose={() => setInviteOpen(false)} data={data} setData={setData} toast={toast} />
      <UserDevicesDrawer userId={devicesUserId} onClose={() => setDevicesUserId(null)} ctx={ctx} getDevices={getDevices} />
    </div>
  );
}

// ─── ADMIN: view & revoke another user's devices ────────────────────────────
function UserDevicesDrawer({ userId, onClose, ctx, getDevices }) {
  const { data, setData, toast, currentUser } = ctx;
  const [confirm, setConfirm] = useP(null);
  const u = data.users.find(x => x.id === userId);
  if (!u) return null;
  const isSelf = u.id === currentUser.id;
  const devices = getDevices(u);

  const revoke = (dev) => {
    setData(d => {
      const users = d.users.map(x => x.id === u.id ? { ...x, devices: Math.max(0, x.devices - 1) } : x);
      if (isSelf) return { ...d, users, myDevices: d.myDevices.filter(x => x.id !== dev.id) };
      return { ...d, users, userDevices: { ...d.userDevices, [u.id]: (d.userDevices[u.id] || []).filter(x => x.id !== dev.id) } };
    });
    toast(`Revoked ${dev.name} for ${u.name.split(' ')[0]}`, 'danger');
    setConfirm(null);
  };
  const revokeAll = () => {
    setData(d => {
      const users = d.users.map(x => x.id === u.id ? { ...x, devices: 0 } : x);
      if (isSelf) return { ...d, users, myDevices: d.myDevices.filter(x => x.current) };
      return { ...d, users, userDevices: { ...d.userDevices, [u.id]: [] } };
    });
    toast(`Signed out all devices for ${u.name.split(' ')[0]}`, 'danger');
    setConfirm(null);
  };

  return (
    <PDrawer open={!!userId} onClose={onClose} icon="laptop" title={`${u.name.split(' ')[0]}'s devices`}
      subtitle={`${devices.length} trusted device${devices.length !== 1 ? 's' : ''} · ${u.email}`}
      footer={devices.length > 1 && (
        <PBtn variant="danger" leftIcon="shield-x" onClick={() => setConfirm('all')}>Sign out all devices</PBtn>
      )}>
      <div style={{ display: 'flex', gap: 10, padding: 13, background: PC.surface, borderRadius: 10, border: `1px solid ${PC.border}`, marginBottom: 16 }}>
        <PIcon name="shield-alert" size={15} color={PC.muted} style={{ marginTop: 1, flex: '0 0 auto' }} />
        <span style={{ fontSize: 12, color: PC.muted, lineHeight: '17px' }}>
          Revoking a device signs it out immediately and removes its trust. Use this if a device is lost or stolen — {u.name.split(' ')[0]} will need to re-link it{!isSelf && ' (or be re-approved if it was their last device)'}.
        </span>
      </div>

      {devices.length === 0 ? (
        <PEmpty icon="laptop" title="No trusted devices" text={`${u.name.split(' ')[0]} has no devices linked to this server.`} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {devices.map(dev => {
            const danger = confirm === dev.id;
            return (
              <div key={dev.id} style={{ border: `1px solid ${danger ? PC.red : PC.border}`, borderRadius: 11, padding: 14,
                background: danger ? PC.redSoft : '#fff' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
                  <span style={{ width: 40, height: 40, borderRadius: 10, flex: '0 0 auto', background: PC.surface2,
                    display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <PDeviceIcon kind={dev.kind} size={19} color={PC.fg} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span style={{ fontSize: 13.5, fontWeight: 600, color: PC.fg, whiteSpace: 'nowrap' }}>{dev.name}</span>
                      {dev.current && <PPill tone="success" size="xs">This device</PPill>}
                    </div>
                    <div style={{ fontSize: 11.5, color: PC.muted, marginTop: 2 }}>{dev.browser} · {dev.os}</div>
                    <div style={{ fontSize: 11, color: PC.mutedFg, marginTop: 3, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><PIcon name="map-pin" size={11} color={PC.mutedFg} />{dev.location}</span>
                      <span style={{ fontFamily: 'Geist Mono, monospace' }}>{dev.ip}</span>
                      <span>{dev.lastActive}</span>
                    </div>
                  </div>
                  {!dev.current && (
                    danger ? (
                      <div style={{ display: 'flex', gap: 6, flex: '0 0 auto' }}>
                        <PBtn variant="ghost" size="sm" onClick={() => setConfirm(null)}>Cancel</PBtn>
                        <PBtn variant="danger" size="sm" onClick={() => revoke(dev)}>Confirm</PBtn>
                      </div>
                    ) : (
                      <PBtn variant="default" size="sm" leftIcon="log-out" onClick={() => setConfirm(dev.id)}>Revoke</PBtn>
                    )
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <PModal open={confirm === 'all'} onClose={() => setConfirm(null)} icon="shield-x" title={`Sign out all of ${u.name.split(' ')[0]}'s devices?`}
        subtitle="Every trusted device loses access immediately. They'll need to be re-approved or re-linked to get back in."
        footer={<>
          <PBtn variant="default" onClick={() => setConfirm(null)}>Cancel</PBtn>
          <PBtn variant="primary" style={{ background: PC.red, borderColor: PC.red }} onClick={revokeAll}>Sign out everything</PBtn>
        </>} />
    </PDrawer>
  );
}

function InvitePersonModal({ open, onClose, data, setData, toast }) {
  const [email, setEmail] = useP('');
  const [role, setRole] = useP('member');
  React.useEffect(() => { if (open) { setEmail(''); setRole('member'); } }, [open]);
  const invite = () => {
    const name = email.split('@')[0].replace(/\./g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const colors = ['#0ea5e9', '#d946ef', '#65a30d', '#e11d48', '#7c3aed'];
    setData(d => ({ ...d, users: [...d.users, {
      id: 'u-' + Math.random().toString(36).slice(2, 6), name, email: email.trim(), role,
      status: 'invited', color: colors[d.users.length % colors.length], lastActive: '—', devices: 0,
    }] }));
    toast(`Invitation sent to ${email.trim()}`, 'success');
    onClose();
  };
  return (
    <PModal open={open} onClose={onClose} icon="user-plus" title="Invite a person"
      subtitle="They'll sign in via Keycloak — then their first device waits for your approval."
      footer={<>
        <PBtn variant="default" onClick={onClose}>Cancel</PBtn>
        <PBtn variant="primary" disabled={!email.includes('@')} onClick={invite}>Send invite</PBtn>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <PField label="Work email" hint="Must match an account in your Keycloak realm.">
          <PTextInput value={email} onChange={setEmail} placeholder="name@harmonum.ai" mono autoFocus />
        </PField>
        <PField label="Server role">
          <PSelect value={role} onChange={setRole} options={window.SC_DATA.ROLES.map(r => ({ value: r.id, label: `${r.label} — ${r.desc}` }))} />
        </PField>
        <div style={{ display: 'flex', gap: 10, padding: 13, background: PC.surface, borderRadius: 10, border: `1px solid ${PC.border}` }}>
          <PIcon name="info" size={15} color={PC.muted} style={{ marginTop: 1, flex: '0 0 auto' }} />
          <span style={{ fontSize: 12, color: PC.muted, lineHeight: '17px' }}>
            Inviting only grants the <em>right</em> to sign in. After signing in with Keycloak, this person's first device shows you a code that you must enter to trust it.
          </span>
        </div>
      </div>
    </PModal>
  );
}

// ─── DEVICE APPROVALS (the trust gate) ──────────────────────────────────────
function ApprovalsView({ ctx }) {
  const { data, setData, toast } = ctx;
  const [focusId, setFocusId] = useP(data.pending[0]?.id || null);
  const [code, setCode] = useP('');
  const [error, setError] = useP(false);

  React.useEffect(() => { setCode(''); setError(false); }, [focusId]);

  const focus = data.pending.find(p => p.id === focusId) || null;
  const codeNoSep = (s) => s.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  const matches = focus && codeNoSep(code) === codeNoSep(focus.code);

  const approve = () => {
    if (!matches) { setError(true); return; }
    const dev = focus;
    setData(d => {
      const pending = d.pending.filter(p => p.id !== dev.id);
      // mark the user active if they were invited; bump device count
      const users = d.users.map(u => u.email === dev.userEmail
        ? { ...u, status: 'active', devices: u.devices + 1, lastActive: 'now' } : u);
      return { ...d, pending, users };
    });
    toast(`Device trusted for ${dev.userName}`, 'success');
    const next = data.pending.filter(p => p.id !== dev.id)[0];
    setFocusId(next ? next.id : null);
  };
  const deny = (p) => {
    setData(d => ({ ...d, pending: d.pending.filter(x => x.id !== p.id) }));
    toast(`Request from ${p.userName} denied`, 'danger');
    const next = data.pending.filter(x => x.id !== p.id)[0];
    setFocusId(next ? next.id : null);
  };

  const detailRow = (label, value, mono) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderBottom: `1px solid ${PC.surface2}` }}>
      <span style={{ fontSize: 12, color: PC.muted, whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ fontSize: 12.5, color: PC.fg, fontWeight: 500, fontFamily: mono ? 'Geist Mono, monospace' : 'inherit', whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  );

  return (
    <div>
      <PPageHeader title="Device approvals" icon="shield-check"
        subtitle="Keycloak proves who someone is. This step proves which device they're on. A signed-in user reaches the server only after you confirm the code shown on their screen — so a compromised Keycloak account still can't get in." />

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 18, alignItems: 'start' }}>
        {/* Left: queue */}
        <PCard pad={0}>
          <div style={{ padding: '13px 16px', borderBottom: `1px solid ${PC.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: PC.fg, whiteSpace: 'nowrap' }}>Awaiting approval</span>
            <PPill tone={data.pending.length ? 'warning' : 'neutral'} size="xs">{data.pending.length}</PPill>
          </div>
          {data.pending.length === 0 ? (
            <PEmpty icon="shield-check" title="Nothing pending" text="New sign-ins from untrusted devices will appear here." />
          ) : (
            <div style={{ padding: 8 }}>
              {data.pending.map(p => {
                const on = p.id === focusId;
                return (
                  <button key={p.id} onClick={() => setFocusId(p.id)} style={{
                    display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '11px 12px', borderRadius: 9,
                    border: `1px solid ${on ? PC.primary : 'transparent'}`, background: on ? PC.primarySoft : 'transparent',
                    cursor: 'pointer', textAlign: 'left', marginBottom: 2 }}
                    onMouseEnter={e => { if (!on) e.currentTarget.style.background = PC.surface; }}
                    onMouseLeave={e => { if (!on) e.currentTarget.style.background = 'transparent'; }}>
                    <span style={{ width: 34, height: 34, borderRadius: 9, flex: '0 0 auto', background: '#fff', border: `1px solid ${PC.border}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <PDeviceIcon kind={p.kind} size={16} color={PC.muted} />
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: PC.fg }}>{p.userName}</div>
                      <div style={{ fontSize: 11.5, color: PC.muted }}>{p.os} · {p.location}</div>
                    </div>
                    {p.firstDevice && <PPill tone="info" size="xs">1st</PPill>}
                  </button>
                );
              })}
            </div>
          )}
        </PCard>

        {/* Right: detail + code entry */}
        {focus ? (
          <PCard pad={0}>
            <div style={{ padding: '18px 22px', borderBottom: `1px solid ${PC.border}`, display: 'flex', alignItems: 'center', gap: 13 }}>
              <span style={{ width: 46, height: 46, borderRadius: 11, flex: '0 0 auto', background: PC.surface2,
                display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <PDeviceIcon kind={focus.kind} size={22} color={PC.fg} />
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: PC.fg, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {focus.userName}
                  {focus.firstDevice
                    ? <PPill tone="info" size="xs">First device</PPill>
                    : <PPill tone="neutral" size="xs">Additional device</PPill>}
                </div>
                <div style={{ fontSize: 12.5, color: PC.muted, fontFamily: 'Geist Mono, monospace' }}>{focus.userEmail}</div>
              </div>
              <PPill tone="warning" size="xs">⏱ {focus.requested}</PPill>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0, padding: '6px 22px 4px' }}>
              <div style={{ paddingRight: 18 }}>
                {detailRow('Device', `${focus.browser}`)}
                {detailRow('Operating system', focus.os)}
                {detailRow('Signed in via', focus.oauth)}
              </div>
              <div style={{ paddingLeft: 18, borderLeft: `1px solid ${PC.surface2}` }}>
                {detailRow('IP address', focus.ip, true)}
                {detailRow('Location', focus.location)}
                {detailRow('Trust origin', 'Admin approval')}
              </div>
            </div>

            {/* code entry */}
            <div style={{ margin: '14px 22px 22px', padding: 20, borderRadius: 12, border: `1px solid ${error ? PC.red : PC.border}`,
              background: error ? PC.redSoft : PC.surface }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
                <PIcon name="keyboard" size={16} color={PC.fg} />
                <span style={{ fontSize: 13.5, fontWeight: 600, color: PC.fg, whiteSpace: 'nowrap' }}>Confirm the code</span>
              </div>
              <p style={{ margin: '0 0 14px', fontSize: 12.5, color: PC.muted, lineHeight: '18px' }}>
                Ask {focus.userName.split(' ')[0]} to read you the code shown on their device, then type it below. This proves they're physically present.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <PSeg format={[4, 4]} value={code} onChange={v => { setCode(v); setError(false); }} size="md" auto />
                <PProtoHint>user is showing&nbsp;<strong style={{ color: PC.fg, fontFamily: 'Geist Mono, monospace' }}>{focus.code}</strong></PProtoHint>
              </div>
              {error && <div style={{ marginTop: 10, fontSize: 12.5, color: PC.red, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                <PIcon name="x-circle" size={14} color={PC.red} /> Code doesn't match. Check with {focus.userName.split(' ')[0]} and try again.
              </div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                <PBtn variant="primary" leftIcon="shield-check" disabled={codeNoSep(code).length < 8} onClick={approve}>Trust this device</PBtn>
                <PBtn variant="danger" leftIcon="x" onClick={() => deny(focus)}>Deny</PBtn>
              </div>
            </div>
          </PCard>
        ) : (
          <PCard><PEmpty icon="shield-check" title="No device selected"
            text="All caught up — there are no devices waiting for approval." /></PCard>
        )}
      </div>
    </div>
  );
}

window.SC_PEOPLE = { UsersView, ApprovalsView };
