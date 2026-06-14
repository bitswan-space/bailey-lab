// deployments.jsx — Deployments view (main branch / no worktree)

const { C, Icon, Pill, Btn, useLucide, CommitHash } = window.WD_SHELL;

const STAGES = [
  { id: 'dev',        label: 'Development', short: 'Dev',  icon: 'code-2' },
  { id: 'staging',    label: 'Staging',     short: 'Stg',  icon: 'flask-conical' },
  { id: 'production', label: 'Production',  short: 'Prod', icon: 'rocket' },
  { id: 'dr',         label: 'Disaster Recovery', short: 'DR', icon: 'life-buoy' },
];

// DR is a mirror of production: it shares production's secrets, deployment
// history and firewall rules. Map a stage id to the id whose data it shows.
const stageDataId = (id) => (id === 'dr' ? 'production' : id);

// ── Disaster-recovery manual-test tracking ─────────────────────────────────
// A DR stage must be periodically restored-and-verified by a human. We track
// who did it and enforce a review cadence (default quarterly).
const DR_WINDOW_DAYS  = { monthly: 30, quarterly: 91, 'semi-annually': 182, annually: 365 };
const DR_WINDOW_LABEL = { monthly: 'Monthly', quarterly: 'Quarterly',
                          'semi-annually': 'Every 6 months', annually: 'Annually' };
const WD_DR = {};
function drStore(bpId) {
  if (!WD_DR[bpId]) {
    WD_DR[bpId] = {
      policy: 'quarterly',
      tests: [
        { id:'dr2', by:'Jana Nováková', role:'Engineering lead', at:'Jan 12, 2026',
          date:'2026-01-12', verified:true,
          note:'Restored prod snapshot into DR — employee directory and payroll records all present and correct.' },
        { id:'dr1', by:'Tomáš Novák', role:'Platform', at:'Oct 3, 2025',
          date:'2025-10-03', verified:true,
          note:'Quarterly DR drill. Data intact after restore, UI spot-checked.' },
      ],
    };
  }
  return WD_DR[bpId];
}
function drDaysSince(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}
function drStatus(bpId) {
  const s = drStore(bpId);
  const last = s.tests[0];
  const win = DR_WINDOW_DAYS[s.policy] || 91;
  if (!last) return { overdue: true, daysSince: null, window: win, last: null, policy: s.policy };
  const since = drDaysSince(last.date);
  return { overdue: since > win, daysSince: since, window: win, last, policy: s.policy };
}

function statusMeta(status) {
  switch (status) {
    case 'deployed':     return { tone: 'success', label: 'Deployed', dot: C.green };
    case 'building':     return { tone: 'primary', label: 'Building', dot: C.primary };
    case 'failed':       return { tone: 'danger',  label: 'Failed',   dot: C.red };
    default:             return { tone: 'neutral', label: 'Not deployed', dot: '#a1a1aa' };
  }
}

function KindBadge({ kind }) {
  const m = window.WD_DATA.KIND_META[kind];
  return (
    <span style={{
      display:'inline-flex', alignItems:'center', gap:6,
      padding:'2px 8px', background:C.surface2, borderRadius:6,
      fontSize:11, color:C.muted, fontWeight:500,
    }}>
      <Icon name={m.icon} size={12} color={m.color}/>
      {m.label}
    </span>
  );
}

function CardHeader({ aut, onConfigure, onInspect }) {
  return (
    <div style={{
      padding:'14px 16px', borderBottom:`1px solid ${C.border}`,
      display:'flex', alignItems:'center', gap:10,
    }}>
      <div style={{
        width:30, height:30, borderRadius:6, background:C.surface2,
        display:'inline-flex', alignItems:'center', justifyContent:'center',
      }}>
        <Icon name={window.WD_DATA.KIND_META[aut.kind].icon}
              size={15} color={window.WD_DATA.KIND_META[aut.kind].color}/>
      </div>
      <div style={{flex:1, minWidth:0}}>
        <div style={{fontSize:14, fontWeight:600, color:C.fg,
                     overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
          {aut.name}
        </div>
        <div style={{fontSize:11, color:C.muted}}>
          {window.WD_DATA.KIND_META[aut.kind].label}
        </div>
      </div>
      <Btn variant="outline" size="xs" leftIcon="activity"
           onClick={onInspect} title="Inspect containers & logs">Inspect</Btn>
      <Btn variant="outline" size="xs" leftIcon="settings"
           onClick={onConfigure} title="Configure secrets, env, URLs"/>
    </div>
  );
}

// ─── Variant A: vertical stacked stages (matches current implementation) ────
function AutomationCardVertical({ aut, onConfigure, onInspect, onHistory }) {
  return (
    <div style={{
      background:'#fff', border:`1px solid ${C.border}`, borderRadius:12,
      boxShadow:'0 1px 2px 0 rgba(0,0,0,0.04)', overflow:'hidden',
      display:'flex', flexDirection:'column',
    }}>
      <CardHeader aut={aut} onConfigure={onConfigure} onInspect={onInspect}/>

      {STAGES.map((s, i) => {
        const st = aut.stages[s.id];
        const meta = statusMeta(st.status);
        const canDeploy = st.status === 'not-deployed' || st.status === 'failed';
        const promoteFrom = i === 1 ? 'dev' : 'staging';
        const prevDeployed = i > 0 && aut.stages[STAGES[i-1].id].status === 'deployed';
        const hasHistory = !!st.sha;
        return (
          <div key={s.id}
            onClick={hasHistory ? () => onHistory?.(s.id) : undefined}
            style={{
              padding:'12px 16px',
              borderBottom: i < STAGES.length - 1 ? `1px solid ${C.border}` : 'none',
              background: i === 0 ? '#fff' : i === 1 ? '#fcfcfd' : C.surface,
              cursor: hasHistory ? 'pointer' : 'default',
              transition:'background 120ms',
            }}
            onMouseEnter={hasHistory ? (e) => e.currentTarget.style.background = '#f4f4f5' : undefined}
            onMouseLeave={hasHistory ? (e) => e.currentTarget.style.background = (i === 0 ? '#fff' : i === 1 ? '#fcfcfd' : C.surface) : undefined}
          >
            <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:8}}>
              <span style={{
                fontSize:10, fontWeight:600, color:C.muted,
                letterSpacing:0.5, textTransform:'uppercase', minWidth:64,
              }}>{s.label}</span>
              <Pill tone={meta.tone}>
                <span style={{width:6, height:6, borderRadius:9999,
                              background:meta.dot, display:'inline-block'}}/>
                {meta.label}
              </Pill>
              {st.sha && (
                <span style={{marginLeft:'auto', display:'flex', alignItems:'center', gap:6}}>
                  <CommitHash sha={st.sha}/>
                  <Icon name="history" size={12} color={C.mutedFg}/>
                </span>
              )}
            </div>
            {st.deployedAt && (
              <div style={{fontSize:11, color:C.muted, marginBottom:8}}>
                deployed {st.deployedAt}
              </div>
            )}
            <div onClick={(e) => e.stopPropagation()}>
              {i === 0 && (
                <Btn variant={canDeploy ? 'primary' : 'outline'} size="sm" leftIcon="cloud-upload"
                     style={{width:'100%'}}>
                  {canDeploy ? 'Deploy' : 'Redeploy'}
                </Btn>
              )}
              {i > 0 && (
                <Btn variant={prevDeployed ? 'default' : 'outline'} size="sm"
                     leftIcon="arrow-right" disabled={!prevDeployed}
                     style={{width:'100%'}}>
                  Promote from {promoteFrom}
                </Btn>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Stage cell — used by both Deployments (3 cols) and worktree live-dev (1 col)
// stage: { short, label, status, sha, deployedAt, url, meta }
// meta : pre-computed { dot, label } from statusMeta() or live-dev equivalent
function StageCell({ stage, isLast, onClick, density = 'comfortable' }) {
  const interactive = !!onClick;
  const padV = density === 'compact' ? '10px 14px 12px' : '14px 16px 16px';
  return (
    <div
      onClick={interactive ? onClick : undefined}
      style={{
        padding: padV,
        borderRight: isLast ? 'none' : `1px solid ${C.border}`,
        display:'flex', flexDirection:'column', gap:8,
        cursor: interactive ? 'pointer' : 'default',
        transition:'background 120ms',
        minWidth: 0,
      }}
      onMouseEnter={interactive ? (e) => e.currentTarget.style.background = '#f4f4f5' : undefined}
      onMouseLeave={interactive ? (e) => e.currentTarget.style.background = '' : undefined}
    >
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:8}}>
        <span style={{display:'inline-flex', alignItems:'center', gap:6,
                      fontSize:11, fontWeight:600, color:C.fg,
                      textTransform:'uppercase', letterSpacing:0.6, minWidth:0}}>
          <span style={{overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
            {stage.short}
          </span>
          {stage.url && (
            <a
              href={stage.url} target="_blank" rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              title={`Open ${stage.url}`}
              style={{
                display:'inline-flex', alignItems:'center', justifyContent:'center',
                width:18, height:18, borderRadius:4,
                color: C.mutedFg, textDecoration:'none',
                transition:'color 120ms, background 120ms',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = C.primary;
                                     e.currentTarget.style.background = C.surface2; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = C.mutedFg;
                                     e.currentTarget.style.background = 'transparent'; }}
            >
              <Icon name="external-link" size={11}/>
            </a>
          )}
        </span>
        <span style={{width:8, height:8, borderRadius:9999, background:stage.meta.dot,
                      flex:'0 0 auto'}}/>
      </div>
      <div style={{minHeight:18, display:'flex', alignItems:'center', gap:8}}>
        {stage.sha
          ? <CommitHash sha={stage.sha}/>
          : <span style={{fontSize:11, color:C.mutedFg, fontStyle:'italic'}}>—</span>}
      </div>
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:8}}>
        <span style={{fontSize:11, color: stage.meta.dot === '#a1a1aa' ? C.muted : stage.meta.dot,
                      fontWeight:500}}>
          {stage.meta.label}
        </span>
        {stage.deployedAt && (
          <span style={{fontSize:11, color:C.muted,
                        overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
            {stage.deployedAt}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Variant B: horizontal stages (more compact, scannable) ─────────────────
// Cards are read-only — actions live in the Inspect dialog. Clicking a stage
// opens the promotion manager.
function AutomationCardHorizontal({ aut, onConfigure, onInspect, onHistory }) {
  // Synthesize a deploy URL for any stage that has a deployment.
  const stageUrl = (stageId, sha) => {
    if (!sha) return null;
    if (stageId === 'production') return `https://${aut.name}.harmonum.ai`;
    return `https://${aut.name}-${stageId}.harmonum.ai`;
  };
  return (
    <div style={{
      background:'#fff', border:`1px solid ${C.border}`, borderRadius:12,
      boxShadow:'0 1px 2px 0 rgba(0,0,0,0.04)', overflow:'hidden',
    }}>
      <CardHeader aut={aut} onConfigure={onConfigure} onInspect={onInspect}/>
      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:0}}>
        {STAGES.map((s, i) => {
          const st = aut.stages[s.id];
          const stage = {
            short: s.short, label: s.label,
            status: st.status, sha: st.sha, deployedAt: st.deployedAt,
            url: stageUrl(s.id, st.sha),
            meta: statusMeta(st.status),
          };
          return (
            <StageCell key={s.id} stage={stage}
              isLast={i === STAGES.length - 1}
              onClick={() => onHistory?.(s.id)}/>
          );
        })}
      </div>
    </div>
  );
}

// ─── Variant D: single-line row ─────────────────────────────────────────────
// One automation per row: name on the left, then stage chips with promote
// buttons between them, then Inspect on the right.
// • Each stage chip shows status + sha; clicking the small clock icon opens
//   the deployment history for THAT stage (rollback lives in there).
// • Promote buttons sit BETWEEN stage chips and are disabled when the source
//   isn't deployed or the target already matches it.
// • Inspect opens the promotion manager / per-container view.
function StageChip({ stage, st, sha, onHistory }) {
  const meta = statusMeta(st.status);
  const [hover, setHover] = React.useState(false);
  const clickable = !!st.sha;
  return (
    <div style={{
      flex:'1 1 0', minWidth:0,
      display:'flex', alignItems:'center', gap:8,
      padding:'8px 10px',
      background: hover && clickable ? '#f4f4f5' : '#fafafa',
      border:`1px solid ${C.border}`, borderRadius:8,
      cursor: clickable ? 'pointer' : 'default',
      transition:'background 120ms',
    }}
      onClick={clickable ? () => onHistory?.(stage.id) : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={clickable ? `View deployment history for ${stage.label}` : `${stage.label} — ${meta.label}`}
    >
      <span style={{
        width:8, height:8, borderRadius:9999, background:meta.dot, flex:'0 0 auto',
      }}/>
      <div style={{display:'flex', flexDirection:'column', minWidth:0, flex:1, lineHeight:1.2}}>
        <span style={{
          fontSize:10, fontWeight:600, color:C.muted,
          letterSpacing:0.6, textTransform:'uppercase',
        }}>{stage.short}</span>
        <span style={{
          fontSize:12, color: st.status === 'not-deployed' ? C.mutedFg : C.fg,
          overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
        }}>
          {st.sha
            ? <CommitHash sha={st.sha} color={C.fg}/>
            : <span style={{fontStyle:'italic', color:C.mutedFg}}>—</span>}
        </span>
      </div>
      {clickable && (
        <span
          style={{
            width:22, height:22, borderRadius:6,
            display:'inline-flex', alignItems:'center', justifyContent:'center',
            color: C.mutedFg, flex:'0 0 auto',
            background: hover ? '#fff' : 'transparent',
            border: hover ? `1px solid ${C.border}` : '1px solid transparent',
          }}
          title="Rollback / view history"
        >
          <Icon name="history" size={13}/>
        </span>
      )}
    </div>
  );
}

function PromoteButton({ from, to, fromSt, toSt, onPromote }) {
  const canPromote =
    fromSt.status === 'deployed' &&
    (!toSt.sha || toSt.sha !== fromSt.sha) &&
    toSt.status !== 'building';
  const [hover, setHover] = React.useState(false);
  const label = `Promote to ${to.short}`;
  return (
    <button
      onClick={canPromote ? onPromote : undefined}
      disabled={!canPromote}
      title={
        !fromSt.sha ? `Nothing to promote from ${from.label}`
        : toSt.sha === fromSt.sha ? `${to.label} already matches ${from.label}`
        : toSt.status === 'building' ? `${to.label} is building`
        : `Promote ${from.label} → ${to.label}`
      }
      style={{
        flex:'0 0 auto',
        display:'inline-flex', alignItems:'center', gap:5,
        height:30, padding:'0 10px',
        background: canPromote ? (hover ? C.primaryHi : C.primary) : '#fff',
        color: canPromote ? '#fff' : C.mutedFg,
        border: `1px solid ${canPromote ? C.primary : C.border}`,
        borderRadius:9999,
        fontSize:11, fontWeight:600, fontFamily:'inherit',
        letterSpacing:0.2, textTransform:'uppercase',
        cursor: canPromote ? 'pointer' : 'not-allowed',
        transition:'background 120ms',
        whiteSpace:'nowrap',
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Icon name="arrow-right" size={13}/>
      {label}
    </button>
  );
}

function AutomationRow({ aut, onConfigure, onInspect, onHistory }) {
  const m = window.WD_DATA.KIND_META[aut.kind];
  return (
    <div style={{
      background:'#fff', border:`1px solid ${C.border}`, borderRadius:12,
      boxShadow:'0 1px 2px 0 rgba(0,0,0,0.04)',
      padding:'12px 14px',
      display:'grid',
      gridTemplateColumns:'minmax(180px, 220px) 1fr auto',
      alignItems:'center', gap:14,
    }}>
      {/* Identity */}
      <div style={{display:'flex', alignItems:'center', gap:10, minWidth:0}}>
        <div style={{
          width:32, height:32, borderRadius:8, background:C.surface2,
          display:'inline-flex', alignItems:'center', justifyContent:'center',
          flex:'0 0 auto',
        }}>
          <Icon name={m.icon} size={16} color={m.color}/>
        </div>
        <div style={{minWidth:0, flex:1}}>
          <div style={{
            fontSize:14, fontWeight:600, color:C.fg,
            fontFamily:'Geist Mono, ui-monospace, monospace',
            overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
          }}>{aut.name}</div>
          <div style={{fontSize:11, color:C.muted, marginTop:1}}>{m.label}</div>
        </div>
      </div>

      {/* Stages + promote buttons */}
      <div style={{
        display:'flex', alignItems:'center', gap:8, minWidth:0,
      }}>
        {STAGES.map((s, i) => {
          const st = aut.stages[s.id];
          const next = STAGES[i+1];
          const nextSt = next ? aut.stages[next.id] : null;
          return (
            <React.Fragment key={s.id}>
              <StageChip stage={s} st={st} onHistory={onHistory}/>
              {next && (
                <PromoteButton
                  from={s} to={next} fromSt={st} toSt={nextSt}
                  onPromote={() => onInspect?.()} // open promotion manager
                />
              )}
            </React.Fragment>
          );
        })}
      </div>

      {/* Actions */}
      <div style={{display:'flex', alignItems:'center', gap:6}}>
        <Btn variant="outline" size="sm" leftIcon="boxes"
             onClick={onInspect} title="Inspect containers · logs · promotion manager">
          Inspect
        </Btn>
        <Btn variant="ghost" size="sm" leftIcon="settings"
             onClick={onConfigure} title="Configure secrets, env, URLs"/>
      </div>
    </div>
  );
}

// ─── Variant D: ONE stage strip for the whole BP ────────────────────────────
// All containers promote together. Three stage chips with promote buttons
// between them. Inspect opens a per-container view; clock icon on each stage
// opens deployment history / rollback for that stage.

// Aggregate the status across N automations for a single stage.
// Worst-status-wins, plus sha-consensus.
function aggregateStage(automations, stageId) {
  const stages = automations.map(a => a.stages[stageId]).filter(Boolean);
  if (!stages.length) return { status: 'not-deployed', sha: null, deployedAt: null, mixed: false, total: 0, deployed: 0 };
  const order = { 'failed': 4, 'building': 3, 'not-deployed': 2, 'deployed': 1 };
  let worst = 'deployed';
  for (const s of stages) {
    if (order[s.status] > order[worst]) worst = s.status;
  }
  const deployedShas = stages.filter(s => s.sha).map(s => s.sha);
  const allMatch = deployedShas.length > 0 && deployedShas.every(s => s === deployedShas[0]);
  const sha = allMatch ? deployedShas[0] : null;
  const mixed = !allMatch && deployedShas.length > 0;
  // Use a recent deployedAt if any
  const deployedAt = stages.find(s => s.deployedAt)?.deployedAt || null;
  return {
    status: worst, sha, deployedAt, mixed,
    total: stages.length,
    deployed: stages.filter(s => s.status === 'deployed').length,
    failed: stages.filter(s => s.status === 'failed').length,
    building: stages.filter(s => s.status === 'building').length,
    replicas: stages
      .filter(s => s.status !== 'not-deployed')
      .reduce((a, s) => a + (s.replicas || 1), 0),
  };
}

function StageServiceLink({ icon, label, href }) {
  const [hover, setHover] = React.useState(false);
  return (
    <a
      href={href} target="_blank" rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={`Open ${label} admin in new tab`}
      style={{
        flex:'1 1 0', minWidth:0,
        display:'inline-flex', alignItems:'center', justifyContent:'center', gap:5,
        height:26, padding:'0 8px',
        background: hover ? '#fff' : 'transparent',
        border: `1px solid ${hover ? C.borderHi : C.border}`,
        borderRadius:6,
        color: hover ? C.fg : C.muted,
        fontSize:11, fontWeight:500, letterSpacing:0.1,
        textDecoration:'none', cursor:'pointer',
        transition:'background 120ms, color 120ms, border-color 120ms',
        whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis',
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Icon name={icon} size={12}/>
      {label}
      <Icon name="external-link" size={10} style={{opacity:0.6}}/>
    </a>
  );
}

// Like StageServiceLink but a button — opens an in-app modal instead of an external URL.
function StageServiceButton({ icon, label, onClick }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
      title={`Open ${label} manager`}
      style={{
        flex:'1 1 0', minWidth:0,
        display:'inline-flex', alignItems:'center', justifyContent:'center', gap:5,
        height:26, padding:'0 8px',
        background: hover ? '#fff' : 'transparent',
        border: `1px solid ${hover ? C.borderHi : C.border}`,
        borderRadius:6,
        color: hover ? C.fg : C.muted,
        fontSize:11, fontWeight:500, letterSpacing:0.1,
        cursor:'pointer', fontFamily:'inherit',
        transition:'background 120ms, color 120ms, border-color 120ms',
        whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis',
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Icon name={icon} size={12}/>
      {label}
    </button>
  );
}

// Big circular stage node — the icon represents the STAGE's purpose
// (dev=code, staging=flask, prod=rocket); status is conveyed by the
// circle's color/border treatment.
function StageNode({ stage, agg, alert }) {
  const meta = statusMeta(agg.status);
  const deployed = agg.status === 'deployed';
  const building = agg.status === 'building';
  const failed   = agg.status === 'failed';
  const fill =
      alert    ? '#d97706'
    : deployed ? meta.dot
    : building ? meta.dot
    : failed   ? meta.dot
    : '#fff';
  const iconColor =
      alert || deployed || building || failed ? '#fff' : C.mutedFg;
  return (
    <div style={{position:'relative'}}>
      {alert && (
        <span style={{
          position:'absolute', inset:-5, borderRadius:9999,
          background:'#f59e0b66', animation:'wd-pulse 1.6s ease-out infinite',
        }}/>
      )}
      <div style={{
        width:52, height:52, borderRadius:9999,
        background: fill,
        border: (!alert && agg.status === 'not-deployed') ? `1.5px dashed ${C.borderHi}` : 'none',
        display:'inline-flex', alignItems:'center', justifyContent:'center',
        flex:'0 0 auto', position:'relative',
        boxShadow: alert ? '0 1px 3px rgba(217,119,6,0.35)'
                  : deployed ? '0 1px 2px rgba(22,163,74,0.2)' : 'none',
      }}>
        <Icon name={stage.icon} size={22} color={iconColor}/>
      </div>
      {/* status badge */}
      <div title={alert ? 'Disaster-recovery test overdue' : meta.label} style={{
        position:'absolute', right:-2, bottom:-2,
        width:18, height:18, borderRadius:9999,
        background:'#fff', border:`2px solid #fff`,
        display:'inline-flex', alignItems:'center', justifyContent:'center',
        boxShadow:'0 1px 2px rgba(0,0,0,0.12)',
      }}>
        {alert ? (
          <Icon name="alert-triangle" size={12} color="#d97706"/>
        ) : building ? (
          <Icon name="loader" size={11} color={meta.dot}/>
        ) : failed ? (
          <Icon name="x" size={11} color={meta.dot}/>
        ) : deployed ? (
          <Icon name="check" size={11} color={meta.dot}/>
        ) : (
          <span style={{width:6, height:6, borderRadius:9999, background:C.mutedFg}}/>
        )}
      </div>
    </div>
  );
}

// Per-stage detail panel — sha, status counts, deployedAt, service links, history.
function StageDetailBox({ stage, agg, bpName, frontends, onHistory, onSecrets, onInspect }) {
  const meta = statusMeta(agg.status);
  // Build a friendly frontend URL for this stage.
  const frontendUrl = (fName) =>
    stage.id === 'production'
      ? `https://${fName}.harmonum.ai`
      : `https://${fName}-${stage.id}.harmonum.ai`;

  // Plain-language status.
  const friendly =
    agg.failed     ? { label: `${agg.failed} service${agg.failed === 1 ? '' : 's'} failing`, color:'#dc2626' }
  : agg.building   ? { label: 'Deploying…', color:'#2563eb' }
  : agg.mixed      ? { label: 'Versions out of sync', color:'#d97706' }
  : agg.deployed === agg.total && agg.total > 0
                   ? { label: 'Healthy', color:'#16a34a' }
  : agg.deployed > 0
                   ? { label: `${agg.deployed} of ${agg.total} running`, color:'#d97706' }
                   : { label: 'Not deployed yet', color:'#a1a1aa' };

  return (
    <div style={{
      flex:'1 1 0', minWidth:0,
      padding:'16px 16px 14px',
      background:'#fff',
      border:`1px solid ${C.border}`, borderRadius:12,
      boxShadow:'0 1px 2px 0 rgba(0,0,0,0.03)',
      display:'flex', flexDirection:'column', gap:14,
    }}>
      {/* Status headline */}
      <div style={{display:'flex', alignItems:'center', gap:10}}>
        <span style={{
          width:10, height:10, borderRadius:9999, flex:'0 0 auto',
          background: friendly.color,
          boxShadow: `0 0 0 4px ${friendly.color}1a`,
        }}/>
        <div style={{display:'flex', flexDirection:'column', minWidth:0, lineHeight:1.3}}>
          <span style={{fontSize:14, fontWeight:600, color: friendly.color}}>
            {friendly.label}
          </span>
          <span style={{fontSize:12, color:C.muted}}>
            {agg.deployedAt ? `Updated ${agg.deployedAt}` : 'Never deployed'}
          </span>
        </div>
      </div>

      {/* Version line */}
      <div style={{
        display:'flex', alignItems:'center', gap:6,
        fontSize:12, color:C.muted,
        paddingBottom:12, borderBottom:`1px solid ${C.border}`,
      }}>
        {agg.sha ? (
          <>
            <span>Version</span>
            <CommitHash sha={agg.sha} color={C.fg}/>
            {agg.replicas > 0 && (
              <span style={{marginLeft:'auto', display:'inline-flex', alignItems:'center', gap:5}}>
                <Icon name="layers" size={12}/>
                {agg.replicas} replica{agg.replicas === 1 ? '' : 's'}
              </span>
            )}
          </>
        ) : agg.mixed ? (
          <span style={{color:'#d97706'}}>Containers on different versions</span>
        ) : (
          <span style={{fontStyle:'italic'}}>No version live</span>
        )}
      </div>

      {/* Frontends — friendly link rows */}
      {frontends && frontends.length > 0 && (
        <div style={{display:'flex', flexDirection:'column', gap:5}}>
          <div style={{fontSize:12, fontWeight:600, color:C.fg}}>Open app</div>
          {frontends.map(f => {
            const st = f.stages[stage.id];
            const deployed = st && st.status === 'deployed';
            return (
              <StageFrontendLink
                key={f.id}
                name={f.name}
                kind={f.kind}
                href={deployed ? frontendUrl(f.name) : null}
              />
            );
          })}
        </div>
      )}

      {/* Primary actions */}
      <div style={{display:'flex', gap:6}}>
        <button
          onClick={() => onSecrets?.(stage.id)}
          style={{
            flex:1,
            display:'inline-flex', alignItems:'center', justifyContent:'center', gap:6,
            height:32, padding:'0 10px',
            background:'#fff', border:`1px solid ${C.border}`, borderRadius:7,
            fontSize:12, fontWeight:600, color:C.fg, fontFamily:'inherit',
            cursor:'pointer',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = C.surface2; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = '#fff'; }}
          title={`Edit secrets — ${stage.label}`}
        >
          <Icon name="key-round" size={13}/>
          Secrets
        </button>
        <button
          onClick={() => onHistory?.(stage.id)}
          style={{
            flex:1,
            display:'inline-flex', alignItems:'center', justifyContent:'center', gap:6,
            height:32, padding:'0 10px',
            background:'#fff', border:`1px solid ${C.border}`, borderRadius:7,
            fontSize:12, fontWeight:500, color:C.muted, fontFamily:'inherit',
            cursor:'pointer',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = C.surface2;
                                 e.currentTarget.style.color = C.fg; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = '#fff';
                                 e.currentTarget.style.color = C.muted; }}
          title={`Deployment history & rollback — ${stage.label}`}
        >
          <Icon name="history" size={13}/>
          History
        </button>
      </div>

      {/* Admin tools — quiet footer */}
      <div style={{
        display:'flex', alignItems:'center', gap:4,
        paddingTop:12, borderTop:`1px solid ${C.border}`,
        fontSize:11,
      }}>
        <span style={{color:C.mutedFg, marginRight:4}}>Manage</span>
        <StageServiceLink
          icon="database" label="Database"
          href={`https://pg.${stage.id}.${bpName || 'app'}.harmonum.ai`}
        />
        <StageServiceLink
          icon="hard-drive" label="Files"
          href={`https://minio.${stage.id}.${bpName || 'app'}.harmonum.ai`}
        />
        <StageServiceButton
          icon="boxes" label="Inspect"
          onClick={() => onInspect?.(stage.id)}
        />
      </div>
    </div>
  );
}

// Compact frontend link row. If href is null (frontend not deployed in this
// stage), render as a disabled-looking line so users see what's expected.
function StageFrontendLink({ name, kind, href }) {
  const [hover, setHover] = React.useState(false);
  const m = window.WD_DATA.KIND_META[kind] || { icon: 'globe', color: C.muted };
  const disabled = !href;
  const inner = (
    <>
      <Icon name={m.icon} size={12} color={disabled ? C.mutedFg : m.color}/>
      <span style={{
        flex:1, minWidth:0, fontSize:12,
        fontFamily:'Geist Mono, ui-monospace, monospace',
        color: disabled ? C.mutedFg : C.fg,
        overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
      }}>{name}</span>
      <Icon name="external-link" size={10}
            color={disabled ? C.mutedFg : (hover ? C.primary : C.muted)}
            style={{opacity: disabled ? 0.5 : 1}}/>
    </>
  );
  const sharedStyle = {
    display:'inline-flex', alignItems:'center', gap:6,
    padding:'5px 8px',
    background: hover && !disabled ? '#fff' : 'transparent',
    border: `1px solid ${hover && !disabled ? C.borderHi : C.border}`,
    borderRadius:6,
    textDecoration:'none',
    transition:'background 120ms, border-color 120ms',
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
  if (disabled) {
    return (
      <span title={`${name} — not deployed in this stage`} style={sharedStyle}>{inner}</span>
    );
  }
  return (
    <a
      href={href} target="_blank" rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={`Open ${name} (${href})`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={sharedStyle}
    >{inner}</a>
  );
}

function AggregatePromote({ from, to, fromAgg, toAgg, onPromote }) {
  const canPromote =
    fromAgg.deployed === fromAgg.total && fromAgg.total > 0 &&
    fromAgg.sha &&
    fromAgg.sha !== toAgg.sha &&
    toAgg.building === 0;
  const [hover, setHover] = React.useState(false);
  return (
    <button
      onClick={canPromote ? onPromote : undefined}
      disabled={!canPromote}
      title={
        fromAgg.deployed === 0   ? `Nothing to promote from ${from.label}`
        : fromAgg.mixed           ? `${from.label} has mixed versions — sync containers before promoting`
        : fromAgg.sha === toAgg.sha ? `${to.label} already matches ${from.label}`
        : toAgg.building          ? `${to.label} is mid-build`
        : `Promote all containers from ${from.label} → ${to.label}`
      }
      style={{
        display:'inline-flex', alignItems:'center', gap:6,
        height:30, padding:'0 12px',
        background: canPromote ? (hover ? C.primaryHi : C.primary) : '#fff',
        color: canPromote ? '#fff' : C.mutedFg,
        border: `1px solid ${canPromote ? C.primary : C.border}`,
        borderRadius:9999,
        fontSize:11, fontWeight:600, fontFamily:'inherit',
        letterSpacing:0.3, textTransform:'uppercase',
        cursor: canPromote ? 'pointer' : 'not-allowed',
        transition:'background 120ms',
        whiteSpace:'nowrap',
        boxShadow: canPromote ? '0 1px 2px rgba(9,61,245,0.18)' : 'none',
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      Promote
      <Icon name="arrow-right" size={13}/>
    </button>
  );
}

function AutomationStrip({ automations, bpName, onInspect, onHistory, onPromote, onSecrets }) {
  const aggs = STAGES.map(s => ({ stage: s, agg: aggregateStage(automations, s.id) }));
  const frontends = automations.filter(a => typeof a.kind === 'string' && a.kind.startsWith('frontend'));

  return (
    <div style={{
      background:'#fff', border:`1px solid ${C.border}`, borderRadius:14,
      boxShadow:'0 1px 2px 0 rgba(0,0,0,0.04)',
      padding:'22px 24px 20px',
      display:'flex', flexDirection:'column', gap:16,
    }}>
      {/* ── Pipeline header: circles with connecting line and inline promote ── */}
      <div style={{position:'relative'}}>
        {/* connecting line across the middle */}
        <div style={{
          position:'absolute', left:'8.33%', right:'8.33%', top:26,
          height:2, background:C.border, zIndex:0,
        }}/>
        <div style={{
          display:'grid',
          gridTemplateColumns:'1fr auto 1fr auto 1fr',
          alignItems:'center', gap:12,
          position:'relative', zIndex:1,
        }}>
          {aggs.map(({ stage, agg }, i) => (
            <React.Fragment key={stage.id}>
              <div style={{
                display:'flex', flexDirection:'column', alignItems:'center', gap:6,
                background:'#fff', padding:'0 4px',
              }}>
                <StageNode stage={stage} agg={agg}/>
                <div style={{
                  fontSize:11, fontWeight:700, color:C.fg,
                  letterSpacing:0.8, textTransform:'uppercase',
                }}>{stage.label}</div>
              </div>
              {i < aggs.length - 1 && (
                <div style={{background:'#fff', padding:'0 8px'}}>
                  <AggregatePromote
                    from={stage}
                    to={aggs[i+1].stage}
                    fromAgg={agg}
                    toAgg={aggs[i+1].agg}
                    onPromote={() => onPromote?.(stage.id, aggs[i+1].stage.id)}
                  />
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* ── Per-stage detail row ── */}
      <div style={{display:'flex', gap:10}}>
        {aggs.map(({ stage, agg }) => (
          <StageDetailBox
            key={stage.id}
            stage={stage} agg={agg}
            bpName={bpName}
            frontends={frontends}
            onHistory={onHistory}
            onSecrets={onSecrets}
            onInspect={onInspect}
          />
        ))}
      </div>
    </div>
  );
}


function AutomationCardPipeline({ aut, onConfigure, onInspect, onHistory }) {
  return (
    <div style={{
      background:'#fff', border:`1px solid ${C.border}`, borderRadius:12,
      boxShadow:'0 1px 2px 0 rgba(0,0,0,0.04)',
      display:'flex', flexDirection:'column',
    }}>
      <CardHeader aut={aut} onConfigure={onConfigure} onInspect={onInspect}/>
      <div style={{padding:'16px 18px', display:'flex', flexDirection:'column', gap:14}}>

      {/* pipeline */}
      <div style={{display:'flex', alignItems:'center', gap:0}}>
        {STAGES.map((s, i) => {
          const st = aut.stages[s.id];
          const meta = statusMeta(st.status);
          const isLast = i === STAGES.length - 1;
          const nextSt = !isLast ? aut.stages[STAGES[i+1].id] : null;
          const arrowActive = st.status === 'deployed';
          const hasHistory = !!st.sha;
          return (
            <React.Fragment key={s.id}>
              <div
                onClick={hasHistory ? () => onHistory?.(s.id) : undefined}
                style={{
                  flex:'0 0 auto', display:'flex', flexDirection:'column', alignItems:'center', gap:6,
                  cursor: hasHistory ? 'pointer' : 'default',
                  padding:'4px 8px', borderRadius:8,
                  transition:'background 120ms',
                }}
                onMouseEnter={hasHistory ? (e) => e.currentTarget.style.background = '#f4f4f5' : undefined}
                onMouseLeave={hasHistory ? (e) => e.currentTarget.style.background = 'transparent' : undefined}
              >
                <div style={{
                  width:42, height:42, borderRadius:9999,
                  background: st.status === 'deployed' ? meta.dot
                            : st.status === 'building' ? meta.dot
                            : st.status === 'failed'   ? meta.dot
                            : '#fff',
                  border: st.status === 'not-deployed' ? `1.5px dashed ${C.borderHi}` : 'none',
                  display:'inline-flex', alignItems:'center', justifyContent:'center',
                  color:'#fff',
                }}>
                  <Icon name={
                    st.status === 'deployed' ? 'check'
                    : st.status === 'building' ? 'loader'
                    : st.status === 'failed'   ? 'x'
                    : 'circle-dashed'
                  } size={18} color={st.status === 'not-deployed' ? C.mutedFg : '#fff'}/>
                </div>
                <div style={{fontSize:10, fontWeight:600, color:C.muted, textTransform:'uppercase',
                             letterSpacing:0.5}}>{s.short}</div>
                <div style={{display:'flex', justifyContent:'center'}}>
                  <CommitHash sha={st.sha} color={C.fg}/>
                </div>
              </div>
              {!isLast && (
                <div style={{
                  flex:1, height:2,
                  background: arrowActive
                    ? `linear-gradient(to right, ${meta.dot}, ${C.border})`
                    : C.border,
                  margin:'0 6px', position:'relative', top:-12,
                }}/>
              )}
            </React.Fragment>
          );
        })}
      </div>

      {/* actions row */}
      <div style={{display:'flex', gap:8}}>
        {STAGES.map((s, i) => {
          const st = aut.stages[s.id];
          const canDeploy = st.status === 'not-deployed' || st.status === 'failed';
          const prevDeployed = i === 0 || aut.stages[STAGES[i-1].id].status === 'deployed';
          return (
            <Btn key={s.id} size="xs"
                 variant={i === 0 && canDeploy ? 'primary' : 'outline'}
                 leftIcon={i === 0 ? 'cloud-upload' : 'arrow-right'}
                 disabled={i > 0 && !prevDeployed}
                 style={{flex:1}}>
              {i === 0 ? (canDeploy ? 'Deploy dev' : 'Redeploy dev')
                : i === 1 ? 'Promote → staging'
                : 'Promote → prod'}
            </Btn>
          );
        })}
      </div>
      </div>
    </div>
  );
}

function CardForLayout({ aut, layout, onConfigure, onInspect, onHistory }) {
  const props = { aut, onConfigure, onInspect, onHistory };
  if (layout === 'row')        return <AutomationRow            {...props}/>;
  if (layout === 'horizontal') return <AutomationCardHorizontal {...props}/>;
  if (layout === 'pipeline')   return <AutomationCardPipeline   {...props}/>;
  return <AutomationCardVertical {...props}/>;
}

function ReadmeCard({ readme, hidden }) {
  if (hidden) return null;
  return (
    <div style={{
      background:'#fff', border:`1px solid ${C.border}`, borderRadius:12,
      padding:'20px 22px',
    }}>
      <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:6}}>
        <Icon name="book-text" size={14} color={C.muted}/>
        <span style={{fontSize:10, fontWeight:600, color:C.muted, textTransform:'uppercase',
                      letterSpacing:0.5}}>README</span>
        <Btn variant="ghost" size="xs" leftIcon="pencil" style={{marginLeft:'auto'}}/>
      </div>
      <div style={{fontFamily:'Roboto, Inter', fontSize:22, fontWeight:700,
                   letterSpacing:-0.4, color:C.fg, marginBottom:6}}>
        {readme.title}
      </div>
      <div style={{fontSize:13, lineHeight:'20px', color:C.muted, marginBottom:14}}>
        {readme.summary}
      </div>
      {readme.sections.map(s => (
        <div key={s.heading} style={{marginTop:12}}>
          <div style={{fontSize:13, fontWeight:600, color:C.fg, marginBottom:6}}>{s.heading}</div>
          <ul style={{margin:0, padding:0, listStyle:'none', display:'flex', flexDirection:'column', gap:4}}>
            {s.items.map(([term, desc]) => (
              <li key={term} style={{fontSize:13, lineHeight:'20px', color:'#3f3f46'}}>
                <span style={{fontWeight:600, color:C.fg}}>{term}</span>
                <span style={{color:C.muted}}> — {desc}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ─── Dep tab nav (Specification / Automation) ───────────────────────────────
function DepTabs({ active, onChange }) {
  const tabs = [
    { id:'specification', label:'Specification', icon:'file-text' },
    { id:'automation',    label:'Automation',    icon:'boxes' },
  ];
  return (
    <div style={{
      display:'flex', gap:0, padding:'0 28px', background:'#fff',
      borderBottom:`1px solid ${C.border}`, flexShrink: 0,
    }}>
      {tabs.map(t => {
        const isAct = t.id === active;
        return (
          <button key={t.id} onClick={() => onChange(t.id)} style={{
            display:'flex', alignItems:'center', gap:7,
            padding:'12px 16px', background:'transparent',
            border:0, borderBottom: isAct ? `2px solid ${C.fg}` : '2px solid transparent',
            marginBottom:-1,
            fontSize:13, fontWeight: isAct ? 600 : 500,
            color: isAct ? C.fg : C.muted, cursor:'pointer', fontFamily:'inherit',
          }}>
            <Icon name={t.icon} size={13} color={isAct ? C.fg : C.mutedFg}/>
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Specification (read-only) ──────────────────────────────────────────────
function DepSpecificationTab({ readme, density }) {
  const padding = density === 'compact' ? '20px 28px' : '32px 56px';
  return (
    <div style={{
      flex:1, overflow:'hidden', background: C.bg,
      display:'flex', flexDirection:'column',
    }}>
      <div style={{
        display:'flex', alignItems:'center', gap:12,
        padding:'14px 28px', background:'#fff',
        borderBottom:`1px solid ${C.border}`,
      }}>
        <div style={{flex:1, minWidth:0}}>
          <div style={{fontSize:10, fontWeight:600, color:C.muted, letterSpacing:0.5,
                       textTransform:'uppercase', marginBottom:2}}>Specification</div>
          <div style={{fontSize:15, fontWeight:600, color:C.fg, letterSpacing:-0.2,
                       display:'flex', alignItems:'center', gap:8}}>
            README
            <span style={{fontSize:11, color:C.muted, fontWeight:500,
                          padding:'2px 8px', background:C.surface2, borderRadius:9999}}>
              read-only · main
            </span>
          </div>
        </div>
        <Btn variant="primary" size="sm" leftIcon="git-branch"
             title="Open a new worktree to edit this spec and start an automation">
          Implement in new worktree
        </Btn>
      </div>

      <div style={{flex:1, overflow:'auto', background: C.bg}}>
        <div style={{
          maxWidth: 820, margin:'24px auto 40px',
          background:'#fff', border:`1px solid ${C.border}`,
          borderRadius:6, boxShadow:'0 1px 3px rgba(0,0,0,0.04)',
        }}>
          <div className="wd-doc-ro" style={{padding, color:C.fg, fontSize:15, lineHeight:1.7}}>
            {readme
              ? <ReadmeRendered readme={readme}/>
              : (
                <div style={{color:C.muted, fontSize:13, textAlign:'center',
                             padding:'40px 0'}}>
                  No specification yet for <b>{'this automation'}</b>.
                </div>
              )}
          </div>
        </div>
      </div>

      <style>{`
        .wd-doc-ro h1 { font-family: Roboto, Inter; font-size: 30px; font-weight: 700;
                        letter-spacing: -0.5px; margin: 0 0 12px; color: ${C.fg}; }
        .wd-doc-ro h2 { font-size: 22px; font-weight: 700; letter-spacing: -0.3px;
                        margin: 26px 0 8px; color: ${C.fg}; }
        .wd-doc-ro p  { margin: 0 0 12px; color: #3f3f46; }
        .wd-doc-ro ul { margin: 0 0 14px 0; padding-left: 26px;
                        display: flex; flex-direction: column; gap: 4px; }
        .wd-doc-ro li { color: #3f3f46; }
        .wd-doc-ro strong { font-weight: 600; color: ${C.fg}; }
      `}</style>
    </div>
  );
}

function ReadmeRendered({ readme }) {
  return (
    <>
      <h1>{readme.title}</h1>
      <p>{readme.summary}</p>
      {readme.sections.map(s => (
        <React.Fragment key={s.heading}>
          <h2>{s.heading}</h2>
          <ul>
            {s.items.map(([term, desc]) => (
              <li key={term}>
                <strong>{term}</strong> — {desc}
              </li>
            ))}
          </ul>
        </React.Fragment>
      ))}
    </>
  );
}

// ── Stage pipeline where each bubble is a TAB selecting the visible card ────
function FirewallRow({ r, onApprove, onDeny, onView, hasRecord, readOnly }) {
  const blocked = r.status === 'blocked';
  return (
    <div style={{
      display:'flex', alignItems:'center', gap:12, padding:'12px 14px',
      background:'#fff', border:`1px solid ${C.border}`, borderRadius:10,
    }}>
      <div style={{
        width:30, height:30, borderRadius:7, flex:'0 0 auto',
        background: blocked ? '#fee2e2' : '#dcfce7',
        display:'inline-flex', alignItems:'center', justifyContent:'center',
      }}>
        <Icon name={blocked ? 'shield-alert' : 'shield-check'} size={15}
              color={blocked ? '#dc2626' : '#16a34a'}/>
      </div>
      <div style={{flex:1, minWidth:0}}>
        <div style={{fontSize:13, fontWeight:600, color:C.fg,
                     fontFamily:'Geist Mono, ui-monospace, monospace'}}>{r.host}</div>
        <div style={{fontSize:11, color:C.muted, marginTop:1}}>{r.purpose} · {r.at}</div>
      </div>
      {hasRecord && (
        <button onClick={onView} title="View data-processing record" style={{
          display:'inline-flex', alignItems:'center', gap:6, height:30, padding:'0 10px',
          background:'#fff', color:C.fg, border:`1px solid ${C.border}`, borderRadius:6,
          fontSize:11, fontWeight:500, fontFamily:'inherit', cursor:'pointer',
        }}><Icon name="file-text" size={13}/>Data record</button>
      )}
      {readOnly ? (
        <span style={{display:'inline-flex', alignItems:'center', gap:5, fontSize:11,
                      fontWeight:600, color: blocked ? '#b91c1c' : '#15803d'}}>
          <Icon name={blocked ? 'ban' : 'check'} size={12}
                color={blocked ? '#dc2626' : '#16a34a'}/>
          {blocked ? 'Blocked' : 'Allowed'}
        </span>
      ) : blocked ? (
        <div style={{display:'flex', gap:6}}>
          <button onClick={onApprove} style={{
            display:'inline-flex', alignItems:'center', gap:6, height:30, padding:'0 12px',
            background:C.primary, color:'#fff', border:`1px solid ${C.primary}`, borderRadius:6,
            fontSize:11, fontWeight:600, fontFamily:'inherit', cursor:'pointer',
          }}><Icon name="check" size={13}/>Review &amp; approve</button>
          <button onClick={onDeny} title="Keep blocked" style={{
            display:'inline-flex', alignItems:'center', gap:6, height:30, padding:'0 12px',
            background:'#fff', color:'#dc2626', border:`1px solid ${C.border}`, borderRadius:6,
            fontSize:11, fontWeight:600, fontFamily:'inherit', cursor:'pointer',
          }}><Icon name="x" size={13}/>Deny</button>
        </div>
      ) : (
        <button onClick={onDeny} title="Revoke access" style={{
          display:'inline-flex', alignItems:'center', gap:6, height:30, padding:'0 12px',
          background:'#fff', color:C.muted, border:`1px solid ${C.border}`, borderRadius:6,
          fontSize:11, fontWeight:500, fontFamily:'inherit', cursor:'pointer',
        }}><Icon name="ban" size={13}/>Revoke</button>
      )}
    </div>
  );
}

// GDPR data-processing record form / viewer for a 3rd-party service.
function FirewallGdprModal({ rule, record, readOnly, onClose, onSave }) {
  const [f, setF] = React.useState(record || {
    host: rule?.host || '', dataSent:'', purpose:'', stored:'no',
    jurisdiction:'', noUserData:false, dpaFile:'',
  });
  React.useEffect(() => { if (window.lucide) window.lucide.createIcons(); });
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  const field = (label, node) => (
    <div style={{display:'flex', flexDirection:'column', gap:5}}>
      <label style={{fontSize:12, fontWeight:600, color:C.fg}}>{label}</label>
      {node}
    </div>
  );
  const inputStyle = {
    width:'100%', boxSizing:'border-box', minHeight:34, padding:'7px 10px',
    border:`1px solid ${C.border}`, borderRadius:6, fontSize:13, fontFamily:'inherit',
    color:C.fg, background: readOnly ? C.surface : '#fff', outline:'none', resize:'vertical',
  };
  const ro = readOnly;
  return (
    <div onClick={onClose} style={{
      position:'absolute', inset:0, background:'rgba(0,0,0,0.45)', zIndex:1000,
      display:'flex', alignItems:'center', justifyContent:'center', padding:20,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width:600, maxWidth:'96vw', maxHeight:'90vh', background:'#fff',
        border:`1px solid ${C.border}`, borderRadius:12, overflow:'hidden',
        display:'flex', flexDirection:'column', boxShadow:'0 25px 50px -12px rgba(0,0,0,0.35)',
      }}>
        <div style={{padding:'16px 20px', borderBottom:`1px solid ${C.border}`,
                     display:'flex', alignItems:'center', gap:12}}>
          <div style={{width:34, height:34, borderRadius:8, background:C.surface2, flex:'0 0 auto',
                       display:'inline-flex', alignItems:'center', justifyContent:'center'}}>
            <Icon name="shield-check" size={17} color={C.fg}/>
          </div>
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontSize:15, fontWeight:700, color:C.fg}}>
              {ro ? 'Data-processing record' : 'Approve 3rd-party access'}
            </div>
            <div style={{fontSize:12, color:C.muted, marginTop:1, fontFamily:'Geist Mono, monospace'}}>
              {f.host}
            </div>
          </div>
          <button onClick={onClose} style={{width:30, height:30, border:0, background:'transparent',
            cursor:'pointer', color:C.muted, display:'inline-flex', alignItems:'center', justifyContent:'center'}}>
            <Icon name="x" size={16}/>
          </button>
        </div>

        <div style={{flex:1, minHeight:0, overflow:'auto', padding:'18px 20px',
                     display:'flex', flexDirection:'column', gap:16}}>
          {!ro && (
            <div style={{fontSize:12, color:C.muted, lineHeight:1.5}}>
              GDPR requires documenting what data leaves the system and how the processor handles it.
            </div>
          )}
          <label style={{
            display:'flex', alignItems:'center', gap:10, padding:'10px 12px',
            border:`1px solid ${f.noUserData ? '#86efac' : C.border}`,
            background: f.noUserData ? '#f0fdf4' : '#fff', borderRadius:8,
            cursor: ro ? 'default' : 'pointer',
          }}>
            <input type="checkbox" checked={f.noUserData} disabled={ro}
                   onChange={e => set('noUserData', e.target.checked)} style={{cursor:ro?'default':'pointer'}}/>
            <div>
              <div style={{fontSize:13, fontWeight:600, color:C.fg}}>No user data is sent to this service</div>
              <div style={{fontSize:11, color:C.muted, marginTop:1}}>
                Tick if only non-personal/operational data leaves the system.
              </div>
            </div>
          </label>

          {!f.noUserData && (
            <>
              {field('1 · What data is sent to the 3rd party',
                <textarea rows={2} style={inputStyle} readOnly={ro} value={f.dataSent}
                          placeholder="e.g. employee email, error stack traces"
                          onChange={e => set('dataSent', e.target.value)}/>)}
              {field('2 · What is the data used for',
                <textarea rows={2} style={inputStyle} readOnly={ro} value={f.purpose}
                          placeholder="e.g. crash diagnostics & alerting"
                          onChange={e => set('purpose', e.target.value)}/>)}
              {field('3 · Is the data stored there?',
                ro ? <div style={inputStyle}>{f.stored === 'yes' ? 'Yes — stored' : f.stored === 'transient' ? 'Transient only' : 'No'}</div>
                   : <div style={{display:'flex', gap:6}}>
                       {[['no','No'],['transient','Transient'],['yes','Yes']].map(([v,l]) => (
                         <button key={v} onClick={() => set('stored', v)} style={{
                           flex:1, height:34, borderRadius:6, fontSize:12, fontWeight:600, cursor:'pointer',
                           border:`1px solid ${f.stored===v?C.primary:C.border}`,
                           background: f.stored===v?C.primarySoft:'#fff', color: f.stored===v?C.primary:C.fg,
                           fontFamily:'inherit',
                         }}>{l}</button>
                       ))}
                     </div>)}
              {field('4 · Jurisdiction of the data processor',
                <input style={inputStyle} readOnly={ro} value={f.jurisdiction}
                       placeholder="e.g. EU (Ireland) · USA (DPF certified)"
                       onChange={e => set('jurisdiction', e.target.value)}/>)}
              {field('5 · Data processing agreement (PDF)',
                ro
                  ? <div style={{...inputStyle, display:'flex', alignItems:'center', gap:8}}>
                      <Icon name="file-text" size={13} color={C.muted}/>{f.dpaFile || 'None attached'}</div>
                  : <label style={{
                      display:'flex', alignItems:'center', gap:8, padding:'9px 12px',
                      border:`1.5px dashed ${C.borderHi}`, borderRadius:6, cursor:'pointer',
                      fontSize:13, color:C.muted,
                    }}>
                      <Icon name="upload" size={14}/>
                      {f.dpaFile || 'Upload DPA PDF'}
                      <input type="file" accept="application/pdf" style={{display:'none'}}
                             onChange={e => set('dpaFile', e.target.files?.[0]?.name || 'dpa.pdf')}/>
                    </label>)}
            </>
          )}
        </div>

        {!ro && (
          <div style={{padding:'12px 20px', borderTop:`1px solid ${C.border}`, background:C.surface,
                       display:'flex', justifyContent:'flex-end', gap:8}}>
            <Btn variant="ghost" size="sm" onClick={onClose}>Cancel</Btn>
            <Btn variant="primary" size="sm" leftIcon="check" onClick={() => onSave(f)}>
              Approve &amp; record
            </Btn>
          </div>
        )}
      </div>
    </div>
  );
}

// Packages in the deployed image + CVEs against them.
const SUPPLY_PACKAGES = [
  { name:'openssl', version:'3.0.11', cves:[{ id:'CVE-2023-5678', sev:'high' }] },
  { name:'lodash', version:'4.17.21', cves:[] },
  { name:'express', version:'4.18.2', cves:[{ id:'CVE-2024-29041', sev:'medium' }] },
  { name:'node', version:'20.11.0', cves:[] },
  { name:'libxml2', version:'2.9.14', cves:[{ id:'CVE-2023-39615', sev:'critical' }, { id:'CVE-2023-45322', sev:'medium' }] },
  { name:'postgres-client', version:'15.4', cves:[] },
  { name:'axios', version:'1.6.2', cves:[{ id:'CVE-2023-45857', sev:'low' }] },
];
function supplyCounts() {
  return SUPPLY_PACKAGES.flatMap(p => p.cves).reduce((a,c) => ({...a, [c.sev]:(a[c.sev]||0)+1}), {});
}

// Shared per-stage audit log for access-control & firewall changes.
const WD_AUDIT = {};
function auditLog(stageId, category, text) {
  const key = `${stageId}:${category}`;
  WD_AUDIT[key] = WD_AUDIT[key] || [];
  const who = (window.WD_DATA.CURRENT_USER && window.WD_DATA.CURRENT_USER.name) || 'You';
  WD_AUDIT[key].unshift({ who, at:'just now', text });
  return WD_AUDIT[key];
}
function AuditLogView({ stageId, category, seed }) {
  const key = `${stageId}:${category}`;
  if (!WD_AUDIT[key]) WD_AUDIT[key] = (seed || []).slice();
  const [, force] = React.useReducer(x => x+1, 0);
  const entries = WD_AUDIT[key] || [];
  // expose a refresh on window so action handlers can nudge (cheap for a mock)
  React.useEffect(() => { WD_AUDIT['__refresh_'+key] = force; }, [key]);
  return (
    <div style={{marginTop:8, borderTop:`1px solid ${C.border}`, paddingTop:14}}>
      <div style={{fontSize:11, fontWeight:600, color:C.mutedFg, letterSpacing:0.5,
                   textTransform:'uppercase', marginBottom:8,
                   display:'flex', alignItems:'center', gap:6}}>
        <Icon name="history" size={12} color={C.mutedFg}/>Audit log
      </div>
      <div style={{display:'flex', flexDirection:'column'}}>
        {entries.length === 0 && (
          <div style={{fontSize:12, color:C.muted}}>No changes recorded yet.</div>
        )}
        {entries.map((e, i) => (
          <div key={i} style={{display:'flex', alignItems:'baseline', gap:8, padding:'5px 0',
                               fontSize:12, color:'#3f3f46',
                               borderBottom: i < entries.length-1 ? `1px solid ${C.border}` : 'none'}}>
            <span style={{fontWeight:600, color:C.fg}}>{e.who}</span>
            <span style={{flex:1}}>{e.text}</span>
            <span style={{color:C.mutedFg, fontSize:11, whiteSpace:'nowrap'}}>{e.at}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
function logAndRefresh(stageId, category, text) {
  auditLog(stageId, category, text);
  const fn = WD_AUDIT['__refresh_'+`${stageId}:${category}`];
  if (fn) fn();
}

// Per-stage access control: ACL per frontend, tree style. Owner can edit & share.
function StageAccessControl({ stage, frontends }) {
  const fes = (frontends && frontends.length) ? frontends
    : [{ id:'app', name:'app', kind:'frontend-public' }];
  const meId = 'u1';
  const seed = () => {
    const m = {};
    fes.forEach((f, i) => {
      m[f.id] = i === 0
        ? [{ id:'u1', kind:'user', name:'Tomáš Novák', detail:'tomas@harmonum.ai', role:'owner' },
           { id:'g1', kind:'group', name:'HR team', detail:'14 members', role:'user' },
           { id:'u2', kind:'user', name:'Jana Nováková', detail:'jana@harmonum.ai', role:'user' }]
        : [{ id:'u1', kind:'user', name:'Tomáš Novák', detail:'tomas@harmonum.ai', role:'owner' },
           { id:'g2', kind:'group', name:'Engineering', detail:'8 members', role:'user' }];
    });
    return m;
  };
  const [acl, setAcl] = React.useState(seed);
  React.useEffect(() => { setAcl(seed()); }, [stage.id, fes.map(f=>f.id).join()]);
  const [adding, setAdding] = React.useState(null);   // frontend id with the share box open
  const [query, setQuery] = React.useState('');
  const canPublic = stage.id === 'staging' || stage.id === 'production';
  const [pub, setPub] = React.useState({});
  React.useEffect(() => { setPub({}); }, [stage.id]);
  const togglePublic = (fid) => {
    setPub(p => {
      const now = !p[fid];
      logAndRefresh(stage.id, 'access',
        now ? `made ${fnameOf(fid)} PUBLIC to the internet` : `made ${fnameOf(fid)} private`);
      return { ...p, [fid]: now };
    });
  };
  const [confirmPublic, setConfirmPublic] = React.useState(null); // frontend obj
  const [confirmText, setConfirmText] = React.useState('');

  const DIRECTORY = [
    { kind:'user',  name:'Petr Svoboda',   detail:'petr@harmonum.ai' },
    { kind:'user',  name:'Eva Dvořáková',  detail:'eva@harmonum.ai' },
    { kind:'user',  name:'Marek Horák',    detail:'marek@harmonum.ai' },
    { kind:'user',  name:'Lucie Černá',    detail:'lucie@harmonum.ai' },
    { kind:'group', name:'Finance',        detail:'6 members' },
    { kind:'group', name:'Leadership',     detail:'4 members' },
    { kind:'group', name:'Contractors',    detail:'11 members' },
  ];

  const setRole = (fid, eid, role) => {
    setAcl(a => {
      const ent = (a[fid]||[]).find(e => e.id===eid);
      if (ent) logAndRefresh(stage.id, 'access', `set ${ent.name} to ${role} on ${fnameOf(fid)}`);
      return { ...a, [fid]: a[fid].map(e => e.id===eid ? {...e, role} : e) };
    });
  };
  const remove = (fid, eid) => {
    setAcl(a => {
      const ent = (a[fid]||[]).find(e => e.id===eid);
      if (ent) logAndRefresh(stage.id, 'access', `removed ${ent.name} from ${fnameOf(fid)}`);
      return { ...a, [fid]: a[fid].filter(e => e.id!==eid) };
    });
  };
  const addCandidate = (fid, cand) => {
    setAcl(a => ({ ...a, [fid]: [...a[fid], {
      id:`n${Date.now()}`, kind:cand.kind, name:cand.name, detail:cand.detail, role:'user' }] }));
    logAndRefresh(stage.id, 'access', `granted ${cand.name} access to ${fnameOf(fid)}`);
    setQuery(''); setAdding(null);
  };
  const fnameOf = (fid) => (fes.find(x => x.id === fid)?.name) || fid;
  const dashLite = {
    display:'inline-flex', alignItems:'center', gap:6, height:30, padding:'0 12px',
    background:'#fff', border:`1.5px dashed ${C.borderHi}`, borderRadius:6,
    color:C.muted, fontSize:12, fontWeight:500, fontFamily:'inherit', cursor:'pointer',
  };

  return (
    <div style={{display:'flex', flexDirection:'column', gap:16}}>
      <div style={{fontSize:12, color:C.muted, lineHeight:1.5}}>
        Who can access each frontend in {stage.label}. <strong style={{color:C.fg}}>Owners</strong> can
        edit this list and share access; <strong style={{color:C.fg}}>Users</strong> can only open the app.
      </div>
      {[...fes].sort((a,b) => (pub[b.id]?1:0) - (pub[a.id]?1:0)).map(f => {
        const m = window.WD_DATA.KIND_META[f.kind] || { icon:'globe', color:C.muted };
        const entries = acl[f.id] || [];
        const iAmOwner = entries.some(e => e.id === meId && e.role === 'owner');
        const isPublic = !!pub[f.id];
        return (
          <div key={f.id} style={{
            border:`1px solid ${isPublic ? '#dc2626' : C.border}`, borderRadius:10,
            overflow:'hidden', background:'#fff',
            boxShadow: isPublic ? '0 0 0 3px #fee2e2' : 'none',
          }}>
            {isPublic && (
              <div style={{
                display:'flex', alignItems:'center', gap:8, padding:'8px 14px',
                background:'#fef2f2', borderBottom:`1px solid #fecaca`,
                fontSize:12, fontWeight:600, color:'#b91c1c',
              }}>
                <Icon name="globe" size={14} color="#dc2626"/>
                Public — anyone on the internet can open this frontend
              </div>
            )}
            <div style={{
              display:'flex', alignItems:'center', gap:10, padding:'12px 14px',
              borderBottom:`1px solid ${C.border}`, background:C.surface,
            }}>
              <Icon name={m.icon} size={15} color={isPublic ? '#dc2626' : m.color}/>
              <span style={{flex:1, fontSize:13, fontWeight:600, color:C.fg,
                            fontFamily:'Geist Mono, ui-monospace, monospace'}}>{f.name}</span>
              <span style={{fontSize:11, color:C.muted}}>{entries.length} with access</span>
              {canPublic && iAmOwner && (
                <button onClick={() => { if (isPublic) togglePublic(f.id); else { setConfirmPublic(f); setConfirmText(''); } }}
                  title={isPublic ? 'Make private' : 'Make public to the internet'}
                  style={{
                    display:'inline-flex', alignItems:'center', gap:5, height:26, padding:'0 10px',
                    borderRadius:9999, fontSize:11, fontWeight:600, fontFamily:'inherit', cursor:'pointer',
                    border:`1px solid ${isPublic ? '#dc2626' : C.border}`,
                    background: isPublic ? '#dc2626' : '#fff',
                    color: isPublic ? '#fff' : C.muted,
                  }}>
                  <Icon name={isPublic ? 'lock-open' : 'globe'} size={12}
                        color={isPublic ? '#fff' : C.muted}/>
                  {isPublic ? 'Public' : 'Make public'}
                </button>
              )}
              {iAmOwner && (
                <span title="You can edit this ACL" style={{
                  display:'inline-flex', alignItems:'center', gap:4, fontSize:10, fontWeight:700,
                  padding:'2px 7px', borderRadius:9999, background:'#dbeafe', color:'#1d4ed8',
                  letterSpacing:0.3, textTransform:'uppercase',
                }}><Icon name="shield" size={10}/>Owner</span>
              )}
            </div>
            {entries.map(e => (
              <div key={e.id} style={{
                display:'flex', alignItems:'center', gap:10, padding:'10px 14px 10px 34px',
                borderBottom:`1px solid ${C.border}`,
              }}>
                <div style={{
                  width:28, height:28, borderRadius:e.kind==='group'?7:9999, flex:'0 0 auto',
                  background:C.surface2, display:'inline-flex', alignItems:'center', justifyContent:'center',
                }}>
                  <Icon name={e.kind==='group'?'users':'user'} size={14} color={C.muted}/>
                </div>
                <div style={{flex:1, minWidth:0}}>
                  <div style={{fontSize:13, fontWeight:500, color:C.fg,
                               overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                    {e.name}{e.id===meId && <span style={{color:C.muted, fontWeight:400}}> · you</span>}
                  </div>
                  <div style={{fontSize:11, color:C.muted}}>{e.detail}</div>
                </div>
                {iAmOwner ? (
                  <>
                    <select value={e.role}
                      onChange={ev => setRole(f.id, e.id, ev.target.value)}
                      style={{
                        height:30, padding:'0 8px', borderRadius:6,
                        border:`1px solid ${C.border}`, background:'#fff', color:C.fg,
                        fontSize:12, fontWeight:500, fontFamily:'inherit', cursor:'pointer',
                      }}>
                      <option value="user">User</option>
                      <option value="owner">Owner</option>
                    </select>
                    <button onClick={() => remove(f.id, e.id)} title="Remove access" style={{
                      width:28, height:28, padding:0, border:0, background:'transparent',
                      color:C.mutedFg, cursor:'pointer', borderRadius:6,
                      display:'inline-flex', alignItems:'center', justifyContent:'center',
                    }}><Icon name="x" size={14}/></button>
                  </>
                ) : (
                  <span style={{fontSize:11, fontWeight:600, color:C.muted, textTransform:'capitalize',
                                padding:'2px 8px', border:`1px solid ${C.border}`, borderRadius:9999}}>
                    {e.role}
                  </span>
                )}
              </div>
            ))}
            {iAmOwner && (
              <div style={{padding:'10px 14px 10px 34px'}}>
                {adding === f.id ? (
                  <div style={{position:'relative', maxWidth:420}}>
                    <div style={{display:'flex', alignItems:'center', gap:8, height:34, padding:'0 10px',
                                 border:`1px solid ${C.fg}`, borderRadius:7, background:'#fff'}}>
                      <Icon name="search" size={13} color={C.mutedFg}/>
                      <input autoFocus value={query} onChange={e => setQuery(e.target.value)}
                        placeholder="Add people or groups…"
                        style={{flex:1, border:0, outline:0, fontSize:13, fontFamily:'inherit',
                                background:'transparent', color:C.fg}}/>
                      <button onClick={() => { setAdding(null); setQuery(''); }} style={{
                        background:'transparent', border:0, cursor:'pointer', color:C.mutedFg, padding:0,
                      }}><Icon name="x" size={14}/></button>
                    </div>
                    {(() => {
                      const taken = new Set(entries.map(e => e.name));
                      const matches = DIRECTORY.filter(c => !taken.has(c.name) &&
                        (c.name.toLowerCase().includes(query.toLowerCase()) ||
                         c.detail.toLowerCase().includes(query.toLowerCase())));
                      return (
                        <div style={{
                          position:'absolute', top:'calc(100% + 4px)', left:0, right:0, zIndex:20,
                          background:'#fff', border:`1px solid ${C.border}`, borderRadius:8,
                          boxShadow:'0 8px 24px rgba(0,0,0,0.10)', overflow:'hidden', maxHeight:240,
                          overflowY:'auto',
                        }}>
                          {matches.length === 0 && (
                            <div style={{padding:'12px 14px', fontSize:12, color:C.muted}}>No matches.</div>
                          )}
                          {matches.map((c, i) => (
                            <button key={i} onClick={() => addCandidate(f.id, c)} style={{
                              display:'flex', alignItems:'center', gap:10, width:'100%', textAlign:'left',
                              padding:'8px 12px', border:0, background:'#fff', cursor:'pointer',
                              fontFamily:'inherit',
                            }}
                              onMouseEnter={e=>e.currentTarget.style.background=C.surface}
                              onMouseLeave={e=>e.currentTarget.style.background='#fff'}>
                              <div style={{width:26, height:26, borderRadius:c.kind==='group'?6:9999,
                                background:C.surface2, display:'inline-flex', alignItems:'center',
                                justifyContent:'center', flex:'0 0 auto'}}>
                                <Icon name={c.kind==='group'?'users':'user'} size={13} color={C.muted}/>
                              </div>
                              <div style={{flex:1, minWidth:0}}>
                                <div style={{fontSize:13, color:C.fg}}>{c.name}</div>
                                <div style={{fontSize:11, color:C.muted}}>{c.detail}</div>
                              </div>
                              <Icon name="plus" size={13} color={C.mutedFg}/>
                            </button>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                ) : (
                  <button onClick={() => { setAdding(f.id); setQuery(''); }} style={dashLite}>
                    <Icon name="plus" size={13}/>Grant access
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}

      <AuditLogView stageId={stage.id} category="access" seed={[
        { who:'Jana Nováková', at:'2 days ago', text:'granted HR team access to external-frontend-hr' },
        { who:'Tomáš Novák', at:'8 days ago', text:'set Tomáš Novák to owner on external-frontend-hr' },
      ]}/>

      {confirmPublic && (
        <div onClick={() => setConfirmPublic(null)} style={{
          position:'absolute', inset:0, background:'rgba(0,0,0,0.45)', zIndex:1000,
          display:'flex', alignItems:'center', justifyContent:'center', padding:20,
        }}>
          <div onClick={ev => ev.stopPropagation()} style={{
            width:480, maxWidth:'96vw', background:'#fff', border:`1px solid ${C.border}`,
            borderRadius:12, overflow:'hidden', boxShadow:'0 25px 50px -12px rgba(0,0,0,0.35)',
          }}>
            <div style={{padding:'18px 20px 14px', display:'flex', alignItems:'flex-start', gap:12,
                         borderBottom:`1px solid ${C.border}`}}>
              <div style={{width:36, height:36, borderRadius:9999, background:'#fee2e2', flex:'0 0 auto',
                           display:'inline-flex', alignItems:'center', justifyContent:'center'}}>
                <Icon name="globe" size={17} color="#dc2626"/>
              </div>
              <div style={{flex:1, minWidth:0}}>
                <div style={{fontSize:15, fontWeight:700, color:C.fg}}>Make frontend public?</div>
                <div style={{fontSize:13, color:C.muted, marginTop:5, lineHeight:1.55}}>
                  This exposes <strong style={{color:C.fg, fontFamily:'Geist Mono, monospace'}}>{confirmPublic.name}</strong> to
                  anyone on the internet in <strong style={{color:C.fg}}>{stage.label}</strong>. Type the
                  frontend name to confirm.
                </div>
              </div>
            </div>
            <div style={{padding:'16px 20px'}}>
              <input autoFocus value={confirmText} onChange={e => setConfirmText(e.target.value)}
                placeholder={confirmPublic.name}
                style={{width:'100%', boxSizing:'border-box', height:36, padding:'0 12px',
                        border:`1px solid ${C.border}`, borderRadius:7, fontSize:13,
                        fontFamily:'Geist Mono, ui-monospace, monospace', outline:'none', color:C.fg}}/>
            </div>
            <div style={{padding:'12px 20px', borderTop:`1px solid ${C.border}`, background:C.surface,
                         display:'flex', justifyContent:'flex-end', gap:8}}>
              <Btn variant="ghost" size="sm" onClick={() => setConfirmPublic(null)}>Cancel</Btn>
              <button
                disabled={confirmText.trim() !== confirmPublic.name}
                onClick={() => { togglePublic(confirmPublic.id); setConfirmPublic(null); }}
                style={{
                  display:'inline-flex', alignItems:'center', gap:6, height:32, padding:'0 14px',
                  borderRadius:6, fontSize:13, fontWeight:600, fontFamily:'inherit',
                  border:`1px solid ${confirmText.trim()===confirmPublic.name ? '#dc2626' : C.border}`,
                  background: confirmText.trim()===confirmPublic.name ? '#dc2626' : '#fff',
                  color: confirmText.trim()===confirmPublic.name ? '#fff' : C.mutedFg,
                  cursor: confirmText.trim()===confirmPublic.name ? 'pointer' : 'not-allowed',
                }}>
                <Icon name="globe" size={13} color={confirmText.trim()===confirmPublic.name ? '#fff' : C.mutedFg}/>
                Make public
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SupplyChain({ stage, agg, readOnly }) {
  const sev = {
    critical: { bg:'#fee2e2', fg:'#b91c1c', label:'Critical' },
    high:     { bg:'#ffedd5', fg:'#c2410c', label:'High' },
    medium:   { bg:'#fef9c3', fg:'#a16207', label:'Medium' },
    low:      { bg:'#e0f2fe', fg:'#0369a1', label:'Low' },
  };
  const packages = SUPPLY_PACKAGES;
  const me = (window.WD_DATA.CURRENT_USER && window.WD_DATA.CURRENT_USER.name) || 'You';

  // key = `${pkg}:${cveId}` → { by, at, comment }
  const [ignored, setIgnored] = React.useState({});
  const [dialog, setDialog] = React.useState(null);   // { pkg, cve } being marked out of scope
  const [comment, setComment] = React.useState('');
  React.useEffect(() => { setIgnored({}); }, [stage.id]);

  const keyOf = (pkgName, cveId) => `${pkgName}:${cveId}`;
  const isIgnored = (pkgName, cveId) => !!ignored[keyOf(pkgName, cveId)];

  const markOutOfScope = () => {
    if (!dialog || !comment.trim()) return;
    setIgnored(m => ({ ...m, [keyOf(dialog.pkg, dialog.cve.id)]: {
      by: me, at: 'just now', comment: comment.trim() } }));
    setDialog(null); setComment('');
  };
  const restore = (pkgName, cveId) => {
    setIgnored(m => { const n = { ...m }; delete n[keyOf(pkgName, cveId)]; return n; });
  };

  // Only active (non-ignored) CVEs count toward the severity rollup.
  const activeCves = packages.flatMap(p => p.cves.filter(c => !isIgnored(p.name, c.id)));
  const counts = activeCves.reduce((a,c) => ({...a, [c.sev]:(a[c.sev]||0)+1}), {});
  const totalActive = activeCves.length;
  const ignoredEntries = Object.entries(ignored).map(([k, v]) => {
    const [pkgName, cveId] = k.split(':');
    const cve = packages.find(p => p.name === pkgName)?.cves.find(c => c.id === cveId);
    return { pkgName, cveId, sev: cve?.sev, ...v };
  });

  return (
    <div style={{display:'flex', flexDirection:'column', gap:12}}>
      <div style={{display:'flex', alignItems:'center', gap:14, flexWrap:'wrap'}}>
        <div style={{flex:1, minWidth:0, fontSize:12, color:C.muted, lineHeight:1.5}}>
          Packages in the image currently deployed to {stage.label}
          {agg.sha && <> (<span style={{fontFamily:'Geist Mono, monospace'}}>{agg.sha.slice(0,7)}</span>)</>}
          {' '}and known vulnerabilities (CVEs) against them. Click a CVE to mark it out of scope.
        </div>
        <div style={{display:'flex', gap:6}}>
          {['critical','high','medium','low'].map(k => counts[k] ? (
            <span key={k} style={{
              fontSize:11, fontWeight:600, padding:'3px 8px', borderRadius:9999,
              background:sev[k].bg, color:sev[k].fg,
            }}>{counts[k]} {sev[k].label}</span>
          ) : null)}
        </div>
      </div>
      <div style={{
        background:'#fff', border:`1px solid ${C.border}`, borderRadius:10, overflow:'hidden',
      }}>
        <div style={{
          display:'grid', gridTemplateColumns:'1fr 120px 1fr', gap:12, padding:'8px 14px',
          fontSize:10, fontWeight:600, color:C.mutedFg, letterSpacing:0.5, textTransform:'uppercase',
          borderBottom:`1px solid ${C.border}`, background:C.surface,
        }}>
          <span>Package</span><span>Version</span><span>Vulnerabilities</span>
        </div>
        {packages.map((p, i) => (
          <div key={p.name} style={{
            display:'grid', gridTemplateColumns:'1fr 120px 1fr', gap:12, padding:'10px 14px',
            alignItems:'center',
            borderBottom: i < packages.length-1 ? `1px solid ${C.border}` : 'none',
          }}>
            <span style={{fontSize:13, color:C.fg, fontWeight:500,
                          fontFamily:'Geist Mono, ui-monospace, monospace'}}>{p.name}</span>
            <span style={{fontSize:12, color:C.muted,
                          fontFamily:'Geist Mono, ui-monospace, monospace'}}>{p.version}</span>
            <span style={{display:'flex', gap:6, flexWrap:'wrap'}}>
              {p.cves.length === 0
                ? <span style={{fontSize:12, color:'#16a34a', display:'inline-flex',
                                alignItems:'center', gap:4}}><Icon name="check" size={12}/>Clean</span>
                : p.cves.map(c => {
                    const ign = isIgnored(p.name, c.id);
                    const rec = ignored[keyOf(p.name, c.id)];
                    return (
                      <button key={c.id} disabled={readOnly}
                        onClick={readOnly ? undefined
                          : () => ign ? restore(p.name, c.id) : (setDialog({ pkg:p.name, cve:c }), setComment(''))}
                        title={readOnly ? c.id
                               : ign ? `Out of scope — ${rec.comment} (click to restore)`
                                     : 'Click to mark out of scope'}
                        style={{
                          display:'inline-flex', alignItems:'center', gap:5,
                          fontSize:11, fontWeight:600, padding:'2px 7px', borderRadius:9999,
                          border: ign ? `1px dashed ${C.borderHi}` : `1px solid transparent`,
                          background: ign ? C.surface : sev[c.sev].bg,
                          color: ign ? C.mutedFg : sev[c.sev].fg,
                          textDecoration: ign ? 'line-through' : 'none',
                          fontFamily:'Geist Mono, ui-monospace, monospace',
                          cursor: readOnly ? 'default' : 'pointer',
                        }}>
                        <span style={{width:6, height:6, borderRadius:9999,
                                      background: ign ? C.mutedFg : sev[c.sev].fg}}/>
                        {c.id}
                        {ign && <Icon name="eye-off" size={11} color={C.mutedFg}/>}
                      </button>
                    );
                  })}
            </span>
          </div>
        ))}
      </div>
      <div style={{fontSize:11, color:C.muted}}>
        {packages.length} packages · {totalActive} in-scope {totalActive === 1 ? 'CVE' : 'CVEs'}
        {ignoredEntries.length > 0 && <> · {ignoredEntries.length} marked out of scope</>}
        {' '}· scanned against the deployed image
      </div>

      {/* Out-of-scope audit log */}
      {ignoredEntries.length > 0 && (
        <div style={{
          background:'#fff', border:`1px solid ${C.border}`, borderRadius:10, overflow:'hidden',
        }}>
          <div style={{
            padding:'10px 14px', borderBottom:`1px solid ${C.border}`, background:C.surface,
            fontSize:11, fontWeight:600, color:C.mutedFg, letterSpacing:0.5, textTransform:'uppercase',
            display:'flex', alignItems:'center', gap:6,
          }}>
            <Icon name="eye-off" size={12} color={C.mutedFg}/>Out of scope — audit log
          </div>
          {ignoredEntries.map((e, i) => (
            <div key={i} style={{
              display:'flex', alignItems:'flex-start', gap:10, padding:'11px 14px',
              borderBottom: i < ignoredEntries.length-1 ? `1px solid ${C.border}` : 'none',
            }}>
              <span style={{
                fontSize:11, fontWeight:600, padding:'2px 7px', borderRadius:9999, flex:'0 0 auto',
                background: e.sev ? sev[e.sev].bg : C.surface2, color: e.sev ? sev[e.sev].fg : C.muted,
                fontFamily:'Geist Mono, monospace', marginTop:1,
              }}>{e.cveId}</span>
              <div style={{flex:1, minWidth:0}}>
                <div style={{fontSize:12.5, color:'#3f3f46', lineHeight:1.5}}>
                  <span style={{fontFamily:'Geist Mono, monospace', color:C.muted}}>{e.pkgName}</span>
                  {' — '}{e.comment}
                </div>
                <div style={{fontSize:11, color:C.mutedFg, marginTop:2}}>
                  Marked out of scope by <strong style={{color:C.fg, fontWeight:600}}>{e.by}</strong> · {e.at}
                </div>
              </div>
              <button onClick={() => restore(e.pkgName, e.cveId)} title="Restore to in-scope" style={{
                display:'inline-flex', alignItems:'center', gap:5, height:28, padding:'0 10px',
                background:'#fff', border:`1px solid ${C.border}`, borderRadius:6,
                fontSize:11, fontWeight:500, color:C.fg, fontFamily:'inherit', cursor:'pointer',
              }}><Icon name="undo-2" size={12}/>Restore</button>
            </div>
          ))}
        </div>
      )}

      {/* Mark-out-of-scope dialog */}
      {dialog && (
        <div onClick={() => setDialog(null)} style={{
          position:'absolute', inset:0, background:'rgba(0,0,0,0.45)', zIndex:1000,
          display:'flex', alignItems:'center', justifyContent:'center', padding:'40px 20px',
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            width:480, maxWidth:'96%', background:'#fff', border:`1px solid ${C.border}`,
            borderRadius:12, overflow:'hidden', boxShadow:'0 25px 50px -12px rgba(0,0,0,0.35)',
          }}>
            <div style={{padding:'16px 20px 14px', borderBottom:`1px solid ${C.border}`,
                         display:'flex', alignItems:'center', gap:12}}>
              <div style={{width:34, height:34, borderRadius:8, background:sev[dialog.cve.sev].bg,
                           flex:'0 0 auto', display:'inline-flex', alignItems:'center', justifyContent:'center'}}>
                <Icon name="shield-off" size={16} color={sev[dialog.cve.sev].fg}/>
              </div>
              <div style={{flex:1, minWidth:0}}>
                <div style={{fontSize:15, fontWeight:700, color:C.fg}}>Mark CVE out of scope</div>
                <div style={{fontSize:12, color:C.muted, marginTop:1, fontFamily:'Geist Mono, monospace'}}>
                  {dialog.cve.id} · {dialog.pkg}
                </div>
              </div>
            </div>
            <div style={{padding:'16px 20px', display:'flex', flexDirection:'column', gap:10}}>
              <div style={{fontSize:13, color:'#3f3f46', lineHeight:1.5}}>
                This CVE will be ignored in the {stage.label} risk rollup. A justification is
                required and recorded in the audit log against your name.
              </div>
              <textarea autoFocus value={comment} onChange={e => setComment(e.target.value)}
                placeholder="Why is this not exploitable here? e.g. the vulnerable code path is never reached…"
                rows={3}
                style={{width:'100%', boxSizing:'border-box', padding:'10px 12px',
                        border:`1px solid ${C.border}`, borderRadius:8, fontSize:13,
                        fontFamily:'inherit', lineHeight:1.5, color:C.fg, outline:'none', resize:'vertical'}}/>
            </div>
            <div style={{padding:'12px 20px', borderTop:`1px solid ${C.border}`, background:C.surface,
                         display:'flex', justifyContent:'flex-end', gap:8}}>
              <Btn variant="ghost" size="sm" onClick={() => setDialog(null)}>Cancel</Btn>
              <button disabled={!comment.trim()} onClick={markOutOfScope} style={{
                display:'inline-flex', alignItems:'center', gap:6, height:32, padding:'0 14px',
                borderRadius:6, fontSize:13, fontWeight:600, fontFamily:'inherit',
                border:`1px solid ${comment.trim() ? C.fg : C.border}`,
                background: comment.trim() ? C.fg : '#fff',
                color: comment.trim() ? '#fff' : C.mutedFg,
                cursor: comment.trim() ? 'pointer' : 'not-allowed',
              }}>
                <Icon name="eye-off" size={13} color={comment.trim() ? '#fff' : C.mutedFg}/>
                Mark out of scope
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Stage pipeline where each bubble is a TAB selecting the visible card ────
function StageAudits({ stage, bp }) {
  // Policy: who must sign off before promotion to production.
  const [audits, setAudits] = React.useState([]);
  React.useEffect(() => {
    setAudits([
      { id:'a1', who:'security-agent', role:'Automated security scan', kind:'agent',
        status:'approved', at:'approved 2 days ago', note:'No critical CVEs, no secrets in diff.' },
      { id:'a2', who:'Jana Novákova', role:'Engineering lead', kind:'human',
        status:'approved', at:'signed off 1 day ago', note:'Payroll logic reviewed — looks correct.' },
      { id:'a3', who:'Compliance officer', role:'Required by policy', kind:'human',
        status:'pending', at:'awaiting sign-off', note:'' },
    ]);
  }, [stage.id, bp.id]);

  const required = audits.length;
  const done = audits.filter(a => a.status === 'approved').length;
  const allSigned = done === required;

  const meta = {
    approved: { bg:'#dcfce7', fg:'#15803d', label:'Approved', icon:'check' },
    pending:  { bg:'#fef9c3', fg:'#a16207', label:'Pending', icon:'clock' },
    rejected: { bg:'#fee2e2', fg:'#b91c1c', label:'Changes requested', icon:'x' },
  };

  return (
    <div style={{display:'flex', flexDirection:'column', gap:12}}>
      {/* Policy banner */}
      <div style={{
        padding:'12px 14px', borderRadius:10,
        background: allSigned ? '#dcfce7' : '#eff6ff',
        border:`1px solid ${allSigned ? '#86efac' : '#bfdbfe'}`,
        display:'flex', alignItems:'center', gap:10,
      }}>
        <Icon name={allSigned ? 'shield-check' : 'gavel'} size={16}
              color={allSigned ? '#15803d' : '#1d4ed8'}/>
        <div style={{flex:1, minWidth:0, fontSize:13, color:'#3f3f46', lineHeight:1.5}}>
          <strong style={{color:C.fg}}>Promotion policy:</strong> code must be audited and
          signed off by all required reviewers before it can be promoted from Staging to Production.
          {' '}<strong style={{color: allSigned ? '#15803d' : '#1d4ed8'}}>{done} of {required} complete.</strong>
        </div>
      </div>

      {audits.map(a => {
        const m = meta[a.status];
        return (
          <div key={a.id} style={{
            background:'#fff', border:`1px solid ${C.border}`, borderRadius:10,
            padding:'12px 14px', display:'flex', alignItems:'flex-start', gap:12,
          }}>
            <div style={{
              width:32, height:32, borderRadius:'50%', flex:'0 0 auto',
              background: a.kind === 'agent' ? '#dbeafe' : C.surface2,
              display:'inline-flex', alignItems:'center', justifyContent:'center',
            }}>
              <Icon name={a.kind === 'agent' ? 'bot' : 'user'} size={15}
                    color={a.kind === 'agent' ? '#1d4ed8' : C.muted}/>
            </div>
            <div style={{flex:1, minWidth:0}}>
              <div style={{display:'flex', alignItems:'center', gap:8, flexWrap:'wrap'}}>
                <span style={{fontSize:13, fontWeight:600, color:C.fg}}>{a.who}</span>
                <span style={{fontSize:11, color:C.muted}}>· {a.role}</span>
                <span style={{
                  display:'inline-flex', alignItems:'center', gap:4,
                  fontSize:10, fontWeight:700, padding:'1px 7px', borderRadius:9999,
                  background:m.bg, color:m.fg, letterSpacing:0.3, textTransform:'uppercase',
                }}>
                  <Icon name={m.icon} size={10}/>{m.label}
                </span>
              </div>
              <div style={{fontSize:12, color:C.muted, marginTop:3}}>{a.at}</div>
              {a.note && (
                <div style={{fontSize:12, color:'#3f3f46', marginTop:6, lineHeight:1.5,
                             paddingLeft:10, borderLeft:`2px solid ${C.border}`}}>{a.note}</div>
              )}
              {a.status === 'pending' && (
                <div style={{display:'flex', gap:6, marginTop:10}}>
                  <button
                    onClick={() => setAudits(audits.map(x => x.id === a.id
                      ? {...x, status:'approved', at:'signed off just now'} : x))}
                    style={{
                      display:'inline-flex', alignItems:'center', gap:6, height:30, padding:'0 12px',
                      background:C.primary, color:'#fff', border:`1px solid ${C.primary}`, borderRadius:6,
                      fontSize:11, fontWeight:600, fontFamily:'inherit', cursor:'pointer',
                    }}><Icon name="check" size={13}/>Sign off</button>
                  <button
                    onClick={() => setAudits(audits.map(x => x.id === a.id
                      ? {...x, status:'rejected', at:'changes requested just now'} : x))}
                    style={{
                      display:'inline-flex', alignItems:'center', gap:6, height:30, padding:'0 12px',
                      background:'#fff', color:'#b91c1c', border:`1px solid ${C.border}`, borderRadius:6,
                      fontSize:11, fontWeight:600, fontFamily:'inherit', cursor:'pointer',
                    }}><Icon name="x" size={13}/>Request changes</button>
                  <button
                    title="Ask a coding agent to audit this change"
                    style={{
                      display:'inline-flex', alignItems:'center', gap:6, height:30, padding:'0 12px',
                      background:'#fff', color:C.fg, border:`1px solid ${C.border}`, borderRadius:6,
                      fontSize:11, fontWeight:500, fontFamily:'inherit', cursor:'pointer',
                    }}><Icon name="bot" size={13}/>Ask agent to audit</button>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Stage pipeline where each bubble is a TAB selecting the visible card ────
function StagePipelineTabs({ aggs, activeStage, onSelect, onPromote }) {
  // Flex row: [node] [line] [promote] [line] [node] [line] [promote] [line] [node]
  // Line segments are flex:1 so they connect node↔promote edges exactly — no
  // guessed percentages, nothing overshoots.
  const line = (key) => (
    <div key={key} style={{ flex:1, height:2, background:C.border }}/>
  );
  const items = [];
  aggs.forEach(({ stage, agg, alert }, i) => {
    const active = stage.id === activeStage;
    items.push(
      <button
        key={stage.id}
        onClick={() => onSelect(stage.id)}
        title={alert ? 'Disaster-recovery test overdue — click to test now' : undefined}
        style={{
          appearance:'none', border:'none', background:'transparent',
          position:'relative', flex:'0 0 auto',
          display:'flex', flexDirection:'column', alignItems:'center',
          padding:0, cursor:'pointer', fontFamily:'inherit',
        }}
      >
        <span style={{
          position:'absolute', bottom:'calc(100% + 8px)', left:'50%',
          transform:'translateX(-50%)', whiteSpace:'nowrap',
          fontSize:11, fontWeight:700, letterSpacing:0.8, textTransform:'uppercase',
          color: alert ? '#b45309' : active ? C.fg : C.mutedFg,
        }}>{stage.label}</span>
        <span style={{ borderRadius:9999,
                       boxShadow: active ? `0 0 0 4px ${alert ? '#f59e0b' : C.primary}` : 'none' }}>
          <StageNode stage={stage} agg={agg} alert={alert}/>
        </span>
        {active && (
          <span style={{
            position:'absolute', top:'100%', left:'50%', transform:'translateX(-50%)',
            width:2, height:22, background: alert ? '#f59e0b' : C.primary,
          }}/>
        )}
      </button>
    );
    if (i < aggs.length - 1) {
      const next = aggs[i+1];
      items.push(line(`l1-${i}`));
      if (next.stage.id === 'dr') {
        // DR isn't "promoted" into — it's seeded by restoring production's DB.
        items.push(
          <button key={`restore-${i}`} onClick={() => onSelect('dr')}
            title="Restore Production's database into Disaster Recovery (Production stays live)"
            style={{
              flex:'0 0 auto', display:'inline-flex', alignItems:'center', gap:6,
              height:30, padding:'0 12px', background:'#fff',
              border:`1px dashed ${C.borderHi}`, borderRadius:9999,
              fontSize:11, fontWeight:600, color:C.muted, fontFamily:'inherit',
              letterSpacing:0.3, textTransform:'uppercase', cursor:'pointer',
            }}>
            <Icon name="database-backup" size={13} color={C.muted}/>
            Restore
          </button>
        );
      } else {
        items.push(
          <div key={`p-${i}`} style={{ flex:'0 0 auto' }}>
            <AggregatePromote
              from={stage} to={next.stage}
              fromAgg={agg} toAgg={next.agg}
              onPromote={() => onPromote?.(stage.id, next.stage.id)}
            />
          </div>
        );
      }
      items.push(line(`l2-${i}`));
    }
  });
  return (
    <div style={{
      position:'relative', padding:'28px 44px 0',
      display:'flex', alignItems:'center', gap:8,
    }}>
      {items}
    </div>
  );
}

// ── Disaster-recovery manual-test panel ─────────────────────────────────────
function DisasterRecovery({ bp, frontends = [], onChange }) {
  const [, force] = React.useReducer(x => x + 1, 0);
  const store = drStore(bp.id);
  const status = drStatus(bp.id);
  const me = (window.WD_DATA.CURRENT_USER && window.WD_DATA.CURRENT_USER.name) || 'You';
  const [run, setRun] = React.useState(null); // test wizard state | null
  const [swap, setSwap] = React.useState(null); // swap confirm state | null
  const bump = () => { force(); onChange && onChange(); };

  const setPolicy = (p) => { store.policy = p; bump(); };

  // Production snapshots you can restore into DR for a test.
  const prodSnapshots = [
    { id:'snap-live', label:'Latest (live Production)', at:'continuous replication', size:'1.4 GB' },
    { id:'snap-3',    label:'Before last deploy',       at:'2 days ago',  size:'1.4 GB' },
    { id:'snap-2',    label:'Pre-migration',            at:'5 days ago',  size:'1.3 GB' },
    { id:'snap-1',    label:'Nightly',                  at:'6 days ago',  size:'1.3 GB' },
  ];

  const startTest = () => setRun({ didRestore: false, didVerify: false, note: '',
                                   snapId: prodSnapshots[0].id });
  const recordTest = () => {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const at = now.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
    const snap = prodSnapshots.find(s => s.id === run.snapId);
    const snapNote = snap ? `Restored "${snap.label}" snapshot. ` : '';
    store.tests = [{ id:`dr${Date.now()}`, by: me, role:'', at, date, verified:true,
                     note: snapNote + (run.note.trim() || 'Recovery procedure performed and data verified in the UI.') },
                   ...store.tests];
    setRun(null); bump();
  };

  const overdue = status.overdue;
  const lastTxt = status.last
    ? `${status.last.at} by ${status.last.by}` : 'never';

  return (
    <div style={{display:'flex', flexDirection:'column', gap:14}}>
      {/* What DR is */}
      <div style={{fontSize:12.5, color:C.muted, lineHeight:1.55}}>
        Disaster Recovery mirrors <strong style={{color:C.fg}}>Production</strong> — same code, secrets and
        firewall rules — but runs against its <strong style={{color:C.fg}}>own isolated database</strong>.
        Restoring copies Production's data <em>into DR</em> (Production is untouched) so you can rehearse
        recovery and confirm, by hand, that nothing is missing. Only if you ever need to go live do you
        then <strong style={{color:C.fg}}>swap DR with Production</strong>. Routine quarterly testing
        restores &amp; verifies — it does <strong style={{color:C.fg}}>not</strong> swap. DR is deliberately
        <strong style={{color:C.fg}}> never backed up</strong>.
      </div>

      {/* Status + policy banner */}
      <div style={{
        display:'flex', alignItems:'center', gap:14, flexWrap:'wrap',
        padding:'14px 16px', borderRadius:10,
        background: overdue ? '#fffbeb' : '#f0fdf4',
        border: `1px solid ${overdue ? '#fcd34d' : '#86efac'}`,
      }}>
        <Icon name={overdue ? 'alert-triangle' : 'shield-check'} size={20}
              color={overdue ? '#d97706' : '#16a34a'}/>
        <div style={{flex:1, minWidth:200}}>
          <div style={{fontSize:14, fontWeight:700, color: overdue ? '#92400e' : '#15803d'}}>
            {overdue
              ? (status.daysSince == null
                  ? 'Never tested — recovery unverified'
                  : `Recovery test overdue by ${status.daysSince - status.window} days`)
              : `Recovery verified · last tested ${status.daysSince} days ago`}
          </div>
          <div style={{fontSize:12, color: overdue ? '#92400e' : '#166534', marginTop:2}}>
            Last manual check: {lastTxt} · policy: {DR_WINDOW_LABEL[store.policy]}
          </div>
        </div>
        <div style={{display:'flex', alignItems:'center', gap:8}}>
          <label style={{fontSize:11, color:C.muted, fontWeight:600}}>Check every</label>
          <select value={store.policy} onChange={e => setPolicy(e.target.value)}
            style={{
              height:32, padding:'0 8px', borderRadius:7, border:`1px solid ${C.border}`,
              background:'#fff', color:C.fg, fontSize:12, fontWeight:500,
              fontFamily:'inherit', cursor:'pointer',
            }}>
            {Object.keys(DR_WINDOW_DAYS).map(p => (
              <option key={p} value={p}>{DR_WINDOW_LABEL[p]}</option>
            ))}
          </select>
          <button onClick={startTest} style={{
            display:'inline-flex', alignItems:'center', gap:6, height:32, padding:'0 14px',
            borderRadius:7, fontSize:12.5, fontWeight:600, fontFamily:'inherit', cursor:'pointer',
            border:`1px solid ${overdue ? '#d97706' : C.primary}`,
            background: overdue ? '#d97706' : C.primary, color:'#fff',
          }}>
            <Icon name="play" size={13} color="#fff"/>
            Test recovery
          </button>
        </div>
      </div>

      {/* Go-live swap — separate, heavier action; NOT part of routine testing */}
      <div style={{
        display:'flex', alignItems:'center', gap:14, flexWrap:'wrap',
        padding:'14px 16px', borderRadius:10, background:'#fff',
        border:`1px solid ${C.border}`,
      }}>
        <div style={{
          width:38, height:38, borderRadius:9999, flex:'0 0 auto', background:'#fef2f2',
          display:'inline-flex', alignItems:'center', justifyContent:'center',
        }}>
          <Icon name="arrow-left-right" size={18} color="#dc2626"/>
        </div>
        <div style={{flex:1, minWidth:220}}>
          <div style={{fontSize:13.5, fontWeight:700, color:C.fg}}>Swap with Production</div>
          <div style={{fontSize:12, color:C.muted, marginTop:2, lineHeight:1.5}}>
            Go live on the recovered environment with zero downtime — DR becomes Production and the
            old Production becomes the standby. Only do this in a real disaster, after verifying the data.
          </div>
        </div>
        <button onClick={() => setSwap({ ack:false })} style={{
          flex:'0 0 auto',
          display:'inline-flex', alignItems:'center', gap:6, height:34, padding:'0 14px',
          borderRadius:7, fontSize:12.5, fontWeight:600, fontFamily:'inherit', cursor:'pointer',
          border:`1px solid ${C.border}`, background:'#fff', color:'#b91c1c',
        }}>
          <Icon name="arrow-left-right" size={14} color="#dc2626"/>
          Swap with Production
        </button>
      </div>

      {/* Manual-test log */}
      <div style={{
        background:'#fff', border:`1px solid ${C.border}`, borderRadius:10, overflow:'hidden',
      }}>
        <div style={{
          padding:'10px 14px', borderBottom:`1px solid ${C.border}`, background:C.surface,
          fontSize:11, fontWeight:600, color:C.mutedFg, letterSpacing:0.5, textTransform:'uppercase',
          display:'flex', alignItems:'center', gap:6,
        }}>
          <Icon name="clipboard-check" size={12} color={C.mutedFg}/>Manual recovery tests
          <span style={{marginLeft:'auto', textTransform:'none', letterSpacing:0,
                        fontWeight:500, color:C.muted}}>{store.tests.length} recorded</span>
        </div>
        {store.tests.length === 0 && (
          <div style={{padding:'24px', textAlign:'center', color:C.muted, fontSize:13}}>
            No recovery tests recorded yet.
          </div>
        )}
        {store.tests.map((t, i) => (
          <div key={t.id} style={{
            display:'flex', alignItems:'flex-start', gap:12, padding:'12px 14px',
            borderBottom: i < store.tests.length-1 ? `1px solid ${C.border}` : 'none',
          }}>
            <div style={{
              width:30, height:30, borderRadius:9999, flex:'0 0 auto', background:'#dcfce7',
              display:'inline-flex', alignItems:'center', justifyContent:'center',
            }}>
              <Icon name="check" size={15} color="#16a34a"/>
            </div>
            <div style={{flex:1, minWidth:0}}>
              <div style={{fontSize:13, color:C.fg}}>
                <strong style={{fontWeight:600}}>{t.by}</strong>
                {t.role && <span style={{color:C.muted, fontWeight:400}}> · {t.role}</span>}
                <span style={{color:C.muted, fontWeight:400}}> verified the recovery</span>
              </div>
              {t.note && (
                <div style={{fontSize:12, color:'#3f3f46', marginTop:3, lineHeight:1.5,
                             paddingLeft:10, borderLeft:`2px solid ${C.border}`}}>{t.note}</div>
              )}
            </div>
            <span style={{fontSize:11, color:C.mutedFg, whiteSpace:'nowrap'}}>{t.at}</span>
          </div>
        ))}
      </div>

      {/* Run-test wizard */}
      {run && (
        <div onClick={() => setRun(null)} style={{
          position:'absolute', inset:0, background:'rgba(0,0,0,0.45)', zIndex:1000,
          display:'flex', alignItems:'center', justifyContent:'center', padding:'40px 20px',
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            width:520, maxWidth:'96%', background:'#fff', border:`1px solid ${C.border}`,
            borderRadius:12, overflow:'hidden', boxShadow:'0 25px 50px -12px rgba(0,0,0,0.35)',
          }}>
            <div style={{padding:'16px 20px 14px', borderBottom:`1px solid ${C.border}`,
                         display:'flex', alignItems:'center', gap:12}}>
              <div style={{width:34, height:34, borderRadius:8, background:C.surface2, flex:'0 0 auto',
                           display:'inline-flex', alignItems:'center', justifyContent:'center'}}>
                <Icon name="life-buoy" size={17} color={C.fg}/>
              </div>
              <div style={{flex:1, minWidth:0}}>
                <div style={{fontSize:15, fontWeight:700, color:C.fg}}>Test disaster recovery</div>
                <div style={{fontSize:12, color:C.muted, marginTop:1}}>{bp.name} · DR environment</div>
              </div>
              <button onClick={() => setRun(null)} style={{
                width:30, height:30, border:0, background:'transparent', cursor:'pointer', color:C.muted,
                display:'inline-flex', alignItems:'center', justifyContent:'center'}}>
                <Icon name="x" size={16}/></button>
            </div>

            <div style={{padding:'16px 20px', display:'flex', flexDirection:'column', gap:14}}>
              {/* Step 1: restore */}
              <div style={{display:'flex', gap:12}}>
                <StepDot done={run.didRestore} n={1}/>
                <div style={{flex:1}}>
                  <div style={{fontSize:13.5, fontWeight:600, color:C.fg}}>Restore Production database</div>
                  <div style={{fontSize:12, color:C.muted, marginTop:2, lineHeight:1.5}}>
                    Copies a Production Postgres + MinIO snapshot into the isolated DR database.
                    Production is untouched.
                  </div>
                  {/* Snapshot picker */}
                  <div style={{marginTop:10, display:'flex', flexDirection:'column', gap:6}}>
                    <label style={{fontSize:11, fontWeight:600, color:C.mutedFg, letterSpacing:0.3,
                                   textTransform:'uppercase'}}>Snapshot to test</label>
                    {prodSnapshots.map(s => {
                      const sel = run.snapId === s.id;
                      return (
                        <button key={s.id} disabled={run.didRestore}
                          onClick={() => setRun(r => ({ ...r, snapId:s.id }))}
                          style={{
                            display:'flex', alignItems:'center', gap:10, textAlign:'left',
                            padding:'8px 10px', borderRadius:7, cursor: run.didRestore ? 'default' : 'pointer',
                            border:`1px solid ${sel ? C.primary : C.border}`,
                            background: sel ? C.primarySoft : '#fff', fontFamily:'inherit',
                            opacity: run.didRestore && !sel ? 0.5 : 1,
                          }}>
                          <span style={{
                            width:16, height:16, borderRadius:9999, flex:'0 0 auto',
                            border:`2px solid ${sel ? C.primary : C.borderHi}`,
                            display:'inline-flex', alignItems:'center', justifyContent:'center',
                          }}>
                            {sel && <span style={{width:7, height:7, borderRadius:9999, background:C.primary}}/>}
                          </span>
                          <Icon name="archive" size={14} color={C.muted}/>
                          <span style={{flex:1, minWidth:0}}>
                            <span style={{fontSize:13, fontWeight:600, color:C.fg}}>{s.label}</span>
                            <span style={{fontSize:11, color:C.muted, marginLeft:8,
                                          fontFamily:'Geist Mono, monospace'}}>{s.at} · {s.size}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {!run.didRestore ? (
                    <button onClick={() => setRun(r => ({ ...r, didRestore:true }))} style={{
                      marginTop:10, display:'inline-flex', alignItems:'center', gap:6, height:30,
                      padding:'0 12px', borderRadius:6, fontSize:12, fontWeight:600, cursor:'pointer',
                      border:`1px solid ${C.primary}`, background:C.primary, color:'#fff', fontFamily:'inherit',
                    }}>
                      <Icon name="database-backup" size={13} color="#fff"/>Restore selected snapshot
                    </button>
                  ) : (
                    <div style={{marginTop:10, fontSize:12, color:'#15803d', fontWeight:600,
                                 display:'inline-flex', alignItems:'center', gap:6}}>
                      <Icon name="check" size={13} color="#16a34a"/>
                      Restored “{prodSnapshots.find(s => s.id === run.snapId)?.label}” into DR
                    </div>
                  )}
                </div>
              </div>

              {/* Step 2: verify */}
              <div style={{display:'flex', gap:12, opacity: run.didRestore ? 1 : 0.45,
                           pointerEvents: run.didRestore ? 'auto' : 'none'}}>
                <StepDot done={run.didVerify} n={2}/>
                <div style={{flex:1}}>
                  <div style={{fontSize:13.5, fontWeight:600, color:C.fg}}>Verify the data by hand</div>
                  <div style={{fontSize:12, color:C.muted, marginTop:2, lineHeight:1.5}}>
                    Open each DR frontend and confirm the data that should be there really is.
                  </div>
                  <div style={{marginTop:8, display:'flex', flexWrap:'wrap', gap:8}}>
                    {(frontends.length ? frontends : [{ id:'app', name:'app', kind:'frontend-public' }]).map(f => {
                      const m = window.WD_DATA.KIND_META[f.kind] || { icon:'globe', color:C.muted };
                      return (
                        <a key={f.id} href={`https://${f.name}-dr.harmonum.ai`} target="_blank" rel="noreferrer"
                          style={{
                            display:'inline-flex', alignItems:'center', gap:6, height:30,
                            padding:'0 12px', borderRadius:6, fontSize:12, fontWeight:500, textDecoration:'none',
                            border:`1px solid ${C.border}`, background:'#fff', color:C.fg, fontFamily:'inherit',
                          }}>
                          <Icon name={m.icon} size={13} color={m.color}/>
                          {f.name}
                          <Icon name="external-link" size={12} color={C.mutedFg}/>
                        </a>
                      );
                    })}
                  </div>
                  <label style={{
                    marginTop:10, display:'flex', alignItems:'flex-start', gap:9, cursor:'pointer',
                  }}>
                    <input type="checkbox" checked={run.didVerify}
                      onChange={e => setRun(r => ({ ...r, didVerify:e.target.checked }))}
                      style={{marginTop:2, cursor:'pointer'}}/>
                    <span style={{fontSize:13, color:C.fg, lineHeight:1.45}}>
                      I performed the recovery procedure and confirmed in the UI that the expected
                      data is present and correct.
                    </span>
                  </label>
                  <textarea value={run.note} onChange={e => setRun(r => ({ ...r, note:e.target.value }))}
                    placeholder="Optional notes — what you checked, anything unexpected…" rows={2}
                    style={{
                      marginTop:10, width:'100%', boxSizing:'border-box', padding:'8px 10px',
                      border:`1px solid ${C.border}`, borderRadius:7, fontSize:13, fontFamily:'inherit',
                      lineHeight:1.5, color:C.fg, outline:'none', resize:'vertical',
                    }}/>
                </div>
              </div>
            </div>

            <div style={{padding:'12px 20px', borderTop:`1px solid ${C.border}`, background:C.surface,
                         display:'flex', justifyContent:'flex-end', gap:8}}>
              <Btn variant="ghost" size="sm" onClick={() => setRun(null)}>Cancel</Btn>
              <button disabled={!run.didRestore || !run.didVerify} onClick={recordTest} style={{
                display:'inline-flex', alignItems:'center', gap:6, height:32, padding:'0 14px',
                borderRadius:6, fontSize:13, fontWeight:600, fontFamily:'inherit',
                border:`1px solid ${run.didRestore && run.didVerify ? '#16a34a' : C.border}`,
                background: run.didRestore && run.didVerify ? '#16a34a' : '#fff',
                color: run.didRestore && run.didVerify ? '#fff' : C.mutedFg,
                cursor: run.didRestore && run.didVerify ? 'pointer' : 'not-allowed',
              }}>
                <Icon name="check" size={13} color={run.didRestore && run.didVerify ? '#fff' : C.mutedFg}/>
                Record verified test
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Swap-with-production confirm */}
      {swap && (
        <div onClick={() => setSwap(null)} style={{
          position:'absolute', inset:0, background:'rgba(0,0,0,0.45)', zIndex:1000,
          display:'flex', alignItems:'center', justifyContent:'center', padding:'40px 20px',
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            width:500, maxWidth:'96%', background:'#fff', border:`1px solid ${C.border}`,
            borderRadius:12, overflow:'hidden', boxShadow:'0 25px 50px -12px rgba(0,0,0,0.35)',
          }}>
            <div style={{padding:'16px 20px 14px', borderBottom:`1px solid ${C.border}`,
                         display:'flex', alignItems:'center', gap:12}}>
              <div style={{width:34, height:34, borderRadius:8, background:'#fef2f2', flex:'0 0 auto',
                           display:'inline-flex', alignItems:'center', justifyContent:'center'}}>
                <Icon name="arrow-left-right" size={17} color="#dc2626"/>
              </div>
              <div style={{flex:1, minWidth:0}}>
                <div style={{fontSize:15, fontWeight:700, color:C.fg}}>Swap DR with Production</div>
                <div style={{fontSize:12, color:C.muted, marginTop:1}}>{bp.name} · zero-downtime cutover</div>
              </div>
              <button onClick={() => setSwap(null)} style={{
                width:30, height:30, border:0, background:'transparent', cursor:'pointer', color:C.muted,
                display:'inline-flex', alignItems:'center', justifyContent:'center'}}>
                <Icon name="x" size={16}/></button>
            </div>
            <div style={{padding:'16px 20px', display:'flex', flexDirection:'column', gap:12}}>
              <div style={{fontSize:13, color:'#3f3f46', lineHeight:1.55}}>
                Traffic will be flipped to the Disaster Recovery environment with no downtime. DR becomes
                the live <strong style={{color:C.fg}}>Production</strong>, and today's Production is demoted
                to standby. This is a real go-live — only proceed during an actual disaster, not for routine
                testing.
              </div>
              {!status.overdue ? (
                <div style={{fontSize:12, color:'#15803d', display:'flex', alignItems:'center', gap:6}}>
                  <Icon name="shield-check" size={14} color="#16a34a"/>
                  Recovery was verified {status.daysSince} days ago.
                </div>
              ) : (
                <div style={{fontSize:12, color:'#92400e', display:'flex', alignItems:'flex-start', gap:6,
                             background:'#fffbeb', border:'1px solid #fcd34d', borderRadius:8, padding:'8px 10px'}}>
                  <Icon name="alert-triangle" size={14} color="#d97706"/>
                  Recovery hasn't been verified within the policy window — swap only if you've confirmed the
                  DR data is good.
                </div>
              )}
              <label style={{display:'flex', alignItems:'flex-start', gap:9, cursor:'pointer'}}>
                <input type="checkbox" checked={swap.ack}
                  onChange={e => setSwap(s => ({ ...s, ack:e.target.checked }))}
                  style={{marginTop:2, cursor:'pointer'}}/>
                <span style={{fontSize:13, color:C.fg, lineHeight:1.45}}>
                  I understand this makes Disaster Recovery the live Production environment.
                </span>
              </label>
            </div>
            <div style={{padding:'12px 20px', borderTop:`1px solid ${C.border}`, background:C.surface,
                         display:'flex', justifyContent:'flex-end', gap:8}}>
              <Btn variant="ghost" size="sm" onClick={() => setSwap(null)}>Cancel</Btn>
              <button disabled={!swap.ack} onClick={() => setSwap(null)} style={{
                display:'inline-flex', alignItems:'center', gap:6, height:32, padding:'0 14px',
                borderRadius:6, fontSize:13, fontWeight:600, fontFamily:'inherit',
                border:`1px solid ${swap.ack ? '#dc2626' : C.border}`,
                background: swap.ack ? '#dc2626' : '#fff', color: swap.ack ? '#fff' : C.mutedFg,
                cursor: swap.ack ? 'pointer' : 'not-allowed',
              }}>
                <Icon name="arrow-left-right" size={13} color={swap.ack ? '#fff' : C.mutedFg}/>
                Swap now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StepDot({ done, n }) {
  return (
    <div style={{
      width:24, height:24, borderRadius:9999, flex:'0 0 auto', marginTop:1,
      display:'inline-flex', alignItems:'center', justifyContent:'center',
      fontSize:12, fontWeight:700,
      background: done ? '#16a34a' : C.surface2, color: done ? '#fff' : C.muted,
    }}>
      {done ? <Icon name="check" size={13} color="#fff"/> : n}
    </div>
  );
}

// ── Rich single-stage card: status, app links, secrets + history inline ────
function RichStageCard({ bp, stage, agg, frontends, aut, containers = [], onInspect, onDrChange, onSelectStage }) {
  const { SecretsEditor, DeploymentCard, ScaleEventRow, synthHistory, parseDate, DiffPanel } = window.WD_OVERLAYS;
  const isDr = stage.id === 'dr';
  const effId = stageDataId(stage.id);  // DR mirrors production's data
  const [section, setSection] = React.useState(isDr ? 'recovery' : 'history');
  const [diffShas, setDiffShas] = React.useState(null);
  const [openLogs, setOpenLogs] = React.useState(null); // container id with logs open
  const [openInspect, setOpenInspect] = React.useState(null); // container id with docker-inspect open
  const [snapshots, setSnapshots] = React.useState([]);
  const [fwRules, setFwRules] = React.useState([]);
  const [fwRecords, setFwRecords] = React.useState({}); // host -> GDPR record
  const [fwApprove, setFwApprove] = React.useState(null); // rule being approved
  const [fwView, setFwView] = React.useState(null); // host whose record is shown
  React.useEffect(() => {
    setFwRules([
      { id:'fw1', host:'sentry.io', purpose:'Error reporting', status:'allowed', at:'allowed 8 days ago' },
      { id:'fw2', host:'api.toggl.com', purpose:'Time-tracking sync', status:'allowed', at:'allowed 3 days ago' },
      { id:'fw3', host:'hooks.slack.com', purpose:'Deploy notifications', status:'allowed', at:'allowed 8 days ago' },
      { id:'fw4', host:'api.openai.com', purpose:'Outbound request', status:'blocked', decided:false, at:'2 hours ago · 3 attempts' },
      { id:'fw5', host:'pypi.org', purpose:'Outbound request', status:'blocked', decided:false, at:'yesterday · 1 attempt' },
      { id:'fw6', host:'evil-tracker.example', purpose:'Outbound request', status:'denied', decided:true, at:'denied 4 days ago' },
    ]);
    setFwRecords({
      'sentry.io': { host:'sentry.io', dataSent:'Error stack traces, user email (in error context)',
        purpose:'Crash diagnostics & alerting', stored:'yes',
        jurisdiction:'USA (EU-US Data Privacy Framework certified)', noUserData:false,
        dpaFile:'sentry-dpa-2025.pdf' },
      'api.toggl.com': { host:'api.toggl.com', noUserData:true, stored:'no' },
      'hooks.slack.com': { host:'hooks.slack.com', dataSent:'Deploy status messages',
        purpose:'Team notifications', stored:'transient', jurisdiction:'USA', noUserData:false, dpaFile:'' },
    });
  }, [stage.id, bp.id]);
  React.useEffect(() => {
    setSnapshots([
      { id:'snap-3', label:'Before deploy', at:'2 days ago', size:'1.4 GB', kind:'auto' },
      { id:'snap-2', label:'Pre-migration', at:'5 days ago', size:'1.3 GB', kind:'manual' },
      { id:'snap-1', label:'Nightly', at:'6 days ago', size:'1.3 GB', kind:'auto' },
    ]);
  }, [stage.id, bp.id]);
  React.useEffect(() => { setDiffShas(null); }, [stage.id, bp.id]);
  // Pick a sensible default section per stage, and bounce off sections that
  // don't exist for the current stage (audits = staging only; backups & the
  // recovery tab are DR-specific).
  React.useEffect(() => {
    setSection(stage.id === 'dr' ? 'recovery' : 'history');
  }, [stage.id, bp.id]);
  React.useEffect(() => {
    if (section === 'recovery' && stage.id !== 'dr') setSection('history');
    if (section === 'backups' && stage.id === 'dr') setSection('recovery');
  }, [stage.id, section]);
  React.useEffect(() => { setOpenLogs(null); setOpenInspect(null); }, [stage.id, bp.id, section]);

  // Human-friendly container details (same info as `docker inspect`, readable).
  const containerDetails = (c, st) => {
    const running = st.status === 'deployed';
    const tag = (st.sha || 'latest').slice(0, 7);
    return {
      status: running ? 'Running' : st.status === 'failed' ? 'Stopped (crashed)' : 'Not started',
      statusColor: running ? '#16a34a' : st.status === 'failed' ? '#dc2626' : '#a1a1aa',
      facts: [
        ['Started', running ? '2 days ago (May 5, 11:02)' : '—'],
        ['Restarts', '0'],
        ['Image', `${bp.name}/${c.name}:${tag}`],
        ['Internal address', '10.0.3.17 · port 8080'],
        ['Storage', `${c.name}-data → /data (read-write)`],
      ],
      env: [
        ['STAGE', stage.id],
        ['NODE_ENV', 'production'],
        ['DATABASE_URL', `postgres://${stage.id}…`],
      ],
    };
  };

  const frontendUrl = (fName) =>
    stage.id === 'production' ? `https://${fName}.harmonum.ai`
                              : `https://${fName}-${stage.id}.harmonum.ai`;
  const friendly =
    agg.failed     ? { label: `${agg.failed} service${agg.failed === 1 ? '' : 's'} failing`, color:'#dc2626' }
  : agg.building   ? { label: 'Deploying…', color:'#2563eb' }
  : agg.mixed      ? { label: 'Versions out of sync', color:'#d97706' }
  : agg.deployed === agg.total && agg.total > 0 ? { label: 'Healthy', color:'#16a34a' }
  : agg.deployed > 0 ? { label: `${agg.deployed} of ${agg.total} running`, color:'#d97706' }
                     : { label: 'Not deployed yet', color:'#a1a1aa' };

  // History (primary container drives the timeline). DR mirrors production.
  const k = `${bp.id}:${aut?.id}:${effId}`;
  const dep = (aut && ((window.WD_DATA.DEPLOYMENT_HISTORY && window.WD_DATA.DEPLOYMENT_HISTORY[k])
              || synthHistory(aut, effId))) || [];
  const scale = (window.WD_DATA.SCALE_EVENTS && window.WD_DATA.SCALE_EVENTS[k]) || [];
  const merged = [...dep.map(d => ({...d, kind:'deploy'})), ...scale]
    .sort((a, b) => parseDate(b.atAbs || b.deployedAtAbs) - parseDate(a.atAbs || a.deployedAtAbs));
  const currentDeploy = dep.find(d => d.current);
  const deployOnly = dep;

  const SectionTab = ({ id, icon, label, count, badges, locked }) => {
    const on = section === id;
    return (
      <button onClick={() => setSection(id)} style={{
        display:'inline-flex', alignItems:'center', gap:6,
        height:38, padding:'0 4px', marginBottom:-1,
        background:'transparent', color: on ? C.fg : C.muted,
        border:0, borderBottom: on ? `2px solid ${C.fg}` : '2px solid transparent',
        fontSize:13, fontWeight: on ? 600 : 500, fontFamily:'inherit', cursor:'pointer',
      }}>
        <Icon name={icon} size={13} color={on ? C.fg : C.mutedFg}/>
        {label}
        {locked && <Icon name="lock" size={11} color={C.mutedFg}/>}
        {typeof count === 'number' && (
          <span style={{
            fontSize:10, fontWeight:700, padding:'1px 6px', borderRadius:9999,
            background: on ? C.fg : C.surface2,
            color: on ? '#fff' : C.muted,
          }}>{count}</span>
        )}
        {(badges || []).map((b, i) => (
          <span key={i} title={b.title} style={{
            minWidth:18, height:18, padding:'0 5px', borderRadius:9999,
            display:'inline-flex', alignItems:'center', justifyContent:'center',
            fontSize:10, fontWeight:700, color:'#fff', background:b.color,
          }}>{b.n}</span>
        ))}
      </button>
    );
  };
  // Banner shown atop the DR mirrored (read-only) sections.
  const MirrorBanner = () => (
    <div style={{
      display:'flex', alignItems:'center', gap:8, padding:'9px 12px', marginBottom:12,
      background:C.surface2, border:`1px solid ${C.border}`, borderRadius:8,
      fontSize:12, color:C.muted, lineHeight:1.4,
    }}>
      <Icon name="lock" size={13} color={C.mutedFg}/>
      <span>Mirrored from <strong style={{color:C.fg}}>Production</strong> · read-only.
        To change this, manage it on the Production stage.</span>
    </div>
  );
  const cve = supplyCounts();
  const supplyBadges = [];
  if (cve.critical) supplyBadges.push({ n:cve.critical, color:'#dc2626', title:`${cve.critical} critical CVEs` });
  if (cve.high)     supplyBadges.push({ n:cve.high, color:'#ea580c', title:`${cve.high} high CVEs` });

  return (
    <div style={{
      background:'#fff', border:`1px solid ${C.border}`, borderRadius:14,
      boxShadow:'0 1px 2px 0 rgba(0,0,0,0.04)', overflow:'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding:'18px 22px', borderBottom:`1px solid ${C.border}`,
        display:'flex', alignItems:'flex-start', gap:16, flexWrap:'wrap',
      }}>
        <div style={{display:'flex', alignItems:'center', gap:12, flex:'1 1 320px', minWidth:0}}>
          <span style={{
            width:12, height:12, borderRadius:9999, flex:'0 0 auto',
            background: friendly.color, boxShadow:`0 0 0 5px ${friendly.color}1a`,
          }}/>
          <div style={{minWidth:0}}>
            <div style={{fontSize:18, fontWeight:700, color:C.fg, letterSpacing:-0.2}}>
              {stage.label}
            </div>
            <div style={{fontSize:13, color: friendly.color, fontWeight:600, marginTop:1}}>
              {friendly.label}
              <span style={{color:C.muted, fontWeight:400}}>
                {agg.deployedAt ? ` · updated ${agg.deployedAt}` : ' · never deployed'}
              </span>
            </div>
          </div>
        </div>
        <div style={{display:'flex', alignItems:'center', gap:14, fontSize:12, color:C.muted}}>
          {agg.sha ? (
            <span style={{display:'inline-flex', alignItems:'center', gap:6}}>
              Version <CommitHash sha={agg.sha} color={C.fg}/>
            </span>
          ) : agg.mixed ? (
            <span style={{color:'#d97706'}}>Mixed versions</span>
          ) : null}
          {agg.replicas > 0 && (
            <span style={{display:'inline-flex', alignItems:'center', gap:5}}>
              <Icon name="layers" size={13}/>{agg.replicas} replica{agg.replicas === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>

      {/* Open app — prominent cards */}
      {frontends && frontends.length > 0 && (
        <div style={{padding:'16px 22px', borderBottom:`1px solid ${C.border}`}}>
          <div style={{fontSize:11, fontWeight:600, color:C.mutedFg, letterSpacing:0.5,
                       textTransform:'uppercase', marginBottom:10}}>Open app</div>
          <div style={{display:'flex', gap:10, flexWrap:'wrap'}}>
            {frontends.map(f => {
              const st = f.stages[effId];
              const deployed = st && st.status === 'deployed';
              const m = window.WD_DATA.KIND_META[f.kind] || { icon:'globe', color:C.muted, label:f.kind };
              const url = frontendUrl(f.name);
              const inner = (
                <>
                  <div style={{
                    width:36, height:36, borderRadius:8, flex:'0 0 auto',
                    background: deployed ? `${m.color}14` : C.surface2,
                    display:'inline-flex', alignItems:'center', justifyContent:'center',
                  }}>
                    <Icon name={m.icon} size={18} color={deployed ? m.color : C.mutedFg}/>
                  </div>
                  <div style={{flex:1, minWidth:0}}>
                    <div style={{fontSize:13, fontWeight:600,
                                 color: deployed ? C.fg : C.muted,
                                 fontFamily:'Geist Mono, ui-monospace, monospace',
                                 overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                      {f.name}
                    </div>
                    <div style={{fontSize:11, color:C.muted, marginTop:1,
                                 overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                      {deployed ? url.replace('https://', '') : 'Not deployed'}
                    </div>
                  </div>
                  <Icon name={deployed ? 'external-link' : 'circle-slash'}
                        size={14} color={deployed ? C.primary : C.mutedFg}/>
                </>
              );
              const cardStyle = {
                display:'flex', alignItems:'center', gap:10,
                width:280, maxWidth:'100%', padding:'12px 14px',
                border:`1px solid ${C.border}`, borderRadius:10,
                background:'#fff', textDecoration:'none',
                cursor: deployed ? 'pointer' : 'default',
                transition:'border-color 120ms, box-shadow 120ms',
              };
              return deployed ? (
                <a key={f.id} href={url} target="_blank" rel="noreferrer"
                   title={`Open ${url}`} style={cardStyle}
                   onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.borderHi;
                                          e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.08)'; }}
                   onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border;
                                          e.currentTarget.style.boxShadow = 'none'; }}>
                  {inner}
                </a>
              ) : (
                <div key={f.id} title={`${f.name} — not deployed in ${stage.label}`}
                     style={{...cardStyle, background:C.surface, opacity:0.75}}>
                  {inner}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Manage moved into the Containers tab */}

      {/* Section switch: History / Secrets / Containers */}
      <div style={{
        padding:'14px 22px 0', display:'flex', alignItems:'center', gap:18, flexWrap:'wrap',
        borderBottom:`1px solid ${C.border}`,
      }}>
        {isDr ? (
          <>
            <SectionTab id="recovery" icon="life-buoy" label="Recovery tests"
              badges={drStatus(bp.id).overdue
                ? [{ n:'!', color:'#d97706', title:'Recovery test overdue' }] : []}/>
            <SectionTab id="containers" icon="boxes" label="Containers" count={containers.length}/>
            <SectionTab id="access" icon="users" label="Access control"/>
            {/* Mirrored-from-production, read-only group */}
            <span style={{width:1, height:22, background:C.border, alignSelf:'center'}}/>
            <span style={{display:'inline-flex', alignItems:'center', gap:5, alignSelf:'center',
                          fontSize:10, fontWeight:700, color:C.mutedFg, letterSpacing:0.4,
                          textTransform:'uppercase'}}>
              <Icon name="lock" size={11} color={C.mutedFg}/>Mirrored from Production
            </span>
            <SectionTab id="history" icon="history" label="Deployment history" count={deployOnly.length} locked/>
            <SectionTab id="secrets" icon="key-round" label="Secrets" locked/>
            <SectionTab id="firewall" icon="shield" label="Firewall" locked/>
            <SectionTab id="supply" icon="boxes" label="Supply chain" badges={supplyBadges} locked/>
          </>
        ) : (
          <>
            <SectionTab id="history" icon="history" label="Deployment history" count={deployOnly.length}/>
            <SectionTab id="secrets" icon="key-round" label="Secrets"/>
            <SectionTab id="containers" icon="boxes" label="Containers" count={containers.length}/>
            <SectionTab id="backups" icon="archive" label="Backups"/>
            <SectionTab id="firewall" icon="shield" label="Firewall"
                        badges={fwRules.filter(r => r.status === 'blocked' && !r.decided).length
                          ? [{ n: fwRules.filter(r => r.status === 'blocked' && !r.decided).length,
                               color:'#dc2626', title:'unreviewed blocked attempts' }] : []}/>
            <SectionTab id="supply" icon="boxes" label="Supply chain" badges={supplyBadges}/>
            <SectionTab id="access" icon="users" label="Access control"/>
          </>
        )}
      </div>

      <div style={{padding:'14px 22px 20px', background:C.surface}}>
        {section === 'recovery' && isDr && (
          <DisasterRecovery bp={bp} frontends={frontends} onChange={onDrChange}/>
        )}
        {section === 'secrets' && (
          <>
            {isDr && <MirrorBanner/>}
            <div style={isDr ? { pointerEvents:'none', opacity:0.92 } : undefined}>
              <SecretsEditor stageId={effId} bpName={bp.name}/>
            </div>
          </>
        )}
        {section === 'backups' && (
          <div style={{display:'flex', flexDirection:'column', gap:12}}>
            <div style={{
              display:'flex', alignItems:'center', gap:10, flexWrap:'wrap',
              padding:'2px 0 2px',
            }}>
              <div style={{flex:1, minWidth:0, fontSize:12, color:C.muted, lineHeight:1.5}}>
                Point-in-time snapshots of this stage's <strong style={{color:C.fg}}>Postgres</strong> and
                {' '}<strong style={{color:C.fg}}>MinIO</strong> data. To recover, a snapshot is restored
                into the isolated <strong style={{color:C.fg}}>Disaster Recovery</strong> stage — this stage
                is left untouched so you can verify the data before going live by swapping DR with it.
              </div>
              <button
                onClick={() => setSnapshots([
                  { id:`snap-${Date.now()}`, label:'Manual snapshot', at:'just now',
                    size:'1.4 GB', kind:'manual' },
                  ...snapshots,
                ])}
                style={{
                  flex:'0 0 auto',
                  display:'inline-flex', alignItems:'center', gap:6, height:32, padding:'0 14px',
                  background:C.primary, color:'#fff', border:`1px solid ${C.primary}`,
                  borderRadius:7, fontSize:12, fontWeight:600, fontFamily:'inherit', cursor:'pointer',
                }}
              >
                <Icon name="camera" size={13}/>
                Create snapshot
              </button>
            </div>
            {snapshots.map(s => (
              <div key={s.id} style={{
                display:'flex', alignItems:'center', gap:12, padding:'12px 14px',
                background:'#fff', border:`1px solid ${C.border}`, borderRadius:10,
              }}>
                <div style={{
                  width:30, height:30, borderRadius:7, flex:'0 0 auto',
                  background:C.surface2,
                  display:'inline-flex', alignItems:'center', justifyContent:'center',
                }}>
                  <Icon name="archive" size={15} color={C.muted}/>
                </div>
                <div style={{flex:1, minWidth:0}}>
                  <div style={{fontSize:13, fontWeight:600, color:C.fg,
                               display:'flex', alignItems:'center', gap:8}}>
                    {s.label}
                    <span style={{
                      fontSize:9, fontWeight:700, letterSpacing:0.4, textTransform:'uppercase',
                      padding:'1px 6px', borderRadius:9999,
                      background: s.kind === 'manual' ? '#dbeafe' : C.surface2,
                      color: s.kind === 'manual' ? '#1d4ed8' : C.muted,
                    }}>{s.kind}</span>
                  </div>
                  <div style={{fontSize:11, color:C.muted, marginTop:1,
                               fontFamily:'Geist Mono, ui-monospace, monospace'}}>
                    {s.at} · {s.size} · Postgres + MinIO
                  </div>
                </div>
                <button
                  title="Download snapshot"
                  style={{
                    width:30, height:30, padding:0, border:`1px solid ${C.border}`, borderRadius:6,
                    background:'#fff', color:C.muted, cursor:'pointer',
                    display:'inline-flex', alignItems:'center', justifyContent:'center',
                  }}
                ><Icon name="download" size={13}/></button>
                <button
                  onClick={() => onSelectStage && onSelectStage('dr')}
                  title={`Restore "${s.label}" into the Disaster Recovery stage to verify it`}
                  style={{
                    display:'inline-flex', alignItems:'center', gap:6, height:30, padding:'0 12px',
                    background:'#fff', border:`1px solid ${C.border}`, borderRadius:6,
                    fontSize:11, fontWeight:600, color:C.fg, fontFamily:'inherit', cursor:'pointer',
                  }}
                >
                  <Icon name="life-buoy" size={13}/>
                  Restore to DR stage
                </button>
              </div>
            ))}
          </div>
        )}
        {section === 'firewall' && (
          <div style={{display:'flex', flexDirection:'column', gap:12}}>
            {isDr && <MirrorBanner/>}
            <div style={{fontSize:12, color:C.muted, lineHeight:1.5}}>
              {stage.label} can only reach the external services on this allow-list. Any other
              outbound connection is blocked and logged here for you to approve or deny.
            </div>
            {(() => {
              const pending = fwRules.filter(r => r.status === 'blocked' && !r.decided);
              const allowed = fwRules.filter(r => r.status === 'allowed');
              const denied  = fwRules.filter(r => r.status === 'denied' || (r.status === 'blocked' && r.decided));
              const approve = (id) => setFwRules(fwRules.map(x => x.id === id ? {...x, status:'allowed', decided:true, at:'just now · approved'} : x));
              const deny    = (id) => { const r=fwRules.find(x=>x.id===id); if(r) logAndRefresh(stage.id,'firewall',`denied ${r.host}`); setFwRules(fwRules.map(x => x.id === id ? {...x, status:'denied', decided:true, at:'just now · denied'} : x)); };
              const revoke  = (id) => { const r=fwRules.find(x=>x.id===id); if(r) logAndRefresh(stage.id,'firewall',`revoked access to ${r.host}`); setFwRules(fwRules.map(x => x.id === id ? {...x, status:'denied', decided:true, at:'just now · revoked'} : x)); };
              return (
                <>
                  {/* New blocked attempts — needs a decision */}
                  {pending.length > 0 && (
                    <>
                      <div style={{display:'flex', alignItems:'center', gap:8}}>
                        <span style={{fontSize:11, fontWeight:600, color:'#b91c1c', letterSpacing:0.5,
                                      textTransform:'uppercase'}}>Needs review</span>
                        <span style={{
                          minWidth:18, height:18, padding:'0 5px', borderRadius:9999,
                          display:'inline-flex', alignItems:'center', justifyContent:'center',
                          fontSize:10, fontWeight:700, color:'#fff', background:'#dc2626',
                        }}>{pending.length}</span>
                      </div>
                      {pending.map(r => (
                        <FirewallRow key={r.id} r={r} readOnly={isDr}
                          onApprove={() => setFwApprove(r)} onDeny={() => deny(r.id)}/>
                      ))}
                    </>
                  )}

                  <div style={{fontSize:11, fontWeight:600, color:C.mutedFg, letterSpacing:0.5,
                               textTransform:'uppercase', marginTop:6}}>Allowed</div>
                  {allowed.map(r => (
                    <FirewallRow key={r.id} r={r} readOnly={isDr} onDeny={() => revoke(r.id)}
                      hasRecord={!!fwRecords[r.host]} onView={() => setFwView(r.host)}/>
                  ))}

                  {denied.length > 0 && (
                    <>
                      <div style={{fontSize:11, fontWeight:600, color:C.mutedFg, letterSpacing:0.5,
                                   textTransform:'uppercase', marginTop:6}}>Denied</div>
                      {denied.map(r => (
                        <FirewallRow key={r.id} r={r} readOnly={isDr} onApprove={() => approve(r.id)}/>
                      ))}
                    </>
                  )}
                </>
              );
            })()}
            <AuditLogView stageId={stage.id} category="firewall" seed={[
              { who:'Tomáš Novák', at:'3 days ago', text:'approved api.toggl.com' },
              { who:'Jana Nováková', at:'8 days ago', text:'approved sentry.io with data-processing record' },
            ]}/>
          </div>
        )}
        {fwApprove && (
          <FirewallGdprModal rule={fwApprove}
            onClose={() => setFwApprove(null)}
            onSave={(rec) => {
              setFwRecords(m => ({ ...m, [fwApprove.host]: rec }));
              logAndRefresh(stage.id, 'firewall', `approved ${fwApprove.host} with data-processing record`);
              setFwRules(rs => rs.map(x => x.id === fwApprove.id
                ? {...x, status:'allowed', decided:true, at:'just now · approved'} : x));
              setFwApprove(null);
            }}/>
        )}
        {fwView && fwRecords[fwView] && (
          <FirewallGdprModal record={fwRecords[fwView]} readOnly
            onClose={() => setFwView(null)}/>
        )}
        {section === 'supply' && (
          <>
            {isDr && <MirrorBanner/>}
            <SupplyChain stage={stage} agg={agg} readOnly={isDr}/>
          </>
        )}
        {section === 'access' && (
          <StageAccessControl stage={stage} frontends={frontends}/>
        )}
        {section === 'containers' && (
          <div style={{display:'flex', flexDirection:'column', gap:10}}>
            {/* Shared stage services */}
            <div style={{
              display:'flex', alignItems:'center', gap:8,
              padding:'10px 14px', background:'#fff',
              border:`1px solid ${C.border}`, borderRadius:10,
            }}>
              <span style={{fontSize:12, fontWeight:600, color:C.fg, marginRight:2}}>
                Stage services
              </span>
              <StageServiceLink icon="database" label="Postgres"
                href={`https://pg.${stage.id}.${bp.name}.harmonum.ai`}/>
              <StageServiceLink icon="hard-drive" label="MinIO"
                href={`https://minio.${stage.id}.${bp.name}.harmonum.ai`}/>
            </div>
            {containers.length === 0 && (
              <div style={{padding:'30px', textAlign:'center', color:C.muted, fontSize:13}}>
                No containers in this automation.
              </div>
            )}
            {containers.map(c => {
              const st = c.stages[effId] || { status:'not-deployed' };
              const m = window.WD_DATA.KIND_META[c.kind] || { icon:'box', color:C.muted, label:c.kind };
              const meta = statusMeta(st.status);
              const logsOpen = openLogs === c.id;
              return (
                <div key={c.id} style={{
                  background:'#fff', border:`1px solid ${C.border}`, borderRadius:10,
                  overflow:'hidden',
                }}>
                  <div style={{
                    display:'flex', alignItems:'center', gap:12, padding:'12px 14px',
                  }}>
                    <div style={{
                      width:30, height:30, borderRadius:7, background:C.surface2,
                      display:'inline-flex', alignItems:'center', justifyContent:'center', flex:'0 0 auto',
                    }}>
                      <Icon name={m.icon} size={15} color={m.color}/>
                    </div>
                    <div style={{flex:1, minWidth:0}}>
                      <div style={{fontSize:13, fontWeight:600, color:C.fg,
                                   fontFamily:'Geist Mono, ui-monospace, monospace',
                                   overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                        {c.name}
                      </div>
                      <div style={{fontSize:11, color:C.muted, marginTop:1}}>{m.label}</div>
                    </div>
                    {st.sha && <CommitHash sha={st.sha} color={C.fg}/>}
                    <span style={{display:'inline-flex', alignItems:'center', gap:6, minWidth:96}}>
                      <span style={{width:8, height:8, borderRadius:9999, background:meta.dot}}/>
                      <span style={{fontSize:12, color: meta.dot === '#a1a1aa' ? C.muted : meta.dot,
                                    fontWeight:500}}>{meta.label}</span>
                    </span>
                    {(() => {
                      const isRunning = st.status === 'deployed';
                      return (
                        <>
                          <button
                            title={isRunning ? `Restart ${c.name}` : `${c.name} is not running`}
                            disabled={!isRunning}
                            style={{
                              display:'inline-flex', alignItems:'center', justifyContent:'center',
                              width:28, height:28, padding:0,
                              background:'#fff', border:`1px solid ${C.border}`, borderRadius:6,
                              color: isRunning ? C.fg : C.mutedFg,
                              cursor: isRunning ? 'pointer' : 'not-allowed', fontFamily:'inherit',
                            }}
                          >
                            <Icon name="rotate-ccw" size={13}/>
                          </button>
                          <button
                            title={isRunning ? `Stop ${c.name}` : `Start ${c.name}`}
                            style={{
                              display:'inline-flex', alignItems:'center', justifyContent:'center',
                              width:28, height:28, padding:0,
                              background:'#fff', border:`1px solid ${C.border}`, borderRadius:6,
                              color: isRunning ? '#dc2626' : '#16a34a',
                              cursor:'pointer', fontFamily:'inherit',
                            }}
                          >
                            <Icon name={isRunning ? 'square' : 'play'} size={13}/>
                          </button>
                        </>
                      );
                    })()}
                    <span style={{width:1, height:22, background:C.border, margin:'0 4px'}}/>
                    <button
                      onClick={() => { setOpenInspect(null); setOpenLogs(logsOpen ? null : c.id); }}
                      style={{
                        display:'inline-flex', alignItems:'center', gap:6, height:28, padding:'0 10px',
                        background: logsOpen ? C.surface2 : '#fff',
                        border:`1px solid ${C.border}`, borderRadius:6,
                        fontSize:11, fontWeight:500, color:C.fg, fontFamily:'inherit', cursor:'pointer',
                      }}
                    >
                      <Icon name="terminal" size={12}/>
                      Logs
                    </button>
                    <button
                      onClick={() => { setOpenLogs(null); setOpenInspect(openInspect === c.id ? null : c.id); }}
                      title="Inspect container"
                      style={{
                        display:'inline-flex', alignItems:'center', gap:6, height:28, padding:'0 10px',
                        background: openInspect === c.id ? C.surface2 : '#fff',
                        border:`1px solid ${C.border}`, borderRadius:6,
                        fontSize:11, fontWeight:500, color:C.fg, fontFamily:'inherit', cursor:'pointer',
                      }}
                    >
                      <Icon name="search" size={12}/>
                      Inspect
                    </button>
                  </div>
                  {logsOpen && (
                    <div style={{borderTop:`1px solid ${C.border}`}}>
                      <div style={{
                        background:'#0c0c0e', padding:'12px 16px',
                        fontFamily:'Geist Mono, monospace', fontSize:12, lineHeight:'19px',
                        maxHeight:200, overflow:'auto',
                      }}>
                        {(c.liveDev?.logs || [
                          `[boot] ${c.name} starting on ${stage.id}`,
                          `[boot] connected to pg.${stage.id}`,
                          `[info] ready · ${st.sha ? st.sha.slice(0,7) : 'no build'}`,
                        ]).map((l, i) => (
                          <div key={i} style={{color: /ERROR|FATAL/.test(l) ? '#fca5a5'
                                                     : /WARN/.test(l) ? '#fcd34d'
                                                     : /info|INFO|ready/.test(l) ? '#a5b4fc' : '#a1a1aa'}}>{l}</div>
                        ))}
                      </div>
                      <div style={{
                        display:'flex', justifyContent:'flex-end', padding:'8px 12px',
                        background:C.surface, borderTop:`1px solid ${C.border}`,
                      }}>
                        <button
                          title="Send these logs to an agent to investigate"
                          style={{
                            display:'inline-flex', alignItems:'center', gap:6,
                            height:28, padding:'0 12px',
                            background:C.primary, color:'#fff',
                            border:`1px solid ${C.primary}`, borderRadius:6,
                            fontSize:11, fontWeight:600, fontFamily:'inherit', cursor:'pointer',
                          }}
                        >
                          <Icon name="bot" size={12}/>
                          Send to agent
                        </button>
                      </div>
                    </div>
                  )}
                  {openInspect === c.id && (() => {
                    const d = containerDetails(c, st);
                    return (
                      <div style={{borderTop:`1px solid ${C.border}`, background:'#fff'}}>
                        <div style={{padding:'14px 16px', display:'flex', flexDirection:'column', gap:14}}>
                          {/* status line */}
                          <div style={{display:'flex', alignItems:'center', gap:8}}>
                            <span style={{width:9, height:9, borderRadius:9999, background:d.statusColor,
                                          boxShadow:`0 0 0 4px ${d.statusColor}1a`}}/>
                            <span style={{fontSize:13, fontWeight:600, color:d.statusColor}}>{d.status}</span>
                          </div>
                          {/* facts */}
                          <div style={{display:'grid', gridTemplateColumns:'140px 1fr', rowGap:8, columnGap:14}}>
                            {d.facts.map(([k, v]) => (
                              <React.Fragment key={k}>
                                <div style={{fontSize:12, color:C.muted, fontWeight:500}}>{k}</div>
                                <div style={{fontSize:12, color:C.fg,
                                             fontFamily:'Geist Mono, ui-monospace, monospace',
                                             wordBreak:'break-all'}}>{v}</div>
                              </React.Fragment>
                            ))}
                          </div>
                          {/* env */}
                          <div>
                            <div style={{fontSize:11, fontWeight:600, color:C.mutedFg,
                                         letterSpacing:0.5, textTransform:'uppercase', marginBottom:6}}>
                              Environment
                            </div>
                            <div style={{display:'flex', flexDirection:'column', gap:4}}>
                              {d.env.map(([k, v]) => (
                                <div key={k} style={{
                                  display:'flex', gap:8, fontSize:12,
                                  fontFamily:'Geist Mono, ui-monospace, monospace',
                                }}>
                                  <span style={{color:C.muted, minWidth:130}}>{k}</span>
                                  <span style={{color:C.fg, wordBreak:'break-all'}}>{v}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        )}
        {section === 'history' && (
          <div style={{display:'flex', flexDirection:'column', gap:12}}>
            {isDr && <MirrorBanner/>}
            {merged.length === 0 ? (
              <div style={{padding:'40px 12px', textAlign:'center', color:C.muted, fontSize:13}}>
                <Icon name="cloud-off" size={28} color={C.mutedFg}/>
                <div style={{marginTop:8, fontWeight:600, color:C.fg}}>Not deployed yet</div>
                <div style={{marginTop:4}}>
                  {stage.id === 'dev'
                    ? 'Sync from a worktree to deploy.'
                    : 'Promote from a previous stage to start a deployment history.'}
                </div>
              </div>
            ) : merged.map((h, i) => {
              if (h.kind === 'scale') return <ScaleEventRow key={'s'+i} ev={h}/>;
              const di = deployOnly.findIndex(d => d === h);
              // Audits gate promotion to production, so show audit badges on
              // staging & production deploys (the audited path).
              const audited = h.current || h.stagedFrom;
              const audit = (stage.id === 'staging' || stage.id === 'production')
                ? { status: audited ? 'passed' : 'pending',
                    by: audited ? ['security-agent', 'Jana Novákova'] : [],
                    title: audited
                      ? 'Signed off by security-agent & Jana Novákova (Engineering lead)'
                      : 'Awaiting audit sign-off' }
                : null;
              return (
                <DeploymentCard key={h.sha + i} h={h}
                  previous={deployOnly[di + 1]}
                  currentSha={currentDeploy?.sha}
                  stageLabel={stage.label}
                  audit={audit}
                  onViewFiles={(fromSha, toSha) => setDiffShas({ fromSha, toSha })}/>
              );
            })}
          </div>
        )}
      </div>

      {/* Diff viewer (files / diff) */}
      {diffShas && (() => {
        const from = merged.find(h => h.sha === diffShas.fromSha);
        const to   = merged.find(h => h.sha === diffShas.toSha);
        const isView = diffShas.fromSha === diffShas.toSha;
        return (
          <div onClick={() => setDiffShas(null)} style={{
            position:'fixed', inset:0, background:'rgba(0,0,0,0.45)',
            display:'flex', alignItems:'center', justifyContent:'center', zIndex:80,
          }}>
            <div onClick={e => e.stopPropagation()} style={{
              width:'min(96%, 980px)', maxHeight:'92%', background:'#fff',
              border:`1px solid ${C.border}`, borderRadius:12, overflow:'hidden',
              boxShadow:'0 25px 50px -12px rgba(0,0,0,0.25)',
              display:'flex', flexDirection:'column',
            }}>
              <div style={{padding:'14px 18px', borderBottom:`1px solid ${C.border}`,
                           display:'flex', alignItems:'center', gap:10}}>
                <Icon name="files" size={15} color={C.muted}/>
                <div style={{flex:1, fontSize:13, color:C.fg}}>
                  {isView ? 'Files at ' : 'Files changed — '}
                  <span style={{fontFamily:'Geist Mono, monospace'}}>{(to?.sha||'').slice(0,7)}</span>
                </div>
                <Btn variant="ghost" size="sm" leftIcon="x" onClick={() => setDiffShas(null)}/>
              </div>
              <div style={{flex:1, minHeight:0, overflow:'auto'}}>
                <DiffPanel viewOnly={isView}
                  a={{ label:'previous', sha: from?.sha || '', who: from?.who, when: from?.deployedAt }}
                  b={{ label:'this deployment', sha: to?.sha || '', who: to?.who, when: to?.deployedAt }}/>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function DeploymentsView({ bp, layout = 'vertical', density = 'comfortable', readmeHidden = false }) {
  useLucide();
  const automationsRaw = window.WD_DATA.AUTOMATIONS_BY_BP[bp.id] || [];
  const readme = window.WD_DATA.READMES[bp.id];
  const isRow = layout === 'row';
  const colMin = layout === 'pipeline' ? 360 : layout === 'horizontal' ? 380 : 280;
  const padding = density === 'compact' ? '16px 20px' : '24px 28px';
  const gap = density === 'compact' ? 10 : (isRow ? 10 : 20);
  const [tab, setTab] = React.useState('specification');
  React.useEffect(() => { setTab('specification'); }, [bp.id]);
  const [configAut, setConfigAut] = React.useState(null);
  const [inspectAut, setInspectAut] = React.useState(null);
  const [historyTarget, setHistoryTarget] = React.useState(null);
  const [secretsTarget, setSecretsTarget] = React.useState(null);  // { stageId } | null
  const [activeStage, setActiveStage] = React.useState('dev');
  React.useEffect(() => { setActiveStage('dev'); }, [bp.id]);
  // Bumped when a DR recovery test is recorded so the pipeline alert recomputes.
  const [drTick, setDrTick] = React.useState(0);
  // Local overrides for promotions performed in this session.
  // Shape: { [autId]: { [stageId]: stageData } }
  const [overrides, setOverrides] = React.useState({});
  React.useEffect(() => { setOverrides({}); }, [bp.id]);
  const { ConfigureOverlay, InspectOverlay, StageHistoryOverlay, SecretsOverlay } = window.WD_OVERLAYS;

  // Merge overrides onto raw automations.
  const automations = automationsRaw.map(a => {
    const ov = overrides[a.id];
    if (!ov) return a;
    return { ...a, stages: { ...a.stages, ...ov } };
  });

  function doPromote(fromStageId, toStageId) {
    const next = { ...overrides };
    for (const a of automations) {
      const src = a.stages[fromStageId];
      if (!src || src.status !== 'deployed' || !src.sha) continue;
      next[a.id] = {
        ...(next[a.id] || {}),
        [toStageId]: {
          status: 'deployed', sha: src.sha,
          deployedAt: 'just now',
        },
      };
    }
    setOverrides(next);
  }

  const mainContainers = automations.filter(a => a.kind !== 'tests');
  const testContainers = automations.filter(a => a.kind === 'tests');

  // Find a stand-in requirements list — use the first worktree's requirements
  // as the "main branch" testable spec until BP-level reqs are modelled.
  const wts = window.WD_DATA.WORKTREES_BY_BP[bp.id] || [];
  let reqs = [];
  for (const w of wts) {
    const k = `${bp.id}:${w.id}`;
    const r = window.WD_DATA.REQUIREMENTS[k];
    if (r && r.length) { reqs = r; break; }
  }

  return (
    <div style={{
      flex:1, minHeight:0, overflow:'hidden', background:C.bg, position:'relative',
      display:'flex', flexDirection:'column',
    }}>
      <div style={{
        position:'absolute', inset:0, overflow:'auto', background:C.bg,
        padding,
      }}>
        <div style={{display:'flex', flexDirection:'column', gap:20}}>
        <SectionHeader
          eyebrow="Automation"
          title={bp.name}
          helper={`${mainContainers.length} container${mainContainers.length === 1 ? '' : 's'} promote together. Pick a stage to manage its deployment, secrets and history.`}
        />
        {(() => {
          const drOverdue = drStatus(bp.id).overdue;  // drTick keeps this fresh
          void drTick;
          const aggs = STAGES.map(s => ({
            stage: s,
            // DR mirrors production's deployment aggregate.
            agg: aggregateStage(mainContainers, stageDataId(s.id)),
            alert: s.id === 'dr' && drOverdue,
          }));
          const frontends = mainContainers.filter(a => typeof a.kind === 'string' && a.kind.startsWith('frontend'));
          const active = aggs.find(a => a.stage.id === activeStage) || aggs[0];
          return (
            <>
              <StagePipelineTabs
                aggs={aggs}
                activeStage={activeStage}
                onSelect={setActiveStage}
                onPromote={doPromote}
              />
              <RichStageCard
                bp={bp}
                stage={active.stage}
                agg={active.agg}
                frontends={frontends}
                aut={mainContainers[0]}
                containers={mainContainers}
                onInspect={() => mainContainers[0] && setInspectAut(mainContainers[0])}
                onDrChange={() => setDrTick(t => t + 1)}
                onSelectStage={setActiveStage}
              />
            </>
          );
        })()}
        </div>
      </div>

      <style>{`
        .wd-doc-ro h1 { font-family: Roboto, Inter; font-size: 24px; font-weight: 700;
                        letter-spacing: -0.4px; margin: 0 0 10px; color: ${C.fg}; }
        .wd-doc-ro h2 { font-size: 17px; font-weight: 700; letter-spacing: -0.2px;
                        margin: 22px 0 6px; color: ${C.fg}; }
        .wd-doc-ro p  { margin: 0 0 10px; color: #3f3f46; }
        .wd-doc-ro ul { margin: 0 0 12px 0; padding-left: 24px;
                        display: flex; flex-direction: column; gap: 3px; }
        .wd-doc-ro li { color: #3f3f46; }
        .wd-doc-ro strong { font-weight: 600; color: ${C.fg}; }
      `}</style>

      <ConfigureOverlay open={!!configAut} aut={configAut} onClose={() => setConfigAut(null)}/>
      <SecretsOverlay
        open={!!secretsTarget}
        stageId={secretsTarget?.stageId}
        bpName={bp.name}
        onClose={() => setSecretsTarget(null)}/>
      <InspectOverlay open={!!inspectAut} aut={inspectAut} onClose={() => setInspectAut(null)}/>
      <StageHistoryOverlay
        open={!!historyTarget} onClose={() => setHistoryTarget(null)}
        aut={historyTarget?.aut} stageId={historyTarget?.stageId} bpId={bp.id}/>
    </div>
  );
}

// Read-only list of testable requirements. Compact rows with status pill.
function DeploymentsRequirementsList({ reqs }) {
  if (!reqs || reqs.length === 0) {
    return (
      <div style={{
        background:'#fff', border:`1px solid ${C.border}`, borderRadius:12,
        padding:'24px', textAlign:'center', color:C.muted, fontSize:13,
      }}>
        No requirements defined yet.
      </div>
    );
  }
  const STATUS = {
    pass:    { bg:'#dcfce7', fg:'#15803d', label:'PASS',    icon:'check' },
    fail:    { bg:'#fee2e2', fg:'#b91c1c', label:'FAIL',    icon:'x' },
    review:  { bg:'#dbeafe', fg:'#1d4ed8', label:'REVIEW',  icon:'eye' },
    todo:    { bg:'#f4f4f5', fg:'#52525b', label:'TODO',    icon:'circle-dashed' },
    pending: { bg:'#fef3c7', fg:'#a16207', label:'PENDING', icon:'clock' },
  };
  return (
    <div style={{
      background:'#fff', border:`1px solid ${C.border}`, borderRadius:12,
      boxShadow:'0 1px 2px 0 rgba(0,0,0,0.04)', overflow:'hidden',
    }}>
      {reqs.map((r, i) => {
        const s = STATUS[r.status] || STATUS.todo;
        return (
          <div key={r.id} style={{
            display:'grid',
            gridTemplateColumns:'78px 90px 1fr',
            gap:14, padding:'12px 16px',
            borderBottom: i < reqs.length - 1 ? `1px solid ${C.border}` : 'none',
            alignItems:'start',
          }}>
            <span style={{
              fontFamily:'Geist Mono, ui-monospace, monospace',
              fontSize:12, color:C.muted, paddingTop:2,
            }}>{r.id}</span>
            <span style={{
              display:'inline-flex', alignItems:'center', gap:5,
              padding:'2px 8px',
              background:s.bg, color:s.fg,
              borderRadius:9999,
              fontSize:10, fontWeight:700, letterSpacing:0.4,
              alignSelf:'start',
              width:'fit-content',
            }}>
              <Icon name={s.icon} size={10}/>
              {s.label}
            </span>
            <div style={{
              fontSize:13, color:C.fg, lineHeight:1.5,
              whiteSpace:'pre-wrap',
            }}>
              {r.text}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SectionHeader({ eyebrow, title, helper, right }) {
  return (
    <div style={{display:'flex', alignItems:'flex-end', gap:16}}>
      <div style={{flex:1, minWidth:0}}>
        <div style={{fontSize:10, fontWeight:600, color:C.muted, textTransform:'uppercase',
                     letterSpacing:0.5, marginBottom:4}}>{eyebrow}</div>
        <div style={{fontSize:18, fontWeight:600, color:C.fg, letterSpacing:-0.2}}>{title}</div>
        {helper && <div style={{fontSize:13, color:C.muted, marginTop:2}}>{helper}</div>}
      </div>
      {right}
    </div>
  );
}

window.WD_DEPLOYMENTS = { DeploymentsView, AutomationCardVertical, AutomationCardHorizontal, AutomationCardPipeline, CardForLayout, CardHeader, StageCell, ReadmeCard, SectionHeader, statusMeta, KindBadge };
