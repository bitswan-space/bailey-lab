import React from 'react';
// views-devices.jsx — My devices (WhatsApp-style linking) + Security & recovery

const { C: DC, Icon: DIcon, Btn: DBtn, Pill: DPill } = window.WD_SHELL;
const {
  Card: DCard, PageHeader: DPageHeader, Field: DField, TextInput: DTextInput, Modal: DModal,
  SegmentedCode: DSeg, QRCode: DQR, QRImage: DQRImage, DeviceIcon: DDeviceIcon, ProtoHint: DProtoHint,
  CopyChip: DCopyChip, Toggle: DToggle, EmptyState: DEmpty, LiveState: DLiveState,
} = window.SC_UI;
const { Api: DApi } = window.SC_API;
const { useState: useD, useEffect: useDE } = React;

const TRUST_BADGE = {
  root:   { label: 'Root device', tone: 'primary', icon: 'crown' },
  admin:  { label: 'Admin-approved', tone: 'info', icon: 'shield-check' },
  linked: { label: 'Linked', tone: 'neutral', icon: 'link' },
};

// ─── MY DEVICES ─────────────────────────────────────────────────────────────
function DevicesView({ ctx }) {
  const { data, setData, toast, refresh } = ctx;
  const [linkOpen, setLinkOpen] = useD(false);
  const [revoke, setRevoke] = useD(null);
  const [busy, setBusy] = useD(false);

  // Live: remove the device via POST /bailey/api/devices/remove, then
  // re-fetch the device list so the UI reflects the backend.
  const doRevoke = async (dev) => {
    setBusy(true);
    try {
      await DApi.removeDevice(dev.id);
      toast(`${dev.name} signed out and removed`, 'danger');
      setRevoke(null);
      await refresh('devices');
    } catch (e) {
      toast(`Couldn't remove device: ${e.message}`, 'danger');
    } finally { setBusy(false); }
  };

  return (
    <div>
      <DPageHeader title="Your devices" icon="laptop"
        subtitle="Every device signed in to your account. Trust spreads device-to-device: a device you've already trusted can vouch for a new one — no admin needed."
        actions={<DBtn variant="primary" leftIcon="plus" onClick={() => setLinkOpen(true)}>Link a device</DBtn>} />

      {data.load.devices !== 'ok' && (
        <DLiveState status={data.load.devices} error={data.error.devices}
          label="Loading your devices…" onRetry={() => refresh('devices')} />
      )}
      {data.load.devices === 'ok' && data.myDevices.length === 0 && (
        <DCard><DEmpty icon="laptop" title="No trusted devices"
          text="No devices are currently paired to your account on this server." /></DCard>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {data.myDevices.map(dev => {
          const badge = TRUST_BADGE[dev.trustOrigin] || TRUST_BADGE.linked;
          return (
            <div key={dev.id} style={{
              display: 'flex', alignItems: 'center', gap: 16, padding: '16px 18px',
              border: `1px solid ${dev.current ? DC.primary : DC.border}`, borderRadius: 12, background: '#fff',
              boxShadow: dev.current ? `0 0 0 3px ${DC.primarySoft}` : 'none',
            }}>
              <span style={{ width: 46, height: 46, borderRadius: 11, flex: '0 0 auto',
                background: dev.current ? DC.primarySoft : DC.surface2,
                display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <DDeviceIcon kind={dev.kind} size={22} color={dev.current ? DC.primary : DC.fg} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 14.5, fontWeight: 600, color: DC.fg }}>{dev.name}</span>
                  {dev.current && <DPill tone="success" size="xs">● This device</DPill>}
                  <DPill tone={badge.tone} size="xs">{badge.label}</DPill>
                </div>
                {(dev.browser || dev.os || dev.location || dev.ip) && (
                  <div style={{ fontSize: 12.5, color: DC.muted, marginTop: 3, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                    {(dev.browser || dev.os) && <span>{[dev.browser, dev.os].filter(Boolean).join(' · ')}</span>}
                    {dev.location && <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><DIcon name="map-pin" size={12} color={DC.mutedFg} />{dev.location}</span>}
                    {dev.ip && <span style={{ fontFamily: 'Geist Mono, monospace' }}>{dev.ip}</span>}
                  </div>
                )}
                <div style={{ fontSize: 11.5, color: DC.mutedFg, marginTop: 4, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  <span>{dev.lastActive}</span>
                  {dev.added && dev.added !== '—' && <><span>·</span><span>Added {dev.added}</span></>}
                  {dev.linkedFrom && <><span>·</span><span>Linked from {dev.linkedFrom}</span></>}
                </div>
              </div>
              {dev.current ? (
                <DPill tone="outline" size="xs">In use</DPill>
              ) : (
                <DBtn variant="danger" size="sm" leftIcon="log-out" onClick={() => setRevoke(dev)}>Sign out</DBtn>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 16, padding: 14, borderRadius: 12, background: DC.surface, border: `1px solid ${DC.border}` }}>
        <DIcon name="info" size={15} color={DC.muted} style={{ marginTop: 1, flex: '0 0 auto' }} />
        <span style={{ fontSize: 12.5, color: DC.muted, lineHeight: '18px' }}>
          Lose access to <em>all</em> of these devices and you'll be locked out — a Keycloak login alone won't let you back in. Set up&nbsp;
          <button onClick={() => ctx.go('security')} style={{ border: 0, background: 'transparent', color: DC.primary, cursor: 'pointer', padding: 0, font: 'inherit', fontWeight: 600 }}>authenticator recovery</button>
          &nbsp;so you always have a way back.
        </span>
      </div>

      <LinkDeviceModal open={linkOpen} onClose={() => setLinkOpen(false)} ctx={ctx} />

      <DModal open={!!revoke} onClose={() => setRevoke(null)} icon="log-out" title={`Sign out ${revoke?.name}?`}
        subtitle="That device will lose trust immediately and must be re-linked to get back in."
        footer={<>
          <DBtn variant="default" onClick={() => setRevoke(null)}>Cancel</DBtn>
          <DBtn variant="primary" disabled={busy} style={{ background: DC.red, borderColor: DC.red }} onClick={() => doRevoke(revoke)}>{busy ? 'Signing out…' : 'Sign out device'}</DBtn>
        </>}>
        {revoke && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 13, padding: 13, background: DC.surface, borderRadius: 10 }}>
            <DDeviceIcon kind={revoke.kind} size={20} color={DC.fg} />
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>{revoke.name}</div>
              <div style={{ fontSize: 12, color: DC.muted }}>{revoke.location} · {revoke.lastActive}</div>
            </div>
          </div>
        )}
      </DModal>
    </div>
  );
}

// ─── LINK DEVICE ────────────────────────────────────────────────────────────
// Trust spreads device-to-device with NO admin: the new device signs in and
// shows a short code; the user enters that code HERE, on a device they already
// trust, and the new device is trusted immediately. This posts the code to the
// same approval endpoint the gate uses (/2fa-gate/approve) for the caller's own
// account — approverIsTrusted gates it to a trusted browser, and a non-admin
// may only approve their OWN pending code, so a user links their own devices
// without involving an admin.
function LinkDeviceModal({ open, onClose, ctx }) {
  const { currentUser, toast, refresh } = ctx;
  const [code, setCode] = useD('');
  const [busy, setBusy] = useD(false);
  const [err, setErr] = useD('');

  const submit = async () => {
    const c = code.trim();
    if (!c) { setErr('Enter the code shown on the new device.'); return; }
    setBusy(true); setErr('');
    try {
      await DApi.approvePair(currentUser.email, c);
      toast('New device linked and trusted', 'success');
      setCode('');
      await refresh('devices');
      onClose();
    } catch (e) {
      setErr(e.message || "That code didn't match — check it and try again.");
    } finally { setBusy(false); }
  };

  return (
    <DModal open={open} onClose={() => { setCode(''); setErr(''); onClose(); }} icon="smartphone" title="Link a new device" width={520}
      subtitle="Trust a new device from this one — no admin needed."
      footer={<>
        <DBtn variant="default" onClick={() => { setCode(''); setErr(''); onClose(); }}>Cancel</DBtn>
        <DBtn variant="primary" leftIcon="link" disabled={busy || !code.trim()} onClick={submit}>{busy ? 'Linking…' : 'Link device'}</DBtn>
      </>}>
      <div style={{ display: 'flex', gap: 11, padding: '13px 15px', background: DC.surface, borderRadius: 10, marginBottom: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5, color: DC.fg, lineHeight: '17px' }}>
          <div style={{ display: 'flex', gap: 9 }}><Step n="1" /><span>On the new device, open this server and sign in. It shows a short code.</span></div>
          <div style={{ display: 'flex', gap: 9 }}><Step n="2" /><span>Enter that code below to trust the new device — it'll be let in straight away.</span></div>
        </div>
      </div>

      <DField label="Code from the new device">
        <DTextInput value={code} mono autoFocus placeholder="000000"
          onChange={(v) => { setCode(v); setErr(''); }} />
      </DField>
      {err && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: DC.red }}>{err}</div>
      )}
    </DModal>
  );
}

function Step({ n }) {
  return <span style={{ width: 20, height: 20, borderRadius: 9999, flex: '0 0 auto', background: DC.primary, color: '#fff',
    fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{n}</span>;
}

// ─── SECURITY & RECOVERY ────────────────────────────────────────────────────
// Wired to the real gate APIs:
//   • enrolment status comes from gate-state (synced into data.recovery by App)
//   • Set up   → SetupTotpModal: GET /totp/enroll then POST /totp/verify
//   • Regenerate → POST /backup-codes/regenerate (returns the new plaintext set)
// Backup codes are only ever returned once (only hashes are stored), so the
// card can show codes only for the set generated in this browser session.
function SecurityView({ ctx }) {
  const { data, setData, toast } = ctx;
  const rec = data.recovery;
  const [setupOpen, setSetupOpen] = useD(false);
  const [showCodes, setShowCodes] = useD(false);
  const [regenBusy, setRegenBusy] = useD(false);
  // Codes shown here are only those generated in this session (empty when the
  // user enrolled earlier — the plaintext can't be re-fetched).
  const sessionCodes = rec.recoveryCodes || [];

  const removeTotp = () => {
    // No backend "remove" endpoint in the gate contract; keep the control
    // visible only as a local toggle would be misleading, so we surface it.
    toast('Removing the authenticator is done from account settings', 'info');
  };
  const regenerate = async () => {
    setRegenBusy(true);
    try {
      const r = await DApi.regenerateBackupCodes();
      setData(d => ({ ...d, recovery: { ...d.recovery, recoveryCodes: (r && r.backup_codes) || [] } }));
      setShowCodes(true);
      toast('New recovery codes generated', 'success');
    } catch (e) {
      toast(e.message || 'Could not regenerate codes', 'error');
    } finally {
      setRegenBusy(false);
    }
  };

  return (
    <div>
      <DPageHeader title="Security &amp; recovery" icon="shield"
        subtitle="If you ever lose every trusted device, an authenticator app is your way back in — without waiting on an admin." />

      <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Authenticator card */}
        <DCard pad={0}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 15, padding: 20 }}>
            <span style={{ width: 44, height: 44, borderRadius: 11, flex: '0 0 auto',
              background: rec.totpActive ? '#dcfce7' : DC.surface2,
              display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <DIcon name="key-round" size={21} color={rec.totpActive ? '#16a34a' : DC.muted} />
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: DC.fg }}>Authenticator app</span>
                {rec.totpActive
                  ? <DPill tone="success" size="xs">● Active</DPill>
                  : <DPill tone="warning" size="xs">Not set up</DPill>}
              </div>
              <p style={{ margin: '5px 0 0', fontSize: 13, color: DC.muted, lineHeight: '19px', maxWidth: 440 }}>
                Use Google Authenticator, 1Password, or any TOTP app. A rotating 6-digit code becomes a recovery factor that doesn't depend on Keycloak or any single device.
              </p>
            </div>
            {rec.totpActive
              ? <DBtn variant="danger" size="sm" onClick={removeTotp}>Remove</DBtn>
              : <DBtn variant="primary" leftIcon="plus" onClick={() => setSetupOpen(true)}>Set up</DBtn>}
          </div>
        </DCard>

        {/* Recovery codes (only when TOTP active) */}
        {rec.totpActive && (
          <DCard pad={0}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: showCodes ? `1px solid ${DC.border}` : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
                <span style={{ width: 40, height: 40, borderRadius: 10, background: DC.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <DIcon name="list-checks" size={19} color={DC.muted} />
                </span>
                <div>
                  <div style={{ fontSize: 14.5, fontWeight: 700, color: DC.fg }}>Backup recovery codes</div>
                  <div style={{ fontSize: 12.5, color: DC.muted }}>Single-use codes for when you can't reach your authenticator.</div>
                </div>
              </div>
              <DBtn variant="default" size="sm" rightIcon={showCodes ? 'chevron-up' : 'chevron-down'} onClick={() => setShowCodes(s => !s)}>
                {showCodes ? 'Hide' : 'Show'} codes
              </DBtn>
            </div>
            {showCodes && (
              <div style={{ padding: 20 }}>
                {sessionCodes.length > 0 ? (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
                      {sessionCodes.map((c, i) => (
                        <div key={i} style={{ fontFamily: 'Geist Mono, monospace', fontSize: 13.5, fontWeight: 500, color: DC.fg,
                          padding: '9px 10px', background: DC.surface, border: `1px solid ${DC.border}`, borderRadius: 8, textAlign: 'center', letterSpacing: 0.5 }}>{c}</div>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                      <DCopyChip text={sessionCodes.join('\n')} label="Copy all" />
                      <DBtn variant="default" size="sm" leftIcon="refresh-cw" onClick={regenerate} disabled={regenBusy}>{regenBusy ? 'Generating…' : 'Regenerate'}</DBtn>
                    </div>
                  </>
                ) : (
                  <div style={{ textAlign: 'center' }}>
                    <p style={{ margin: '0 auto 14px', fontSize: 12.5, color: DC.muted, lineHeight: '18px', maxWidth: 380 }}>
                      Backup codes are shown only once, when they're created. We can't display your existing codes again — generate a fresh set if you need them (this invalidates the old set).
                    </p>
                    <DBtn variant="default" size="sm" leftIcon="refresh-cw" onClick={regenerate} disabled={regenBusy}>{regenBusy ? 'Generating…' : 'Generate new codes'}</DBtn>
                  </div>
                )}
              </div>
            )}
          </DCard>
        )}
      </div>

      <SetupTotpModal open={setupOpen} onClose={() => setSetupOpen(false)} data={data} setData={setData} toast={toast} onDone={() => setShowCodes(true)} />
    </div>
  );
}

// SetupTotpModal — real opt-in authenticator enrolment:
//   step 1: GET /bailey/api/totp/enroll → {secret, otpauth_url}; render a
//           scannable QR from otpauth_url + the base32 secret to type manually.
//           The pending secret lives in an HttpOnly cookie set by the GET; we
//           never persist it client-side.
//   step 2: POST /bailey/api/totp/verify {code} → {backup_codes}; confirms +
//           persists enrolment and returns the one-time plaintext backup codes.
//   step 3: show the returned backup codes (the only time they're visible).
function SetupTotpModal({ open, onClose, data, setData, toast, onDone }) {
  const [step, setStep] = useD(1);
  const [code, setCode] = useD('');
  const [error, setError] = useD('');
  const [enroll, setEnroll] = useD(null);     // { secret, otpauth_url }
  const [enrollErr, setEnrollErr] = useD('');
  const [verifying, setVerifying] = useD(false);
  const [codes, setCodes] = useD([]);         // backup_codes from /verify

  // On open, reset and request a fresh enrolment session.
  useDE(() => {
    if (!open) return;
    setStep(1); setCode(''); setError(''); setEnroll(null); setEnrollErr(''); setVerifying(false); setCodes([]);
    let alive = true;
    DApi.totpEnroll()
      .then(r => { if (alive) setEnroll(r); })
      .catch(e => { if (alive) setEnrollErr(e.message || 'Could not start authenticator setup.'); });
    return () => { alive = false; };
  }, [open]);

  const verify = async () => {
    if (code.replace(/\D/g, '').length < 6) { setError('Enter all 6 digits from your app.'); return; }
    setVerifying(true); setError('');
    try {
      const r = await DApi.totpVerify(code.replace(/\D/g, ''));
      const bc = (r && r.backup_codes) || [];
      setCodes(bc);
      setData(d => ({ ...d, recovery: { ...d.recovery, totpActive: true, recoveryCodes: bc } }));
      setStep(3);
    } catch (e) {
      setError(e.message || 'That code did not match. Try the current code.');
    } finally {
      setVerifying(false);
    }
  };
  const finish = () => { toast('Authenticator recovery enabled', 'success'); onDone && onDone(); onClose(); };

  return (
    <DModal open={open} onClose={onClose} icon="key-round" title="Set up authenticator recovery" width={460}>
      {step === 1 && (
        <div style={{ textAlign: 'center' }}>
          <p style={{ margin: '0 0 16px', fontSize: 13, color: DC.muted, lineHeight: '19px' }}>
            Scan this QR with your authenticator app, or enter the key manually.
          </p>
          {enrollErr ? (
            <div style={{ fontSize: 12.5, color: DC.red, fontWeight: 500, padding: '12px 0' }}>{enrollErr}</div>
          ) : (
            <>
              <div style={{ display: 'inline-block', padding: 12, border: `1px solid ${DC.border}`, borderRadius: 14 }}>
                {enroll && enroll.otpauth_url
                  ? <DQRImage value={enroll.otpauth_url} size={168} />
                  : <div style={{ width: 168, height: 168, borderRadius: 8, background: DC.surface2 }} />}
              </div>
              <div style={{ marginTop: 16, marginBottom: 6, display: 'flex', justifyContent: 'center' }}>
                {enroll && enroll.secret
                  ? <DCopyChip text={enroll.secret} label={enroll.secret} />
                  : <span style={{ fontSize: 12, color: DC.muted }}>Loading setup key…</span>}
              </div>
              <div style={{ marginTop: 18 }}>
                <DBtn variant="primary" rightIcon="arrow-right" disabled={!enroll} onClick={() => setStep(2)} style={{ width: '100%' }}>I've added it — continue</DBtn>
              </div>
            </>
          )}
        </div>
      )}
      {step === 2 && (
        <div style={{ textAlign: 'center' }}>
          <p style={{ margin: '0 0 18px', fontSize: 13, color: DC.muted, lineHeight: '19px' }}>
            Enter the current 6-digit code from your authenticator app to confirm it's set up.
          </p>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <DSeg format={[3, 3]} value={code} onChange={v => { setCode(v); setError(''); }} size="lg" auto mono />
          </div>
          {error && <div style={{ marginTop: 12, fontSize: 12.5, color: DC.red, fontWeight: 500 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
            <DBtn variant="default" onClick={() => setStep(1)} style={{ flex: 1 }}>Back</DBtn>
            <DBtn variant="primary" disabled={verifying || code.replace(/\D/g, '').length < 6} onClick={verify} style={{ flex: 1 }}>{verifying ? 'Verifying…' : 'Verify'}</DBtn>
          </div>
        </div>
      )}
      {step === 3 && (
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 56, height: 56, borderRadius: 9999, background: '#dcfce7', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
            <DIcon name="check" size={28} color="#16a34a" />
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: DC.fg, marginBottom: 6 }}>Recovery is on</div>
          <p style={{ margin: '0 auto 18px', fontSize: 13, color: DC.muted, lineHeight: '19px', maxWidth: 340 }}>
            Save these backup codes somewhere safe — this is the only time they're shown. If you're ever locked out of every device, your authenticator or a backup code gets you back in.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 14, textAlign: 'left' }}>
            {codes.map((c, i) => (
              <div key={i} style={{ fontFamily: 'Geist Mono, monospace', fontSize: 13, padding: '8px 10px', background: DC.surface, border: `1px solid ${DC.border}`, borderRadius: 8, textAlign: 'center' }}>{c}</div>
            ))}
          </div>
          {codes.length > 0 && <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}><DCopyChip text={codes.join('\n')} label="Copy all codes" /></div>}
          <DBtn variant="primary" onClick={finish} style={{ width: '100%' }}>Done</DBtn>
        </div>
      )}
    </DModal>
  );
}

window.SC_DEVICES = { DevicesView, SecurityView };