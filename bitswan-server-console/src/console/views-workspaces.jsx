import React from 'react';
// views-workspaces.jsx — Overview + Workspaces (list, create, ownership/members)

const { C: WC, Icon: WIcon, Btn: WBtn, Pill: WPill } = window.WD_SHELL;
const {
  Avatar: WAvatar, UserChip: WUserChip, Card: WCard, PageHeader: WPageHeader, Field: WField, TextInput: WTextInput,
  Modal: WModal, Toggle: WToggle, EmptyState: WEmpty, Stat: WStat, Drawer: WDrawer,
  Select: WSelect, AvatarStack: WAvatarStack, LiveState: WLiveState,
} = window.SC_UI;
const { Api: WApi } = window.SC_API;
const { useState: useWS } = React;

// WUpdateBar — a determinate progress bar for a streaming update (workspace or
// server). `prog` is { fraction: 0..1, label } fed from the NDJSON progress
// events. Exposed on SC_UI so the Updates view reuses the exact same bar.
function WUpdateBar({ prog }) {
  const frac = Math.max(0, Math.min(1, (prog && prog.fraction) || 0));
  const pct = Math.round(frac * 100);
  return (
    <div style={{ minWidth: 190 }}>
      <div style={{ height: 6, borderRadius: 999, background: WC.border, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: pct + '%', background: WC.primary, transition: 'width 300ms ease' }} />
      </div>
      <div style={{ marginTop: 4, fontSize: 11, color: WC.muted, whiteSpace: 'nowrap' }}>
        {(prog && prog.label) || 'Updating…'} · {pct}%
      </div>
    </div>
  );
}
if (window.SC_UI) window.SC_UI.UpdateBar = WUpdateBar;

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

// Horizontal launch tile for the "Apps you can access" section — one live
// frontend the caller has been granted, opened directly.
function AccessibleAppTile({ app, onOpen }) {
  return (
    <button onClick={onOpen} style={{
      display: 'flex', alignItems: 'center', gap: 11, padding: '13px 14px', textAlign: 'left',
      border: `1px solid ${WC.border}`, borderRadius: 11, background: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}
      onMouseEnter={e => { e.currentTarget.style.background = WC.surface; e.currentTarget.style.borderColor = WC.borderHi; }}
      onMouseLeave={e => { e.currentTarget.style.background = '#fff'; e.currentTarget.style.borderColor = WC.border; }}>
      <span style={{ width: 34, height: 34, borderRadius: 9, flex: '0 0 auto', background: WC.primarySoft,
        display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <WIcon name="app-window" size={17} color={WC.primary} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: WC.fg, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{app.name}</span>
          {app.stage && app.stage !== 'production' && <WPill tone="outline" size="xs">{app.stage}</WPill>}
        </div>
        <div style={{ fontSize: 11.5, color: WC.muted, fontFamily: 'Geist Mono, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{app.host}</div>
      </div>
      <WIcon name="external-link" size={14} color={WC.mutedFg} />
    </button>
  );
}

// ─── OVERVIEW ───────────────────────────────────────────────────────────────
// Fully wired to GET /bailey/api/overview (admin-only): stat-tile counts, the
// server-identity card (claimed-by/version/region/uptime/start-time), and the
// "Recent security activity" feed all come from that endpoint's adapted
// response (data.overview). No seed fallback — a failed fetch shows the error
// UI; an empty activity feed shows an empty state.
// EditableRegionRow — the overview identity card's Region field, editable
// in place (admin-only view). Persists via the admin region API; empty clears
// it. The daemon reads the value live, so a refresh reflects it immediately.
function EditableRegionRow({ region, toast, refresh }) {
  const [editing, setEditing] = useWS(false);
  const [val, setVal] = useWS(region || '');
  const [busy, setBusy] = useWS(false);
  React.useEffect(() => { setVal(region || ''); }, [region]);
  const save = async () => {
    setBusy(true);
    try {
      const v = val.trim();
      await WApi.setRegion(v);
      toast(v ? `Region set to ${v}` : 'Region cleared', 'success');
      setEditing(false);
      refresh && refresh('overview');
    } catch (e) { toast(`Couldn't set region: ${e.message}`, 'danger'); }
    finally { setBusy(false); }
  };
  const ROW = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: `1px solid ${WC.surface2}` };
  if (editing) {
    return (
      <div style={ROW}>
        <span style={{ fontSize: 12.5, color: WC.muted, whiteSpace: 'nowrap' }}>Region</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 1, justifyContent: 'flex-end' }}>
          <div style={{ maxWidth: 150 }}><WTextInput value={val} onChange={setVal} placeholder="e.g. eu-west" /></div>
          <WBtn variant="primary" size="sm" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</WBtn>
          <WBtn variant="default" size="sm" disabled={busy} onClick={() => { setEditing(false); setVal(region || ''); }}>Cancel</WBtn>
        </div>
      </div>
    );
  }
  return (
    <div style={ROW}>
      <span style={{ fontSize: 12.5, color: WC.muted, whiteSpace: 'nowrap' }}>Region</span>
      <button onClick={() => setEditing(true)} title="Set region" style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, border: 0, background: 'transparent',
        cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 500, color: WC.fg }}>
        {region || '—'}
        <WIcon name="pencil" size={12} color={WC.mutedFg} />
      </button>
    </div>
  );
}

// SiemCard — configure OpenTelemetry forwarding of the security audit log to
// an external SIEM. Starts disconnected; an admin sets protocol + URL + an
// optional port and bearer token. Saving with "enabled" runs a synchronous
// connectivity test on the backend so the card shows a truthful state.
function SiemCard({ toast }) {
  const [cfg, setCfg] = useWS(null);   // null = loading
  const [err, setErr] = useWS('');
  const [editing, setEditing] = useWS(false);
  const [busy, setBusy] = useWS(false);
  const [saveErr, setSaveErr] = useWS('');
  // Conventional OTLP receiver ports — HTTP on 4318, gRPC on 4317.
  const defaultPortFor = (p) => (p === 'otlp-grpc' ? '4317' : '4318');
  const [form, setForm] = useWS({ protocol: 'otlp-http', endpoint: '', port: '4318', auth_token: '' });

  const load = () => {
    setErr('');
    WApi.siem().then(setCfg).catch((e) => { setErr(e.message || 'Could not load SIEM settings.'); });
  };
  React.useEffect(() => { load(); }, []);

  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  // Switching protocol resets the port to that protocol's default, but it
  // stays an editable field the operator can override.
  const onProtocolChange = (p) => setForm((f) => ({ ...f, protocol: p, port: defaultPortFor(p) }));
  const openEdit = () => {
    const proto = (cfg && cfg.protocol) || 'otlp-http';
    setForm({
      protocol: proto,
      endpoint: (cfg && cfg.endpoint) || '',
      port: (cfg && cfg.port) ? String(cfg.port) : defaultPortFor(proto),
      auth_token: '',
    });
    setSaveErr('');
    setEditing(true);
  };

  const save = async (enabled) => {
    setBusy(true); setSaveErr('');
    try {
      const body = { enabled, protocol: form.protocol, endpoint: form.endpoint.trim(), port: form.port ? Number(form.port) : 0 };
      if (form.auth_token.trim()) body.auth_token = form.auth_token.trim(); // omitted = keep stored token
      const next = await WApi.setSiem(body);
      setCfg(next);
      if (enabled && !next.connected) {
        setSaveErr(next.last_error || "Saved, but couldn't reach the ingestor.");
        toast("SIEM saved, but the ingestor couldn't be reached", 'danger');
      } else {
        setEditing(false);
        toast(enabled ? 'SIEM forwarding connected' : 'SIEM forwarding disabled', enabled ? 'success' : 'info');
      }
    } catch (e) { setSaveErr(e.message || 'Save failed.'); }
    finally { setBusy(false); }
  };
  const disable = async () => {
    setBusy(true);
    try {
      const next = await WApi.setSiem({ enabled: false, protocol: (cfg && cfg.protocol) || 'otlp-http', endpoint: (cfg && cfg.endpoint) || '' });
      setCfg(next); toast('SIEM forwarding disabled', 'info');
    } catch (e) { toast(`Couldn't disable: ${e.message}`, 'danger'); }
    finally { setBusy(false); }
  };

  const connected = !!(cfg && cfg.connected);
  const enabled = !!(cfg && cfg.enabled);
  const statusPill = connected
    ? <WPill tone="success" size="xs">● Connected</WPill>
    : <WPill tone={enabled ? 'danger' : 'neutral'} size="xs">○ Disconnected</WPill>;

  const labelStyle = { fontSize: 11.5, fontWeight: 600, color: WC.muted, display: 'block', marginBottom: 5 };
  const FIELD = { marginBottom: 11 };

  return (
    <WCard pad={0}>
      <div style={{ padding: '14px 20px', borderBottom: `1px solid ${WC.border}`, display: 'flex', alignItems: 'center', gap: 10 }}>
        <WIcon name="radio-tower" size={16} color={WC.muted} />
        <span style={{ fontSize: 13, fontWeight: 600, color: WC.fg }}>SIEM forwarding</span>
        <span style={{ marginLeft: 'auto' }}>{statusPill}</span>
      </div>
      <div style={{ padding: '14px 20px' }}>
        {!cfg && !err && <div style={{ fontSize: 12.5, color: WC.muted }}>Loading…</div>}
        {err && (
          <div style={{ fontSize: 12.5, color: WC.red }}>{err} <button onClick={load} style={{ border: 0, background: 'transparent', color: WC.primary, cursor: 'pointer', font: 'inherit', fontWeight: 600 }}>Retry</button></div>
        )}

        {cfg && !editing && (
          <>
            <p style={{ margin: '0 0 12px', fontSize: 12.5, color: WC.muted, lineHeight: '18px' }}>
              Stream this server's security audit log to your SIEM over OpenTelemetry (OTLP). The same events shown in Recent security activity are forwarded as they happen.
            </p>
            {enabled ? (
              <div style={{ fontSize: 12.5, color: WC.fg }}>
                <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                  <span style={{ color: WC.muted }}>Endpoint</span>
                  <span style={{ fontFamily: 'Geist Mono, monospace', wordBreak: 'break-all' }}>{cfg.endpoint}{cfg.port ? `:${cfg.port}` : ''}</span>
                </div>
                {connected && cfg.last_event_at && (
                  <div style={{ color: WC.muted, fontSize: 11.5 }}>Last delivered {new Date(cfg.last_event_at).toLocaleString()}</div>
                )}
                {!connected && cfg.last_error && (
                  <div style={{ color: WC.red, fontSize: 11.5, marginTop: 2 }}>Last error: {cfg.last_error}</div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <WBtn variant="default" size="sm" leftIcon="settings-2" onClick={openEdit}>Edit</WBtn>
                  <WBtn variant="default" size="sm" disabled={busy} onClick={disable}>Disable</WBtn>
                </div>
              </div>
            ) : (
              <WBtn variant="primary" size="sm" leftIcon="plug" onClick={openEdit}>Configure ingestor</WBtn>
            )}
          </>
        )}

        {cfg && editing && (
          <div>
            <div style={FIELD}>
              <label style={labelStyle}>Ingestor URL</label>
              <WTextInput value={form.endpoint} onChange={setF('endpoint')} placeholder={form.protocol === 'otlp-grpc' ? 'collector.example.com' : 'https://collector.example.com'} />
            </div>
            {/* Protocol + port travel together: the port follows the protocol's
                default but stays editable. */}
            <div style={{ ...FIELD, display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Protocol</label>
                <select value={form.protocol} onChange={(e) => onProtocolChange(e.target.value)}
                  style={{ width: '100%', height: 34, padding: '0 9px', borderRadius: 8, border: `1px solid ${WC.border}`, background: '#fff', fontFamily: 'inherit', fontSize: 13, color: WC.fg }}>
                  <option value="otlp-http">OTLP / HTTP</option>
                  <option value="otlp-grpc">OTLP / gRPC</option>
                </select>
              </div>
              <div style={{ width: 96 }}>
                <label style={labelStyle}>Port</label>
                <WTextInput value={form.port} onChange={setF('port')} placeholder={defaultPortFor(form.protocol)} />
              </div>
            </div>
            <div style={FIELD}>
              <label style={labelStyle}>Auth token <span style={{ fontWeight: 400, color: WC.mutedFg }}>(optional, sent as Bearer)</span></label>
              <WTextInput value={form.auth_token} onChange={setF('auth_token')} type="password"
                placeholder={cfg.has_auth_token ? '•••••••• (leave blank to keep)' : 'optional bearer token'} />
            </div>
            {saveErr && (
              <div style={{ fontSize: 12, color: WC.red, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                <WIcon name="alert-triangle" size={13} color={WC.red} />{saveErr}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <WBtn variant="primary" size="sm" leftIcon="plug" disabled={busy || !form.endpoint.trim()} onClick={() => save(true)}>
                {busy ? 'Testing…' : 'Save & connect'}
              </WBtn>
              <WBtn variant="default" size="sm" disabled={busy} onClick={() => { setEditing(false); setSaveErr(''); }}>Cancel</WBtn>
            </div>
          </div>
        )}
      </div>
    </WCard>
  );
}

function OverviewView({ ctx }) {
  const { data, go, refresh, toast } = ctx;
  const ov = data.overview;
  const loaded = data.load.overview === 'ok' && ov;
  // The server host stays in the page header; it's the real SPA origin
  // (window.location.hostname), not a seeded label, and isn't duplicated by
  // the overview endpoint.
  const host = window.SC_HELPERS.serverHost();

  const idRow = (label, value, mono) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, padding: '9px 0', borderBottom: `1px solid ${WC.surface2}` }}>
      <span style={{ fontSize: 12.5, color: WC.muted, whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 500, color: WC.fg, fontFamily: mono ? 'Geist Mono, monospace' : 'inherit', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value || '—'}</span>
    </div>
  );

  const counts = loaded ? ov.counts : { workspaces: 0, people: 0, trustedDevices: 0, pendingApprovals: 0 };
  const pending = counts.pendingApprovals;

  // Human byte size (binary units — what `df`/`free -h` show).
  const fmtBytes = (n) => {
    if (!n && n !== 0) return '—';
    const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let v = n, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    const s = (v >= 100 || i === 0) ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
    return `${s} ${u[i]}`;
  };
  // One labelled usage bar (free shown alongside used, so "free X" is explicit).
  const ResourceBar = ({ icon, label, pct, detail }) => {
    const p = Math.max(0, Math.min(100, pct || 0));
    const tone = p >= 90 ? WC.red : p >= 75 ? WC.amber : WC.primary;
    return (
      <div style={{ padding: '10px 0', borderBottom: `1px solid ${WC.surface2}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
          <WIcon name={icon} size={14} color={WC.muted} />
          <span style={{ fontSize: 12.5, color: WC.fg, fontWeight: 500 }}>{label}</span>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: WC.muted }}>{detail}</span>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: tone, minWidth: 38, textAlign: 'right' }}>{p.toFixed(0)}%</span>
        </div>
        <div style={{ height: 6, borderRadius: 4, background: WC.surface2, overflow: 'hidden' }}>
          <div style={{ width: `${p}%`, height: '100%', background: tone, borderRadius: 4, transition: 'width .3s' }} />
        </div>
      </div>
    );
  };
  const sys = loaded ? ov.system : null;

  return (
    <div>
      <WPageHeader title="Server overview"
        subtitle={`${host} — manage workspaces, people, and the devices this server trusts.`} />

      {/* Loading / error banner for the overview fetch (retryable). */}
      {data.load.overview !== 'ok' && (
        <WLiveState status={data.load.overview} error={data.error.overview}
          label="Loading server overview…" onRetry={() => refresh('overview')} />
      )}

      {loaded && (<>
      {/* Stat tiles */}
      <div style={{ display: 'flex', gap: 14, marginBottom: 20 }}>
        <WStat label="Workspaces" value={counts.workspaces} icon="layout-grid" onClick={() => go('workspaces')} />
        <WStat label="People" value={counts.people} icon="users" onClick={() => go('users')} />
        <WStat label="Devices" value={counts.trustedDevices} icon="laptop" tone="success" onClick={() => go('devices')} />
        <WStat label="Pending" value={pending} icon="shield-alert" tone={pending ? 'warning' : 'neutral'}
          sub={pending ? 'Needs your review' : 'All clear'} onClick={() => go('users')} />
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
              <WBtn variant="primary" size="sm" leftIcon="arrow-right" onClick={() => go('users')}>Review approvals</WBtn>
            </div>
          )}

          <WCard pad={0}>
            <div style={{ padding: '16px 20px 12px', display: 'flex', alignItems: 'center', gap: 11, borderBottom: `1px solid ${WC.border}` }}>
              <div style={{ width: 36, height: 36, borderRadius: 9, background: WC.fg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <WIcon name="server" size={18} color="#fff" />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: WC.fg, whiteSpace: 'nowrap' }}>{host}</div>
                <div style={{ fontSize: 12, color: WC.muted, fontFamily: 'Geist Mono, monospace', whiteSpace: 'nowrap' }}>Bailey server</div>
              </div>
              {ov.identity.online && (
                <span style={{ marginLeft: 'auto' }}><WPill tone="success" size="xs">● Online</WPill></span>
              )}
            </div>
            <div style={{ padding: '4px 20px 14px' }}>
              <EditableRegionRow region={ov.identity.region} toast={toast} refresh={refresh} />
              {idRow('Version', ov.identity.version, true)}
              {idRow('Claimed by', ov.identity.claimedBy, true)}
              {idRow('Claimed', ov.identity.claimedAt)}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0' }}>
                <span style={{ fontSize: 12.5, color: WC.muted }}>Uptime</span>
                <span style={{ fontSize: 13, fontWeight: 500, color: WC.fg }}>{ov.identity.uptime || '—'}</span>
              </div>
            </div>
          </WCard>

          {/* System resources — live host memory / disk / CPU. */}
          <WCard pad={0}>
            <div style={{ padding: '14px 20px', borderBottom: `1px solid ${WC.border}`, fontSize: 13, fontWeight: 600, color: WC.fg }}>
              System resources
            </div>
            <div style={{ padding: '4px 20px 14px' }}>
              {ov.systemError ? (
                <div style={{ fontSize: 12.5, color: WC.red, padding: '10px 0' }}>
                  Couldn't read host stats: {ov.systemError}
                </div>
              ) : sys ? (
                <>
                  <ResourceBar icon="memory-stick" label="Memory" pct={sys.mem_used_pct}
                    detail={`${fmtBytes(sys.mem_free_bytes)} free of ${fmtBytes(sys.mem_total_bytes)}`} />
                  <ResourceBar icon="hard-drive" label="Disk" pct={sys.disk_used_pct}
                    detail={`${fmtBytes(sys.disk_free_bytes)} free of ${fmtBytes(sys.disk_total_bytes)}`} />
                  <div style={{ padding: '10px 0 0' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
                      <WIcon name="cpu" size={14} color={WC.muted} />
                      <span style={{ fontSize: 12.5, color: WC.fg, fontWeight: 500 }}>CPU</span>
                      <span style={{ marginLeft: 'auto', fontSize: 12, color: WC.muted }}>
                        {sys.cpu_count} core{sys.cpu_count === 1 ? '' : 's'} · load {sys.load1}
                      </span>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: (sys.cpu_used_pct >= 90 ? WC.red : sys.cpu_used_pct >= 75 ? WC.amber : WC.primary), minWidth: 38, textAlign: 'right' }}>
                        {Math.round(sys.cpu_used_pct)}%
                      </span>
                    </div>
                    <div style={{ height: 6, borderRadius: 4, background: WC.surface2, overflow: 'hidden' }}>
                      <div style={{ width: `${Math.max(0, Math.min(100, sys.cpu_used_pct))}%`, height: '100%', background: (sys.cpu_used_pct >= 90 ? WC.red : sys.cpu_used_pct >= 75 ? WC.amber : WC.primary), borderRadius: 4, transition: 'width .3s' }} />
                    </div>
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12.5, color: WC.muted, padding: '10px 0' }}>No stats available.</div>
              )}
            </div>
          </WCard>

          {/* SIEM / OpenTelemetry audit-log forwarding. */}
          <SiemCard toast={toast} />
        </div>

        {/* Right: activity feed */}
        <WCard pad={0}>
          <div style={{ padding: '14px 20px', borderBottom: `1px solid ${WC.border}`, fontSize: 13, fontWeight: 600, color: WC.fg }}>
            Recent security activity
          </div>
          <div style={{ padding: '6px 10px 10px' }}>
            {ov.activity.length === 0 ? (
              <WEmpty icon="activity" title="No activity yet"
                text="Device approvals, workspace changes, and other events will appear here." />
            ) : ov.activity.map((a, i) => {
              const tones = { success: '#16a34a', primary: WC.primary, danger: WC.red, warning: WC.amber, neutral: WC.muted };
              return (
                <div key={i} style={{ display: 'flex', gap: 11, padding: '10px', borderRadius: 8, alignItems: 'flex-start' }}>
                  <span style={{ width: 28, height: 28, borderRadius: 8, background: WC.surface2, flex: '0 0 auto',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
                    <WIcon name={a.icon} size={14} color={tones[a.tone]} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: WC.fg, lineHeight: '18px' }}>
                      {a.who && <span style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}>{a.who}</span>} {a.text}
                    </div>
                    <div style={{ fontSize: 11.5, color: WC.mutedFg, marginTop: 2 }}>{a.when}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </WCard>
      </div>
      </>)}
    </div>
  );
}

// ─── WORKSPACES — workspace cards with launch + live apps + management ──────
function WorkspacesView({ ctx }) {
  const { data, setData, toast, currentUser, openUrl, go, refresh, navigate, routeParam } = ctx;
  const [query, setQuery] = useWS('');
  const [createOpen, setCreateOpen] = useWS(false);
  const [emptyOpen, setEmptyOpen] = useWS(false);
  const [emptyBusy, setEmptyBusy] = useWS(false);
  // The id currently being restored. (Deleting a workspace lives in the manage
  // drawer's danger zone — see ManageWorkspaceDrawer.)
  const [restoreBusy, setRestoreBusy] = useWS('');
  const [updateBusy, setUpdateBusy] = useWS('');
  const [updateProg, setUpdateProg] = useWS(null); // { fraction, label } for the workspace being updated

  // The managed workspace lives in the URL (/workspaces/:name) so the drawer
  // survives refresh and is shareable.
  const manageWs = data.workspaces.find(w => w.id === routeParam);

  // Accessible apps: live frontends the caller can reach (GET /bailey/api/
  // endpoints, kind=frontend), so even a User with no workspaces sees links to
  // the apps shared with them. Fetched here; the list API doesn't carry apps.
  const [appsRaw, setAppsRaw] = useWS(null);
  React.useEffect(() => {
    let alive = true;
    WApi.endpoints()
      .then(r => { if (alive) setAppsRaw((r.endpoints || []).filter(e => e.kind === 'frontend')); })
      .catch(() => { if (alive) setAppsRaw([]); });
    return () => { alive = false; };
  }, []);
  const accessibleApps = (appsRaw || []).map(e => ({
    id: e.hostname, name: e.display_name || e.hostname, host: e.hostname,
    url: 'https://' + e.hostname, stage: e.stage,
    workspace: e.workspace || '', bp: e.business_process || '', parent: e.parent_endpoint || '',
  }));
  // Group the accessible apps by the workspace they belong to (#280) so a
  // person granted many endpoints sees them organised, not as one flat wall.
  // Group key: workspace name when the backend resolved one, else the parent
  // dashboard host, else '' (truly ungrouped — sorted last).
  const appGroups = (() => {
    const map = new Map();
    for (const a of accessibleApps) {
      const key = a.workspace || a.parent;
      if (!map.has(key)) map.set(key, { key, workspace: a.workspace, parent: a.parent, apps: [] });
      map.get(key).apps.push(a);
    }
    const groups = [...map.values()];
    groups.forEach(g => g.apps.sort((x, y) => x.name.localeCompare(y.name)));
    groups.sort((x, y) => (x.key === '' ? 1 : y.key === '' ? -1 : x.key.localeCompare(y.key)));
    return groups;
  })();
  // Within a group, sub-cluster by business process (named BPs first,
  // alphabetically; apps without one trail in an unlabelled cluster).
  const bpClusters = (apps) => {
    const map = new Map();
    for (const a of apps) {
      if (!map.has(a.bp)) map.set(a.bp, { bp: a.bp, apps: [] });
      map.get(a.bp).apps.push(a);
    }
    return [...map.values()].sort((x, y) => (x.bp === '' ? 1 : y.bp === '' ? -1 : x.bp.localeCompare(y.bp)));
  };
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

  // Live: POST /bailey/api/workspaces/{name}/restore (owner-only; clears the
  // trash marker and brings the containers back up before returning).
  const doRestore = async (w) => {
    setRestoreBusy(w.id);
    try {
      await WApi.restoreWorkspace(w.name);
      toast(`${w.name} restored`, 'success');
      await refresh('workspaces');
    } catch (e) {
      toast(`Couldn't restore ${w.name}: ${e.message}`, 'danger');
    } finally { setRestoreBusy(''); }
  };

  // Owner-initiated workspace update: pulls the latest images and recreates the
  // workspace's containers (streams progress). Rollback is intentionally CLI-only.
  const doUpdate = async (w) => {
    setUpdateBusy(w.id);
    setUpdateProg({ fraction: 0, label: 'Starting…' });
    try {
      await WApi.upgradeWorkspace(w.name, (ev) => {
        if (!ev) return;
        if (typeof ev.fraction === 'number') setUpdateProg({ fraction: ev.fraction, label: ev.message || '' });
        else if (ev.message) setUpdateProg(p => ({ fraction: (p && p.fraction) || 0, label: ev.message }));
      });
      toast(`${w.name} updated`, 'success');
      await refresh('workspaces');
      await refresh('updates'); // clear the Updates nav badge for this workspace
    } catch (e) {
      toast(`Couldn't update ${w.name}: ${e.message}`, 'danger');
    } finally { setUpdateBusy(''); setUpdateProg(null); }
  };

  const matchesQuery = w =>
    w.name.toLowerCase().includes(query.toLowerCase()) ||
    (w.apps || []).some(a => a.name.toLowerCase().includes(query.toLowerCase()) || a.url.toLowerCase().includes(query.toLowerCase()));
  // The backend already filters /bailey/api/workspaces to the workspaces
  // the caller can access, so show all of them. (Seed workspaces have a
  // members[] for the prototype; live ones don't — don't filter on it.)
  const list = data.workspaces
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

      {data.workspaces.length > 3 && (
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
            // "Owner" reflects TRUE ownership of the membership surface
            // (the dashboard endpoint), not the parent-delegated is_owner —
            // a workspace member must not be labelled owner.
            const isOwner = w.dashboardRole === 'owner';
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
                        : <WPill tone="neutral" size="xs">Member</WPill>}
                      {archived && <WPill tone="neutral" size="xs">archived</WPill>}
                    </div>
                    {w.versions && (w.versions.gitops || w.versions.dashboard) && (
                      <div style={{ fontSize: 11, color: WC.muted, fontFamily: 'monospace', marginTop: 3 }}>
                        {w.versions.gitops ? `gitops ${w.versions.gitops}` : ''}
                        {w.versions.gitops && w.versions.dashboard ? '  ·  ' : ''}
                        {w.versions.dashboard ? `dashboard ${w.versions.dashboard}` : ''}
                      </div>
                    )}
                  </div>
                  {w.members && w.members.length > 0 && (
                    <WAvatarStack users={w.members.map(m => ({ id: m, name: m }))} size={26} />
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {!archived && isOwner && w.updateAvailable && (
                      updateBusy === w.id ? (
                        <WUpdateBar prog={updateProg} />
                      ) : (
                        <WBtn variant="primary" size="sm" leftIcon="arrow-up-circle" onClick={() => doUpdate(w)}>
                          Update available
                        </WBtn>
                      )
                    )}
                    {!archived && (
                      <WBtn variant="primary" size="sm" leftIcon="external-link" onClick={() => openUrl(w.dashboard || w.gitopsUrl, `${w.name} dashboard`)}>Open</WBtn>
                    )}
                    {/* Trashed workspaces: owner can bring it back (existing restore flow). */}
                    {archived && isOwner && (
                      <WBtn variant="default" size="sm" leftIcon="rotate-ccw" disabled={restoreBusy === w.id} onClick={() => doRestore(w)}>
                        {restoreBusy === w.id ? 'Restoring…' : 'Restore'}
                      </WBtn>
                    )}
                    <button onClick={() => navigate('workspaces', w.id)} title="Manage workspace" style={{ width: 32, height: 32, border: `1px solid ${WC.border}`, background: '#fff', borderRadius: 8, cursor: 'pointer', color: WC.muted, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      onMouseEnter={e => { e.currentTarget.style.background = WC.surface2; e.currentTarget.style.color = WC.fg; }}
                      onMouseLeave={e => { e.currentTarget.style.background = '#fff'; e.currentTarget.style.color = WC.muted; }}>
                      <WIcon name="settings-2" size={15} />
                    </button>
                    {/* No delete here on purpose: a destructive action must not
                        sit in the row's rightmost (default) slot. Deletion is
                        in the manage drawer's danger zone. */}
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

      {/* Apps you can access — live frontends you've been granted, even if you
          aren't a member of (or can't create) the owning workspace. Sourced
          from the accessible-endpoints API so a User-role person still has
          direct links to their apps here. Grouped by workspace (and business
          process within it) so many grants stay readable (#280); apps the
          backend couldn't place fall back to one flat grid. */}
      {accessibleApps.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: WC.fg, marginBottom: 4 }}>Apps you can access</div>
          <div style={{ fontSize: 12.5, color: WC.muted, marginBottom: 14 }}>Live apps shared with you across this server, grouped by the workspace they run in — open them directly.</div>
          {appGroups.length === 1 && appGroups[0].key === '' ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
              {appGroups[0].apps.map(a => <AccessibleAppTile key={a.id} app={a} onOpen={() => openUrl(a.url, a.name)} />)}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {appGroups.map(g => (
                <WCard key={g.key || '(other)'} pad={0}>
                  <div style={{ padding: '12px 18px', borderBottom: `1px solid ${WC.surface2}`, display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ width: 28, height: 28, borderRadius: 8, flex: '0 0 auto', background: WC.surface2,
                      display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <WIcon name="layout-grid" size={14} color={WC.muted} />
                    </span>
                    <span style={{ fontSize: 13.5, fontWeight: 600, color: WC.fg,
                      fontFamily: g.workspace || !g.parent ? 'inherit' : 'Geist Mono, monospace',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {g.workspace || g.parent || 'Other apps'}
                    </span>
                    <span style={{ marginLeft: 'auto', fontSize: 11.5, color: WC.mutedFg }}>
                      {g.apps.length} app{g.apps.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div style={{ padding: '12px 18px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {bpClusters(g.apps).map(c => (
                      <div key={c.bp || '(none)'}>
                        {c.bp && (
                          <div style={{ fontSize: 10.5, fontWeight: 600, color: WC.mutedFg, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>{c.bp}</div>
                        )}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                          {c.apps.map(a => <AccessibleAppTile key={a.id} app={a} onOpen={() => openUrl(a.url, a.name)} />)}
                        </div>
                      </div>
                    ))}
                  </div>
                </WCard>
              ))}
            </div>
          )}
        </div>
      )}

      <CreateWorkspaceModal open={createOpen} onClose={() => setCreateOpen(false)} data={data} setData={setData} toast={toast} currentUser={currentUser} refresh={refresh} />
      <ManageWorkspaceDrawer ws={manageWs} onClose={() => navigate('workspaces')} toast={toast} refresh={refresh} />

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
          <div data-testid="ws-create-log" style={{ maxHeight: 160, overflow: 'auto', padding: 10, borderRadius: 9, background: WC.surface,
            border: `1px solid ${WC.border}`, fontFamily: 'Geist Mono, monospace', fontSize: 11.5, color: WC.muted, whiteSpace: 'pre-wrap' }}>
            {log.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
      </div>
    </WModal>
  );
}

// ─── MANAGE WORKSPACE DRAWER (members + ownership transfer) ─────────────────
// Every workspace shown here comes from the live /bailey/api/workspaces
// endpoint; the member roster is the real ACL share state of the workspace's
// dashboard endpoint, and ownership transfer is the live workspace API.
function hostFromUrl(u) {
  try { return new URL(u).host; } catch (e) { return ''; }
}

// PersonPickList — click-to-pick rows over the server's people roster.
// Shared by the add-member picker and the transfer-ownership picker.
function PersonPickList({ candidates, disabled, titleFor, onPick }) {
  if (!candidates.length) return null;
  return (
    <div style={{ border: `1px solid ${WC.border}`, borderRadius: 10, maxHeight: 192, overflowY: 'auto' }}>
      {candidates.map(p => (
        <button key={p.email} onClick={() => onPick(p.email)} disabled={disabled} title={titleFor(p.email)} style={{
          display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', textAlign: 'left',
          border: 0, borderBottom: `1px solid ${WC.surface2}`, background: 'transparent',
          cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit', opacity: disabled ? 0.6 : 1 }}
          onMouseEnter={e => { e.currentTarget.style.background = WC.surface; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
          <WAvatar user={{ name: p.name || p.email }} size={28} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 500, color: WC.fg, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {p.name && p.name !== p.email ? p.name : p.email}
            </div>
            {p.name && p.name !== p.email && (
              <div style={{ fontSize: 11, color: WC.muted, fontFamily: 'Geist Mono, monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.email}</div>
            )}
          </div>
          {p.invited && <WPill tone="info" size="xs">Invited</WPill>}
          <WIcon name="user-plus" size={14} color={WC.mutedFg} />
        </button>
      ))}
    </div>
  );
}

// Ownership + Members, per the wireframe. Members are the REAL ACL grants on
// the workspace's dashboard endpoint (GET/POST /2fa-gate/api/share/<host>):
// owner_email + access grants. Owner-only — a non-owner can't read the share
// state, so they get an honest read-only note. Ownership transfer is live:
// POST /bailey/api/workspaces/{name}/transfer-ownership — strictly the
// recorded owner's call (the backend rejects even admins), the recipient
// must already be a person on this server, and the old owner stays a member.
function ManageWorkspaceDrawer({ ws, onClose, toast, refresh }) {
  const [share, setShare] = useWS(null);   // {owner_email, grants} | null while loading
  const [err, setErr] = useWS('');
  const [addQuery, setAddQuery] = useWS(''); // search text over the add-member picker
  const [busy, setBusy] = useWS('');        // '' | 'add' | <principal being removed>
  // People directory ({email,name,invited}) feeding both pickers. The
  // endpoint is open to any endpoint owner — every owner of this drawer
  // gets a list. Members are added/transfers started ONLY by picking from
  // it (the search inputs are filters, not free-text entry), so dirErr is
  // a real failure state the sections must surface.
  const [directory, setDirectory] = useWS(null); // null = loading
  const [dirErr, setDirErr] = useWS(false);
  // Transfer-ownership flow: picking a recipient goes straight to the
  // confirm modal (the transfer hands the workspace away — a mis-click
  // must not). transferTarget is the picked recipient; '' = modal closed.
  const [transferOpen, setTransferOpen] = useWS(false);
  const [transferQuery, setTransferQuery] = useWS('');
  const [transferTarget, setTransferTarget] = useWS('');
  const [transferBusy, setTransferBusy] = useWS(false);
  // Delete flow: the danger zone at the bottom of this drawer is the only place
  // a workspace can be deleted (it used to be a trash icon in the list row,
  // where it was the rightmost — i.e. default — control). trashOpen is the
  // confirm modal.
  const [trashOpen, setTrashOpen] = useWS(false);
  const [trashBusy, setTrashBusy] = useWS(false);
  const [addRole, setAddRole] = useWS('access'); // role a newly-picked person gets

  const dashHost = ws ? hostFromUrl(ws.dashboard) : '';
  // Managing members (add/remove) is only allowed for the TRUE owner of the
  // dashboard endpoint — exactly what the owner-only share API enforces. We
  // deliberately don't use ws.isOwner here: it's parent-delegated, so a mere
  // member of the dashboard reads as "owner" of the sub-endpoints and would
  // otherwise be shown management controls the backend then 403s.
  const canManage = ws ? ws.dashboardRole === 'owner' : false;
  const ownerEmail = ws ? ws.ownerEmail : '';

  React.useEffect(() => {
    // Fresh drawer, fresh transfer flow — don't leak a half-picked recipient
    // from the previously opened workspace.
    setTransferOpen(false); setTransferQuery(''); setTransferTarget('');
    // Same for a half-open delete confirm.
    setTrashOpen(false); setTrashBusy(false);
    // Only owners can read the live share state (the API is owner-only).
    // Non-owners render from the workspace DTO (owner_email + members), which
    // the backend computes for every member — no privileged call needed.
    if (!ws || !canManage) { setShare(null); setErr(''); setDirectory(null); setDirErr(false); return undefined; }
    let alive = true;
    setShare(null); setErr(''); setAddQuery(''); setDirectory(null); setDirErr(false);
    WApi.workspaceMembers(dashHost)
      .then(r => { if (alive) setShare(r); })
      .catch(e => { if (alive) { setErr(e.message || 'Could not load members.'); setShare({ owner_email: '', grants: [] }); } });
    WApi.peopleDirectory()
      .then(r => { if (alive) setDirectory(r && r.people ? r.people : []); })
      .catch(() => { if (alive) setDirErr(true); });
    return () => { alive = false; };
  }, [ws && ws.id]);

  if (!ws) return null;
  // Everyone on the workspace, with their ROLE. Owner is a role, not an
  // exclusive property: the recorded owner_email PLUS anyone granted the
  // 'owner' role are all owners; 'access' grants are members. Owners first
  // (the recorded primary owner first), then members.
  const primaryOwner = ((canManage ? (share && share.owner_email) : ownerEmail) || '').trim();
  const people = (() => {
    const rows = [];
    const seen = new Set();
    const push = (pt, pv, role, isPrimary) => {
      pv = (pv || '').trim();
      const key = `${pt}:${pv}`.toLowerCase();
      if (!pv || seen.has(key)) return;
      seen.add(key);
      rows.push({ principal_type: pt, principal_value: pv, role, isPrimary: !!isPrimary });
    };
    if (primaryOwner) push('email', primaryOwner, 'owner', true);
    if (canManage) {
      (share ? share.grants || [] : []).forEach(g =>
        push(g.principal_type, g.principal_value,
          g.role === 'owner' ? 'owner' : (g.principal_type === 'group' ? 'group' : 'access')));
    } else {
      (ws.members || []).forEach(m => push('email', m, 'access'));
    }
    const rank = r => (r.isPrimary ? 0 : r.role === 'owner' ? 1 : 2);
    return rows.sort((a, b) => rank(a) - rank(b) ||
      (a.principal_value || '').localeCompare(b.principal_value || ''));
  })();
  const ownerCount = people.filter(p => p.role === 'owner').length;
  const SECTION = { fontSize: 11, fontWeight: 600, color: WC.muted, textTransform: 'uppercase', letterSpacing: 0.4 };
  // An already-trashed workspace is restored (or permanently removed via Empty
  // trash) from the list — there's nothing to delete here.
  const archived = ws.status === 'archived';

  // Adds a directory pick to the workspace.
  const addMember = async (email) => {
    if (!email) return;
    setBusy('add');
    const label = addRole === 'owner' ? 'owner' : 'user';
    try {
      setShare(await WApi.addWorkspaceMember(dashHost, email, addRole));
      toast(`${email} added to ${ws.name} as ${label}`, 'success');
    } catch (e) { toast(`Couldn't add ${label}: ${e.message}`, 'danger'); }
    finally { setBusy(''); }
  };

  // Candidate picker: everyone already invited into this Bailey server —
  // the people directory fetched above (invited-but-never-seen users
  // included) — minus the owner and anyone already granted, narrowed by
  // the search text.
  const q = addQuery.trim().toLowerCase();
  const onWorkspace = new Set(people.map(p => (p.principal_value || '').toLowerCase()));
  const candidates = !canManage ? [] : (directory || []).filter(p =>
    p.email &&
    !onWorkspace.has(p.email.toLowerCase()) &&
    (!q || p.email.toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q)));

  // Transfer recipients: the same directory minus the current owner.
  // Existing members ARE eligible — promoting a member is the common case.
  const tq = transferQuery.trim().toLowerCase();
  const transferCandidates = !canManage ? [] : (directory || []).filter(p =>
    p.email &&
    p.email.toLowerCase() !== (ownerEmail || '').toLowerCase() &&
    (!tq || p.email.toLowerCase().includes(tq) || (p.name || '').toLowerCase().includes(tq)));

  // One muted status line under a picker's search bar.
  const pickNote = (text, red) => (
    <div style={{ fontSize: 12, color: red ? WC.red : WC.muted, padding: '6px 2px' }}>{text}</div>
  );
  // Loading/error/empty/list for a picker over the directory.
  const pickerBody = (list, emptyText, titleFor, onPick, disabled) => {
    if (dirErr) return pickNote("Couldn't load the server's people directory — close and reopen this workspace to retry.", true);
    if (!directory) return pickNote('Loading people…');
    if (list.length === 0) return pickNote(emptyText);
    return <PersonPickList candidates={list} disabled={disabled} titleFor={titleFor} onPick={onPick} />;
  };

  // Hands the workspace to the picked recipient: the backend rewrites the
  // recorded owner (children included) and keeps the caller on as a member.
  // On success the refreshed workspace DTO re-renders this drawer in the
  // member view.
  const doTransfer = async () => {
    const email = transferTarget.trim();
    if (!email) return;
    setTransferBusy(true);
    try {
      await WApi.transferWorkspaceOwnership(ws.name, email);
      toast(`${ws.name} transferred to ${email} — you're now a member`, 'success');
      setTransferTarget(''); setTransferOpen(false); setTransferQuery('');
      if (refresh) await refresh('workspaces');
    } catch (e) {
      // Keep the panel open so the owner can pick someone else.
      setTransferTarget('');
      toast(`Couldn't transfer ownership: ${e.message}`, 'danger');
    } finally { setTransferBusy(false); }
  };
  // Live: POST /bailey/api/workspaces/{name}/trash (owner-only; 202 — the
  // daemon marks it trashed synchronously and tears the containers down in the
  // background, so the next refresh shows it in the archived/trash state).
  // Permanent removal is the existing "Empty trash" flow on the list page.
  const doTrash = async () => {
    setTrashBusy(true);
    try {
      await WApi.trashWorkspace(ws.name);
      toast(`${ws.name} moved to trash`, 'success');
      setTrashOpen(false);
      if (refresh) await refresh('workspaces');
      // The workspace is gone from the active list — don't leave its drawer up.
      onClose();
    } catch (e) {
      toast(`Couldn't delete ${ws.name}: ${e.message}`, 'danger');
    } finally { setTrashBusy(false); }
  };

  const removeMember = async (g) => {
    setBusy(g.principal_value);
    try {
      setShare(await WApi.removeWorkspaceMember(dashHost, g.principal_type, g.principal_value, g.role));
      toast(`${g.principal_value} removed from ${ws.name}`, 'info');
    } catch (e) { toast(`Couldn't remove person: ${e.message}`, 'danger'); }
    finally { setBusy(''); }
  };
  // Promote a member to owner, or demote a co-owner to member. Grant-based
  // people only — the recorded primary owner is changed via transfer.
  const changeRole = async (p, newRole) => {
    if (!newRole || newRole === p.role) return;
    if (p.role === 'owner' && newRole !== 'owner' && ownerCount <= 1) {
      toast('A workspace needs at least one owner.', 'danger');
      return;
    }
    setBusy(p.principal_value);
    try {
      setShare(await WApi.setWorkspaceMemberRole(dashHost, p.principal_type, p.principal_value, newRole, p.role));
      toast(`${p.principal_value} is now ${newRole === 'owner' ? 'an owner' : 'a user'} of ${ws.name}`, 'success');
    } catch (e) { toast(`Couldn't change role: ${e.message}`, 'danger'); }
    finally { setBusy(''); }
  };

  return (
    <WDrawer open={!!ws} onClose={onClose} icon="layout-grid" title={ws.name}
      subtitle={canManage ? 'You own this workspace' : "You're a member of this workspace"}
      footer={<WBtn variant="primary" onClick={onClose}>Done</WBtn>}>
      {/* People & roles. Owner is a ROLE, not an exclusive property — a
          workspace can have several owners. Owners are listed first. */}
      <div style={{ ...SECTION, margin: '2px 0 10px', display: 'flex', justifyContent: 'space-between' }}>
        <span>People with access</span><span>{(canManage && !share) ? '' : people.length}</span>
      </div>
      {err && <div style={{ fontSize: 12.5, color: WC.red, marginBottom: 8 }}>{err}</div>}
      {canManage && !share && !err && <div style={{ fontSize: 12.5, color: WC.muted, padding: '6px 2px' }}>Loading people…</div>}
      {(!canManage || share) && people.length === 0 && !err && (
        <div style={{ fontSize: 12.5, color: WC.muted, padding: '6px 2px' }}>No one has access yet.</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {people.map(p => {
          const isOwnerRole = p.role === 'owner';
          const isGroup = p.principal_type === 'group';
          const roleLabel = isOwnerRole ? 'Owner' : isGroup ? 'Group' : 'User';
          // The recorded owner (first row) is fixed — a static Owner badge, no
          // controls — exactly like the share dialog's original-owner row.
          const controllable = canManage && !p.isPrimary && !isGroup;
          return (
            <div key={`${p.principal_type}:${p.principal_value}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 6px', borderRadius: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <WUserChip user={{ email: isGroup ? undefined : p.principal_value, name: isGroup ? p.principal_value : undefined }}
                  size={30}
                  nameSuffix={controllable ? null : (
                    <WPill tone={isOwnerRole ? 'primary' : 'neutral'} size="xs">{roleLabel}</WPill>
                  )} />
              </div>
              {controllable && (
                <>
                  {/* Role dropdown (User / Owner) — same control + wording as the share dialog. */}
                  <div style={{ width: 112, ...(busy === p.principal_value ? { opacity: 0.5, pointerEvents: 'none' } : {}) }}>
                    <WSelect value={isOwnerRole ? 'owner' : 'access'}
                      onChange={(r) => changeRole(p, r)}
                      options={[{ value: 'access', label: 'User' }, { value: 'owner', label: 'Owner' }]} />
                  </div>
                  <WBtn variant="ghost" size="xs" disabled={busy === p.principal_value}
                    onClick={() => removeMember(p)}>Remove</WBtn>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Add a person at a chosen role — owner only. */}
      {canManage ? (
        <>
          <div style={{ ...SECTION, margin: '20px 0 10px' }}>Add a person</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 12.5, color: WC.muted }}>as</span>
            <div style={{ width: 130 }}>
              <WSelect value={addRole} onChange={setAddRole}
                options={[{ value: 'access', label: 'User' }, { value: 'owner', label: 'Owner' }]} />
            </div>
            <div style={{ flex: 1 }}>
              <WTextInput value={addQuery} onChange={setAddQuery} placeholder="Search people…" />
            </div>
          </div>
          {pickerBody(candidates,
            q ? 'No one matches.' : 'Everyone on this server is already in this workspace.',
            (e) => `Add ${e} as ${addRole === 'owner' ? 'owner' : 'user'}`, addMember, busy === 'add')}
          <div style={{ fontSize: 11.5, color: WC.mutedFg, marginTop: 8 }}>
            {addRole === 'owner'
              ? 'Owners can manage people and update or delete the workspace.'
              : "Users can open the workspace's apps. They'll still trust a device of their own to get in."}
          </div>

          {/* Reassign the recorded PRIMARY owner — a niche action; to add more
              owners, grant the Owner role above. Only the primary owner may do
              this (the backend enforces it). */}
          <div style={{ marginTop: 18 }}>
            {!transferOpen ? (
              <button onClick={() => setTransferOpen(true)} style={{ background: 'none', border: 0, padding: 0, color: WC.mutedFg, fontSize: 11.5, cursor: 'pointer', textDecoration: 'underline' }}>
                Change the primary owner
              </button>
            ) : (
              <div>
                <div style={{ fontSize: 11.5, color: WC.mutedFg, marginBottom: 6 }}>
                  New primary owner — pick someone already on this server:
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ flex: 1 }}>
                    <WTextInput value={transferQuery} onChange={setTransferQuery} placeholder="Search people…" />
                  </div>
                  <WBtn variant="default" size="sm" disabled={transferBusy} onClick={() => { setTransferOpen(false); setTransferQuery(''); }}>Cancel</WBtn>
                </div>
                {pickerBody(transferCandidates,
                  tq ? 'No one matches.' : 'No one else is on this server yet — invite someone first.',
                  (e) => `Make ${e} the primary owner`, setTransferTarget, transferBusy)}
              </div>
            )}
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', gap: 9, padding: 13, borderRadius: 10, background: WC.surface, border: `1px solid ${WC.border}`, marginTop: 20 }}>
          <WIcon name="info" size={15} color={WC.muted} style={{ marginTop: 1, flex: '0 0 auto' }} />
          <span style={{ fontSize: 12.5, color: WC.muted, lineHeight: '18px' }}>
            You're a member of this workspace. Only an owner can add or remove people.
          </span>
        </div>
      )}

      {/* Confirm changing the recorded primary owner. */}
      <WModal open={!!transferTarget} onClose={transferBusy ? () => {} : () => setTransferTarget('')} icon="arrow-left-right"
        title={`Make ${transferTarget} the primary owner of “${ws.name}”?`}
        subtitle="They become the recorded owner. You stay in the workspace as a member; any other owners keep their role."
        footer={<>
          <WBtn variant="default" disabled={transferBusy} onClick={() => setTransferTarget('')}>Cancel</WBtn>
          <WBtn variant="primary" disabled={transferBusy} onClick={doTransfer}>
            {transferBusy ? 'Updating…' : 'Make primary owner'}
          </WBtn>
        </>} />

      {/* Danger zone — the workspace's only delete affordance. Gated exactly
          like the icon it replaced: true dashboard owner, active workspace. */}
      {canManage && !archived && (
        <>
          <div style={{ borderTop: `1px solid ${WC.border}`, margin: '26px 0 0' }} />
          <div style={{ ...SECTION, color: WC.red, margin: '18px 0 10px' }}>Danger zone</div>
          <div style={{ border: `1px solid ${WC.red}55`, background: WC.redSoft, borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 12.5, color: WC.fg, lineHeight: '18px', marginBottom: 11 }}>
              Deleting <strong>{ws.name}</strong> moves it to trash and stops its containers. You can
              restore it from the workspaces list, or remove it permanently with Empty trash.
            </div>
            <WBtn variant="danger" size="sm" leftIcon="trash-2" disabled={trashBusy}
              onClick={() => setTrashOpen(true)}>Delete this workspace</WBtn>
          </div>
        </>
      )}

      {/* Delete confirm — unchanged from the icon-button flow it replaced. */}
      <WModal open={trashOpen} onClose={trashBusy ? () => {} : () => setTrashOpen(false)} icon="trash-2"
        title={`Delete “${ws.name}”?`}
        subtitle="The workspace moves to trash and its containers stop. You can restore it, or remove it permanently with Empty trash."
        footer={<>
          <WBtn variant="default" disabled={trashBusy} onClick={() => setTrashOpen(false)}>Cancel</WBtn>
          <WBtn variant="primary" disabled={trashBusy} style={{ background: WC.red, borderColor: WC.red }} onClick={doTrash}>
            {trashBusy ? 'Deleting…' : 'Delete workspace'}
          </WBtn>
        </>} />
    </WDrawer>
  );
}

window.SC_WORKSPACES = { OverviewView, WorkspacesView, ROLE_TONE };