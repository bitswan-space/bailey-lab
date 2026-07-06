import React from 'react';
// views-resources.jsx — admin Resource Management: host memory budget, the
// reserved breakdown (system / per-workspace infra / always-on / on-demand pool),
// per-BP actual-vs-reserved usage, and the (read-only) platform reservation knobs.

const { C: WC, Icon: WIcon, Pill: WPill } = window.WD_SHELL;
const {
  Card: WCard, PageHeader: WPageHeader, Stat: WStat, LiveState: WLiveState,
} = window.SC_UI;

// Human byte size (binary units — what `free -h` shows).
function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  const s = (v >= 100 || i === 0) ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
  return `${s} ${u[i]}`;
}
function fmtMB(mb) {
  if (mb == null) return '—';
  return fmtBytes(mb * 1024 * 1024);
}

// A labelled reserved-vs-total bar.
function Bar({ label, usedMB, totalMB, tone }) {
  const p = totalMB > 0 ? Math.max(0, Math.min(100, (usedMB / totalMB) * 100)) : 0;
  const color = tone || (p >= 95 ? WC.red : p >= 80 ? WC.amber : WC.primary);
  return (
    <div style={{ padding: '10px 0', borderBottom: `1px solid ${WC.surface2}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
        <span style={{ fontSize: 12.5, color: WC.fg, fontWeight: 500 }}>{label}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: WC.muted }}>
          {fmtMB(usedMB)} of {fmtMB(totalMB)}
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 600, color, minWidth: 40, textAlign: 'right' }}>{p.toFixed(0)}%</span>
      </div>
      <div style={{ height: 6, borderRadius: 4, background: WC.surface2, overflow: 'hidden' }}>
        <div style={{ width: `${p}%`, height: '100%', background: color, borderRadius: 4, transition: 'width .3s' }} />
      </div>
    </div>
  );
}

function kvRow(label, value, tone) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, padding: '8px 0', borderBottom: `1px solid ${WC.surface2}` }}>
      <span style={{ fontSize: 12.5, color: WC.muted }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: tone || WC.fg }}>{value}</span>
    </div>
  );
}

// Read-only platform reservation knobs. These are tuned in the product (env /
// built-in defaults), NOT user-configurable — surfaced here only so an admin can
// see the budget's inputs.
function PolicyKnobs({ b }) {
  const rows = [
    ['System reserve', fmtMB(b.system_reserve_mb)],
    ['Per-workspace reserve', fmtMB(b.workspace_reserve_mb)],
    ['Default per-container', fmtMB(b.default_container_mb)],
    ['On-demand pool floor', fmtMB(b.ondemand_pool_floor_mb)],
    ['On-demand pool top-N', b.ondemand_pool_topn != null ? String(b.ondemand_pool_topn) : '—'],
  ];
  return (
    <div>
      {rows.map(([label, value]) => kvRow(label, value))}
      <div style={{ fontSize: 11.5, color: WC.muted, paddingTop: 10, lineHeight: '16px' }}>
        These are platform defaults tuned for this deployment — not user-configurable.
      </div>
    </div>
  );
}

const POLICY_TONE = { 'always-on': 'primary', 'on-demand': 'neutral' };

function ResourcesView({ ctx }) {
  const { data, refresh } = ctx;
  const b = data.resources;
  const loaded = data.load.resources === 'ok' && b;
  const totalMB = loaded ? Math.round((b.host_total_bytes || 0) / (1024 * 1024)) : 0;

  return (
    <div>
      <WPageHeader title="Resource management"
        subtitle="Host memory budget — always-on reservations, the on-demand pool, and per-business-process usage." />

      {data.load.resources !== 'ok' && (
        <WLiveState status={data.load.resources} error={data.error.resources}
          label="Loading resource usage…" onRetry={() => refresh('resources')} />
      )}

      {loaded && (<>
        {b.pressure && (
          <div style={{ border: `1px solid ${WC.red}55`, background: '#fef2f2', borderRadius: 12, padding: 14, marginBottom: 18, display: 'flex', gap: 10, alignItems: 'center' }}>
            <WIcon name="triangle-alert" size={18} color={WC.red} />
            <div style={{ fontSize: 13, color: '#991b1b' }}>
              <strong>Memory pressure.</strong> {(b.warnings && b.warnings[0]) || 'On-demand services are being shut down to protect always-on reservations.'}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 14, marginBottom: 20 }}>
          <WStat label="Host total" value={fmtMB(totalMB)} icon="server" />
          <WStat label="Reserved" value={fmtMB(b.reserved_mb)} icon="lock"
            tone={b.reserved_mb > totalMB ? 'warning' : 'neutral'} />
          <WStat label="Unreserved" value={fmtMB(b.unreserved_mb)} icon="circle-slash"
            tone={b.unreserved_mb < 0 ? 'warning' : 'success'} />
          <WStat label="Workspaces" value={b.workspaces} icon="layout-grid" />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, alignItems: 'start' }}>
          {/* Reserved breakdown */}
          <WCard pad={0}>
            <div style={{ padding: '14px 20px', borderBottom: `1px solid ${WC.border}`, fontSize: 13, fontWeight: 600, color: WC.fg }}>
              Reserved budget
            </div>
            <div style={{ padding: '4px 20px 14px' }}>
              <Bar label="Reserved of host" usedMB={b.reserved_mb} totalMB={totalMB} />
              {kvRow('System', fmtMB(b.system_reserve_mb))}
              {kvRow(`Workspace infra (${b.workspaces} × ${fmtMB(b.workspace_reserve_mb)})`, fmtMB(b.workspaces * b.workspace_reserve_mb))}
              {kvRow('Always-on services', fmtMB(b.always_on_mb))}
              {kvRow('On-demand pool', fmtMB(b.ondemand_pool_mb))}
              {kvRow('On-demand in use', fmtMB(b.ondemand_usage_mb),
                b.ondemand_usage_mb > b.ondemand_pool_mb ? WC.amber : undefined)}
            </div>
          </WCard>

          {/* Read-only platform knobs (tuned in the product, not user-editable) */}
          <WCard pad={0}>
            <div style={{ padding: '14px 20px', borderBottom: `1px solid ${WC.border}`, fontSize: 13, fontWeight: 600, color: WC.fg }}>
              Reservation policy
            </div>
            <div style={{ padding: '4px 20px 14px' }}>
              <PolicyKnobs b={b} />
            </div>
          </WCard>
        </div>

        {/* Per-BP breakdown */}
        <WCard pad={0} style={{ marginTop: 18 }}>
          <div style={{ padding: '14px 20px', borderBottom: `1px solid ${WC.border}`, fontSize: 13, fontWeight: 600, color: WC.fg }}>
            Memory by business process
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ color: WC.muted, textAlign: 'left' }}>
                  {['Workspace', 'Business process', 'Stage', 'Policy', 'Reserved', 'Actual', ''].map((h) => (
                    <th key={h} style={{ padding: '8px 20px', fontWeight: 500, borderBottom: `1px solid ${WC.border}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.by_bp.length === 0 && (
                  <tr><td colSpan={7} style={{ padding: '16px 20px', color: WC.muted }}>No deployed automations.</td></tr>
                )}
                {b.by_bp.map((g, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${WC.surface2}` }}>
                    <td style={{ padding: '8px 20px', fontFamily: 'Geist Mono, monospace' }}>{g.workspace}</td>
                    <td style={{ padding: '8px 20px', fontFamily: 'Geist Mono, monospace' }}>{g.bp}</td>
                    <td style={{ padding: '8px 20px' }}>{g.stage || 'production'}</td>
                    <td style={{ padding: '8px 20px' }}><WPill tone={POLICY_TONE[g.policy] || 'neutral'} size="xs">{g.policy || '—'}</WPill></td>
                    <td style={{ padding: '8px 20px' }}>{fmtMB(g.reservation_mb)}</td>
                    <td style={{ padding: '8px 20px', color: g.over ? WC.red : WC.fg, fontWeight: g.over ? 600 : 400 }}>
                      {fmtBytes(g.usage_bytes)}{!g.running && ' (stopped)'}
                    </td>
                    <td style={{ padding: '8px 20px' }}>
                      {g.over && <WPill tone="danger" size="xs">over reservation</WPill>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </WCard>
      </>)}
    </div>
  );
}

window.SC_RESOURCES = { ResourcesView };
