import React from 'react';
// auth-scenes.jsx — full-screen onboarding/auth states:
// first-admin bootstrap · awaiting device approval · account recovery

const { C: SC, Icon: SIcon, Btn: SBtn, Pill: SPill } = window.WD_SHELL;
const { QRCode: SQR, SegmentedCode: SSeg, CopyChip: SCopyChip, Avatar: SAvatar, Modal: SModal } = window.SC_UI;
const { Api: SApi } = window.SC_API;
const { useState: useSc, useEffect: useScE } = React;

// followRedirect navigates to the redirect_path returned by a trust-granting
// gate endpoint, or reloads in place when none is given (the SPA re-fetches
// gate-state, now sees trusted:true, and renders the console). On the console
// host a bare reload lands the user in the console; on an app host the
// redirect_path points back at the original app URL.
function followRedirect(redirectPath) {
  if (redirectPath) window.location.assign(redirectPath);
  else window.location.reload();
}

// ─── "Why so complicated?" explainer ────────────────────────────────────────
// Shared across the device-trust scenes (bootstrap · approval · recovery).
// A small help link that opens the end-to-end access-control explainer in the
// console's standard Modal (focusable, Escape-to-close, backdrop click).
function WhyComplicatedLink() {
  const [open, setOpen] = useSc(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} style={{
        border: 0, background: 'transparent', color: SC.primary, cursor: 'pointer',
        font: 'inherit', fontSize: 12.5, fontWeight: 600, textDecoration: 'underline',
        textUnderlineOffset: 2, padding: 0 }}>
        Why so complicated?
      </button>
      <SModal open={open} onClose={() => setOpen(false)} title="End-to-end access control" icon="shield" width={560}>
        <h3 style={{ margin: '0 0 4px', fontSize: 14.5, fontWeight: 700, color: SC.fg }}>Two locks, not one</h3>
        <p style={{ margin: '0 0 6px', fontSize: 13, color: SC.muted, lineHeight: '19px' }}>
          Single sign-on proves who you are. Bailey adds a second, independent check that lives on this server and that you control: a new device has to be approved here before it can reach anything. Your data sovereignty stays with you, not with a third party.
        </p>
        <h3 style={{ margin: '16px 0 4px', fontSize: 14.5, fontWeight: 700, color: SC.fg }}>Safe even if your login provider is breached</h3>
        <p style={{ margin: '0 0 6px', fontSize: 13, color: SC.muted, lineHeight: '19px' }}>
          If an attacker compromised your central identity provider (SSO), they still couldn't get to your data. A fresh device must be confirmed on this server — by reading back the code shown on the device — and that approval happens on infrastructure you own, beyond the identity provider's reach.
        </p>
        <h3 style={{ margin: '16px 0 4px', fontSize: 14.5, fontWeight: 700, color: SC.fg }}>Lost or stolen device? Cut it off instantly</h3>
        <p style={{ margin: '0 0 6px', fontSize: 13, color: SC.muted, lineHeight: '19px' }}>
          Every browser you trust is a named device you can see and revoke. If a laptop or phone is lost or stolen, remove its device here and it loses access immediately — no password reset, no waiting on anyone else.
        </p>
        <p style={{ margin: '18px 0 0', fontSize: 11.5, color: SC.mutedFg, lineHeight: '17px' }}>
          That's the small step when you first connect a device or recover access — the cost of data sovereignty that survives even a compromised identity provider.
        </p>
      </SModal>
    </>
  );
}

// shared centered chrome
function SceneShell({ children, footerNote, badge }) {
  // Real server origin, not a seeded label.
  let host = '';
  try { host = window.location.hostname || ''; } catch (e) { host = ''; }
  return (
    <div style={{
      position: 'absolute', inset: 0, background: SC.surface,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: 24, overflow: 'auto',
    }}>
      {/* subtle grid backdrop */}
      <div style={{ position: 'absolute', inset: 0, opacity: 0.5,
        backgroundImage: `radial-gradient(${SC.border} 1px, transparent 1px)`, backgroundSize: '22px 22px' }} />
      <div style={{ position: 'relative', width: 440, maxWidth: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center', marginBottom: 18 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: SC.fg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <SIcon name="hexagon" size={18} color="#fff" />
          </div>
          <div style={{ textAlign: 'left' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: SC.fg, lineHeight: '16px', whiteSpace: 'nowrap' }}>Bailey</div>
            <div style={{ fontSize: 11.5, color: SC.muted, fontFamily: 'Geist Mono, monospace' }}>{host}</div>
          </div>
          {badge && <span style={{ marginLeft: 6 }}>{badge}</span>}
        </div>
        <div style={{ background: '#fff', border: `1px solid ${SC.border}`, borderRadius: 16,
          boxShadow: '0 20px 50px rgba(0,0,0,0.10)', overflow: 'hidden' }}>
          {children}
        </div>
        {footerNote && <div style={{ textAlign: 'center', marginTop: 16, fontSize: 12, color: SC.muted, lineHeight: '17px' }}>{footerNote}</div>}
      </div>
    </div>
  );
}

function OAuthButton({ label, icon, onClick }) {
  const [h, setH] = useSc(false);
  return (
    <button onClick={onClick} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)} style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, width: '100%', height: 44,
      border: `1px solid ${SC.border}`, borderRadius: 10, background: h ? SC.surface : '#fff', cursor: 'pointer',
      fontSize: 14, fontWeight: 600, color: SC.fg, fontFamily: 'inherit', transition: 'background 140ms' }}>
      <SIcon name={icon} size={17} color={SC.muted} />{label}
    </button>
  );
}

// ─── 1. FIRST-ADMIN BOOTSTRAP ───────────────────────────────────────────────
// POST /bailey/api/claim records the caller as root admin and TOFU-trusts this
// browser; on ok we follow the (cookie-backed) trusted state into the console.
function BootstrapScene({ onClaim }) {
  const [claiming, setClaiming] = useSc(false);
  const [error, setError] = useSc('');
  const claim = async () => {
    setClaiming(true); setError('');
    try {
      await SApi.claim();
      followRedirect(null); // reload — now trusted, lands in console
    } catch (e) {
      setError(e.message || 'Could not claim this server.');
      setClaiming(false);
    }
  };
  return (
    <SceneShell badge={<SPill tone="warning" size="xs">Unclaimed</SPill>}
      footerNote="This is a one-time step. After the server is claimed, new sign-ins require device approval.">
      <div style={{ padding: '30px 30px 26px' }}>
        <div style={{ width: 52, height: 52, borderRadius: 13, background: SC.primarySoft, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
          <SIcon name="flag" size={24} color={SC.primary} />
        </div>
        <h1 style={{ margin: 0, textAlign: 'center', fontSize: 21, fontWeight: 700, color: SC.fg, letterSpacing: '-0.3px' }}>Claim this server</h1>
        <p style={{ margin: '8px auto 22px', textAlign: 'center', fontSize: 13.5, color: SC.muted, lineHeight: '20px', maxWidth: 340 }}>
          No one administers this Bailey server yet. The first person to sign in becomes the root admin — and this device becomes the first trusted device.
        </p>
        {claiming ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '8px 0 4px' }}>
            <SIcon name="loader" size={22} color={SC.primary} />
            <span style={{ fontSize: 13, color: SC.muted }}>Claiming server &amp; trusting this device…</span>
          </div>
        ) : (
          <SBtn variant="primary" leftIcon="key-round" onClick={claim} style={{ width: '100%', height: 44, fontSize: 14 }}>
            Claim this server
          </SBtn>
        )}
        {error && <div style={{ marginTop: 12, textAlign: 'center', fontSize: 12.5, color: SC.red, fontWeight: 500 }}>{error}</div>}
        <div style={{ textAlign: 'center', marginTop: 16 }}><WhyComplicatedLink /></div>
      </div>
      <div style={{ display: 'flex', gap: 10, padding: '14px 22px', background: SC.surface, borderTop: `1px solid ${SC.border}` }}>
        <SIcon name="shield" size={15} color={SC.muted} style={{ marginTop: 1, flex: '0 0 auto' }} />
        <span style={{ fontSize: 11.5, color: SC.muted, lineHeight: '16px' }}>
          From now on, a login from your identity provider alone never grants access — every device must be explicitly trusted.
        </span>
      </div>
    </SceneShell>
  );
}

// ─── 2. AWAITING DEVICE APPROVAL ────────────────────────────────────────────
// What a user sees after Keycloak login on an untrusted device.
//   • Admin tab  — GET /pending-pair for the code to read out to an admin,
//                  then poll GET /pending-pair/poll until {approved:true}.
//   • Authenticator tab — POST /self-trust {totp} to trust this browser now.
//                  Shown only when gateState.totp_enrolled.
function ApprovalScene({ onApproved, goConsole, gateState }) {
  // The authenticator tab appears only when this user actually has TOTP
  // enrolled (per the real gate-state).
  const showTotpTab = !!(gateState && gateState.totp_enrolled);
  const email = (gateState && gateState.email) || '';
  // Whether the user already has another trusted device. If so (or if they
  // have an authenticator), they can approve THIS device themselves and we
  // must NOT tell them to find an admin. Only a true first device (no trusted
  // device, no authenticator) needs admin approval.
  const hasTrustedDevice = !!(gateState && gateState.has_trusted_device);
  const canSelfApprove = hasTrustedDevice || showTotpTab;
  // How to describe approving the displayed code (the code method), tailored to
  // what this user can actually do.
  const codeApproverHint = hasTrustedDevice
    ? "Enter this code on a device you already trust — open Your devices → Link a device — and you'll be let in automatically."
    : 'Read this code to an admin. Once they approve it from a trusted device, you’ll be let in automatically.';
  const waitingFor = hasTrustedDevice ? 'Waiting for approval' : 'Waiting for an admin';

  const [method, setMethod] = useSc('admin');   // 'admin' | 'totp'
  const [code, setCode] = useSc('');
  const [codeErr, setCodeErr] = useSc('');
  const [totp, setTotp] = useSc('');
  const [error, setError] = useSc(false);
  const [trusting, setTrusting] = useSc(false);
  const [dots, setDots] = useSc(1);
  useScE(() => { const t = setInterval(() => setDots(d => (d % 3) + 1), 500); return () => clearInterval(t); }, []);
  useScE(() => { setTotp(''); setError(false); }, [method]);

  // Fetch the pairing code + poll for admin approval.
  useScE(() => {
    let alive = true;
    let timer = null;
    SApi.pendingPair()
      .then(r => { if (alive && r) setCode(r.code || ''); })
      .catch(e => { if (alive) setCodeErr(e.message || 'Could not request a pairing code.'); });
    const tick = async () => {
      try {
        const r = await SApi.pendingPairPoll();
        if (!alive) return;
        if (r && r.approved) { followRedirect(r.redirect_path); return; }
      } catch (e) { /* transient poll error — keep polling */ }
      if (alive) timer = setTimeout(tick, 2500);
    };
    timer = setTimeout(tick, 2500);
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);

  const verifyTotp = async () => {
    if (totp.replace(/\D/g, '').length < 6) { setError(true); return; }
    setTrusting(true); setError(false);
    try {
      const r = await SApi.selfTrust(totp);
      followRedirect(r && r.redirect_path);
    } catch (e) {
      setError(true); setTrusting(false);
    }
  };

  return (
    <SceneShell footerNote={<>Wrong account? <button onClick={goConsole} style={{ border: 0, background: 'transparent', color: SC.primary, cursor: 'pointer', font: 'inherit', fontWeight: 600 }}>Sign out</button></>}>
      <div style={{ padding: '26px 28px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 12px', background: SC.surface, borderRadius: 10, marginBottom: 20 }}>
          <SAvatar user={{ name: email || 'Signed-in user', color: '#2a9d90' }} size={32} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: SC.fg }}>Signed in</div>
            <div style={{ fontSize: 11.5, color: SC.muted, fontFamily: 'Geist Mono, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email || '—'}</div>
          </div>
          <SIcon name="badge-check" size={17} color="#16a34a" />
        </div>

        <h1 style={{ margin: 0, textAlign: 'center', fontSize: 20, fontWeight: 700, color: SC.fg, letterSpacing: '-0.3px' }}>Trust this device</h1>
        <p style={{ margin: '8px auto 18px', textAlign: 'center', fontSize: 13, color: SC.muted, lineHeight: '19px', maxWidth: 360 }}>
          You're signed in, but this device isn't trusted yet.{' '}
          {canSelfApprove
            ? (hasTrustedDevice && showTotpTab
                ? 'Approve it from a device you already trust, or confirm it with your authenticator.'
                : hasTrustedDevice
                  ? 'Approve it from a device you already trust — no admin needed.'
                  : 'Confirm it with your authenticator, or have an admin approve the code.')
            : 'Have an admin approve the code below.'}
        </p>

        {/* method switch — authenticator tab only when this user has TOTP enrolled */}
        {showTotpTab && (
          <div style={{ display: 'flex', gap: 6, padding: 4, background: SC.surface, borderRadius: 10, marginBottom: 20 }}>
            <MethodTab active={method === 'admin'} icon="user-check" label={hasTrustedDevice ? 'Approve by code' : 'Admin approval'} onClick={() => setMethod('admin')} />
            <MethodTab active={method === 'totp'} icon="key-round" label="Authenticator" onClick={() => setMethod('totp')} />
          </div>
        )}

        {method === 'admin' || !showTotpTab ? (
          <>
            {codeErr ? (
              <div style={{ textAlign: 'center', fontSize: 12.5, color: SC.red, fontWeight: 500, padding: '8px 0' }}>{codeErr}</div>
            ) : (
              <div style={{ display: 'flex', gap: 18, alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ padding: 9, border: `1px solid ${SC.border}`, borderRadius: 12 }}>
                  <SQR seed={'approve-' + (code || 'pending')} size={120} />
                </div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: SC.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Your code</div>
                  <div style={{ fontFamily: 'Geist Mono, monospace', fontSize: 28, fontWeight: 700, color: SC.fg, letterSpacing: 1 }}>{code || '······'}</div>
                  <div style={{ marginTop: 10 }}><SCopyChip text={code} label="Copy code" /></div>
                </div>
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 20, fontSize: 13, color: SC.primary, fontWeight: 500 }}>
              <SIcon name="loader" size={15} color={SC.primary} />
              {waitingFor}{'.'.repeat(dots)}
            </div>
          </>
        ) : (
          <div style={{ textAlign: 'center' }}>
            <p style={{ margin: '0 auto 16px', fontSize: 12.5, color: SC.muted, lineHeight: '18px', maxWidth: 320 }}>
              Enter the current 6-digit code from your authenticator app to trust this device right away — no admin needed.
            </p>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <SSeg format={[3, 3]} value={totp} onChange={v => { setTotp(v); setError(false); }} size="lg" auto mono />
            </div>
            {error && <div style={{ marginTop: 10, fontSize: 12.5, color: SC.red, fontWeight: 500 }}>That code didn't match. Try the current code from your app.</div>}
            <div style={{ marginTop: 16 }}>
              <SBtn variant="primary" leftIcon="shield-check" onClick={verifyTotp} disabled={trusting || totp.replace(/\D/g, '').length < 6} style={{ width: '100%' }}>{trusting ? 'Verifying…' : 'Verify & trust this device'}</SBtn>
            </div>
          </div>
        )}
        <div style={{ textAlign: 'center', marginTop: 18 }}><WhyComplicatedLink /></div>
      </div>

      <div style={{ padding: '14px 22px', background: SC.surface, borderTop: `1px solid ${SC.border}` }}>
        {(method === 'admin' || !showTotpTab)
          ? <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <SIcon name="shield" size={15} color={SC.muted} style={{ marginTop: 1, flex: '0 0 auto' }} />
              <span style={{ fontSize: 11.5, color: SC.muted, lineHeight: '16px' }}>
                {codeApproverHint}
              </span>
            </div>
          : <div style={{ textAlign: 'center', fontSize: 12, color: SC.muted }}>No authenticator handy? <button onClick={() => setMethod('admin')} style={{ border: 0, background: 'transparent', color: SC.primary, cursor: 'pointer', font: 'inherit', fontWeight: 600 }}>{hasTrustedDevice ? 'Use a code instead' : 'Ask an admin instead'}</button></div>}
      </div>
    </SceneShell>
  );
}

function MethodTab({ active, icon, label, onClick }) {
  return (
    <button onClick={onClick} style={{
      flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, height: 36,
      border: 0, borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5,
      fontWeight: active ? 600 : 500, background: active ? '#fff' : 'transparent',
      color: active ? SC.fg : SC.muted, boxShadow: active ? '0 1px 2px rgba(0,0,0,0.08), 0 0 0 1px ' + SC.border : 'none' }}>
      <SIcon name={icon} size={14} color={active ? SC.primary : SC.mutedFg} />{label}
    </button>
  );
}

// ─── 3. ACCOUNT RECOVERY ────────────────────────────────────────────────────
// POST /bailey/api/recover trusts this browser from a recovery factor:
//   • authenticator  → { totp }
//   • backup code    → { backup }  (single-use)
// Tabs reflect which factors the user actually has (gateState.totp_enrolled /
// backup_codes); default to the authenticator tab.
function RecoveryScene({ onRecovered, goConsole, gateState }) {
  const hasTotp = !!(gateState && gateState.totp_enrolled);
  const hasBackup = !!(gateState && gateState.backup_codes);
  const [mode, setMode] = useSc(hasTotp ? 'totp' : 'backup');   // 'totp' | 'backup'
  const [code, setCode] = useSc('');
  const [backup, setBackup] = useSc('');
  const [error, setError] = useSc(false);
  const [busy, setBusy] = useSc(false);

  const recover = async (body) => {
    setBusy(true); setError(false);
    try {
      const r = await SApi.recover(body);
      followRedirect(r && r.redirect_path);
    } catch (e) {
      setError(true); setBusy(false);
    }
  };
  const submitTotp = () => {
    if (code.replace(/\D/g, '').length === 6) recover({ totp: code.replace(/\D/g, '') });
    else setError(true);
  };
  const submitBackup = () => {
    if (backup.replace(/[^A-Z0-9]/gi, '').length >= 8) recover({ backup });
    else setError(true);
  };
  // Can the user switch tabs at all? Only when both factors exist.
  const canSwitch = hasTotp && hasBackup;

  return (
    <SceneShell badge={<SPill tone="danger" size="xs">Locked out</SPill>}
      footerNote={<>Remembered a device? <button onClick={goConsole} style={{ border: 0, background: 'transparent', color: SC.primary, cursor: 'pointer', font: 'inherit', fontWeight: 600 }}>Back to sign in</button></>}>
      <div style={{ padding: '28px 30px 24px' }}>
        <div style={{ width: 52, height: 52, borderRadius: 13, background: SC.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
          <SIcon name="key-round" size={24} color={SC.fg} />
        </div>
        <h1 style={{ margin: 0, textAlign: 'center', fontSize: 21, fontWeight: 700, color: SC.fg, letterSpacing: '-0.3px' }}>Recover your account</h1>
        <p style={{ margin: '8px auto 22px', textAlign: 'center', fontSize: 13, color: SC.muted, lineHeight: '19px', maxWidth: 340 }}>
          You've lost access to every trusted device. {mode === 'totp' ? 'Confirm your authenticator' : 'Use a single-use backup code'} to trust this device and get back in.
        </p>

        {mode === 'totp' ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 12.5, color: SC.muted, marginBottom: 14 }}>6-digit code from your authenticator app</div>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <SSeg format={[3, 3]} value={code} onChange={v => { setCode(v); setError(false); }} size="lg" auto mono />
            </div>
            {error && <div style={{ marginTop: 10, fontSize: 12.5, color: SC.red, fontWeight: 500 }}>That code didn't match. Try the current code from your app.</div>}
            <div style={{ marginTop: 18 }}>
              <SBtn variant="primary" onClick={submitTotp} style={{ width: '100%' }} disabled={busy || code.replace(/\D/g, '').length < 6}>{busy ? 'Verifying…' : 'Verify & trust this device'}</SBtn>
            </div>
          </div>
        ) : (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 12.5, color: SC.muted, marginBottom: 14 }}>Enter one of your single-use backup codes</div>
            <input value={backup} onChange={e => { setBackup(e.target.value.toUpperCase()); setError(false); }} placeholder="XXXX-XXXX" autoFocus
              style={{ width: 200, height: 46, textAlign: 'center', fontFamily: 'Geist Mono, monospace', fontSize: 20, fontWeight: 600,
                letterSpacing: 1, border: `1.5px solid ${error ? SC.red : SC.border}`, borderRadius: 10, outline: 'none', color: SC.fg }} />
            {error && <div style={{ marginTop: 10, fontSize: 12.5, color: SC.red, fontWeight: 500 }}>That backup code wasn't accepted. Each code works only once.</div>}
            <div style={{ marginTop: 18 }}>
              <SBtn variant="primary" onClick={submitBackup} style={{ width: '100%' }} disabled={busy}>{busy ? 'Checking…' : 'Use backup code'}</SBtn>
            </div>
          </div>
        )}
        <div style={{ textAlign: 'center', marginTop: 18 }}><WhyComplicatedLink /></div>
      </div>

      {canSwitch && (
        <div style={{ padding: '13px 22px', background: SC.surface, borderTop: `1px solid ${SC.border}`, textAlign: 'center' }}>
          <button onClick={() => { setMode(m => m === 'totp' ? 'backup' : 'totp'); setError(false); }}
            style={{ border: 0, background: 'transparent', color: SC.primary, cursor: 'pointer', font: 'inherit', fontSize: 12.5, fontWeight: 600 }}>
            {mode === 'totp' ? 'Use a backup code instead' : 'Use authenticator app instead'}
          </button>
        </div>
      )}
    </SceneShell>
  );
}

window.SC_SCENES = { BootstrapScene, ApprovalScene, RecoveryScene };