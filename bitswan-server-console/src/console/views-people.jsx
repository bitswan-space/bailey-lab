import React from 'react';
// views-people.jsx — Users & roles + New user approvals (admin types the code)

const { C: PC, Icon: PIcon, Btn: PBtn, Pill: PPill } = window.WD_SHELL;
const {
  Avatar: PAvatar, Card: PCard, PageHeader: PPageHeader, Field: PField, TextInput: PTextInput,
  Modal: PModal, EmptyState: PEmpty, Drawer: PDrawer,
  SegmentedCode: PSeg, DeviceIcon: PDeviceIcon, ProtoHint: PProtoHint, LiveState: PLiveState,
} = window.SC_UI;
const { Api: PApi, ApiError: PApiError } = window.SC_API;
const { useState: useP, useEffect: usePE, useRef: usePR } = React;

// RoleSelect — a styled role picker: a pill-shaped trigger showing the current
// role, opening a menu of roles with their descriptions. onPick(roleId) fires
// when a (different) role is chosen.
function RoleSelect({ role, onPick }) {
  const [open, setOpen] = useP(false);
  const ref = usePR(null);
  usePE(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const meta = P_ROLES.find(r => r.id === role) || { id: role, label: role || '—', tone: 'neutral' };
  return (
    <div ref={ref} style={{ position: 'relative', width: 'fit-content' }}>
      <button onClick={() => setOpen(o => !o)} title="Change role" style={{
        display: 'inline-flex', alignItems: 'center', gap: 7, height: 30, padding: '0 8px 0 9px',
        border: `1px solid ${open ? PC.primary : PC.border}`, borderRadius: 8, background: '#fff',
        cursor: 'pointer', fontFamily: 'inherit', boxShadow: open ? `0 0 0 3px ${PC.primarySoft}` : 'none', transition: 'border-color 120ms, box-shadow 120ms' }}
        onMouseEnter={e => { if (!open) e.currentTarget.style.borderColor = PC.borderHi; }}
        onMouseLeave={e => { if (!open) e.currentTarget.style.borderColor = PC.border; }}>
        <PPill tone={meta.tone} size="xs">{meta.label}</PPill>
        <PIcon name="chevron-down" size={13} color={PC.mutedFg} />
      </button>
      {open && (
        <div style={{ position: 'absolute', top: 36, left: 0, zIndex: 30, width: 264,
          background: '#fff', border: `1px solid ${PC.border}`, borderRadius: 11,
          boxShadow: '0 10px 30px rgba(0,0,0,0.12)', padding: 6 }}>
          {P_ROLES.map(r => {
            const on = r.id === role;
            return (
              <button key={r.id} onClick={() => { setOpen(false); if (!on) onPick(r.id); }} style={{
                display: 'flex', alignItems: 'flex-start', gap: 9, width: '100%', padding: '8px 9px', textAlign: 'left',
                border: 0, borderRadius: 8, cursor: 'pointer', background: on ? PC.surface2 : 'transparent', fontFamily: 'inherit' }}
                onMouseEnter={e => { if (!on) e.currentTarget.style.background = PC.surface; }}
                onMouseLeave={e => { if (!on) e.currentTarget.style.background = 'transparent'; }}>
                <span style={{ marginTop: 1 }}><PPill tone={r.tone} size="xs">{r.label}</PPill></span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: PC.muted, lineHeight: '15px' }}>{r.desc}</span>
                {on && <PIcon name="check" size={14} color={PC.primary} style={{ marginTop: 2, flex: '0 0 auto' }} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const P_ROLE_TONE = { admin: 'primary', auditor: 'info', member: 'neutral', user: 'outline' };

// Static role legend (reference UI, not user data). Describes what each role
// can do; the per-person role itself comes live from /bailey/api/people.
const P_ROLES = [
  { id: 'admin',   label: 'Admin',   tone: 'primary',
    desc: 'Manages users, server settings, and device approvals. Still sees only workspaces they own or were granted — not everyone’s.' },
  { id: 'auditor', label: 'Auditor', tone: 'info',
    desc: 'Reviews security activity and signs off on deploy promotions. No automatic access to others’ workspace data.' },
  { id: 'member',  label: 'Member',  tone: 'neutral',
    desc: 'Builds in workspaces they own or were added to.' },
  { id: 'user',    label: 'User',    tone: 'outline',
    desc: 'A signed-in identity with no elevated role; sees only workspaces they own or are added to.' },
];

// ─── USERS & ROLES ──────────────────────────────────────────────────────────
// Wired to GET /bailey/api/people (admin-only): the roster, per-person role,
// workspace/device counts, last-active and invited flag all come from
// data.people. No seed fallback — a failed fetch shows the error UI, an empty
// roster shows the empty state, and /people's partial-enumeration `error`
// (200 + error) shows a non-fatal warning above the still-rendered roster.
//
// Controls the backend doesn't expose yet are disabled (not faked):
//   • Role change & suspend — no role-write / suspend route exists, so the
//     role pill is read-only and the suspend control is omitted.
// (There is no Invite button: there's no Keycloak admin client to create
// users, and people appear here as they sign in / get access anyway.)
// The per-user device drawer still uses seed device data (the admin devices
// API isn't keyed by these identities yet) and is only reachable when the
// backend reports a device count.
function UsersView({ ctx }) {
  const { data, toast, go, navigate, routeParam, refresh } = ctx;
  const [query, setQuery] = useP('');
  // The person whose devices are open lives in the URL (/users/:email) so the
  // drawer survives refresh and is shareable.
  const devicesUserId = routeParam;

  // Assign a role (admin-only, stored locally) and refresh the roster.
  const changeRole = async (email, role) => {
    try {
      await PApi.setUserRole(email, role);
      toast(`Role updated to ${role}`, 'success');
      refresh && refresh('people');
    } catch (e) {
      toast(`Couldn't change role: ${e.message}`, 'danger');
    }
  };

  const ROLES = P_ROLES;
  const people = data.people || [];
  const loaded = data.load.people === 'ok';
  const list = people.filter(u =>
    u.name.toLowerCase().includes(query.toLowerCase()) || u.email.toLowerCase().includes(query.toLowerCase()));

  return (
    <div>
      <PPageHeader title="People &amp; roles"
        subtitle="Everyone with access to this server. Roles govern what they can do; devices govern where they can do it from." />

      {/* Least-trust principle — even an admin can't see everyone's data. */}
      <div style={{ display: 'flex', gap: 10, padding: '11px 14px', marginBottom: 14,
        border: `1px solid ${PC.border}`, borderRadius: 10, background: PC.surface }}>
        <PIcon name="shield" size={15} color={PC.muted} style={{ marginTop: 1, flex: '0 0 auto' }} />
        <span style={{ fontSize: 12.5, color: PC.muted, lineHeight: '18px' }}>
          Least-trust access: a role grants <em>capabilities</em>, never blanket data access. Even an admin only reaches
          workspaces they created or were granted — so each person controls who sees their own data.
        </span>
      </div>

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

      {/* Loading / error banner for the roster fetch (retryable). */}
      {data.load.people !== 'ok' && (
        <PLiveState status={data.load.people} error={data.error.people}
          label="Loading people…" onRetry={() => ctx.refresh('people')} />
      )}

      {/* Non-fatal partial-enumeration warning (200 + error from /people). */}
      {loaded && data.peopleWarning && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', marginBottom: 14,
          border: `1px solid ${PC.amber}55`, background: '#fffbeb', borderRadius: 10 }}>
          <PIcon name="alert-triangle" size={15} color="#b45309" style={{ flex: '0 0 auto' }} />
          <span style={{ flex: 1, fontSize: 12.5, color: '#92400e', lineHeight: '17px' }}>
            Some identities couldn't be enumerated: {data.peopleWarning}
          </span>
        </div>
      )}

      {loaded && (<>
      <div style={{ position: 'relative', maxWidth: 320, marginBottom: 14 }}>
        <PIcon name="search" size={14} color={PC.mutedFg} style={{ position: 'absolute', left: 11, top: 11 }} />
        <PTextInput value={query} onChange={setQuery} placeholder="Search people…" style={{ paddingLeft: 32 }} />
      </div>

      {list.length === 0 ? (
        <PCard><PEmpty icon="users"
          title={query ? 'No people match' : 'No people yet'}
          text={query ? 'Try a different search term.' : 'Identities appear here as people sign in, link devices, or get workspace access.'} /></PCard>
      ) : (
      <PCard pad={0}>
        <div style={{ display: 'grid', gridTemplateColumns: '2.2fr 1fr 1fr 1fr 0.9fr', gap: 12,
          padding: '11px 18px', borderBottom: `1px solid ${PC.border}`, background: PC.surface,
          fontSize: 11, fontWeight: 600, color: PC.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
          <span>Person</span><span>Role</span><span>Workspaces</span><span>Devices</span><span>Last active</span>
        </div>
        {list.map(u => (
          <div key={u.id} style={{ display: 'grid', gridTemplateColumns: '2.2fr 1fr 1fr 1fr 0.9fr', gap: 12,
            padding: '12px 18px', borderBottom: `1px solid ${PC.surface2}`, alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
              <PAvatar user={u} size={32} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: PC.fg, display: 'flex', alignItems: 'center', gap: 7 }}>
                  {u.name}
                  {u.role === 'admin' && <span title="Administrator"><PIcon name="crown" size={13} color={PC.amber} /></span>}
                  {u.invited && <PPill tone="warning" size="xs">Invited</PPill>}
                </div>
                <div style={{ fontSize: 11.5, color: PC.muted, fontFamily: 'Geist Mono, monospace' }}>{u.email}</div>
              </div>
            </div>
            {/* Role is a styled dropdown; admins change roles here. The role is
                stored locally (user_roles) and authoritative — not from SSO. */}
            <RoleSelect role={u.role} onPick={(role) => changeRole(u.email, role)} />
            <span style={{ fontSize: 13, color: PC.fg }}>{u.workspaceCount}</span>
            <button onClick={() => u.deviceCount > 0 && navigate('users', u.id)} title={u.deviceCount ? 'Manage devices' : 'No devices'}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 9px', borderRadius: 7,
                border: `1px solid ${u.deviceCount ? PC.border : 'transparent'}`, background: u.deviceCount ? '#fff' : 'transparent',
                cursor: u.deviceCount ? 'pointer' : 'default', fontFamily: 'inherit', fontSize: 13, color: u.deviceCount ? PC.fg : PC.mutedFg, fontWeight: 500, width: 'fit-content' }}
              onMouseEnter={e => { if (u.deviceCount) e.currentTarget.style.background = PC.surface2; }}
              onMouseLeave={e => { if (u.deviceCount) e.currentTarget.style.background = '#fff'; }}>
              <PIcon name="laptop" size={13} color={PC.mutedFg} />{u.deviceCount}
              {u.deviceCount > 0 && <PIcon name="chevron-right" size={12} color={PC.mutedFg} />}
            </button>
            <span style={{ fontSize: 12.5, color: PC.muted }}>{u.lastActive || '—'}</span>
          </div>
        ))}
      </PCard>
      )}
      </>)}

      <UserDevicesDrawer userId={devicesUserId} onClose={() => navigate('users')} ctx={ctx} />
    </div>
  );
}

// ─── ADMIN: view & revoke another user's devices ────────────────────────────
// The People roster is keyed by email; the admin devices API
// (/bailey/api/admin/devices) returns devices grouped by that same email, so
// this drawer lists the person's real devices and revokes them admin-side
// (POST /bailey/api/admin/devices/remove). No seed data.
function UserDevicesDrawer({ userId, onClose, ctx }) {
  const { data, toast, refresh } = ctx;
  const u = (data.people || []).find(x => x.id === userId);
  const [devices, setDevices] = useP(null); // null = loading, [] = none
  const [err, setErr] = useP('');
  const [busyId, setBusyId] = useP('');

  const load = async (email) => {
    setErr(''); setDevices(null);
    try {
      const r = await PApi.adminDevices();
      const row = (r.users || []).find(x => (x.email || '').toLowerCase() === email.toLowerCase());
      setDevices((row && row.devices) || []);
    } catch (e) {
      setErr(e.message || 'Could not load this person’s devices.');
      setDevices([]);
    }
  };
  usePE(() => { if (userId && u) load(u.email); }, [userId]);

  const revoke = async (d) => {
    setBusyId(d.id);
    try {
      await PApi.adminRemoveDevice(u.email, d.id);
      toast(`Signed out ${d.name}`, 'danger');
      await load(u.email);
      refresh && refresh('people'); // device counts in the roster
    } catch (e) {
      toast(`Couldn't remove device: ${e.message}`, 'danger');
    } finally { setBusyId(''); }
  };

  if (!u) return null;
  const firstName = (u.name || u.email).split(/[ @]/)[0];
  const list = devices || [];

  return (
    <PDrawer open={!!userId} onClose={onClose} icon="laptop" title={`${firstName}'s devices`}
      subtitle={`${u.email}`}>
      {devices === null && !err && (
        <div style={{ fontSize: 13, color: PC.muted, padding: '8px 2px' }}>Loading devices…</div>
      )}
      {err && (
        <div style={{ display: 'flex', gap: 10, padding: 13, background: PC.surface, borderRadius: 10, border: `1px solid ${PC.border}`, marginBottom: 12 }}>
          <PIcon name="shield-alert" size={15} color={PC.red} style={{ marginTop: 1, flex: '0 0 auto' }} />
          <span style={{ fontSize: 12.5, color: PC.fg, lineHeight: '17px' }}>{err} <button onClick={() => load(u.email)} style={{ border: 0, background: 'transparent', color: PC.primary, cursor: 'pointer', font: 'inherit', fontWeight: 600 }}>Retry</button></span>
        </div>
      )}
      {devices !== null && !err && list.length === 0 && (
        <PEmpty icon="laptop" title="No trusted devices"
          text={`${firstName} has no trusted devices on this server yet.`} />
      )}
      {list.map(d => (
        <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 13px', border: `1px solid ${PC.border}`, borderRadius: 11, background: '#fff', marginBottom: 8 }}>
          <PDeviceIcon kind="laptop" size={20} color={PC.fg} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: PC.fg }}>{d.name}</span>
              {d.origin === 'root' && <PPill tone="primary" size="xs">Root device</PPill>}
              {d.is_current && <PPill tone="success" size="xs">● This device</PPill>}
            </div>
            <div style={{ fontSize: 11.5, color: PC.muted, marginTop: 2 }}>
              {d.last_seen ? `Last seen ${d.last_seen}` : 'Not seen yet'}{d.paired_at ? ` · Added ${d.paired_at}` : ''}
            </div>
          </div>
          <PBtn variant="default" size="sm" leftIcon="log-out" disabled={busyId === d.id}
            style={{ color: PC.red, borderColor: PC.red }} onClick={() => revoke(d)}>
            {busyId === d.id ? 'Signing out…' : 'Sign out'}
          </PBtn>
        </div>
      ))}
    </PDrawer>
  );
}

// ─── DEVICE APPROVALS (the trust gate) ──────────────────────────────────────
function ApprovalsView({ ctx }) {
  const { data, setData, toast, refresh } = ctx;
  const [focusId, setFocusId] = useP(data.pending[0]?.id || null);
  const [code, setCode] = useP('');
  const [error, setError] = useP(false);
  const [errMsg, setErrMsg] = useP('');
  const [busy, setBusy] = useP(false);

  React.useEffect(() => { setCode(''); setError(false); setErrMsg(''); }, [focusId]);
  // Keep a valid focus as the live list changes (mount, refetch).
  React.useEffect(() => {
    if (!data.pending.find(p => p.id === focusId)) setFocusId(data.pending[0]?.id || null);
  }, [data.pending]);

  const focus = data.pending.find(p => p.id === focusId) || null;
  const codeNoSep = (s) => s.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  // The backend does NOT send the expected code (the admin reads it off the
  // user's screen — that's the trust step), so we can't match locally. The
  // pairing code is 6 digits (generatePendingPair, "%06d"); require a full
  // 6-char entry and let the server validate it — a mismatch comes back as a
  // 401 from /2fa-gate/approve.
  const codeReady = focus && codeNoSep(code).length >= 6;

  // Live: POST email+code to the gate's approve handler, then re-fetch the
  // pending list. On a code mismatch the backend returns 401 → ApiError.
  const approve = async () => {
    if (!codeReady || !focus) { setError(true); return; }
    setBusy(true); setError(false); setErrMsg('');
    try {
      await PApi.approvePair(focus.userEmail, codeNoSep(code));
      toast(`Device trusted for ${focus.userName}`, 'success');
      await Promise.all([refresh('approvals'), refresh('devices')]);
    } catch (e) {
      setError(true);
      setErrMsg(e instanceof PApiError && e.status === 401
        ? "Code didn't match — check with them and try again."
        : (e.message || 'Approval failed.'));
    } finally { setBusy(false); }
  };
  // TODO(api): no backend endpoint yet — there's no "deny/reject pending
  // pair" route in bailey_dispatch.go. Pending requests expire on their
  // own; "Dismiss" only clears it from this view until the next refetch.
  const deny = (p) => {
    setData(d => ({ ...d, pending: d.pending.filter(x => x.id !== p.id) }));
    toast(`Dismissed request from ${p.userName} (it will expire server-side)`, 'info');
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
      <PPageHeader title="New user approvals" icon="shield-check"
        subtitle="Your identity provider proves who someone is. This step proves which device they're on. A signed-in user reaches the server only after you confirm the code shown on their screen — so a compromised identity-provider account still can't get in." />

      {data.load.approvals !== 'ok' && (
        <PLiveState status={data.load.approvals} error={data.error.approvals}
          label="Loading pending approvals…" onRetry={() => refresh('approvals')} />
      )}

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
                      <div style={{ fontSize: 13, fontWeight: 600, color: PC.fg, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.userName}</div>
                      <div style={{ fontSize: 11.5, color: PC.muted }}>Pending pair · {p.requested}</div>
                    </div>
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
                {detailRow('Account', focus.userEmail, true)}
                {detailRow('Signed in via', focus.oauth)}
              </div>
              <div style={{ paddingLeft: 18, borderLeft: `1px solid ${PC.surface2}` }}>
                {detailRow('Requested', focus.requested)}
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
                <PSeg format={[3, 3]} value={code} onChange={v => { setCode(v); setError(false); setErrMsg(''); }} size="md" auto />
              </div>
              {error && <div style={{ marginTop: 10, fontSize: 12.5, color: PC.red, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                <PIcon name="x-circle" size={14} color={PC.red} /> {errMsg || `Enter the full code from ${focus.userName.split('@')[0]}'s screen.`}
              </div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                <PBtn variant="primary" leftIcon="shield-check" disabled={!codeReady || busy} onClick={approve}>{busy ? 'Approving…' : 'Trust this device'}</PBtn>
                <PBtn variant="danger" leftIcon="x" disabled={busy} onClick={() => deny(focus)}>Dismiss</PBtn>
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

// ─── ENDPOINT ACCESS (read-only ACL tree) ───────────────────────────────────
// Admin-only, observational: every registered endpoint with its owner and ACL
// grants, nested workspace → endpoints by `parent`. Read-only by design — even
// an admin doesn't edit others' ACLs here; there are no mutation controls.
function EndpointAccessView({ ctx }) {
  const [tree, setTree] = useP(null);     // null = loading
  const [err, setErr] = useP('');
  const [nonce, setNonce] = useP(0);      // bump to refetch

  usePE(() => {
    let alive = true;
    setErr(''); setTree(null);
    PApi.adminACL()
      .then(r => { if (alive) setTree(r.endpoints || []); })
      .catch(e => { if (alive) { setErr(e.message || 'Could not load endpoints.'); setTree([]); } });
    return () => { alive = false; };
  }, [nonce]);

  const all = tree || [];
  // Special endpoints get their own sections; the rest form the owned tree.
  const publicEps = all.filter(e => e.access === 'public').sort((a, b) => a.hostname.localeCompare(b.hostname));
  const allUsersEps = all.filter(e => e.access === 'all-users').sort((a, b) => a.hostname.localeCompare(b.hostname));
  const eps = all.filter(e => !e.access || e.access === 'owned');

  // Build parent → children for the OWNED endpoints. Roots = owned endpoints
  // with no (or unknown) owned parent.
  const byHost = {};
  eps.forEach(e => { byHost[e.hostname] = e; });
  const childrenOf = {};
  eps.forEach(e => {
    const key = (e.parent && byHost[e.parent]) ? e.parent : '';
    (childrenOf[key] = childrenOf[key] || []).push(e);
  });
  const roots = (childrenOf[''] || []).slice().sort((a, b) => a.hostname.localeCompare(b.hostname));

  const KIND = {
    workspace: { icon: 'layout-grid', label: 'Workspace' },
    frontend:  { icon: 'app-window', label: 'Frontend' },
    service:   { icon: 'server-cog', label: 'Service' },
  };

  const Grants = ({ e }) => {
    const list = e.grants || [];
    return (
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <PIcon name="crown" size={12} color={PC.amber} />
          <span style={{ fontSize: 12, color: PC.fg, fontFamily: 'Geist Mono, monospace' }}>{e.owner_email || 'unowned'}</span>
          <PPill tone="primary" size="xs">Owner</PPill>
        </div>
        {list.length === 0 ? (
          <div style={{ fontSize: 11.5, color: PC.mutedFg, paddingLeft: 20 }}>No additional grants — only the owner has access.</div>
        ) : list.map((g, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 20 }}>
            <PIcon name={g.principal_type === 'group' ? 'users' : 'user'} size={12} color={PC.mutedFg} />
            <span style={{ fontSize: 12, color: PC.fg, fontFamily: 'Geist Mono, monospace' }}>{g.principal_value}</span>
            <PPill tone={g.role === 'owner' ? 'primary' : 'neutral'} size="xs">{g.role}</PPill>
            {g.principal_type === 'group' && <span style={{ fontSize: 10.5, color: PC.mutedFg }}>group</span>}
          </div>
        ))}
      </div>
    );
  };

  const Node = ({ e, depth }) => {
    const kids = (childrenOf[e.hostname] || []).slice().sort((a, b) => a.hostname.localeCompare(b.hostname));
    const k = KIND[e.kind] || { icon: 'globe', label: e.kind || 'Endpoint' };
    return (
      <div style={{ marginLeft: depth ? 18 : 0, borderLeft: depth ? `1px solid ${PC.border}` : 'none', paddingLeft: depth ? 14 : 0 }}>
        <div style={{ border: `1px solid ${PC.border}`, borderRadius: 10, background: '#fff', padding: '12px 14px', marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <PIcon name={k.icon} size={16} color={PC.muted} />
            <span style={{ fontSize: 13.5, fontWeight: 600, color: PC.fg, fontFamily: 'Geist Mono, monospace' }}>{e.hostname}</span>
            <PPill tone="neutral" size="xs">{k.label}</PPill>
            {e.stage && <PPill tone="outline" size="xs">{e.stage}</PPill>}
          </div>
          <Grants e={e} />
        </div>
        {kids.map(c => <Node key={c.hostname} e={c} depth={depth + 1} />)}
      </div>
    );
  };

  const SECTION = { fontSize: 11, fontWeight: 600, color: PC.muted, textTransform: 'uppercase', letterSpacing: 0.4, margin: '4px 0 10px' };
  const SpecialCard = ({ e, icon, note }) => (
    <div style={{ border: `1px solid ${PC.border}`, borderRadius: 10, background: '#fff', padding: '12px 14px', marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <PIcon name={icon} size={16} color={PC.muted} />
        <span style={{ fontSize: 13.5, fontWeight: 600, color: PC.fg, fontFamily: 'Geist Mono, monospace' }}>{e.hostname}</span>
      </div>
      <div style={{ fontSize: 12, color: PC.muted, marginTop: 6, lineHeight: '17px' }}>{note}</div>
    </div>
  );
  const nothing = tree !== null && !err && publicEps.length === 0 && allUsersEps.length === 0 && roots.length === 0;

  return (
    <div>
      <PPageHeader title="Endpoint access" icon="git-fork"
        subtitle="Every endpoint this server routes and who can reach it. Read-only — access is changed by each endpoint's owner from its share dialog." />
      {tree === null && !err && <div style={{ fontSize: 13, color: PC.muted }}>Loading endpoints…</div>}
      {err && (
        <PLiveState status="error" error={err} label="Couldn't load endpoint access" onRetry={() => setNonce(n => n + 1)} />
      )}
      {nothing && (
        <PEmpty icon="git-fork" title="No endpoints registered yet"
          text="Endpoints appear here as workspaces and apps are created on this server." />
      )}

      {publicEps.length > 0 && (
        <>
          <div style={SECTION}>Public endpoints</div>
          {publicEps.map(e => <SpecialCard key={e.hostname} e={e} icon="globe"
            note="Public — any signed-in user reaches this without a per-endpoint grant. It's how a new device gets trusted (the onboarding flow)." />)}
        </>
      )}
      {allUsersEps.length > 0 && (
        <>
          <div style={{ ...SECTION, marginTop: 18 }}>Available to all signed-in users</div>
          {allUsersEps.map(e => <SpecialCard key={e.hostname} e={e} icon="users"
            note="Every verified user can reach this — e.g. the Server Console, so anyone can manage their own devices. Not restricted to its owner." />)}
        </>
      )}
      {roots.length > 0 && (
        <>
          <div style={{ ...SECTION, marginTop: 18 }}>Workspaces &amp; apps</div>
          {roots.map(e => <Node key={e.hostname} e={e} depth={0} />)}
        </>
      )}
    </div>
  );
}

window.SC_PEOPLE = { UsersView, ApprovalsView, EndpointAccessView };