import React from 'react';
// views-devices.jsx — My devices (WhatsApp-style linking) + Security & recovery

const { C: DC, Icon: DIcon, Btn: DBtn, Pill: DPill } = window.WD_SHELL;
const {
  Card: DCard, PageHeader: DPageHeader, Field: DField, Modal: DModal,
  SegmentedCode: DSeg, QRCode: DQR, DeviceIcon: DDeviceIcon, ProtoHint: DProtoHint,
  CopyChip: DCopyChip, Toggle: DToggle, EmptyState: DEmpty,
} = window.SC_UI;
const { useState: useD } = React;

const TRUST_BADGE = {
  root:   { label: 'Root device', tone: 'primary', icon: 'crown' },
  admin:  { label: 'Admin-approved', tone: 'info', icon: 'shield-check' },
  linked: { label: 'Linked', tone: 'neutral', icon: 'link' },
};

// ─── MY DEVICES ─────────────────────────────────────────────────────────────
function DevicesView({ ctx }) {
  const { data, setData, toast } = ctx;
  const [linkOpen, setLinkOpen] = useD(false);
  const [revoke, setRevoke] = useD(null);

  const doRevoke = (dev) => {
    setData(d => ({ ...d, myDevices: d.myDevices.filter(x => x.id !== dev.id) }));
    toast(`${dev.name} signed out and removed`, 'danger');
    setRevoke(null);
  };

  return (
    <div>
      <DPageHeader title="Your devices" icon="laptop"
        subtitle="Every device signed in to your account. Trust spreads device-to-device: a device you've already trusted can vouch for a new one — no admin needed."
        actions={<DBtn variant="primary" leftIcon="plus" onClick={() => setLinkOpen(true)}>Link a device</DBtn>} />

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
                <div style={{ fontSize: 12.5, color: DC.muted, marginTop: 3, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  <span>{dev.browser} · {dev.os}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><DIcon name="map-pin" size={12} color={DC.mutedFg} />{dev.location}</span>
                  <span style={{ fontFamily: 'Geist Mono, monospace' }}>{dev.ip}</span>
                </div>
                <div style={{ fontSize: 11.5, color: DC.mutedFg, marginTop: 4, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  <span>{dev.lastActive}</span>
                  <span>·</span>
                  <span>Added {dev.added}</span>
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

      <LinkDeviceModal open={linkOpen} onClose={() => setLinkOpen(false)} data={data} setData={setData} toast={toast} />

      <DModal open={!!revoke} onClose={() => setRevoke(null)} icon="log-out" title={`Sign out ${revoke?.name}?`}
        subtitle="That device will lose trust immediately and must be re-linked to get back in."
        footer={<>
          <DBtn variant="default" onClick={() => setRevoke(null)}>Cancel</DBtn>
          <DBtn variant="primary" style={{ background: DC.red, borderColor: DC.red }} onClick={() => doRevoke(revoke)}>Sign out device</DBtn>
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

// ─── LINK DEVICE (WhatsApp-style: this trusted device enters the new one's PIN) ─
function LinkDeviceModal({ open, onClose, data, setData, toast }) {
  const [tab, setTab] = useD('pin');       // 'pin' | 'scan'
  const [pin, setPin] = useD('');
  const [error, setError] = useD(false);
  const [scanning, setScanning] = useD(false);
  const LINK = window.SC_DATA.LINK_REQUEST;
  const target = LINK.pin.replace(/\D/g, '');

  React.useEffect(() => { if (open) { setTab('pin'); setPin(''); setError(false); setScanning(false); } }, [open]);

  const addDevice = () => {
    setData(d => ({ ...d, myDevices: [...d.myDevices, {
      id: 'd-' + Math.random().toString(36).slice(2, 6), name: `${LINK.os} · ${LINK.browser}`,
      kind: LINK.kind, current: false, browser: LINK.browser, os: LINK.os, ip: LINK.ip,
      location: LINK.location, lastActive: 'Active now', trustOrigin: 'linked',
      linkedFrom: data.myDevices.find(x => x.current)?.name || 'this device', added: 'Just now',
    }] }));
    toast('New device linked and trusted', 'success');
    onClose();
  };
  const tryPin = (v) => {
    const clean = v.replace(/\D/g, '');
    if (clean.length === 6) {
      if (clean === target) addDevice();
      else setError(true);
    }
  };
  const simulateScan = () => {
    setScanning(true);
    setTimeout(() => addDevice(), 1300);
  };

  const TabBtn = ({ id, icon, label }) => (
    <button onClick={() => setTab(id)} style={{
      flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, height: 36,
      border: 0, borderBottom: `2px solid ${tab === id ? DC.primary : 'transparent'}`,
      background: 'transparent', cursor: 'pointer', fontSize: 13, fontWeight: tab === id ? 600 : 500,
      color: tab === id ? DC.fg : DC.muted }}>
      <DIcon name={icon} size={15} color={tab === id ? DC.primary : DC.mutedFg} />{label}
    </button>
  );

  return (
    <DModal open={open} onClose={onClose} icon="smartphone" title="Link a new device" width={520}
      subtitle="Already-trusted devices can vouch for new ones — just like linking a phone to a chat app.">
      {/* steps */}
      <div style={{ display: 'flex', gap: 11, padding: '13px 15px', background: DC.surface, borderRadius: 10, marginBottom: 18 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5, color: DC.fg, lineHeight: '17px' }}>
          <div style={{ display: 'flex', gap: 9 }}><Step n="1" /><span>On the new device, open <strong style={{ fontFamily: 'Geist Mono, monospace' }}>bailey.harmonum.ai</strong> and sign in with Keycloak.</span></div>
          <div style={{ display: 'flex', gap: 9 }}><Step n="2" /><span>It shows a 6-digit link PIN and a QR code.</span></div>
          <div style={{ display: 'flex', gap: 9 }}><Step n="3" /><span>Enter that PIN here, or scan its QR with this trusted device.</span></div>
        </div>
      </div>

      <div style={{ display: 'flex', borderBottom: `1px solid ${DC.border}`, marginBottom: 20 }}>
        <TabBtn id="pin" icon="keyboard" label="Enter PIN" />
        <TabBtn id="scan" icon="scan-line" label="Scan its QR" />
      </div>

      {tab === 'pin' ? (
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 13, color: DC.muted, marginBottom: 14 }}>Type the PIN shown on the new device</div>
          <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
            <DSeg format={[3, 3]} value={pin} onChange={v => { setPin(v); setError(false); tryPin(v); }} size="lg" auto mono />
            <DProtoHint>new device shows&nbsp;<strong style={{ color: DC.fg, fontFamily: 'Geist Mono, monospace' }}>{LINK.pin}</strong></DProtoHint>
          </div>
          {error && <div style={{ marginTop: 14, fontSize: 12.5, color: DC.red, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
            <DIcon name="x-circle" size={14} color={DC.red} /> That PIN doesn't match. Check the new device and re-enter.
          </div>}
        </div>
      ) : (
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 13, color: DC.muted, marginBottom: 16 }}>Point this device's camera at the QR on the new device</div>
          <div style={{ display: 'inline-block', position: 'relative', padding: 14, border: `1px solid ${DC.border}`, borderRadius: 14, background: '#fff' }}>
            <div style={{ filter: scanning ? 'none' : 'grayscale(1) opacity(0.4)', transition: 'filter 200ms' }}>
              <DQR seed="link-new-device" size={172} />
            </div>
            {/* scan frame */}
            <div style={{ position: 'absolute', inset: 14, borderRadius: 10, pointerEvents: 'none',
              boxShadow: `inset 0 0 0 2px ${scanning ? DC.primary : 'transparent'}`, transition: 'box-shadow 200ms' }} />
            {scanning && <div style={{ position: 'absolute', left: 14, right: 14, top: 14, height: 2, background: DC.primary,
              boxShadow: `0 0 12px ${DC.primary}`, animation: 'sc-scan 1.1s ease-in-out infinite' }} />}
          </div>
          <div style={{ marginTop: 18 }}>
            <DBtn variant="primary" leftIcon={scanning ? 'loader' : 'scan-line'} disabled={scanning} onClick={simulateScan}>
              {scanning ? 'Linking…' : 'Simulate scan'}
            </DBtn>
          </div>
          <div style={{ marginTop: 12 }}><DProtoHint>prototype — real build uses the camera</DProtoHint></div>
        </div>
      )}
    </DModal>
  );
}

function Step({ n }) {
  return <span style={{ width: 20, height: 20, borderRadius: 9999, flex: '0 0 auto', background: DC.primary, color: '#fff',
    fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{n}</span>;
}

// ─── SECURITY & RECOVERY ────────────────────────────────────────────────────
function SecurityView({ ctx }) {
  const { data, setData, toast } = ctx;
  const rec = data.recovery;
  const [setupOpen, setSetupOpen] = useD(false);
  const [showCodes, setShowCodes] = useD(false);

  const removeTotp = () => {
    setData(d => ({ ...d, recovery: { ...d.recovery, totpActive: false } }));
    toast('Authenticator recovery removed', 'info');
  };
  const regenerate = () => {
    const gen = () => Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    setData(d => ({ ...d, recovery: { ...d.recovery, recoveryCodes: Array.from({ length: 8 }, gen) } }));
    toast('New recovery codes generated', 'success');
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
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
                  {rec.recoveryCodes.map((c, i) => (
                    <div key={i} style={{ fontFamily: 'Geist Mono, monospace', fontSize: 13.5, fontWeight: 500, color: DC.fg,
                      padding: '9px 10px', background: DC.surface, border: `1px solid ${DC.border}`, borderRadius: 8, textAlign: 'center', letterSpacing: 0.5 }}>{c}</div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                  <DCopyChip text={rec.recoveryCodes.join('\n')} label="Copy all" />
                  <DBtn variant="default" size="sm" leftIcon="refresh-cw" onClick={regenerate}>Regenerate</DBtn>
                </div>
              </div>
            )}
          </DCard>
        )}
      </div>

      <SetupTotpModal open={setupOpen} onClose={() => setSetupOpen(false)} data={data} setData={setData} toast={toast} onDone={() => setShowCodes(true)} />
    </div>
  );
}

function SetupTotpModal({ open, onClose, data, setData, toast, onDone }) {
  const [step, setStep] = useD(1);
  const [code, setCode] = useD('');
  const [error, setError] = useD(false);
  const rec = data.recovery;
  React.useEffect(() => { if (open) { setStep(1); setCode(''); setError(false); } }, [open]);

  const verify = () => {
    if (code.replace(/\D/g, '').length === 6) {
      setData(d => ({ ...d, recovery: { ...d.recovery, totpActive: true } }));
      setStep(3);
    } else setError(true);
  };
  const finish = () => { toast('Authenticator recovery enabled', 'success'); onDone && onDone(); onClose(); };

  return (
    <DModal open={open} onClose={onClose} icon="key-round" title="Set up authenticator recovery" width={460}>
      {step === 1 && (
        <div style={{ textAlign: 'center' }}>
          <p style={{ margin: '0 0 16px', fontSize: 13, color: DC.muted, lineHeight: '19px' }}>
            Scan this QR with your authenticator app, or enter the key manually.
          </p>
          <div style={{ display: 'inline-block', padding: 12, border: `1px solid ${DC.border}`, borderRadius: 14 }}>
            <DQR seed="totp-harmonum-tomas" size={168} />
          </div>
          <div style={{ marginTop: 16, marginBottom: 6, display: 'flex', justifyContent: 'center' }}>
            <DCopyChip text={rec.totpSecret.replace(/\s/g, '')} label={rec.totpSecret} />
          </div>
          <div style={{ marginTop: 18 }}>
            <DBtn variant="primary" rightIcon="arrow-right" onClick={() => setStep(2)} style={{ width: '100%' }}>I've added it — continue</DBtn>
          </div>
        </div>
      )}
      {step === 2 && (
        <div style={{ textAlign: 'center' }}>
          <p style={{ margin: '0 0 18px', fontSize: 13, color: DC.muted, lineHeight: '19px' }}>
            Enter the current 6-digit code from your authenticator app to confirm it's set up.
          </p>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <DSeg format={[3, 3]} value={code} onChange={v => { setCode(v); setError(false); }} size="lg" auto mono />
          </div>
          {error && <div style={{ marginTop: 12, fontSize: 12.5, color: DC.red, fontWeight: 500 }}>Enter all 6 digits from your app.</div>}
          <div style={{ marginTop: 10, display: 'flex', justifyContent: 'center' }}><DProtoHint>prototype — any 6 digits work</DProtoHint></div>
          <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
            <DBtn variant="default" onClick={() => setStep(1)} style={{ flex: 1 }}>Back</DBtn>
            <DBtn variant="primary" disabled={code.replace(/\D/g, '').length < 6} onClick={verify} style={{ flex: 1 }}>Verify</DBtn>
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
            Save your backup codes somewhere safe. If you're ever locked out of every device, your authenticator gets you back in.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 18, textAlign: 'left' }}>
            {rec.recoveryCodes.slice(0, 4).map((c, i) => (
              <div key={i} style={{ fontFamily: 'Geist Mono, monospace', fontSize: 13, padding: '8px 10px', background: DC.surface, border: `1px solid ${DC.border}`, borderRadius: 8, textAlign: 'center' }}>{c}</div>
            ))}
          </div>
          <DBtn variant="primary" onClick={finish} style={{ width: '100%' }}>Done</DBtn>
        </div>
      )}
    </DModal>
  );
}

window.SC_DEVICES = { DevicesView, SecurityView };