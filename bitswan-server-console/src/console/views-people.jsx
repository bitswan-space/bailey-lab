import React from 'react';
// views-people.jsx — Users & roles + Device approvals (admin types the code)

const { C: PC, Icon: PIcon, Btn: PBtn, Pill: PPill } = window.WD_SHELL;
const {
  Avatar: PAvatar, Card: PCard, PageHeader: PPageHeader, Field: PField, TextInput: PTextInput,
  Modal: PModal, EmptyState: PEmpty, Drawer: PDrawer, Select: PSelect,
  SegmentedCode: PSeg, DeviceIcon: PDeviceIcon, ProtoHint: PProtoHint, LiveState: PLiveState,
} = window.SC_UI;
const { Api: PApi, ApiError: PApiError } = window.SC_API;
const { useState: useP } = React;

const P_ROLE_TONE = { admin: 'primary', auditor: 'info', member: 'neutral', viewer: 'outline' };

// Static role legend (reference UI, not user data). Describes what each role
// can do; the per-person role itself comes live from /bailey/api/people.
const P_ROLES = [
  { id: 'admin',   label: 'Admin',   tone: 'primary',
    desc: 'Approves devices, manages users & workspaces, owns server settings.' },
  { id: 'auditor', label: 'Auditor', tone: 'info',
    desc: 'Signs off on deploy promotions. Read access to all workspaces.' },
  { id: 'member',  label: 'Member',  tone: 'neutral',
    desc: 'Builds in workspaces they own or are added to.' },
  { id: 'viewer',  label: 'Viewer',  tone: 'outline',
    desc: 'Read-only access to assigned workspaces.' },
];

// ─── USERS & ROLES ──────────────────────────────────────────────────────────
// Wired to GET /bailey/api/people (admin-only): the roster, per-person role,
// workspace/device counts, last-active and invited flag all come from
// data.people. No seed fallback — a failed fetch shows the error UI, an empty
// roster shows the empty state, and /people's partial-enumeration `error`
// (200 + error) shows a non-fatal warning above the still-rendered roster.
//
// Controls the backend doesn't expose yet are disabled (not faked):
//   • Invite — POST /people/invite returns 501 (no Keycloak admin client),
//     so the button is disabled with a tooltip rather than calling it.
//   • Role change & suspend — no role-write / suspend route exists, so the
//     role pill is read-only and the suspend control is omitted.
// The per-user device drawer still uses seed device data (the admin devices
// API isn't keyed by these identities yet) and is only reachable when the
// backend reports a device count.
function UsersView({ ctx }) {
  const { data, toast, go } = ctx;
  const [query, setQuery] = useP('');
  const [devicesUserId, setDevicesUserId] = useP(null);

  const ROLES = P_ROLES;
  const people = data.people || [];
  const loaded = data.load.people === 'ok';
  const list = people.filter(u =>
    u.name.toLowerCase().includes(query.toLowerCase()) || u.email.toLowerCase().includes(query.toLowerCase()));

  const INVITE_DISABLED = "Invites aren't wired up yet — the backend has no Keycloak admin client (POST /people/invite returns 501).";
  const ROLE_DISABLED = "Role changes aren't wired up yet — the backend has no role-write endpoint.";

  return (
    <div>
      <PPageHeader title="People &amp; roles"
        subtitle="Everyone with access to this server. Roles govern what they can do; devices govern where they can do it from."
        actions={
          <span title={INVITE_DISABLED} style={{ display: 'inline-flex' }}>
            <PBtn variant="primary" leftIcon="user-plus" disabled onClick={() => {}}>Invite person</PBtn>
          </span>
        } />

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
            <div title={ROLE_DISABLED}>
              <PPill tone={P_ROLE_TONE[u.role] || 'neutral'} size="xs">{u.role}</PPill>
            </div>
            <span style={{ fontSize: 13, color: PC.fg }}>{u.workspaceCount}</span>
            <button onClick={() => u.deviceCount > 0 && setDevicesUserId(u.id)} title={u.deviceCount ? 'Manage devices' : 'No devices'}
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

      <UserDevicesDrawer userId={devicesUserId} onClose={() => setDevicesUserId(null)} ctx={ctx} />
    </div>
  );
}

// ─── ADMIN: view & revoke another user's devices ────────────────────────────
// TODO(api): the People roster is keyed by email (from /people), but the admin
// devices API (/bailey/api/admin/devices) isn't yet correlated to these
// identities, so this drawer can't list a person's real devices. It is only
// reachable when /people reports device_count > 0; until the device API is
// wired here, revoke is disabled and the drawer explains why rather than
// faking a revoke against seed data.
function UserDevicesDrawer({ userId, onClose, ctx }) {
  const { data } = ctx;
  const u = (data.people || []).find(x => x.id === userId);
  if (!u) return null;
  const firstName = (u.name || u.email).split(/[ @]/)[0];

  return (
    <PDrawer open={!!userId} onClose={onClose} icon="laptop" title={`${firstName}'s devices`}
      subtitle={`${u.deviceCount} trusted device${u.deviceCount !== 1 ? 's' : ''} · ${u.email}`}>
      <div style={{ display: 'flex', gap: 10, padding: 13, background: PC.surface, borderRadius: 10, border: `1px solid ${PC.border}`, marginBottom: 16 }}>
        <PIcon name="shield-alert" size={15} color={PC.muted} style={{ marginTop: 1, flex: '0 0 auto' }} />
        <span style={{ fontSize: 12, color: PC.muted, lineHeight: '17px' }}>
          The backend reports {firstName} has {u.deviceCount} trusted device{u.deviceCount !== 1 ? 's' : ''} on this server.
        </span>
      </div>

      <PEmpty icon="laptop" title="Per-person device list isn't wired yet"
        text="The admin devices API isn't yet correlated to these identities, so individual devices and revoke can't be shown here. Manage devices from Device approvals for now." />
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
  // The backend does NOT send the expected code (the admin reads it off
  // the user's screen — that's the trust step), so we can't match locally.
  // We require a full 8-char entry and let the server validate it; a
  // mismatch comes back as a 401 from /2fa-gate/approve.
  const codeReady = focus && codeNoSep(code).length >= 8;

  // Live: POST email+code to the gate's approve handler, then re-fetch the
  // pending list. On a code mismatch the backend returns 401 → ApiError.
  const approve = async () => {
    if (!codeReady || !focus) { setError(true); return; }
    setBusy(true); setError(false); setErrMsg('');
    try {
      await PApi.approvePair(focus.userEmail, code.trim());
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
      <PPageHeader title="Device approvals" icon="shield-check"
        subtitle="Keycloak proves who someone is. This step proves which device they're on. A signed-in user reaches the server only after you confirm the code shown on their screen — so a compromised Keycloak account still can't get in." />

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
                <PSeg format={[4, 4]} value={code} onChange={v => { setCode(v); setError(false); setErrMsg(''); }} size="md" auto />
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

window.SC_PEOPLE = { UsersView, ApprovalsView };