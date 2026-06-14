// auth-scenes.jsx — full-screen onboarding/auth states:
// first-admin bootstrap · awaiting device approval · account recovery

const { C: SC, Icon: SIcon, Btn: SBtn, Pill: SPill } = window.WD_SHELL;
const { QRCode: SQR, SegmentedCode: SSeg, CopyChip: SCopyChip, ProtoHint: SProtoHint, Avatar: SAvatar } = window.SC_UI;
const { useState: useSc, useEffect: useScE } = React;

// shared centered chrome
function SceneShell({ children, footerNote, badge }) {
  const S = window.SC_DATA.SERVER;
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
            <div style={{ fontSize: 11.5, color: SC.muted, fontFamily: 'Geist Mono, monospace' }}>{S.host}</div>
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
function BootstrapScene({ onClaim }) {
  const [claiming, setClaiming] = useSc(false);
  const claim = () => { setClaiming(true); setTimeout(onClaim, 1100); };
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
            Log in with Keycloak
          </SBtn>
        )}
      </div>
      <div style={{ display: 'flex', gap: 10, padding: '14px 22px', background: SC.surface, borderTop: `1px solid ${SC.border}` }}>
        <SIcon name="shield" size={15} color={SC.muted} style={{ marginTop: 1, flex: '0 0 auto' }} />
        <span style={{ fontSize: 11.5, color: SC.muted, lineHeight: '16px' }}>
          From now on, a Keycloak login alone never grants access — every device must be explicitly trusted.
        </span>
      </div>
    </SceneShell>
  );
}

// ─── 2. AWAITING DEVICE APPROVAL ────────────────────────────────────────────
// What a user sees after Keycloak login on an untrusted device.
function ApprovalScene({ onApproved, goConsole }) {
  const code = window.SC_DATA.PENDING_DEVICES[0]?.code || '4821-7K39';
  const totpActive = window.SC_DATA.RECOVERY.totpActive;
  const [method, setMethod] = useSc('admin');   // 'admin' | 'totp'
  const [totp, setTotp] = useSc('');
  const [error, setError] = useSc(false);
  const [dots, setDots] = useSc(1);
  useScE(() => { const t = setInterval(() => setDots(d => (d % 3) + 1), 500); return () => clearInterval(t); }, []);
  useScE(() => { setTotp(''); setError(false); }, [method]);

  const verifyTotp = () => {
    if (totp.replace(/\D/g, '').length === 6) onApproved();
    else setError(true);
  };

  return (
    <SceneShell footerNote={<>Wrong account? <button onClick={goConsole} style={{ border: 0, background: 'transparent', color: SC.primary, cursor: 'pointer', font: 'inherit', fontWeight: 600 }}>Sign out</button></>}>
      <div style={{ padding: '26px 28px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 12px', background: SC.surface, borderRadius: 10, marginBottom: 20 }}>
          <SAvatar user={{ name: 'Alex Mráz', color: '#2a9d90' }} size={32} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: SC.fg }}>Signed in as Alex Mráz</div>
            <div style={{ fontSize: 11.5, color: SC.muted, fontFamily: 'Geist Mono, monospace' }}>alex@harmonum.ai</div>
          </div>
          <SIcon name="badge-check" size={17} color="#16a34a" />
        </div>

        <h1 style={{ margin: 0, textAlign: 'center', fontSize: 20, fontWeight: 700, color: SC.fg, letterSpacing: '-0.3px' }}>Trust this device</h1>
        <p style={{ margin: '8px auto 18px', textAlign: 'center', fontSize: 13, color: SC.muted, lineHeight: '19px', maxWidth: 350 }}>
          You're signed in, but this device isn't trusted yet. Confirm it with your authenticator, or have an admin approve the code.
        </p>

        {/* method switch */}
        <div style={{ display: 'flex', gap: 6, padding: 4, background: SC.surface, borderRadius: 10, marginBottom: 20 }}>
          <MethodTab active={method === 'admin'} icon="user-check" label="Admin approval" onClick={() => setMethod('admin')} />
          <MethodTab active={method === 'totp'} icon="key-round" label="Authenticator" onClick={() => setMethod('totp')} />
        </div>

        {method === 'admin' ? (
          <>
            <div style={{ display: 'flex', gap: 18, alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ padding: 9, border: `1px solid ${SC.border}`, borderRadius: 12 }}>
                <SQR seed={'approve-' + code} size={120} />
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: SC.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Your code</div>
                <div style={{ fontFamily: 'Geist Mono, monospace', fontSize: 28, fontWeight: 700, color: SC.fg, letterSpacing: 1 }}>{code}</div>
                <div style={{ marginTop: 10 }}><SCopyChip text={code} label="Copy code" /></div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 20, fontSize: 13, color: SC.primary, fontWeight: 500 }}>
              <SIcon name="loader" size={15} color={SC.primary} />
              Waiting for an admin{'.'.repeat(dots)}
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
            <div style={{ marginTop: 10, display: 'flex', justifyContent: 'center' }}><SProtoHint>prototype — any 6 digits work</SProtoHint></div>
            {error && <div style={{ marginTop: 10, fontSize: 12.5, color: SC.red, fontWeight: 500 }}>Enter all 6 digits from your app.</div>}
            <div style={{ marginTop: 16 }}>
              <SBtn variant="primary" leftIcon="shield-check" onClick={verifyTotp} disabled={totp.replace(/\D/g, '').length < 6} style={{ width: '100%' }}>Verify &amp; trust this device</SBtn>
            </div>
          </div>
        )}
      </div>

      <div style={{ padding: '14px 22px', background: SC.surface, borderTop: `1px solid ${SC.border}` }}>
        {method === 'admin'
          ? <SBtn variant="primary" leftIcon="check" onClick={onApproved} style={{ width: '100%' }}>Simulate admin approval → enter console</SBtn>
          : <div style={{ textAlign: 'center', fontSize: 12, color: SC.muted }}>No authenticator set up? <button onClick={() => setMethod('admin')} style={{ border: 0, background: 'transparent', color: SC.primary, cursor: 'pointer', font: 'inherit', fontWeight: 600 }}>Ask an admin instead</button></div>}
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
function RecoveryScene({ onRecovered, goConsole }) {
  const [mode, setMode] = useSc('totp');   // 'totp' | 'backup'
  const [code, setCode] = useSc('');
  const [backup, setBackup] = useSc('');
  const [error, setError] = useSc(false);

  const submitTotp = () => {
    if (code.replace(/\D/g, '').length === 6) onRecovered();
    else setError(true);
  };
  const submitBackup = () => {
    if (backup.replace(/[^A-Z0-9]/gi, '').length >= 8) onRecovered();
    else setError(true);
  };

  return (
    <SceneShell badge={<SPill tone="danger" size="xs">Locked out</SPill>}
      footerNote={<>Remembered a device? <button onClick={goConsole} style={{ border: 0, background: 'transparent', color: SC.primary, cursor: 'pointer', font: 'inherit', fontWeight: 600 }}>Back to sign in</button></>}>
      <div style={{ padding: '28px 30px 24px' }}>
        <div style={{ width: 52, height: 52, borderRadius: 13, background: SC.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
          <SIcon name="key-round" size={24} color={SC.fg} />
        </div>
        <h1 style={{ margin: 0, textAlign: 'center', fontSize: 21, fontWeight: 700, color: SC.fg, letterSpacing: '-0.3px' }}>Recover your account</h1>
        <p style={{ margin: '8px auto 22px', textAlign: 'center', fontSize: 13, color: SC.muted, lineHeight: '19px', maxWidth: 340 }}>
          You've lost access to every trusted device. Confirm your authenticator to trust this device and get back in.
        </p>

        {mode === 'totp' ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 12.5, color: SC.muted, marginBottom: 14 }}>6-digit code from your authenticator app</div>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <SSeg format={[3, 3]} value={code} onChange={v => { setCode(v); setError(false); }} size="lg" auto mono />
            </div>
            <div style={{ marginTop: 10, display: 'flex', justifyContent: 'center' }}><SProtoHint>prototype — any 6 digits work</SProtoHint></div>
            {error && <div style={{ marginTop: 10, fontSize: 12.5, color: SC.red, fontWeight: 500 }}>Enter all 6 digits.</div>}
            <div style={{ marginTop: 18 }}>
              <SBtn variant="primary" onClick={submitTotp} style={{ width: '100%' }} disabled={code.replace(/\D/g, '').length < 6}>Verify &amp; trust this device</SBtn>
            </div>
          </div>
        ) : (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 12.5, color: SC.muted, marginBottom: 14 }}>Enter one of your single-use backup codes</div>
            <input value={backup} onChange={e => { setBackup(e.target.value.toUpperCase()); setError(false); }} placeholder="XXXX-XXXX" autoFocus
              style={{ width: 200, height: 46, textAlign: 'center', fontFamily: 'Geist Mono, monospace', fontSize: 20, fontWeight: 600,
                letterSpacing: 1, border: `1.5px solid ${error ? SC.red : SC.border}`, borderRadius: 10, outline: 'none', color: SC.fg }} />
            {error && <div style={{ marginTop: 10, fontSize: 12.5, color: SC.red, fontWeight: 500 }}>That doesn't look like a backup code.</div>}
            <div style={{ marginTop: 18 }}>
              <SBtn variant="primary" onClick={submitBackup} style={{ width: '100%' }}>Use backup code</SBtn>
            </div>
          </div>
        )}
      </div>

      <div style={{ padding: '13px 22px', background: SC.surface, borderTop: `1px solid ${SC.border}`, textAlign: 'center' }}>
        <button onClick={() => { setMode(m => m === 'totp' ? 'backup' : 'totp'); setError(false); }}
          style={{ border: 0, background: 'transparent', color: SC.primary, cursor: 'pointer', font: 'inherit', fontSize: 12.5, fontWeight: 600 }}>
          {mode === 'totp' ? 'Use a backup code instead' : 'Use authenticator app instead'}
        </button>
      </div>
    </SceneShell>
  );
}

window.SC_SCENES = { BootstrapScene, ApprovalScene, RecoveryScene };
