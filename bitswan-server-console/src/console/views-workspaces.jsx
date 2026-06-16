import React from 'react';
// views-workspaces.jsx — Overview + Workspaces (list, create, ownership/members)

const { C: WC, Icon: WIcon, Btn: WBtn, Pill: WPill } = window.WD_SHELL;
const {
  Avatar: WAvatar, Card: WCard, PageHeader: WPageHeader, Field: WField, TextInput: WTextInput,
  Modal: WModal, Toggle: WToggle, EmptyState: WEmpty, Stat: WStat, Drawer: WDrawer,
  Select: WSelect, AvatarStack: WAvatarStack, LiveState: WLiveState,
} = window.SC_UI;
const { Api: WApi } = window.SC_API;
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
  }));
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
                  </div>
                  {w.members && w.members.length > 0 && (
                    <WAvatarStack users={w.members.map(m => ({ id: m, name: m }))} size={26} />
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {!archived && (
                      <WBtn variant="primary" size="sm" leftIcon="external-link" onClick={() => openUrl(w.dashboard || w.gitopsUrl, `${w.name} dashboard`)}>Open</WBtn>
                    )}
                    <button onClick={() => navigate('workspaces', w.id)} title="Manage workspace" style={{ width: 32, height: 32, border: `1px solid ${WC.border}`, background: '#fff', borderRadius: 8, cursor: 'pointer', color: WC.muted, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
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

      {/* Apps you can access — live frontends you've been granted, even if you
          aren't a member of (or can't create) the owning workspace. Sourced
          from the accessible-endpoints API so a User-role person still has
          direct links to their apps here. */}
      {accessibleApps.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: WC.fg, marginBottom: 4 }}>Apps you can access</div>
          <div style={{ fontSize: 12.5, color: WC.muted, marginBottom: 14 }}>Live apps shared with you across this server — open them directly.</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
            {accessibleApps.map(a => (
              <button key={a.id} onClick={() => openUrl(a.url, a.name)} style={{
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
                    <span style={{ fontSize: 13.5, fontWeight: 600, color: WC.fg, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</span>
                    {a.stage && a.stage !== 'production' && <WPill tone="outline" size="xs">{a.stage}</WPill>}
                  </div>
                  <div style={{ fontSize: 11.5, color: WC.muted, fontFamily: 'Geist Mono, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.host}</div>
                </div>
                <WIcon name="external-link" size={14} color={WC.mutedFg} />
              </button>
            ))}
          </div>
        </div>
      )}

      <CreateWorkspaceModal open={createOpen} onClose={() => setCreateOpen(false)} data={data} setData={setData} toast={toast} currentUser={currentUser} refresh={refresh} />
      <ManageWorkspaceDrawer ws={manageWs} onClose={() => navigate('workspaces')} toast={toast} />

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
          <div style={{ maxHeight: 160, overflow: 'auto', padding: 10, borderRadius: 9, background: WC.surface,
            border: `1px solid ${WC.border}`, fontFamily: 'Geist Mono, monospace', fontSize: 11.5, color: WC.muted, whiteSpace: 'pre-wrap' }}>
            {log.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
      </div>
    </WModal>
  );
}

// ─── MANAGE WORKSPACE DRAWER (open links + trash/restore/update) ────────────
// Every workspace shown here comes from the live /bailey/api/workspaces
// endpoint. Membership/ownership grants are NOT exposed by that endpoint —
// they're managed per-endpoint on the gate's /2fa-gate/share/<host> page — so
// this drawer never shows a member roster or transfer control (there is no
// backend for it; faking one would be mock data).
function hostFromUrl(u) {
  try { return new URL(u).host; } catch (e) { return ''; }
}

// Ownership + Members, per the wireframe. Members are the REAL ACL grants on
// the workspace's dashboard endpoint (GET/POST /2fa-gate/api/share/<host>):
// owner_email + access grants. Owner-only — a non-owner can't read the share
// state, so they get an honest read-only note. Transfer-ownership has no
// backend, so it's shown disabled rather than faked.
function ManageWorkspaceDrawer({ ws, onClose, toast }) {
  const [share, setShare] = useWS(null);   // {owner_email, grants} | null while loading
  const [err, setErr] = useWS('');
  const [addEmail, setAddEmail] = useWS('');
  const [busy, setBusy] = useWS('');        // '' | 'add' | <principal being removed>

  const dashHost = ws ? hostFromUrl(ws.dashboard) : '';
  // Managing members (add/remove) is only allowed for the TRUE owner of the
  // dashboard endpoint — exactly what the owner-only share API enforces. We
  // deliberately don't use ws.isOwner here: it's parent-delegated, so a mere
  // member of the dashboard reads as "owner" of the sub-endpoints and would
  // otherwise be shown management controls the backend then 403s.
  const canManage = ws ? ws.dashboardRole === 'owner' : false;
  const ownerEmail = ws ? ws.ownerEmail : '';

  React.useEffect(() => {
    // Only owners can read the live share state (the API is owner-only).
    // Non-owners render from the workspace DTO (owner_email + members), which
    // the backend computes for every member — no privileged call needed.
    if (!ws || !canManage) { setShare(null); setErr(''); return undefined; }
    let alive = true;
    setShare(null); setErr(''); setAddEmail('');
    WApi.workspaceMembers(dashHost)
      .then(r => { if (alive) setShare(r); })
      .catch(e => { if (alive) { setErr(e.message || 'Could not load members.'); setShare({ owner_email: '', grants: [] }); } });
    return () => { alive = false; };
  }, [ws && ws.id]);

  if (!ws) return null;
  // Members list: owners get the live, removable grant list; everyone else
  // gets the DTO's member roster minus the owner (read-only).
  const members = canManage
    ? (share ? (share.grants || []).filter(g => g.role === 'access') : [])
    : (ws.members || [])
        .filter(m => m && m.toLowerCase() !== (ownerEmail || '').toLowerCase())
        .map(m => ({ principal_type: 'email', principal_value: m, role: 'access' }));
  const SECTION = { fontSize: 11, fontWeight: 600, color: WC.muted, textTransform: 'uppercase', letterSpacing: 0.4 };

  const addMember = async () => {
    const email = addEmail.trim();
    if (!email) return;
    setBusy('add');
    try {
      setShare(await WApi.addWorkspaceMember(dashHost, email));
      setAddEmail('');
      toast(`${email} added to ${ws.name}`, 'success');
    } catch (e) { toast(`Couldn't add member: ${e.message}`, 'danger'); }
    finally { setBusy(''); }
  };
  const removeMember = async (g) => {
    setBusy(g.principal_value);
    try {
      setShare(await WApi.removeWorkspaceMember(dashHost, g.principal_type, g.principal_value, g.role));
      toast(`${g.principal_value} removed from ${ws.name}`, 'info');
    } catch (e) { toast(`Couldn't remove member: ${e.message}`, 'danger'); }
    finally { setBusy(''); }
  };

  return (
    <WDrawer open={!!ws} onClose={onClose} icon="layout-grid" title={ws.name}
      subtitle={canManage ? 'You own this workspace' : "You're a member of this workspace"}
      footer={<WBtn variant="primary" onClick={onClose}>Done</WBtn>}>
      {/* Ownership — shown to everyone; only the owner can act on it. */}
      <div style={{ ...SECTION, marginBottom: 10 }}>Ownership</div>
      <div style={{ border: `1px solid ${WC.border}`, borderRadius: 10, padding: 14, marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <WAvatar user={{ name: ownerEmail || ws.name }} size={36} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: WC.fg, display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'Geist Mono, monospace' }}>
              {ownerEmail || 'No owner recorded'} <WPill tone="primary" size="xs">Owner</WPill>
            </div>
          </div>
        </div>
        {canManage && (
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 9 }}>
            <span title="Transferring ownership isn't supported yet." style={{ display: 'inline-flex' }}>
              <WBtn variant="default" size="sm" leftIcon="arrow-left-right" disabled>Transfer ownership</WBtn>
            </span>
            <span style={{ fontSize: 11.5, color: WC.mutedFg }}>Not available yet.</span>
          </div>
        )}
      </div>

      {/* Members */}
      <div style={{ ...SECTION, margin: '20px 0 10px', display: 'flex', justifyContent: 'space-between' }}>
        <span>Members</span><span>{(canManage && !share) ? '' : members.length}</span>
      </div>
      {err && <div style={{ fontSize: 12.5, color: WC.red, marginBottom: 8 }}>{err}</div>}
      {canManage && !share && !err && <div style={{ fontSize: 12.5, color: WC.muted, padding: '6px 2px' }}>Loading members…</div>}
      {(!canManage || share) && members.length === 0 && !err && (
        <div style={{ fontSize: 12.5, color: WC.muted, padding: '6px 2px' }}>No members yet — only the owner has access.</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {members.map(g => (
          <div key={g.principal_value} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '8px 6px', borderRadius: 8 }}>
            <WAvatar user={{ name: g.principal_value }} size={30} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: WC.fg, fontFamily: 'Geist Mono, monospace' }}>{g.principal_value}</div>
              <div style={{ fontSize: 11, color: WC.muted }}>{g.principal_type === 'group' ? 'Group' : 'Member'}</div>
            </div>
            {canManage && (
              <button onClick={() => removeMember(g)} disabled={busy === g.principal_value} title="Remove from workspace" style={{
                width: 28, height: 28, border: 0, background: 'transparent', borderRadius: 6, cursor: 'pointer',
                color: WC.mutedFg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <WIcon name="user-minus" size={15} />
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Add member — owner only. Members can see who's in but not change it. */}
      {canManage ? (
        <>
          <div style={{ ...SECTION, margin: '20px 0 10px' }}>Add a member</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              <WTextInput value={addEmail} onChange={setAddEmail} placeholder="person@example.com" />
            </div>
            <WBtn variant="primary" leftIcon="user-plus" disabled={busy === 'add' || !addEmail.trim()} onClick={addMember}>
              {busy === 'add' ? 'Adding…' : 'Add'}
            </WBtn>
          </div>
          <div style={{ fontSize: 11.5, color: WC.mutedFg, marginTop: 8 }}>
            Grants this person access by email; they'll still trust a device of their own to get in.
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', gap: 9, padding: 13, borderRadius: 10, background: WC.surface, border: `1px solid ${WC.border}`, marginTop: 20 }}>
          <WIcon name="info" size={15} color={WC.muted} style={{ marginTop: 1, flex: '0 0 auto' }} />
          <span style={{ fontSize: 12.5, color: WC.muted, lineHeight: '18px' }}>
            You're a member of this workspace. Only its owner can add or remove members.
          </span>
        </div>
      )}
    </WDrawer>
  );
}

window.SC_WORKSPACES = { OverviewView, WorkspacesView, ROLE_TONE };