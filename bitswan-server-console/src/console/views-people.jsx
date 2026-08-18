import React from 'react';
// views-people.jsx — Users & roles: roster, device approvals (admin types the
// code), org-user invites (48h copy-me link) + pending-invite management.

const { C: PC, Icon: PIcon, Btn: PBtn, Pill: PPill } = window.WD_SHELL;
const {
  Avatar: PAvatar, UserChip: PUserChip, Card: PCard, PageHeader: PPageHeader, Field: PField, TextInput: PTextInput,
  Modal: PModal, EmptyState: PEmpty, Drawer: PDrawer,
  SegmentedCode: PSeg, DeviceIcon: PDeviceIcon, ProtoHint: PProtoHint, LiveState: PLiveState,
} = window.SC_UI;
const { Api: PApi, ApiError: PApiError } = window.SC_API;
const { useState: useP, useEffect: usePE, useRef: usePR } = React;

// RoleSelect — a styled role picker: a pill-shaped trigger showing the current
// role, opening a menu of roles with their descriptions. onPick(roleId) fires
// when a (different) role is chosen. `roles` narrows the menu (the invite
// dialog offers member/admin only).
function RoleSelect({ role, onPick, roles = P_ROLES }) {
  const [open, setOpen] = useP(false);
  const ref = usePR(null);
  usePE(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const meta = roles.find(r => r.id === role) || { id: role, label: role || '—', tone: 'neutral' };
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
          {roles.map(r => {
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

// A successful approval only STAMPS the pending pair server-side — the trusted
// device record is minted later, when the user's device claims the approval on
// its next ~2s poll (see the daemon's pending-pair flow). A refetch fired right
// after the approve call therefore races that claim and still reads the old
// device counts, which is exactly the reported staleness (#331): the roster
// count / device lists never caught up until a manual page reload. So after
// the immediate refresh, re-sync the affected lists a few more times, in the
// background (rendered data stays on screen while refetching — #257). Bounded:
// a handful of one-shot timers, never an open-ended poll. If the user's device
// never claims (tab closed), the counts correctly stay as they are.
const APPROVAL_SETTLE_DELAYS_MS = [2500, 6000, 12000];
const APPROVAL_SETTLE_LISTS = ['approvals', 'devices', 'people', 'overview'];
function scheduleApprovalSettle(refresh) {
  APPROVAL_SETTLE_DELAYS_MS.forEach((ms) => setTimeout(() => {
    APPROVAL_SETTLE_LISTS.forEach((k) => refresh(k, { background: true }));
  }, ms));
}

// PendingApprovalBar — the device-trust step, inlined under the person it
// belongs to in the roster. The admin reads the code off the user's screen and
// types it here; the backend validates it (a mismatch is a 401). Shows whether
// this is the person's first device or an additional one, so the admin has the
// context to decide. POSTs to the gate's approve handler (PApi.approvePair).
function PendingApprovalBar({ req, person, ctx }) {
  const { toast, refresh } = ctx;
  const [code, setCode] = useP('');
  const [error, setError] = useP(false);
  const [errMsg, setErrMsg] = useP('');
  const [busy, setBusy] = useP(false);

  const codeNoSep = (s) => s.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  // The pairing code is 6 digits (generatePendingPair, "%06d"); the backend
  // never sends it (that's the whole point — the admin reads it off the user's
  // device), so we just require a full 6-char entry and let the server check it.
  const codeReady = codeNoSep(code).length >= 6;
  const firstName = (req.userName || req.userEmail).split(/[ @]/)[0];
  const existingDevices = person ? (person.deviceCount || 0) : 0;
  const isAdditional = existingDevices > 0;

  const approve = async () => {
    if (!codeReady) { setError(true); return; }
    setBusy(true); setError(false); setErrMsg('');
    try {
      await PApi.approvePair(req.userEmail, codeNoSep(code));
      toast(`Device trusted for ${req.userName}`, 'success');
      // Refresh approvals (clears this bar + the sidebar badge), devices, the
      // roster (device counts + a brand-new person now becomes a real device
      // owner) and the overview counts. Background: the roster stays rendered
      // while refetching instead of dropping to "Loading people…" (#257).
      await Promise.all(APPROVAL_SETTLE_LISTS.map((k) => refresh(k, { background: true })));
      // …and re-sync shortly after, once the user's device has claimed the
      // approval and the trusted device actually exists (#331).
      scheduleApprovalSettle(refresh);
    } catch (e) {
      setError(true);
      setErrMsg(e instanceof PApiError && e.status === 401
        ? "Code didn't match — check with them and try again."
        : (e.message || 'Approval failed.'));
    } finally { setBusy(false); }
  };
  // Persistently deny the request server-side (delete the pending pair), then
  // refresh — otherwise it reappears on the next refetch. A denied user can
  // still request again from their device; this just clears the current one.
  const dismiss = async () => {
    setBusy(true); setError(false); setErrMsg('');
    try {
      await PApi.denyApproval(req.userEmail);
      toast(`Dismissed the device request from ${req.userName}`, 'info');
      await refresh('approvals');
    } catch (e) {
      setError(true);
      setErrMsg(e.message || 'Could not dismiss the request.');
    } finally { setBusy(false); }
  };

  return (
    <div style={{ borderTop: `1px solid ${PC.primary}33`, background: error ? PC.redSoft : PC.primarySoft, padding: '14px 18px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 9 }}>
        <span style={{ width: 32, height: 32, borderRadius: 8, background: '#fff', border: `1px solid ${PC.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}>
          <PDeviceIcon kind={req.kind} size={16} color={PC.primary} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: PC.fg, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            Device awaiting approval
            {isAdditional ? <PPill tone="neutral" size="xs">Additional device</PPill> : <PPill tone="info" size="xs">First device</PPill>}
            <PPill tone="warning" size="xs">⏱ {req.requested}</PPill>
          </div>
          <div style={{ fontSize: 12, color: PC.fg, fontWeight: 500, marginTop: 3 }}>
            {req.deviceLabel || 'Unknown device'}
          </div>
          <div style={{ fontSize: 11.5, color: PC.muted, marginTop: 1 }}>
            {isAdditional
              ? `${firstName} already has ${existingDevices} trusted device${existingDevices > 1 ? 's' : ''} — this would add another.`
              : `This is ${firstName}'s first device on this server — no other trusted devices yet.`}
          </div>
        </div>
      </div>
      <p style={{ margin: '0 0 12px', fontSize: 12.5, color: PC.muted, lineHeight: '18px' }}>
        Ask {firstName} to read you the code shown on their device, then type it below. This proves they're physically present — a compromised identity-provider account alone can't get in.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <PSeg format={[3, 3]} value={code} onChange={v => { setCode(v); setError(false); setErrMsg(''); }} size="md" auto />
        <div style={{ display: 'flex', gap: 8 }}>
          <PBtn variant="primary" leftIcon="shield-check" disabled={!codeReady || busy} onClick={approve}>{busy ? 'Approving…' : 'Trust this device'}</PBtn>
          <PBtn variant="default" leftIcon="x" disabled={busy} onClick={dismiss}>Dismiss</PBtn>
        </div>
      </div>
      {error && <div style={{ marginTop: 10, fontSize: 12.5, color: PC.red, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
        <PIcon name="x-circle" size={14} color={PC.red} /> {errMsg || `Enter the full code from ${firstName}'s screen.`}
      </div>}
    </div>
  );
}

// The invite dialog offers exactly the roles an invite may carry (the backend
// rejects anything else).
const P_INVITE_ROLES = P_ROLES.filter(r => r.id === 'admin' || r.id === 'member');

// inviteExpiryLabel — human countdown for an invite's 48h window. The backend
// flags `expired` authoritatively; the countdown is display-only.
function inviteExpiryLabel(inv) {
  if (inv.expired) return 'expired';
  const ms = new Date(inv.expires_at).getTime() - Date.now();
  if (isNaN(ms)) return '';
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3600000);
  if (h >= 1) return `expires in ${h}h`;
  return `expires in ${Math.max(1, Math.floor(ms / 60000))}m`;
}

// ─── INVITE LINK PANEL ──────────────────────────────────────────────────────
// The invite link IS a credential: whoever opens it while signed in as the
// invited account gets a trusted device on this server. Nothing on the
// platform delivers it — an emailed link would make possession of a mailbox
// enough to earn device trust (#369) — so it is shown here for the admin to
// copy and pass on over a channel they trust.
//
// Copy degrades on purpose: where the clipboard API is missing or refuses
// (non-secure context, locked-down browser) the link is still readable and
// selectable in the field, and the button says so instead of pretending. The
// link is never logged.
function InviteLinkPanel({ email, link, note }) {
  const [copied, setCopied] = useP(false);
  const [copyErr, setCopyErr] = useP('');
  const inputRef = usePR(null);
  const selectAll = () => {
    const el = inputRef.current;
    if (el) { el.focus(); el.select(); }
  };
  const copy = async () => {
    setCopyErr('');
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch (e) {
      selectAll();
      setCopyErr('Couldn\u2019t reach the clipboard. The link is selected above — copy it with your keyboard.');
    }
  };
  return (
    <div style={{ padding: '12px 13px', background: PC.surface, borderRadius: 10, border: `1px solid ${PC.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <PIcon name="link" size={14} color={PC.mutedFg} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: PC.fg }}>Invite link for {email}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input ref={inputRef} readOnly value={link} onFocus={selectAll} onClick={selectAll}
          aria-label={`Invite link for ${email}`}
          style={{
            flex: 1, minWidth: 0, height: 34, padding: '0 10px', border: `1px solid ${PC.border}`,
            borderRadius: 8, background: '#fff', fontFamily: 'Geist Mono, monospace', fontSize: 12,
            color: PC.fg, outline: 'none',
          }} />
        <PBtn variant={copied ? 'default' : 'primary'} size="sm" leftIcon={copied ? 'check' : 'copy'} onClick={copy}>
          {copied ? 'Copied' : 'Copy link'}
        </PBtn>
      </div>
      {copyErr && (
        <div style={{ display: 'flex', gap: 7, marginTop: 8 }}>
          <PIcon name="alert-triangle" size={13} color="#b45309" style={{ marginTop: 2, flex: '0 0 auto' }} />
          <span style={{ fontSize: 11.5, color: '#92400e', lineHeight: '16px' }}>{copyErr}</span>
        </div>
      )}
      <div style={{ display: 'flex', gap: 7, marginTop: 9 }}>
        <PIcon name="shield-alert" size={13} color={PC.mutedFg} style={{ marginTop: 2, flex: '0 0 auto' }} />
        <span style={{ fontSize: 11.5, color: PC.muted, lineHeight: '16px' }}>
          {note || `Treat this like a password: anyone who opens it signed in as ${email} gets a trusted device here. Send it over a channel you trust — the server deliberately doesn\u2019t send it for you. It works once and expires in 48 hours.`}
        </span>
      </div>
    </div>
  );
}

// ─── INVITE DIALOG ──────────────────────────────────────────────────────────
// Lists the AOC organization's users (GET /bailey/api/people/org-users) — the
// only people who may be invited — and creates the invite (POST .../invite).
// Creating never sends anything: the response carries invite_link, which the
// dialog shows in an InviteLinkPanel for the admin to copy and deliver
// themselves (#369). Errors (e.g. 502 when the AOC is unreachable — nothing
// was created) surface as an inline banner.
function InviteDialog({ open, onClose, ctx, onChanged }) {
  const { toast } = ctx;
  const [users, setUsers] = useP(null);   // null = loading
  const [loadErr, setLoadErr] = useP('');
  const [query, setQuery] = useP('');
  const [selected, setSelected] = useP('');
  const [role, setRole] = useP('member');
  const [busy, setBusy] = useP(false);
  const [submitErr, setSubmitErr] = useP('');
  const [created, setCreated] = useP(null); // { email, link } — invite made, link to copy

  const load = async () => {
    setLoadErr(''); setUsers(null);
    try {
      const r = await PApi.orgUsers();
      setUsers(r.users || []);
    } catch (e) {
      setLoadErr(e.message || 'Could not load organization users.');
      setUsers([]);
    }
  };
  usePE(() => {
    if (!open) return;
    setQuery(''); setSelected(''); setRole('member');
    setSubmitErr(''); setCreated(null);
    load();
  }, [open]);

  const create = async () => {
    if (!selected) return;
    setBusy(true); setSubmitErr('');
    try {
      const r = await PApi.invite(selected, role);
      onChanged && onChanged();
      setCreated({ email: selected, link: (r && r.invite_link) || '' });
      toast(`Invite created for ${selected}`, 'success');
    } catch (e) {
      setSubmitErr(e.message || 'Could not create the invite.');
    } finally { setBusy(false); }
  };

  const list = (users || []).filter(u =>
    (u.email || '').toLowerCase().includes(query.toLowerCase())
    || (u.username || '').toLowerCase().includes(query.toLowerCase()));

  return (
    <PModal open={open} onClose={onClose} title="Invite someone" icon="user-plus" width={560}
      subtitle="Only members of this server's organization can be invited. You get a single-use 48-hour link to pass on yourself — the server never sends it. Their first device is trusted when they open it."
      footer={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
          <span style={{ flex: 1 }} />
          <PBtn variant={created ? 'primary' : 'default'} onClick={onClose}>{created ? 'Done' : 'Close'}</PBtn>
          {!created && (
            <PBtn variant="primary" leftIcon="link" disabled={!selected || busy} onClick={create}>
              {busy ? 'Creating\u2026' : 'Create invite link'}
            </PBtn>
          )}
        </div>
      }>
      {/* the invite exists — the admin's only job left is to deliver the link */}
      {created ? (
        <InviteLinkPanel email={created.email} link={created.link} />
      ) : (
      <>
      {/* who */}
      {users === null && !loadErr && (
        <div style={{ fontSize: 13, color: PC.muted, padding: '6px 2px' }}>Loading organization users\u2026</div>
      )}
      {loadErr && (
        <div style={{ display: 'flex', gap: 10, padding: 13, background: PC.surface, borderRadius: 10, border: `1px solid ${PC.border}`, marginBottom: 12 }}>
          <PIcon name="shield-alert" size={15} color={PC.red} style={{ marginTop: 1, flex: '0 0 auto' }} />
          <span style={{ fontSize: 12.5, color: PC.fg, lineHeight: '17px' }}>
            {loadErr}{' '}
            <button onClick={load} style={{ border: 0, background: 'transparent', color: PC.primary, cursor: 'pointer', font: 'inherit', fontWeight: 600 }}>Retry</button>
          </span>
        </div>
      )}
      {users !== null && !loadErr && (
        <>
          <div style={{ position: 'relative', marginBottom: 10 }}>
            <PIcon name="search" size={14} color={PC.mutedFg} style={{ position: 'absolute', left: 11, top: 11 }} />
            <PTextInput value={query} onChange={setQuery} placeholder="Search organization users\u2026" style={{ paddingLeft: 32 }} autoFocus />
          </div>
          {list.length === 0 ? (
            <PEmpty icon="users" title={query ? 'No users match' : 'No organization users'}
              text={query ? 'Try a different search term.' : 'No users were returned for this organization.'} />
          ) : (
            <div style={{ maxHeight: 260, overflow: 'auto', border: `1px solid ${PC.border}`, borderRadius: 10 }}>
              {list.map(u => {
                const disabled = !!u.in_roster;
                const on = selected === u.email;
                return (
                  <button key={u.email} disabled={disabled}
                    title={disabled ? 'Already has access to this server' : ''}
                    onClick={() => { setSelected(on ? '' : u.email); setSubmitErr(''); }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 12px',
                      border: 0, borderBottom: `1px solid ${PC.surface2}`, textAlign: 'left', fontFamily: 'inherit',
                      background: on ? PC.primarySoft : '#fff', cursor: disabled ? 'default' : 'pointer',
                      opacity: disabled ? 0.55 : 1 }}>
                    <PAvatar user={{ name: u.username || u.email, email: u.email }} size={28} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: PC.fg, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.username || u.email}</span>
                      <span style={{ display: 'block', fontSize: 11.5, color: PC.muted, fontFamily: 'Geist Mono, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</span>
                    </span>
                    {disabled && <PPill tone="neutral" size="xs">Has access</PPill>}
                    {!disabled && u.invited && <PPill tone="warning" size="xs">Invited</PPill>}
                    {on && <PIcon name="check" size={15} color={PC.primary} style={{ flex: '0 0 auto' }} />}
                  </button>
                );
              })}
            </div>
          )}
          {/* role */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: PC.fg }}>Invite as</span>
            <RoleSelect role={role} onPick={setRole} roles={P_INVITE_ROLES} />
            <span style={{ fontSize: 11.5, color: PC.muted }}>Applied when they accept the invite.</span>
          </div>
        </>
      )}

      {submitErr && (
        <div style={{ display: 'flex', gap: 10, padding: '11px 13px', marginTop: 14, background: PC.redSoft, borderRadius: 10, border: `1px solid ${PC.red}44` }}>
          <PIcon name="x-circle" size={15} color={PC.red} style={{ marginTop: 1, flex: '0 0 auto' }} />
          <span style={{ fontSize: 12.5, color: PC.fg, lineHeight: '17px' }}>{submitErr}</span>
        </div>
      )}
      </>
      )}
    </PModal>
  );
}

// ─── PENDING INVITES ────────────────────────────────────────────────────────
// Outstanding (unconsumed) invites with their expiry and the revoke /
// new-link actions. "New link" regenerates the token and the 48h window — any
// link handed out earlier stops working — and shows the fresh one to copy
// (the admin delivers it; nothing here sends it).
function PendingInvites({ invites, ctx, onChanged }) {
  const { toast } = ctx;
  const [busy, setBusy] = useP('');           // email being acted on
  const [linkFor, setLinkFor] = useP(null);   // { email, link } — freshly minted link to copy

  const revoke = async (email) => {
    setBusy(email);
    try {
      await PApi.revokeInvite(email);
      toast(`Invite for ${email} revoked`, 'danger');
      setLinkFor(l => (l && l.email === email ? null : l));
      onChanged && onChanged();
    } catch (e) {
      toast(`Couldn't revoke invite: ${e.message}`, 'danger');
    } finally { setBusy(''); }
  };
  const newLink = async (email) => {
    setBusy(email); setLinkFor(null);
    try {
      const r = await PApi.resendInvite(email);
      setLinkFor({ email, link: (r && r.invite_link) || '' });
      toast(`New invite link for ${email} — the previous one no longer works`, 'success');
      onChanged && onChanged();
    } catch (e) {
      toast(`Couldn't issue a new link: ${e.message}`, 'danger');
    } finally { setBusy(''); }
  };

  if (!invites || invites.length === 0) return null;
  return (
    <PCard pad={0} style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 18px', borderBottom: `1px solid ${PC.border}`, background: PC.surface,
        fontSize: 11, fontWeight: 600, color: PC.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        <PIcon name="link" size={13} color={PC.mutedFg} /> Pending invites
      </div>
      {invites.map(inv => {
        const expiry = inviteExpiryLabel(inv);
        const expired = inv.expired || expiry === 'expired';
        return (
          <div key={inv.email} style={{ borderBottom: `1px solid ${PC.surface2}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 18px', flexWrap: 'wrap' }}>
              <PIcon name="mail" size={15} color={PC.mutedFg} />
              <span style={{ fontSize: 12.5, color: PC.fg, fontFamily: 'Geist Mono, monospace' }}>{inv.email}</span>
              <PPill tone={P_ROLE_TONE[inv.role] || 'neutral'} size="xs">{inv.role}</PPill>
              <PPill tone={expired ? 'danger' : 'warning'} size="xs">{expiry || '48h link'}</PPill>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11.5, color: PC.muted }}>invited by {inv.created_by}</span>
              <PBtn variant="default" size="sm" leftIcon="link" disabled={busy === inv.email}
                title="Mint a fresh link to copy — the previous one stops working" onClick={() => newLink(inv.email)}>
                {busy === inv.email ? 'Working…' : 'New link'}
              </PBtn>
              <PBtn variant="default" size="sm" leftIcon="x" disabled={busy === inv.email}
                style={{ color: PC.red, borderColor: PC.red }} onClick={() => revoke(inv.email)}>Revoke</PBtn>
            </div>
            {linkFor && linkFor.email === inv.email && linkFor.link && (
              <div style={{ padding: '0 18px 12px 43px' }}>
                <InviteLinkPanel email={inv.email} link={linkFor.link}
                  note={`The earlier link for ${inv.email} no longer works. Treat this one like a password and hand it over through a channel you trust — it works once and expires in 48 hours.`} />
              </div>
            )}
          </div>
        );
      })}
    </PCard>
  );
}

// ─── USERS & ROLES ──────────────────────────────────────────────────────────
// Wired to GET /bailey/api/people (admin-only): the roster, per-person role,
// workspace/device counts, last-active and invited flag all come from
// data.people. No seed fallback — a failed fetch shows the error UI, an empty
// roster shows the empty state, and /people's partial-enumeration `error`
// (200 + error) shows a non-fatal warning above the still-rendered roster.
//
// Inviting: the Invite button lists the AOC organization's users (the daemon
// proxies the AOC's org roster) and creates a 48h single-use invite whose
// link the admin copies and delivers themselves; see InviteDialog /
// PendingInvites above. People still
// also appear here organically as they sign in / get access.
function UsersView({ ctx }) {
  const { data, toast, go, navigate, routeParam, refresh } = ctx;
  const [query, setQuery] = useP('');
  // The person whose devices are open lives in the URL (/users/:email) so the
  // drawer survives refresh and is shareable.
  const devicesUserId = routeParam;

  // Outstanding invites — view-local fetch (admin-only endpoint), refetched
  // after every invite mutation. A failed fetch degrades to a compact warning;
  // the roster itself is unaffected.
  const [invites, setInvites] = useP(null);   // null = loading
  const [invitesErr, setInvitesErr] = useP('');
  const [inviteOpen, setInviteOpen] = useP(false);
  const loadInvites = async () => {
    try {
      const r = await PApi.invites();
      setInvites(r.invites || []); setInvitesErr('');
    } catch (e) {
      setInvites([]); setInvitesErr(e.message || 'Could not load pending invites.');
    }
  };
  usePE(() => { loadInvites(); }, []);
  // After any invite mutation: refresh the strip AND the roster (invited-only
  // rows appear/disappear there).
  const invitesChanged = () => { loadInvites(); refresh && refresh('people'); };

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

  // Pending device approvals are shown inline, under the person they belong to.
  // Group them by email so each row knows whether it has one waiting.
  const pending = data.pending || [];
  const pendingByEmail = {};
  pending.forEach(p => {
    const k = (p.userEmail || '').toLowerCase();
    (pendingByEmail[k] = pendingByEmail[k] || []).push(p);
  });
  // A brand-new person signing in from their first device isn't in the roster
  // yet (no trusted device, workspace, or TOTP). Surface them as synthetic
  // "new arrival" rows at the top so the admin can approve them here too.
  const rosterEmails = new Set(people.map(p => (p.email || '').toLowerCase()));
  const newArrivals = Object.keys(pendingByEmail)
    .filter(k => !rosterEmails.has(k))
    .map(k => {
      const req = pendingByEmail[k][0];
      return {
        id: req.userEmail, name: req.userName || req.userEmail, email: req.userEmail,
        role: 'user', workspaceCount: 0, deviceCount: 0, lastActive: '', invited: false, isNewArrival: true,
      };
    })
    .sort((a, b) => a.email.localeCompare(b.email));
  const combined = [...newArrivals, ...people];
  const list = combined.filter(u =>
    u.name.toLowerCase().includes(query.toLowerCase()) || u.email.toLowerCase().includes(query.toLowerCase()));

  return (
    <div>
      <PPageHeader title="People &amp; roles"
        subtitle="Everyone with access to this server. Roles govern what they can do; devices govern where they can do it from. New sign-ins from an untrusted device appear here for you to approve." />

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

      {loaded && pending.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', marginBottom: 14,
          border: `1px solid ${PC.primary}55`, background: PC.primarySoft, borderRadius: 10 }}>
          <PIcon name="shield-alert" size={15} color={PC.primary} style={{ flex: '0 0 auto' }} />
          <span style={{ flex: 1, fontSize: 12.5, color: PC.fg, lineHeight: '17px' }}>
            {pending.length} device{pending.length > 1 ? 's' : ''} awaiting approval — highlighted below. A signed-in user can't reach the server until you confirm the code shown on their device.
          </span>
        </div>
      )}

      {loaded && (<>
      {invitesErr && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', marginBottom: 14,
          border: `1px solid ${PC.amber}55`, background: '#fffbeb', borderRadius: 10 }}>
          <PIcon name="alert-triangle" size={15} color="#b45309" style={{ flex: '0 0 auto' }} />
          <span style={{ flex: 1, fontSize: 12.5, color: '#92400e', lineHeight: '17px' }}>
            Couldn't load pending invites: {invitesErr}
          </span>
          <button onClick={loadInvites} style={{ border: 0, background: 'transparent', color: PC.primary, cursor: 'pointer', font: 'inherit', fontSize: 12.5, fontWeight: 600 }}>Retry</button>
        </div>
      )}
      <PendingInvites invites={invites || []} ctx={ctx} onChanged={invitesChanged} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div style={{ position: 'relative', maxWidth: 320, flex: '1 1 240px' }}>
          <PIcon name="search" size={14} color={PC.mutedFg} style={{ position: 'absolute', left: 11, top: 11 }} />
          <PTextInput value={query} onChange={setQuery} placeholder="Search people…" style={{ paddingLeft: 32 }} />
        </div>
        <span style={{ flex: 1 }} />
        <PBtn variant="primary" leftIcon="user-plus" onClick={() => setInviteOpen(true)}>Invite person</PBtn>
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
        {list.map(u => {
          const reqs = pendingByEmail[(u.email || '').toLowerCase()] || [];
          const hasPending = reqs.length > 0;
          return (
          <div key={u.id} style={{ borderBottom: `1px solid ${PC.surface2}`, boxShadow: hasPending ? `inset 3px 0 0 ${PC.primary}` : 'none' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '2.2fr 1fr 1fr 1fr 0.9fr', gap: 12,
              padding: '12px 18px', alignItems: 'center', background: hasPending ? PC.primarySoft : 'transparent' }}>
              <PUserChip user={u} size={32} nameSuffix={<>
                {u.role === 'admin' && <span title="Administrator"><PIcon name="crown" size={13} color={PC.amber} /></span>}
                {u.isNewArrival && <PPill tone="info" size="xs">New</PPill>}
                {u.invited && <PPill tone="warning" size="xs">Invited</PPill>}
              </>} />
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
            {reqs.map(req => <PendingApprovalBar key={req.id} req={req} person={u} ctx={ctx} />)}
          </div>
          );
        })}
      </PCard>
      )}
      </>)}

      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} ctx={ctx} onChanged={invitesChanged} />
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

// ─── ENDPOINT ACCESS (read-only ACL tree) ───────────────────────────────────
// Admin-only, observational: every registered endpoint with its owner and ACL
// grants, nested workspace → endpoints by `parent`. Read-only by design — even
// an admin doesn't edit others' ACLs here; there are no mutation controls.
// Searchable + paginated (#252): the search matches hostnames, display names,
// owners and grant principals (a workspace stays visible when anything under
// it matches), and the workspace tree pages by root so a server with hundreds
// of endpoints doesn't render one endless column.
const ACL_PAGE_SIZE = 10; // workspace roots per page
function EndpointAccessView({ ctx }) {
  const [tree, setTree] = useP(null);     // null = loading
  const [err, setErr] = useP('');
  const [nonce, setNonce] = useP(0);      // bump to refetch
  const [query, setQuery] = useP('');
  const [page, setPage] = useP(1);        // 1-based, over filtered roots

  usePE(() => {
    let alive = true;
    setErr(''); setTree(null);
    PApi.adminACL()
      .then(r => { if (alive) setTree(r.endpoints || []); })
      .catch(e => { if (alive) { setErr(e.message || 'Could not load endpoints.'); setTree([]); } });
    return () => { alive = false; };
  }, [nonce]);

  const all = tree || [];
  const q = query.trim().toLowerCase();
  // An endpoint matches the query on any human-searchable facet: hostname,
  // display name, owner, grant principals (emails/groups), kind, or stage.
  const epMatches = (e) => !q ||
    (e.hostname || '').toLowerCase().includes(q) ||
    (e.display_name || '').toLowerCase().includes(q) ||
    (e.owner_email || '').toLowerCase().includes(q) ||
    (e.kind || '').toLowerCase().includes(q) ||
    (e.stage || '').toLowerCase().includes(q) ||
    (e.grants || []).some(g => (g.principal_value || '').toLowerCase().includes(q));

  // Special endpoints get their own sections; the rest form the owned tree.
  const publicEps = all.filter(e => e.access === 'public' && epMatches(e)).sort((a, b) => a.hostname.localeCompare(b.hostname));
  const allUsersEps = all.filter(e => e.access === 'all-users' && epMatches(e)).sort((a, b) => a.hostname.localeCompare(b.hostname));
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
  // A node survives the search if it matches or anything below it does; a
  // node that matches itself keeps its whole subtree visible (so finding a
  // workspace shows what's in it).
  const subtreeMatches = (e) => epMatches(e) || (childrenOf[e.hostname] || []).some(subtreeMatches);
  const roots = (childrenOf[''] || []).filter(subtreeMatches).sort((a, b) => a.hostname.localeCompare(b.hostname));

  // Paginate the workspace tree by ROOT card — a workspace and its endpoints
  // never split across pages. The page is clamped so shrinking results (a
  // narrower search) can't strand the view past the end.
  const totalPages = Math.max(1, Math.ceil(roots.length / ACL_PAGE_SIZE));
  const curPage = Math.min(page, totalPages);
  const pageRoots = roots.slice((curPage - 1) * ACL_PAGE_SIZE, curPage * ACL_PAGE_SIZE);

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

  // Endpoint hostnames are live URLs — make them clickable (new tab).
  const HostLink = ({ host }) => (
    <a href={`https://${host}`} target="_blank" rel="noopener noreferrer"
      style={{ fontSize: 13.5, fontWeight: 600, color: PC.primary, fontFamily: 'Geist Mono, monospace', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 5 }}
      onMouseEnter={ev => { ev.currentTarget.style.textDecoration = 'underline'; }}
      onMouseLeave={ev => { ev.currentTarget.style.textDecoration = 'none'; }}>
      {host}
      <PIcon name="external-link" size={12} color={PC.primary} />
    </a>
  );

  const Node = ({ e, depth }) => {
    // While searching, a node that only matched through its descendants shows
    // just the matching branches; a node that matched itself shows everything.
    let kids = (childrenOf[e.hostname] || []);
    if (q && !epMatches(e)) kids = kids.filter(subtreeMatches);
    kids = kids.slice().sort((a, b) => a.hostname.localeCompare(b.hostname));
    const k = KIND[e.kind] || { icon: 'globe', label: e.kind || 'Endpoint' };
    return (
      <div style={{ marginLeft: depth ? 18 : 0, borderLeft: depth ? `1px solid ${PC.border}` : 'none', paddingLeft: depth ? 14 : 0 }}>
        <div style={{ border: `1px solid ${PC.border}`, borderRadius: 10, background: '#fff', padding: '12px 14px', marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <PIcon name={k.icon} size={16} color={PC.muted} />
            <HostLink host={e.hostname} />
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
        <HostLink host={e.hostname} />
      </div>
      <div style={{ fontSize: 12, color: PC.muted, marginTop: 6, lineHeight: '17px' }}>{note}</div>
    </div>
  );
  const empty = tree !== null && !err && publicEps.length === 0 && allUsersEps.length === 0 && roots.length === 0;
  const nothing = empty && !q;    // truly no endpoints registered
  const noMatches = empty && !!q; // endpoints exist, none match the search

  return (
    <div>
      <PPageHeader title="Endpoint access" icon="git-fork"
        subtitle="Every endpoint this server routes and who can reach it." />
      <div style={{ display: 'flex', gap: 11, padding: '13px 15px', borderRadius: 10, background: PC.primarySoft || '#EEF2FF', border: `1px solid ${PC.border}`, marginBottom: 18 }}>
        <PIcon name="shield-check" size={17} color={PC.primary} style={{ marginTop: 1, flex: '0 0 auto' }} />
        <div style={{ fontSize: 12.5, color: PC.fg, lineHeight: '19px' }}>
          This list is read-only — it's here for auditing, not for changing access. Bailey
          follows the principle of <b>least privilege</b>: each endpoint's owner manages who can
          reach it, from that endpoint's own share dialog. There is deliberately <b>no god-mode
          admin</b> who can grant themselves into everything — removing that single point of
          compromise reduces risk and makes the server easier to keep compliant.
        </div>
      </div>
      {tree === null && !err && <div style={{ fontSize: 13, color: PC.muted }}>Loading endpoints…</div>}
      {err && (
        <PLiveState status="error" error={err} label="Couldn't load endpoint access" onRetry={() => setNonce(n => n + 1)} />
      )}

      {tree !== null && !err && all.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <div style={{ position: 'relative', maxWidth: 340, flex: '1 1 260px' }}>
            <PIcon name="search" size={14} color={PC.mutedFg} style={{ position: 'absolute', left: 11, top: 11 }} />
            <PTextInput value={query} onChange={(v) => { setQuery(v); setPage(1); }}
              placeholder="Search endpoints, owners & grants…" style={{ paddingLeft: 32 }} />
          </div>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: PC.muted, whiteSpace: 'nowrap' }}>
            {all.length} endpoint{all.length === 1 ? '' : 's'}
          </span>
        </div>
      )}

      {nothing && (
        <PEmpty icon="git-fork" title="No endpoints registered yet"
          text="Endpoints appear here as workspaces and apps are created on this server." />
      )}
      {noMatches && (
        <PEmpty icon="search" title="No endpoints match"
          text="Try a different hostname, owner, or grant email." />
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
          {pageRoots.map(e => <Node key={e.hostname} e={e} depth={0} />)}
          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 14 }}>
              <PBtn variant="default" size="sm" leftIcon="chevron-left" disabled={curPage === 1}
                onClick={() => setPage(curPage - 1)}>Previous</PBtn>
              <span style={{ fontSize: 12.5, color: PC.muted }}>
                Page {curPage} of {totalPages} · {roots.length} entries
              </span>
              <PBtn variant="default" size="sm" disabled={curPage === totalPages}
                onClick={() => setPage(curPage + 1)}>Next</PBtn>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// scheduleApprovalSettle is shared with views-devices.jsx (the self-link row
// approves through the same endpoint and has the same claim race).
window.SC_PEOPLE = { UsersView, EndpointAccessView, scheduleApprovalSettle };