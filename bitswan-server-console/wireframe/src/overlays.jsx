// overlays.jsx — Configure & Inspect modals (per-automation, per-stage tabs)

const { C: OC, Icon: OIcon, Pill: OPill, Btn: OBtn } = window.WD_SHELL;

const { useState: useStateO } = React;

const O_STAGES = [
  { id: 'dev',        label: 'Development', short: 'Dev'  },
  { id: 'staging',    label: 'Staging',     short: 'Stg'  },
  { id: 'production', label: 'Production',  short: 'Prod' },
];

// Shared secrets store — secret NAMES are shared across all stages; values are
// per stage. Seeded per business process the first time its secrets are opened.
const SECRETS_STORE = {};
function getSecretsStore(bpName) {
  const key = bpName || 'business-process';
  if (!SECRETS_STORE[key]) {
    SECRETS_STORE[key] = {
      keys: ['DATABASE_URL', 'MINIO_KEY', 'TOGGL_TOKEN', 'SENTRY_DSN'],
      values: {
        dev:        { DATABASE_URL:'postgres://dev…',  MINIO_KEY:'dev-***',  TOGGL_TOKEN:'tok_dev_91a',  SENTRY_DSN:'' },
        staging:    { DATABASE_URL:'postgres://stg…',  MINIO_KEY:'stg-***',  TOGGL_TOKEN:'',             SENTRY_DSN:'' },
        production: { DATABASE_URL:'postgres://prod…', MINIO_KEY:'prod-***', TOGGL_TOKEN:'',             SENTRY_DSN:'https://…@sentry' },
      },
    };
  }
  return SECRETS_STORE[key];
}

// Best-effort timestamp parse for sorting merged deploy + scale events.
// Falls back to extracting "N days ago" / "N hours ago" so synthesized strings stay ordered.
function parseDate(s) {
  if (!s) return 0;
  const t = Date.parse(s.replace(' · ', ' '));
  if (!isNaN(t)) return t;
  const m = /(\d+)\s+(minute|hour|day|week|month)s?\s+ago/i.exec(s);
  if (m) {
    const mult = { minute:60e3, hour:3600e3, day:86400e3, week:7*86400e3, month:30*86400e3 }[m[2].toLowerCase()];
    return Date.now() - parseInt(m[1], 10) * mult;
  }
  return 0;
}

function Overlay({ open, onClose, children, width = 720 }) {
  if (!open) return null;
  return (
    <div onClick={onClose} style={{
      position:'absolute', inset:0, background:'rgba(0,0,0,0.4)',
      display:'flex', alignItems:'center', justifyContent:'center',
      zIndex: 50,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width, maxWidth:'92%', maxHeight:'90%', background:'#fff',
        border:`1px solid ${OC.border}`, borderRadius:12, overflow:'hidden',
        boxShadow:'0 25px 50px -12px rgba(0,0,0,0.25)',
        display:'flex', flexDirection:'column',
      }}>
        {children}
      </div>
    </div>
  );
}

function StageTabs({ active, onChange }) {
  return (
    <div style={{display:'flex', gap:0, borderBottom:`1px solid ${OC.border}`}}>
      {O_STAGES.map(s => (
        <button key={s.id} onClick={() => onChange(s.id)} style={{
          padding:'10px 18px', background: active === s.id ? '#fff' : 'transparent',
          border:0, borderBottom: active === s.id ? `2px solid ${OC.primary}` : '2px solid transparent',
          marginBottom:-1,
          fontSize:13, fontWeight: active === s.id ? 600 : 500,
          color: active === s.id ? OC.fg : OC.muted,
          fontFamily:'inherit', cursor:'pointer',
        }}>{s.label}</button>
      ))}
    </div>
  );
}

function ConfigureOverlay({ open, onClose, aut, mode, initialStage, initialTab }) {
  const isLiveDev = mode === 'liveDev';
  const [stage, setStage] = useStateO(isLiveDev ? 'live-dev' : (initialStage || 'dev'));
  const [tab, setTab] = useStateO(initialTab || 'secrets');
  const [accessKind, setAccessKind] = useStateO('groups');
  // When opened with a new initialStage/initialTab (e.g. the user clicked
  // "Secrets" on a different stage chip), sync the controlled view.
  React.useEffect(() => {
    if (open && !isLiveDev && initialStage) setStage(initialStage);
  }, [open, isLiveDev, initialStage]);
  React.useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [open, initialTab]);
  React.useEffect(() => { if (window.lucide) window.lucide.createIcons(); });

  if (!aut) return null;
  const secrets = isLiveDev
    ? [['DATABASE_URL','postgres://localhost…'], ['MINIO_KEY','dev-***'], ['TOGGL_TOKEN','']]
    : {
        dev:        [['DATABASE_URL','postgres://dev…'], ['MINIO_KEY','dev-***'], ['TOGGL_TOKEN','']],
        staging:    [['DATABASE_URL','postgres://stg…'], ['MINIO_KEY','stg-***']],
        production: [['DATABASE_URL','postgres://prod…'], ['MINIO_KEY','prod-***'], ['SENTRY_DSN','https://…']],
      }[stage];

  // Access control — per-stage data. Same shape across live-dev and stages.
  const accessGroups = {
    'live-dev':  [
      { name:'hr-team',         role:'admin',    members:6, source:'azure-ad' },
      { name:'developers',      role:'admin',    members:14, source:'azure-ad' },
    ],
    'dev':       [
      { name:'developers',      role:'admin',    members:14, source:'azure-ad' },
      { name:'qa-engineers',    role:'editor',   members:4,  source:'azure-ad' },
    ],
    'staging':   [
      { name:'developers',      role:'editor',   members:14, source:'azure-ad' },
      { name:'qa-engineers',    role:'admin',    members:4,  source:'azure-ad' },
      { name:'product-managers',role:'viewer',   members:3,  source:'azure-ad' },
    ],
    'production':[
      { name:'sre-oncall',      role:'admin',    members:5,  source:'azure-ad' },
      { name:'developers',      role:'viewer',   members:14, source:'azure-ad' },
      { name:'product-managers',role:'viewer',   members:3,  source:'azure-ad' },
      { name:'auditors',        role:'auditor',  members:2,  source:'okta' },
    ],
  };
  const accessUsers = {
    'live-dev':  [
      { email:'tomas@harmonum.ai', name:'Tomáš Novák',  role:'owner',  avatar:'TN' },
    ],
    'dev':       [
      { email:'tomas@harmonum.ai', name:'Tomáš Novák',  role:'owner',  avatar:'TN' },
      { email:'pavel@harmonum.ai', name:'Pavel Dvořák', role:'admin',  avatar:'PD' },
      { email:'jana@harmonum.ai',  name:'Jana Veselá',  role:'editor', avatar:'JV' },
    ],
    'staging':   [
      { email:'tomas@harmonum.ai', name:'Tomáš Novák',  role:'owner',  avatar:'TN' },
      { email:'pavel@harmonum.ai', name:'Pavel Dvořák', role:'admin',  avatar:'PD' },
    ],
    'production':[
      { email:'tomas@harmonum.ai', name:'Tomáš Novák',  role:'owner',  avatar:'TN' },
      { email:'cio@harmonum.ai',   name:'Petr CIO',     role:'admin',  avatar:'PC' },
    ],
  };
  const stageKey = isLiveDev ? 'live-dev' : stage;
  const accessList = accessKind === 'groups' ? accessGroups[stageKey] : accessUsers[stageKey];

  return (
    <Overlay open={open} onClose={onClose}>
      <div style={{padding:'16px 20px', borderBottom:`1px solid ${OC.border}`,
                   display:'flex', alignItems:'center', gap:10}}>
        <OIcon name="settings" size={16} color={OC.muted}/>
        <div style={{flex:1, minWidth:0}}>
          <div style={{fontSize:14, fontWeight:600, color:OC.fg}}>
            Configure <span style={{fontFamily:'Geist Mono, monospace'}}>{aut.name}</span>
          </div>
          <div style={{fontSize:12, color:OC.muted}}>
            {isLiveDev
              ? 'Live-dev configuration · secrets, environment, URLs, access'
              : 'Per-stage configuration · secrets, environment, URLs, access'}
          </div>
        </div>
        <OBtn variant="ghost" size="sm" leftIcon="x" onClick={onClose}/>
      </div>
      {!isLiveDev && <StageTabs active={stage} onChange={setStage}/>}
      <div style={{display:'flex', borderBottom:`1px solid ${OC.border}`,
                   background:OC.surface, padding:'0 16px'}}>
        {[
          ['secrets','Secrets','key-round'],
          ['env','Environment','file-cog'],
          ['urls','Public URLs','globe'],
          ['access','Access control','shield'],
        ].map(([id,lab,ic]) => (
          <button key={id} onClick={() => setTab(id)} style={{
            display:'flex', alignItems:'center', gap:6,
            padding:'10px 14px', background:'transparent', border:0,
            borderBottom: tab === id ? `2px solid ${OC.fg}` : '2px solid transparent',
            marginBottom:-1, fontSize:12, fontWeight: tab === id ? 600 : 500,
            color: tab === id ? OC.fg : OC.muted, cursor:'pointer', fontFamily:'inherit',
          }}>
            <OIcon name={ic} size={12}/>{lab}
          </button>
        ))}
      </div>
      <div style={{padding:'16px 20px', overflow:'auto', flex:1, minHeight: 360}}>
        {tab === 'secrets' && (
          <div style={{display:'flex', flexDirection:'column', gap:10}}>
            <div style={{fontSize:12, color:OC.muted, marginBottom:4}}>
              Encrypted at rest. Mounted into the {isLiveDev ? 'live-dev' : stage} container as env vars.
            </div>
            {secrets.map(([k,v]) => (
              <div key={k} style={{
                display:'grid', gridTemplateColumns:'180px 1fr auto', gap:10,
                alignItems:'center', padding:'8px 12px',
                border:`1px solid ${OC.border}`, borderRadius:6, background:'#fff',
              }}>
                <code style={{fontFamily:'Geist Mono, monospace', fontSize:12, color:OC.fg}}>{k}</code>
                <input defaultValue={v} type="password" placeholder="(empty)" style={{
                  fontFamily:'Geist Mono, monospace', fontSize:12, color:OC.fg,
                  border:0, outline:0, background:'transparent', minWidth:0,
                }}/>
                <OBtn variant="ghost" size="xs" leftIcon="trash-2"/>
              </div>
            ))}
            <OBtn variant="default" size="sm" leftIcon="plus" style={{alignSelf:'flex-start'}}>
              Add secret
            </OBtn>
          </div>
        )}
        {tab === 'env' && (
          <div style={{fontSize:13, color:OC.muted, padding:'40px 0', textAlign:'center'}}>
            Non-secret env vars for {stage} would go here.
          </div>
        )}
        {tab === 'urls' && (
          <div style={{fontSize:13, color:OC.muted, padding:'40px 0', textAlign:'center'}}>
            Public URL routing for {stage} would go here.
          </div>
        )}
        {tab === 'access' && (
          <AccessControlPane
            kind={accessKind} setKind={setAccessKind}
            list={accessList} stageLabel={isLiveDev ? 'live-dev' : stage}/>
        )}
      </div>
      <div style={{padding:'12px 20px', borderTop:`1px solid ${OC.border}`,
                   display:'flex', gap:8, justifyContent:'flex-end', background:OC.surface}}>
        <OBtn variant="default" size="sm" onClick={onClose}>Cancel</OBtn>
        <OBtn variant="primary" size="sm">Save changes</OBtn>
      </div>
    </Overlay>
  );
}

// ─── Access control pane ─────────────────────────────────────────────────────
function AccessControlPane({ kind, setKind, list, stageLabel }) {
  const roleTone = (r) => ({
    owner:   { bg:'#dbeafe', fg:'#1d4ed8' },
    admin:   { bg:'#dcfce7', fg:'#15803d' },
    editor:  { bg:'#fef3c7', fg:'#a16207' },
    viewer:  { bg:'#f1f5f9', fg:'#475569' },
    auditor: { bg:'#ede9fe', fg:'#6d28d9' },
  }[r] || { bg:'#f1f5f9', fg:'#475569' });

  return (
    <div style={{display:'flex', flexDirection:'column', gap:12}}>
      <div style={{display:'flex', alignItems:'center', gap:10}}>
        {/* Groups/Users switcher */}
        <div style={{
          display:'inline-flex', padding:2, background:OC.surface,
          border:`1px solid ${OC.border}`, borderRadius:6, gap:2,
        }}>
          {[
            { id:'groups', label:'Groups', icon:'users' },
            { id:'users',  label:'Users',  icon:'user'  },
          ].map(t => {
            const active = t.id === kind;
            return (
              <button key={t.id} onClick={() => setKind(t.id)} style={{
                display:'inline-flex', alignItems:'center', gap:6,
                padding:'5px 12px', background: active ? '#fff' : 'transparent',
                color: active ? OC.fg : OC.muted,
                border:0, borderRadius:4, cursor:'pointer', fontFamily:'inherit',
                fontSize:12, fontWeight: active ? 600 : 500,
                boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
              }}>
                <OIcon name={t.icon} size={12}/>
                {t.label}
                <span style={{
                  fontSize:10, padding:'1px 6px', borderRadius:9999,
                  background: active ? OC.surface2 : 'transparent',
                  color: active ? OC.muted : OC.mutedFg, fontWeight:500,
                }}>
                  {(t.id === kind ? list.length : '')}
                </span>
              </button>
            );
          })}
        </div>
        <span style={{fontSize:11, color:OC.muted, marginLeft:4}}>
          on <b style={{color:OC.fg, fontFamily:'Geist Mono, monospace'}}>{stageLabel}</b>
        </span>
        <div style={{flex:1}}/>
        <OBtn variant="primary" size="sm" leftIcon="plus">
          Add {kind === 'groups' ? 'group' : 'user'}
        </OBtn>
      </div>

      <div style={{fontSize:11, color:OC.muted}}>
        {kind === 'groups'
          ? 'Roles are inherited by all members of a group. Sourced from your identity provider.'
          : 'Direct user grants override group permissions.'}
      </div>

      <div style={{
        border:`1px solid ${OC.border}`, borderRadius:8, overflow:'hidden',
        background:'#fff',
      }}>
        {list.length === 0 && (
          <div style={{padding:'36px 16px', textAlign:'center', color:OC.muted, fontSize:13}}>
            No {kind === 'groups' ? 'groups' : 'users'} assigned to {stageLabel}.
          </div>
        )}
        {list.map((item, i) => {
          const rt = roleTone(item.role);
          const isGroup = kind === 'groups';
          return (
            <div key={isGroup ? item.name : item.email}
              style={{
                display:'flex', alignItems:'center', gap:12,
                padding:'10px 14px',
                borderTop: i > 0 ? `1px solid ${OC.border}` : 'none',
              }}>
              <div style={{
                width:32, height:32, borderRadius: isGroup ? 6 : 9999,
                background: isGroup ? OC.surface2 : '#dbeafe',
                color: isGroup ? OC.muted : '#1d4ed8',
                display:'inline-flex', alignItems:'center', justifyContent:'center',
                fontSize:11, fontWeight:700, flex:'0 0 auto',
              }}>
                {isGroup ? <OIcon name="users" size={14}/> : item.avatar}
              </div>
              <div style={{flex:1, minWidth:0}}>
                <div style={{fontSize:13, fontWeight:600, color:OC.fg,
                             overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                  {isGroup ? item.name : item.name}
                </div>
                <div style={{fontSize:11, color:OC.muted, marginTop:1,
                             display:'flex', alignItems:'center', gap:6}}>
                  {isGroup ? (
                    <>
                      <OIcon name="user" size={10}/>
                      <span>{item.members} members</span>
                      <span>·</span>
                      <OIcon name="building-2" size={10}/>
                      <span>{item.source}</span>
                    </>
                  ) : (
                    <span style={{fontFamily:'Geist Mono, monospace'}}>{item.email}</span>
                  )}
                </div>
              </div>
              <select defaultValue={item.role} style={{
                fontSize:11, fontWeight:600, padding:'3px 8px',
                background: rt.bg, color: rt.fg,
                border:0, borderRadius:9999, fontFamily:'inherit',
                textTransform:'uppercase', letterSpacing:0.3, cursor:'pointer',
              }}>
                {['owner','admin','editor','viewer','auditor'].map(r => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
              <OBtn variant="ghost" size="xs" leftIcon="trash-2"/>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InspectOverlay({ open, onClose, aut, mode }) {
  const isLiveDev = mode === 'liveDev';
  const [stage, setStage] = useStateO(isLiveDev ? 'live-dev' : 'dev');
  const [tab, setTab] = useStateO('overview');
  React.useEffect(() => { if (window.lucide) window.lucide.createIcons(); });

  if (!aut) return null;
  const stageLabel = isLiveDev ? 'live-dev' : stage;
  const sampleLogs = [
    `[14:02:11] INFO  ${stageLabel} container started — sha a3f8c21`,
    `[14:02:12] INFO  serving on :8080`,
    `[14:13:48] DEBUG GET /api/employees → 200 (47ms)`,
    `[14:14:03] DEBUG POST /api/payroll → 201 (112ms)`,
    `[14:14:08] WARN  slow query: SELECT * FROM compensation (412ms)`,
    `[14:14:32] DEBUG GET /api/contracts/123 → 200 (22ms)`,
    `[14:14:48] INFO  background job: payroll-recalc completed in 2.3s`,
  ];

  const inspectGroups = [
    {
      heading: 'Identity',
      icon: 'fingerprint',
      rows: [
        ['Container ID', '7f3c2a98e4b1'],
        ['Name',         `bitswan_${aut.name}_${stage}`],
        ['Created',      'Apr 28, 2026 · 14:02:11 UTC'],
        ['Status',       <OPill tone="success">Running · healthy</OPill>],
        ['Restart count', '0'],
      ],
    },
    {
      heading: 'Image',
      icon: 'box',
      rows: [
        ['Repository',   `bitswan/${aut.name}`],
        ['Commit',       stage === 'dev' ? 'a3f8c21d4e9b7f6c0a1d2e3f4b5c6d7e8f9a0b1c'
                       : stage === 'staging' ? '7b2e9d4a8c1f5e3b6d9a0c2e4f8b1d3a5c7e9b2d'
                       : 'f1c4e7a2b9d6c3e0f8a5b2d4c7e9f1a3b5d8c0e2'],
        ['Digest',       'sha256:a1b2c3d4…ef89'],
        ['Size',         '142 MB'],
        ['Pulled',       '3 hours ago'],
      ],
    },
    {
      heading: 'Network',
      icon: 'network',
      rows: [
        ['Network',      'bitswan_internal'],
        ['IP address',   '10.42.0.17'],
        ['Ports',        '8080/tcp → 8080 (host)'],
        ['Hostname',     `${aut.name}-${stage}`],
        ['Public URL',   stage === 'production' ? 'hr.harmonum.ai' : '—'],
      ],
    },
    {
      heading: 'Resources',
      icon: 'cpu',
      rows: [
        ['CPU limit',    '2 cores · using 0.34 (17%)'],
        ['Memory limit', '512 MB · using 187 MB (37%)'],
        ['PIDs',         '24'],
        ['Storage',      '/var/lib/bitswan/data — 1.2 GB'],
      ],
    },
    {
      heading: 'Mounts & volumes',
      icon: 'hard-drive',
      rows: [
        ['/app/data',     'volume bitswan_data (rw)'],
        ['/app/secrets',  'tmpfs (ro)'],
        ['/etc/config',   'configmap (ro)'],
      ],
    },
    {
      heading: 'Health check',
      icon: 'heart-pulse',
      rows: [
        ['Endpoint',     'GET /healthz'],
        ['Interval',     '30s'],
        ['Last check',   <span style={{color:OC.green, fontWeight:500}}>OK · 2s ago</span>],
        ['Failing streak', '0'],
      ],
    },
  ];

  return (
    <Overlay open={open} onClose={onClose} width={1100}>
      <div style={{padding:'16px 20px', borderBottom:`1px solid ${OC.border}`,
                   display:'flex', alignItems:'center', gap:10}}>
        <OIcon name="activity" size={16} color={OC.muted}/>
        <div style={{flex:1, minWidth:0}}>
          <div style={{fontSize:14, fontWeight:600, color:OC.fg}}>
            Inspect <span style={{fontFamily:'Geist Mono, monospace'}}>{aut.name}</span>
          </div>
          <div style={{fontSize:12, color:OC.muted}}>
            {isLiveDev
              ? 'Local container — logs, metrics, and details for this worktree'
              : 'Container details, logs, metrics — per stage'}
          </div>
        </div>
        <OBtn variant="outline" size="sm" leftIcon="terminal"
              onClick={() => setTab('logs')}>View logs</OBtn>
        {isLiveDev && aut.liveDev?.status === 'stopped' && (
          <OBtn variant="primary" size="sm" leftIcon="play">Start</OBtn>
        )}
        {isLiveDev && aut.liveDev?.status === 'failed' && (
          <OBtn variant="primary" size="sm" leftIcon="rotate-cw">Retry</OBtn>
        )}
        {(!isLiveDev || aut.liveDev?.status === 'running' || aut.liveDev?.status === 'starting') && (
          <>
            <OBtn variant="outline" size="sm" leftIcon="rotate-cw">Restart</OBtn>
            <OBtn variant="outline" size="sm" leftIcon="square">Stop</OBtn>
          </>
        )}
        {!isLiveDev && (
          <OBtn variant="outline" size="sm" leftIcon="cloud-upload">Redeploy</OBtn>
        )}
        <OBtn variant="ghost" size="sm" leftIcon="x" onClick={onClose}/>
      </div>
      {!isLiveDev && <StageTabs active={stage} onChange={setStage}/>}
      <div style={{display:'flex', borderBottom:`1px solid ${OC.border}`,
                   background:OC.surface, padding:'0 16px'}}>
        {[['overview','Overview','info'],['logs','Logs','terminal'],['metrics','Metrics','line-chart'],['events','Events','clock']].map(([id,lab,ic]) => (
          <button key={id} onClick={() => setTab(id)} style={{
            display:'flex', alignItems:'center', gap:6,
            padding:'10px 14px', background:'transparent', border:0,
            borderBottom: tab === id ? `2px solid ${OC.fg}` : '2px solid transparent',
            marginBottom:-1, fontSize:12, fontWeight: tab === id ? 600 : 500,
            color: tab === id ? OC.fg : OC.muted, cursor:'pointer', fontFamily:'inherit',
          }}>
            <OIcon name={ic} size={12}/>{lab}
          </button>
        ))}
      </div>
      <div style={{flex:1, overflow:'hidden', display:'flex', flexDirection:'column', minHeight:520}}>
        {tab === 'overview' && (
          <div style={{flex:1, overflow:'auto', padding:'18px 22px',
                       display:'grid', gridTemplateColumns:'1fr 1fr', gap:18}}>
            {inspectGroups.map(g => (
              <div key={g.heading} style={{
                border:`1px solid ${OC.border}`, borderRadius:10, overflow:'hidden',
                background:'#fff',
              }}>
                <div style={{
                  padding:'10px 14px', background:OC.surface,
                  borderBottom:`1px solid ${OC.border}`,
                  display:'flex', alignItems:'center', gap:8,
                  fontSize:12, fontWeight:600, color:OC.fg,
                  textTransform:'uppercase', letterSpacing:0.4,
                }}>
                  <OIcon name={g.icon} size={13} color={OC.muted}/>
                  {g.heading}
                </div>
                <table style={{width:'100%', borderCollapse:'collapse', fontSize:12}}>
                  <tbody>
                    {g.rows.map(([k,v], i) => (
                      <tr key={k} style={{borderTop: i > 0 ? `1px solid ${OC.border}` : 'none'}}>
                        <td style={{
                          padding:'8px 14px', color:OC.muted, fontWeight:500,
                          width:'40%', verticalAlign:'top',
                        }}>{k}</td>
                        <td style={{
                          padding:'8px 14px', color:OC.fg,
                          fontFamily: typeof v === 'string' && /^[a-z0-9:./_-]+$/i.test(v) && !/\s/.test(v)
                            ? 'Geist Mono, monospace' : 'inherit',
                          wordBreak:'break-all',
                        }}>{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
        {tab === 'logs' && (
          <div style={{flex:1, overflow:'auto', background:'#0c0c0e', padding:'14px 18px',
                       fontFamily:'Geist Mono, monospace', fontSize:12, lineHeight:'19px'}}>
            {sampleLogs.map((l,i) => {
              const isWarn = /WARN/.test(l);
              const isErr = /ERROR|FATAL/.test(l);
              const isInfo = /INFO/.test(l);
              return <div key={i} style={{color: isErr ? '#fca5a5' : isWarn ? '#fcd34d' : isInfo ? '#a5b4fc' : '#a1a1aa'}}>{l}</div>;
            })}
          </div>
        )}
        {tab === 'metrics' && (
          <div style={{padding:'60px 20px', textAlign:'center', color:OC.muted, fontSize:13}}>
            CPU / memory / request graphs for {stage}.
          </div>
        )}
        {tab === 'events' && (
          <div style={{padding:'60px 20px', textAlign:'center', color:OC.muted, fontSize:13}}>
            Deploy / restart / crash event log for {stage}.
          </div>
        )}
      </div>
    </Overlay>
  );
}

// ─── Stage info panel + action bar ───────────────────────────────────────────
function StageInfoPanel({ stageMeta, runtime, currentDeploy, sourceStage, targetStage, canPromote, onPromote, otherStageDiffs, onDiff }) {
  if (!currentDeploy) {
    return (
      <div style={{padding:'14px 22px', borderBottom:`1px solid ${OC.border}`,
                   background:'#fff', display:'flex', alignItems:'center', gap:14}}>
        <OPill tone="neutral">Not deployed</OPill>
        <span style={{fontSize:12, color:OC.muted}}>
          No deployment on this stage yet.
        </span>
      </div>
    );
  }
  const state = runtime?.state || (currentDeploy.status === 'deployed' ? 'running' : currentDeploy.status);
  const stateColor = state === 'running' ? OC.green : state === 'failed' ? OC.red : OC.amber;
  // No stage-level actions remain here — Scale lives on the current deployment
  // card, rollback/diff live on each history card.
  return null;
}

// ─── Scale event row ─────────────────────────────────────────────────────────
function ScaleEventRow({ ev }) {
  const isAuto = ev.who === 'autoscaler';
  return (
    <div style={{
      background:'#fff', border:`1px solid ${OC.border}`, borderRadius:10,
      padding:'10px 14px', display:'flex', alignItems:'center', gap:12,
    }}>
      <div style={{
        width:28, height:28, borderRadius:'50%',
        background: isAuto ? '#fef3c7' : OC.surface2,
        display:'inline-flex', alignItems:'center', justifyContent:'center', flex:'0 0 auto',
      }}>
        <OIcon name="scaling" size={14} color={isAuto ? '#92400e' : OC.muted}/>
      </div>
      <div style={{flex:1, minWidth:0}}>
        <div style={{fontSize:13, color:OC.fg}}>
          Scaled <strong>{ev.from}</strong> → <strong>{ev.to}</strong> replicas
          <span style={{color:OC.muted, marginLeft:8, fontWeight:400}}>· {ev.reason}</span>
        </div>
        <div style={{fontSize:11, color:OC.muted, marginTop:2,
                     display:'flex', alignItems:'center', gap:6}}>
          <OIcon name={isAuto ? 'cpu' : 'user'} size={11}/>
          <span>{ev.who}</span>
          <span>·</span>
          <span>{ev.atAbs || ev.at}</span>
        </div>
      </div>
      <OPill tone={isAuto ? 'warning' : 'neutral'}>{isAuto ? 'auto' : 'manual'}</OPill>
    </div>
  );
}

// ─── Promote flow with audit gate ────────────────────────────────────────────
function PromoteFlow({ open, onClose, aut, bpId, sourceStage, targetStage, sourceDeploy, currentDeploy }) {
  const [reportText, setReportText] = useStateO('');
  const [verdict, setVerdict] = useStateO('approve');
  React.useEffect(() => { if (window.lucide) window.lucide.createIcons(); }, [open, verdict]);
  React.useEffect(() => { if (open) { setReportText(''); setVerdict('approve'); } }, [open, sourceDeploy?.sha]);

  if (!open || !sourceStage || !targetStage || !sourceDeploy) return null;

  const policy = (window.WD_DATA?.AUDIT_POLICY?.[`${bpId}:${targetStage.id}`])
              || { required:1, allowAi:true, roles:['developer','auditor'], description:'1 audit' };
  const auditKey = `${bpId}:${aut.id}:${targetStage.id}:${sourceDeploy.sha}`;
  const existing = (window.WD_DATA?.PENDING_AUDITS?.[auditKey]) || [];
  const user = window.WD_DATA?.CURRENT_USER || { email:'you@harmonum.ai', roles:['developer'] };
  const userCanAudit = policy.roles.some(r => user.roles.includes(r));
  const userAlreadySigned = existing.some(a => a.who === user.email);
  const approvals = existing.filter(a => a.verdict === 'approve' && !a.advisory);
  const policyMet = approvals.length >= policy.required;

  return (
    <div onClick={onClose} style={{
      position:'absolute', inset:0, background:'rgba(0,0,0,0.55)',
      display:'flex', alignItems:'center', justifyContent:'center', zIndex:70,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width:'min(96%, 1080px)', maxHeight:'94%', background:'#fff',
        border:`1px solid ${OC.border}`, borderRadius:12, overflow:'hidden',
        boxShadow:'0 25px 50px -12px rgba(0,0,0,0.35)',
        display:'flex', flexDirection:'column',
      }}>
        <div style={{padding:'16px 22px', borderBottom:`1px solid ${OC.border}`,
                     display:'flex', alignItems:'center', gap:12}}>
          <div style={{width:32, height:32, borderRadius:6, background:OC.primarySoft,
                       display:'inline-flex', alignItems:'center', justifyContent:'center'}}>
            <OIcon name="git-merge" size={16} color={OC.primary}/>
          </div>
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontSize:15, fontWeight:600, color:OC.fg,
                         display:'flex', alignItems:'center', gap:8}}>
              Promote <span style={{fontFamily:'Geist Mono, monospace'}}>{aut.name}</span>
              <OIcon name="arrow-right" size={13} color={OC.mutedFg}/>
              <span>{sourceStage.label}</span>
              <OIcon name="arrow-right" size={13} color={OC.mutedFg}/>
              <span style={{color:OC.primary}}>{targetStage.label}</span>
            </div>
            <div style={{fontSize:12, color:OC.muted, marginTop:2,
                         display:'inline-flex', alignItems:'center', gap:6}}>
              <OIcon name="shield-check" size={11}/>
              Audit policy: {policy.description}
            </div>
          </div>
          <OBtn variant="ghost" size="sm" leftIcon="x" onClick={onClose}/>
        </div>

        <div style={{flex:1, minHeight:0, display:'grid',
                     gridTemplateColumns:'1.4fr 1fr', overflow:'hidden'}}>
          <div style={{borderRight:`1px solid ${OC.border}`,
                       display:'flex', flexDirection:'column', minHeight:0}}>
            <div style={{padding:'10px 18px', borderBottom:`1px solid ${OC.border}`,
                         fontSize:12, fontWeight:600, color:OC.fg,
                         display:'flex', alignItems:'center', gap:8}}>
              <OIcon name="git-compare" size={13} color={OC.muted}/>
              Pre-promotion diff
              <span style={{color:OC.muted, fontWeight:400}}>
                — what changes if you promote
              </span>
            </div>
            <div style={{flex:1, minHeight:0, overflow:'auto'}}>
              <DiffPanel
                a={{ label: `current on ${targetStage.label}`,
                     sha: currentDeploy?.sha || '0000000',
                     who: currentDeploy?.who, when: currentDeploy?.deployedAt }}
                b={{ label: `incoming from ${sourceStage.label}`,
                     sha: sourceDeploy.sha,
                     who: sourceDeploy.who, when: sourceDeploy.deployedAt }}
              />
            </div>
          </div>

          <div style={{display:'flex', flexDirection:'column', minHeight:0,
                       background: OC.surface}}>
            <div style={{padding:'10px 18px', borderBottom:`1px solid ${OC.border}`,
                         fontSize:12, fontWeight:600, color:OC.fg,
                         display:'flex', alignItems:'center', gap:8}}>
              <OIcon name="shield-check" size={13} color={OC.muted}/>
              Audit sign-offs
              <OPill tone={policyMet ? 'success' : 'warning'}>
                {approvals.length} / {policy.required}
              </OPill>
            </div>

            <div style={{flex:1, minHeight:0, overflow:'auto', padding:'14px 18px',
                         display:'flex', flexDirection:'column', gap:10}}>
              {existing.length === 0 && (
                <div style={{padding:'16px 12px', border:`1px dashed ${OC.border}`,
                             borderRadius:8, fontSize:12, color:OC.muted, textAlign:'center'}}>
                  No audits yet. {policy.required} required to promote.
                </div>
              )}
              {existing.map((a, i) => <AuditCard key={i} a={a}/>)}
              {policy.allowAi && (
                <button style={{
                  appearance:'none', border:`1px dashed ${OC.border}`, background:'#fff',
                  borderRadius:8, padding:'10px 12px', fontSize:12, color:OC.fg,
                  display:'flex', alignItems:'center', gap:8, cursor:'pointer',
                  fontFamily:'inherit', textAlign:'left',
                }}>
                  <OIcon name="sparkles" size={13} color={OC.primary}/>
                  <span>Request AI audit</span>
                  <span style={{marginLeft:'auto', color:OC.muted}}>
                    Static analysis · risk · ~30s
                  </span>
                </button>
              )}
            </div>

            {userCanAudit && !userAlreadySigned && (
              <div style={{padding:'14px 18px', borderTop:`1px solid ${OC.border}`,
                           background:'#fff', display:'flex', flexDirection:'column', gap:10}}>
                <div style={{fontSize:12, fontWeight:600, color:OC.fg,
                             display:'flex', alignItems:'center', gap:8}}>
                  <OIcon name="pen-line" size={13} color={OC.muted}/>
                  Your sign-off
                  <span style={{color:OC.muted, fontWeight:400}}>
                    as {user.email} · {user.roles.find(r => policy.roles.includes(r))}
                  </span>
                </div>
                <div style={{display:'flex', gap:6}}>
                  {['approve', 'reject'].map(v => (
                    <button key={v} onClick={() => setVerdict(v)} style={{
                      appearance:'none',
                      border:`1px solid ${verdict===v ? (v==='approve'?OC.green:OC.red) : OC.border}`,
                      background: verdict===v ? (v==='approve' ? '#dcfce7' : '#fee2e2') : '#fff',
                      color: verdict===v ? (v==='approve' ? '#166534' : '#991b1b') : OC.fg,
                      borderRadius:6, padding:'6px 12px', fontSize:12, fontWeight:500,
                      fontFamily:'inherit', cursor:'pointer', flex:1,
                      display:'inline-flex', alignItems:'center', justifyContent:'center', gap:6,
                    }}>
                      <OIcon name={v==='approve' ? 'check' : 'x'} size={12}/>
                      {v === 'approve' ? 'Approve' : 'Reject'}
                    </button>
                  ))}
                </div>
                <textarea
                  value={reportText}
                  onChange={e => setReportText(e.target.value)}
                  placeholder="Audit report — what did you check? Any concerns? (Required)"
                  rows={4}
                  style={{
                    width:'100%', boxSizing:'border-box',
                    border:`1px solid ${OC.border}`, borderRadius:6, padding:8,
                    fontSize:12, fontFamily:'inherit', color:OC.fg, resize:'vertical',
                  }}
                />
                <OBtn variant={verdict==='approve' ? 'primary' : 'destructive'} size="sm"
                      leftIcon={verdict==='approve' ? 'check-circle-2' : 'x-circle'}>
                  Sign off · {verdict === 'approve' ? 'Approve' : 'Reject'} promotion
                </OBtn>
              </div>
            )}
            {userCanAudit && userAlreadySigned && (
              <div style={{padding:'12px 18px', borderTop:`1px solid ${OC.border}`,
                           background:'#fff', fontSize:12, color:OC.muted,
                           display:'flex', alignItems:'center', gap:8}}>
                <OIcon name="check-circle-2" size={13} color={OC.green}/>
                You've already signed off on this promotion candidate.
              </div>
            )}
            {!userCanAudit && (
              <div style={{padding:'12px 18px', borderTop:`1px solid ${OC.border}`,
                           background:'#fff', fontSize:12, color:OC.muted,
                           display:'flex', alignItems:'center', gap:8}}>
                <OIcon name="lock" size={13} color={OC.mutedFg}/>
                You don't have a role permitted by this audit policy ({policy.roles.join(', ')}).
              </div>
            )}
          </div>
        </div>

        <div style={{padding:'14px 22px', borderTop:`1px solid ${OC.border}`, background:'#fff',
                     display:'flex', alignItems:'center', gap:10}}>
          <div style={{fontSize:12, color:OC.muted, display:'flex', alignItems:'center', gap:6}}>
            {policyMet
              ? <><OIcon name="shield-check" size={13} color={OC.green}/>
                  <span style={{color:OC.fg, fontWeight:500}}>Policy met</span> — promotion ready</>
              : <><OIcon name="shield-alert" size={13} color={OC.amber}/>
                  Need {policy.required - approvals.length} more audit{policy.required - approvals.length !== 1 ? 's' : ''} to promote</>}
          </div>
          <div style={{marginLeft:'auto', display:'flex', gap:8}}>
            <OBtn variant="ghost" size="sm" onClick={onClose}>Cancel</OBtn>
            <OBtn variant="primary" size="sm" leftIcon="git-merge" disabled={!policyMet}>
              Promote to {targetStage.label}
            </OBtn>
          </div>
        </div>
      </div>
    </div>
  );
}

function AuditCard({ a }) {
  const isAi = a.kind === 'ai';
  const isApprove = a.verdict === 'approve';
  return (
    <div style={{
      background:'#fff', border:`1px solid ${isApprove ? OC.green : OC.red}`,
      borderRadius:8, padding:'10px 12px',
      boxShadow: a.advisory ? '0 0 0 2px #ede9fe' : `0 0 0 2px ${isApprove ? '#dcfce7' : '#fee2e2'}`,
      display:'flex', flexDirection:'column', gap:6,
    }}>
      <div style={{display:'flex', alignItems:'center', gap:8}}>
        <div style={{
          width:24, height:24, borderRadius:'50%',
          background: isAi ? '#ede9fe' : OC.surface2,
          display:'inline-flex', alignItems:'center', justifyContent:'center', flex:'0 0 auto',
        }}>
          <OIcon name={isAi ? 'sparkles' : 'user'} size={12} color={isAi ? '#7c3aed' : OC.muted}/>
        </div>
        <div style={{flex:1, minWidth:0}}>
          <div style={{fontSize:12, fontWeight:600, color:OC.fg,
                       overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
            {a.who}
          </div>
          <div style={{fontSize:10, color:OC.muted}}>
            {a.role} · {isAi ? 'AI auditor' : 'human'}{a.advisory ? ' · advisory' : ''} · {a.signedAt}
          </div>
        </div>
        <OPill tone={isApprove ? (a.advisory ? 'info' : 'success') : 'danger'}>
          {a.advisory ? 'Advisory' : (isApprove ? 'Approved' : 'Rejected')}
        </OPill>
      </div>
      {a.report && (
        <div style={{fontSize:11, color:OC.fg, lineHeight:1.5,
                     paddingLeft:32, borderTop:`1px solid ${OC.border}`, paddingTop:6}}>
          {a.report}
        </div>
      )}
    </div>
  );
}

// ─── Stage secrets — simple key/value editor ────────────────────────────────
// Lightweight modal triggered from a stage's "Secrets" button. No tabs, no
// groups, no environment vars — just KEY = value rows.
// Big circular stage node — mirrors the StageNode on the Deployments page so
// the history overlay's stage selector uses the exact same visual.
const O_STAGE_ICON = { dev: 'code-2', staging: 'flask-conical', production: 'rocket' };
function OStageNode({ stageId, status }) {
  const deployed = status === 'deployed';
  const building = status === 'building';
  const failed   = status === 'failed';
  const dot = deployed ? OC.green : building ? OC.primary : failed ? OC.red : '#a1a1aa';
  const fill = (deployed || building || failed) ? dot : '#fff';
  const iconColor = (deployed || building || failed) ? '#fff' : OC.mutedFg;
  return (
    <div style={{position:'relative'}}>
      <div style={{
        width:52, height:52, borderRadius:9999,
        background: fill,
        border: status === 'not-deployed' ? `1.5px dashed ${OC.borderHi}` : 'none',
        display:'inline-flex', alignItems:'center', justifyContent:'center',
        flex:'0 0 auto',
        boxShadow: deployed ? '0 1px 2px rgba(22,163,74,0.2)' : 'none',
      }}>
        <OIcon name={O_STAGE_ICON[stageId] || 'box'} size={22} color={iconColor}/>
      </div>
      <div style={{
        position:'absolute', right:-2, bottom:-2,
        width:18, height:18, borderRadius:9999,
        background:'#fff', border:'2px solid #fff',
        display:'inline-flex', alignItems:'center', justifyContent:'center',
        boxShadow:'0 1px 2px rgba(0,0,0,0.12)',
      }}>
        {building ? <OIcon name="loader" size={11} color={dot}/>
        : failed   ? <OIcon name="x" size={11} color={dot}/>
        : deployed ? <OIcon name="check" size={11} color={dot}/>
        : <span style={{width:6, height:6, borderRadius:9999, background:OC.mutedFg}}/>}
      </div>
    </div>
  );
}

// Inline secrets editor — shared key names across stages, per-stage values.
// Used both in the modal (SecretsOverlay) and inline on the Deployments page.
function SecretsEditor({ stageId, bpName }) {
  const stage = O_STAGES.find(s => s.id === stageId);
  const [data, setData] = useStateO({ keys: [], values: {} });
  const [reveal, setReveal] = useStateO({});
  React.useEffect(() => {
    if (bpName != null) {
      const store = getSecretsStore(bpName);
      setData({ keys: [...store.keys], values: JSON.parse(JSON.stringify(store.values)) });
      setReveal({});
    }
  }, [bpName]);
  React.useEffect(() => { if (window.lucide) window.lucide.createIcons(); });

  if (!stage) return null;

  const commit = (next) => {
    setData(next);
    const store = getSecretsStore(bpName);
    store.keys = [...next.keys];
    store.values = JSON.parse(JSON.stringify(next.values));
  };
  const setValue = (key, v) => {
    const next = { ...data, values: { ...data.values } };
    next.values[stageId] = { ...(next.values[stageId] || {}), [key]: v };
    commit(next);
  };
  const renameKey = (oldKey, newRaw) => {
    const newKey = (newRaw || '').trim().toUpperCase();
    if (!newKey || newKey === oldKey || data.keys.includes(newKey)) return;
    const next = { keys: data.keys.map(k => k === oldKey ? newKey : k), values: {} };
    for (const sid of Object.keys(data.values)) {
      next.values[sid] = {};
      for (const k of Object.keys(data.values[sid])) {
        next.values[sid][k === oldKey ? newKey : k] = data.values[sid][k];
      }
    }
    commit(next);
  };
  const removeKey = (key) => {
    const next = { keys: data.keys.filter(k => k !== key), values: {} };
    for (const sid of Object.keys(data.values)) {
      next.values[sid] = { ...data.values[sid] };
      delete next.values[sid][key];
    }
    commit(next);
  };
  const addKey = () => {
    let n = 1, name = 'NEW_SECRET';
    while (data.keys.includes(name)) { n++; name = `NEW_SECRET_${n}`; }
    const next = { keys: [...data.keys, name], values: {} };
    for (const s of O_STAGES) {
      next.values[s.id] = { ...(data.values[s.id] || {}), [name]: '' };
    }
    commit(next);
  };
  const toggleReveal = (key) => setReveal({ ...reveal, [key]: !reveal[key] });

  const stageVals = data.values[stageId] || {};
  const missingCount = data.keys.filter(k => !(stageVals[k] || '').trim()).length;

  return (
    <div>
      {missingCount > 0 && (
        <div style={{
          margin:'0 0 12px', padding:'8px 12px',
          background:'#fffbeb', border:'1px solid #fcd34d', borderRadius:8,
          display:'flex', alignItems:'center', gap:8,
          fontSize:12, color:'#92400e',
        }}>
          <OIcon name="alert-triangle" size={14} color="#d97706"/>
          {missingCount} secret{missingCount === 1 ? '' : 's'} {missingCount === 1 ? 'has' : 'have'} no
          value in {stage.label} yet.
        </div>
      )}

      <div style={{
        display:'grid', gridTemplateColumns:'210px 1fr 32px', gap:8,
        fontSize:10, fontWeight:600, color:OC.mutedFg, letterSpacing:0.5,
        textTransform:'uppercase', padding:'0 0 6px',
      }}>
        <span>Name <span style={{fontWeight:500, textTransform:'none', letterSpacing:0}}>(shared)</span></span>
        <span>Value in {stage.short || stage.label}</span>
        <span/>
      </div>

      <div style={{display:'flex', flexDirection:'column', gap:8}}>
        {data.keys.length === 0 && (
          <div style={{
            fontSize:13, color:OC.muted, padding:'18px 0', textAlign:'center',
            border:`1.5px dashed ${OC.border}`, borderRadius:8,
          }}>
            No secrets yet — click "Add secret" below.
          </div>
        )}
        {data.keys.map((key) => {
          const val = stageVals[key] || '';
          const missing = !val.trim();
          return (
            <div key={key} style={{
              display:'grid', gridTemplateColumns:'210px 1fr 32px', gap:8,
              alignItems:'center',
            }}>
              <input
                defaultValue={key}
                onBlur={(e) => renameKey(key, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                style={{
                  height:32, padding:'0 10px',
                  border:`1px solid ${OC.border}`, borderRadius:6,
                  background:OC.surface, color:OC.fg,
                  fontFamily:'Geist Mono, ui-monospace, monospace',
                  fontSize:12, fontWeight:600, outline:'none',
                }}
              />
              <div style={{position:'relative'}}>
                <input
                  type={reveal[key] ? 'text' : 'password'}
                  value={val}
                  onChange={(e) => setValue(key, e.target.value)}
                  placeholder={missing ? 'Needs a value' : 'value'}
                  style={{
                    width:'100%', height:32, padding:'0 84px 0 10px',
                    border:`1px solid ${missing ? '#fcd34d' : OC.border}`,
                    borderRadius:6,
                    background: missing ? '#fffbeb' : '#fff', color:OC.fg,
                    fontFamily:'Geist Mono, ui-monospace, monospace',
                    fontSize:12, outline:'none', boxSizing:'border-box',
                  }}
                />
                {missing ? (
                  <span style={{
                    position:'absolute', right:8, top:7, fontSize:10, fontWeight:600,
                    color:'#92400e', letterSpacing:0.3, textTransform:'uppercase',
                  }}>Not set</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => toggleReveal(key)}
                    title={reveal[key] ? 'Hide' : 'Show'}
                    style={{
                      position:'absolute', right:6, top:5, height:22, padding:'0 6px',
                      background:'transparent', border:0, color: OC.muted,
                      cursor:'pointer', fontSize:11, fontFamily:'inherit',
                      display:'inline-flex', alignItems:'center', gap:4,
                    }}
                  >
                    <OIcon name={reveal[key] ? 'eye-off' : 'eye'} size={12}/>
                  </button>
                )}
              </div>
              <button
                onClick={() => removeKey(key)}
                title="Delete secret (removes from every stage)"
                style={{
                  width:32, height:32, padding:0, border:0, background:'transparent',
                  borderRadius:6, cursor:'pointer', color:OC.muted,
                  display:'inline-flex', alignItems:'center', justifyContent:'center',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = OC.surface;
                                       e.currentTarget.style.color = '#dc2626'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent';
                                       e.currentTarget.style.color = OC.muted; }}
              ><OIcon name="trash-2" size={13}/></button>
            </div>
          );
        })}
      </div>

      <button
        onClick={addKey}
        style={{
          marginTop:14, display:'inline-flex', alignItems:'center', gap:6,
          height:32, padding:'0 12px',
          background:'#fff', border:`1.5px dashed ${OC.borderHi}`, borderRadius:6,
          color: OC.muted, fontSize:12, fontWeight:500, fontFamily:'inherit',
          cursor:'pointer',
        }}
        title="Adds a secret name to every stage — fill in each stage's value separately"
      >
        <OIcon name="plus" size={13}/>
        Add secret
      </button>
    </div>
  );
}

function SecretsOverlay({ open, onClose, stageId, bpName }) {
  const stage = O_STAGES.find(s => s.id === stageId);
  React.useEffect(() => { if (window.lucide) window.lucide.createIcons(); });
  if (!open || !stage) return null;
  return (
    <Overlay open={open} onClose={onClose} width={640}>
      <div style={{
        padding:'18px 20px 14px', borderBottom:`1px solid ${OC.border}`,
        display:'flex', alignItems:'center', gap:12,
      }}>
        <div style={{
          width:36, height:36, borderRadius:8, background: OC.surface2,
          display:'inline-flex', alignItems:'center', justifyContent:'center',
        }}>
          <OIcon name="key-round" size={16} color={OC.fg}/>
        </div>
        <div style={{flex:1, minWidth:0}}>
          <div style={{fontSize:14, fontWeight:600, color:OC.fg}}>
            Secrets · {stage.label}
          </div>
          <div style={{fontSize:12, color:OC.muted, marginTop:2}}>
            Names are shared across all stages — values are set per stage.
          </div>
        </div>
        <button onClick={onClose} title="Close" style={{
          width:30, height:30, padding:0, border:0, background:'transparent',
          borderRadius:6, cursor:'pointer', color:OC.muted,
          display:'inline-flex', alignItems:'center', justifyContent:'center',
        }}><OIcon name="x" size={15}/></button>
      </div>
      <div style={{padding:'14px 20px', flex:1, overflow:'auto'}}>
        <SecretsEditor stageId={stageId} bpName={bpName}/>
      </div>
      <div style={{
        padding:'12px 20px', borderTop:`1px solid ${OC.border}`,
        background: OC.surface, display:'flex', alignItems:'center', justifyContent:'flex-end', gap:8,
      }}>
        <OBtn variant="ghost" size="sm" onClick={onClose}>Cancel</OBtn>
        <OBtn variant="primary" size="sm" leftIcon="check" onClick={onClose}>
          Save changes
        </OBtn>
      </div>
    </Overlay>
  );
}

window.WD_OVERLAYS = { ConfigureOverlay, InspectOverlay, StageHistoryOverlay, SecretsOverlay,
                       SecretsEditor, getSecretsStore,
                       DeploymentCard, ScaleEventRow, synthHistory, parseDate, OStageNode, DiffPanel };

// ─── Stage history overlay ──────────────────────────────────────────────────
function StageHistoryOverlay({ open, onClose, aut, stageId, bpId }) {
  const [diffShas, setDiffShas] = useStateO(null); // { fromSha, toSha } when viewing files
  const [activeStage, setActiveStage] = useStateO(stageId);
  const [promoteOpen, setPromoteOpen] = useStateO(false);
  React.useEffect(() => { setActiveStage(stageId); }, [stageId, aut?.id, open]);
  React.useEffect(() => { if (window.lucide) window.lucide.createIcons(); }, [open, diffShas, activeStage, promoteOpen]);
  React.useEffect(() => { setDiffShas(null); setPromoteOpen(false); }, [aut?.id, activeStage, open]);

  if (!open || !aut || !stageId) return null;

  // Build per-stage history map for the tab strip (so we can show counts + disable empties)
  const stageHistories = O_STAGES.map(s => {
    const k = `${bpId}:${aut.id}:${s.id}`;
    const raw = (window.WD_DATA && window.WD_DATA.DEPLOYMENT_HISTORY && window.WD_DATA.DEPLOYMENT_HISTORY[k]) || synthHistory(aut, s.id);
    const dep = raw && raw.length ? raw : synthHistory(aut, s.id);
    const scale = (window.WD_DATA && window.WD_DATA.SCALE_EVENTS && window.WD_DATA.SCALE_EVENTS[k]) || [];
    // Merge: deploy events have `current` flag; scale events have `kind:'scale'`. Sort by atAbs/deployedAtAbs desc.
    const merged = [...dep.map(d => ({...d, kind:'deploy'})), ...scale]
      .sort((a, b) => parseDate(b.atAbs || b.deployedAtAbs) - parseDate(a.atAbs || a.deployedAtAbs));
    return { stage: s, history: merged, deployHistory: dep };
  });

  const current = stageHistories.find(x => x.stage.id === activeStage)
                || stageHistories.find(x => x.history.length)
                || stageHistories[0];
  const history = current.history;
  const deployHistory = current.deployHistory;
  const stageMeta = current.stage;
  const currentDeploy = deployHistory.find(d => d.current);

  // Stage runtime info
  const rtKey = `${bpId}:${aut.id}:${stageMeta.id}`;
  const runtime = (window.WD_DATA?.STAGE_RUNTIME?.[rtKey]) || null;

  // Source for promote = THIS stage. Target = next in pipeline.
  // (Promote button lives on the source tab — "from here, push to next stage".)
  const nextStageIdx = O_STAGES.findIndex(s => s.id === stageMeta.id) + 1;
  const targetStage = nextStageIdx > 0 && nextStageIdx < O_STAGES.length ? O_STAGES[nextStageIdx] : null;
  const sourceStage = stageMeta;
  const sourceDeploy = currentDeploy;
  const targetCurrentDeploy = targetStage
    ? (stageHistories.find(x => x.stage.id === targetStage.id)?.deployHistory.find(d => d.current))
    : null;
  const canPromote = !!(targetStage && sourceDeploy && sourceDeploy.sha !== targetCurrentDeploy?.sha);

  // diff against same automation on a different stage (use the dev sha as a stand-in)
  const otherStages = O_STAGES.filter(s => s.id !== stageId).map(s => ({
    ...s, sha: aut.stages?.[s.id]?.sha,
  })).filter(s => s.sha);

  return (
    <Overlay open={open} onClose={onClose} width={960}>
      <div style={{padding:'16px 20px 0', borderBottom:`1px solid ${OC.border}`}}>
        <div style={{display:'flex', alignItems:'center', gap:10, paddingBottom:14}}>
          <div style={{
            width:30, height:30, borderRadius:6, background:OC.surface2,
            display:'inline-flex', alignItems:'center', justifyContent:'center',
          }}>
            <OIcon name="rocket" size={15} color={OC.muted}/>
          </div>
          <div style={{flex:1, minWidth:0}}>
            <div style={{display:'flex', alignItems:'center', gap:8, fontSize:14, fontWeight:600, color:OC.fg}}>
              <span style={{fontFamily:'Geist Mono, monospace'}}>{aut.name}</span>
              <OIcon name="chevron-right" size={13} color={OC.mutedFg}/>
              <span>Promotion manager</span>
            </div>
            <div style={{fontSize:12, color:OC.muted, marginTop:2}}>
              Deploy timeline · promote between stages with audit sign-off · scale, view logs, roll back
            </div>
          </div>
          <OBtn variant="ghost" size="sm" leftIcon="x" onClick={onClose}/>
        </div>

        {/* Stage pipeline — exact same visual as the Deployments page */}
        <div style={{position:'relative', marginTop:10}}>
          {/* connecting line across the middle */}
          <div style={{
            position:'absolute', left:'8.33%', right:'8.33%', top:26,
            height:2, background:OC.border, zIndex:0,
          }}/>
          <div style={{
            display:'grid',
            gridTemplateColumns:'1fr auto 1fr auto 1fr',
            alignItems:'center', gap:12,
            position:'relative', zIndex:1,
          }}>
            {stageHistories.map(({ stage, deployHistory: dh }, i) => {
              const active = stage.id === stageMeta.id;
              const empty = !dh.length;
              const cur = dh.find(x => x.current);
              const status = cur ? (cur.status === 'failed' ? 'failed' : 'deployed') : 'not-deployed';
              const next = stageHistories[i + 1];
              const nextCur = next && next.deployHistory.find(x => x.current);
              const canPromoteStep = !!(cur && (!nextCur || nextCur.sha !== cur.sha));
              return (
                <React.Fragment key={stage.id}>
                  <button
                    onClick={() => !(empty && !active) && setActiveStage(stage.id)}
                    disabled={empty && !active}
                    style={{
                      appearance:'none', border:'none', background:'#fff',
                      display:'flex', flexDirection:'column', alignItems:'center', gap:6,
                      padding:'0 4px', cursor:(empty && !active) ? 'not-allowed' : 'pointer',
                      fontFamily:'inherit', opacity:(empty && !active) ? 0.5 : 1,
                    }}
                  >
                    <span style={{
                      borderRadius:9999,
                      boxShadow: active ? `0 0 0 3px ${OC.fg}` : 'none',
                    }}>
                      <OStageNode stageId={stage.id} status={status}/>
                    </span>
                    <div style={{
                      fontSize:11, fontWeight:700,
                      color: active ? OC.fg : OC.muted,
                      letterSpacing:0.8, textTransform:'uppercase',
                    }}>{stage.label}</div>
                  </button>
                  {i < stageHistories.length - 1 && (
                    <div style={{background:'#fff', padding:'0 8px'}}>
                      <button
                        onClick={canPromoteStep ? () => { setActiveStage(stage.id); setPromoteOpen(true); } : undefined}
                        disabled={!canPromoteStep}
                        style={{
                          display:'inline-flex', alignItems:'center', gap:6,
                          height:30, padding:'0 12px',
                          background: canPromoteStep ? OC.primary : '#fff',
                          color: canPromoteStep ? '#fff' : OC.mutedFg,
                          border:`1px solid ${canPromoteStep ? OC.primary : OC.border}`,
                          borderRadius:9999,
                          fontSize:11, fontWeight:600, fontFamily:'inherit',
                          letterSpacing:0.3, textTransform:'uppercase',
                          cursor: canPromoteStep ? 'pointer' : 'not-allowed',
                          whiteSpace:'nowrap',
                        }}
                      >
                        Promote
                        <OIcon name="arrow-right" size={13}/>
                      </button>
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>

      {/* Stage runtime info + action bar */}
      <StageInfoPanel
        stageMeta={stageMeta}
        runtime={runtime}
        currentDeploy={currentDeploy}
        sourceStage={sourceStage}
        targetStage={targetStage}
        canPromote={canPromote}
        onPromote={() => setPromoteOpen(true)}
        otherStageDiffs={
          currentDeploy
            ? O_STAGES
                .filter(s => s.id !== stageMeta.id)
                .map(s => {
                  const sh = stageHistories.find(x => x.stage.id === s.id);
                  const cur = sh?.deployHistory.find(d => d.current);
                  return { stage: s, targetSha: cur?.sha };
                })
                .filter(d => d.targetSha)
            : []
        }
        onDiff={(targetSha) => setDiffShas({ fromSha: targetSha, toSha: currentDeploy.sha })}
      />

      {/* List of deployment cards */}
      <div style={{flex:1, minHeight:0, overflow:'auto', padding:'18px 22px',
                   background: OC.surface, display:'flex', flexDirection:'column', gap:12}}>
        {history.length === 0 ? (
          <div style={{padding:'40px 12px', textAlign:'center', color:OC.muted, fontSize:13}}>
            <OIcon name="cloud-off" size={28} color={OC.mutedFg}/>
            <div style={{marginTop:8, fontWeight:600, color:OC.fg}}>Not deployed yet</div>
            <div style={{marginTop:4}}>
              {stageMeta.id === 'dev'
                ? 'Sync from a worktree to deploy.'
                : 'Promote from a previous stage to start a deployment history.'}
            </div>
          </div>
        ) : history.map((h, i) => {
          if (h.kind === 'scale') {
            return <ScaleEventRow key={'scale'+i} ev={h}/>;
          }
          // Find previous deploy in deploy-only list for diff context
          const deployIdx = deployHistory.findIndex(d => d === h);
          const previous = deployHistory[deployIdx + 1];
          return (
            <DeploymentCard
              key={h.sha + i}
              h={h}
              previous={previous}
              currentSha={currentDeploy?.sha}
              stageLabel={stageMeta.label}
              onViewFiles={(fromSha, toSha) => setDiffShas({ fromSha, toSha })}
            />
          );
        })}
      </div>

      {/* Files / diff sub-overlay */}
      {diffShas && (() => {
        const from = history.find(h => h.sha === diffShas.fromSha);
        const to   = history.find(h => h.sha === diffShas.toSha);
        const isViewMode = diffShas.fromSha === diffShas.toSha;
        return (
          <div onClick={() => setDiffShas(null)} style={{
            position:'absolute', inset:0, background:'rgba(0,0,0,0.45)',
            display:'flex', alignItems:'center', justifyContent:'center', zIndex:60,
          }}>
            <div onClick={e => e.stopPropagation()} style={{
              width:'min(96%, 980px)', maxHeight:'92%', background:'#fff',
              border:`1px solid ${OC.border}`, borderRadius:12, overflow:'hidden',
              boxShadow:'0 25px 50px -12px rgba(0,0,0,0.25)',
              display:'flex', flexDirection:'column',
            }}>
              <div style={{padding:'14px 18px', borderBottom:`1px solid ${OC.border}`,
                           display:'flex', alignItems:'center', gap:10}}>
                <OIcon name="files" size={15} color={OC.muted}/>
                <div style={{flex:1, minWidth:0, fontSize:13, color:OC.fg}}>
                  {isViewMode ? 'Files at ' : 'Files changed — '}
                  <span style={{fontFamily:'Geist Mono, monospace'}}>{to?.sha.slice(0,7)}</span>
                  {!isViewMode && (
                    <>
                      {' (vs '}
                      <span style={{fontFamily:'Geist Mono, monospace'}}>{from?.sha.slice(0,7)}</span>
                      {')'}
                    </>
                  )}
                </div>
                <OBtn variant="ghost" size="sm" leftIcon="x" onClick={() => setDiffShas(null)}/>
              </div>
              <div style={{flex:1, minHeight:0, overflow:'auto'}}>
                <DiffPanel
                  viewOnly={isViewMode}
                  a={{ label: 'previous on ' + stageMeta.label, sha: from?.sha || '', who: from?.who, when: from?.deployedAt }}
                  b={{ label: isViewMode ? 'this deployment' : 'this deployment', sha: to?.sha || '', who: to?.who, when: to?.deployedAt }}
                />
              </div>
            </div>
          </div>
        );
      })()}

      {/* Promote flow */}
      <PromoteFlow
        open={promoteOpen}
        onClose={() => setPromoteOpen(false)}
        aut={aut}
        bpId={bpId}
        sourceStage={sourceStage}
        targetStage={targetStage}
        sourceDeploy={sourceDeploy}
        currentDeploy={targetCurrentDeploy}
      />
    </Overlay>
  );
}

// Inline panel chrome shared by the deployment-card sub-tabs.
const panelBox = {
  marginTop:12, border:`1px solid ${OC.border}`, borderRadius:10, overflow:'hidden',
  background:'#fff',
};
function PanelHead({ icon, title, sub, onClose }) {
  return (
    <div style={{padding:'12px 16px', borderBottom:`1px solid ${OC.border}`,
                 display:'flex', alignItems:'center', gap:10}}>
      <div style={{
        width:30, height:30, borderRadius:7, background:OC.surface2, flex:'0 0 auto',
        display:'inline-flex', alignItems:'center', justifyContent:'center',
      }}><OIcon name={icon} size={15} color={OC.fg}/></div>
      <div style={{flex:1, minWidth:0}}>
        <div style={{fontSize:14, fontWeight:700, color:OC.fg}}>{title}</div>
        {sub && <div style={{fontSize:11, color:OC.muted, marginTop:1,
                             fontFamily:'Geist Mono, monospace'}}>{sub}</div>}
      </div>
      <button onClick={onClose} title="Close" style={{
        width:28, height:28, border:0, background:'transparent', cursor:'pointer',
        color:OC.muted, display:'inline-flex', alignItems:'center', justifyContent:'center',
      }}><OIcon name="x" size={15}/></button>
    </div>
  );
}

// Proper file browser: folder tree on the left, file contents on the right.
function FileBrowser({ sha }) {
  const FILES = {
    'src/api/payroll.ts': "export async function syncPayroll(employeeId: string) {\n  const since = await getLastSync(employeeId);\n  const records = await togglFetch({ since });\n  if (!records.length) return { created: 0 };\n  for (const r of records) {\n    await db.payroll.upsert({ employeeId, ...r });\n  }\n}",
    'src/api/employees.ts': "export const listEmployees = (q: Query) =>\n  db.employees.where(q).orderBy('name');",
    'src/api/onboarding.ts': "export const onboardingSteps = [\n  'contract', 'equipment', 'accounts', 'intro-call',\n];",
    'src/pages/Compensation.tsx': "export function Compensation() {\n  const rows = useComp();\n  return <Table rows={rows} />;\n}",
    'src/pages/EmployeeDetail.tsx': "// 8-tab employee detail card\nexport function EmployeeDetail() { /* … */ }",
    'src/pages/Onboarding.tsx': "export function Onboarding() { /* checklist */ }",
    'src/lib/probation.ts': "export const isOnProbation = (e: Employee) =>\n  daysSince(e.startedAt) < 90;",
    'src/lib/toggl.ts': "export async function togglFetch(opts: TogglOpts) { /* … */ }",
    'src/lib/db.ts': "export const db = createClient(process.env.DATABASE_URL!);",
    'helm/values-staging.yaml': "replicas: 2\nimage:\n  tag: a3f8c21\nresources:\n  cpu: 500m",
    'package.json': '{\n  "name": "hr-module",\n  "version": "1.4.0"\n}',
    'README.md': "# HR Module\n\nEmployee lifecycle management platform.",
  };
  const paths = Object.keys(FILES);
  const [sel, setSel] = useStateO(paths[0]);

  // Build a nested tree from flat paths.
  const root = {};
  paths.forEach(p => {
    const parts = p.split('/');
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      node.children = node.children || {};
      node.children[part] = node.children[part] || (isFile ? { file:p } : {});
      node = node.children[part];
    });
  });

  const Row = ({ name, node, depth }) => {
    if (node.file) {
      const active = sel === node.file;
      return (
        <button onClick={() => setSel(node.file)} style={{
          display:'flex', alignItems:'center', gap:6, width:'100%', textAlign:'left',
          padding:`5px 10px 5px ${10 + depth*14}px`, border:0,
          background: active ? OC.surface2 : 'transparent', cursor:'pointer',
          color: active ? OC.fg : '#3f3f46', fontSize:12, fontFamily:'inherit',
          borderLeft: active ? `2px solid ${OC.fg}` : '2px solid transparent',
        }}>
          <OIcon name="file" size={12} color={OC.mutedFg}/>{name}
        </button>
      );
    }
    return (
      <div>
        <div style={{display:'flex', alignItems:'center', gap:6,
                     padding:`5px 10px 5px ${10 + depth*14}px`,
                     fontSize:12, color:OC.muted, fontWeight:600}}>
          <OIcon name="folder" size={12} color={OC.mutedFg}/>{name}
        </div>
        {Object.entries(node.children || {})
          .sort((a,b) => (!!a[1].file - !!b[1].file) || a[0].localeCompare(b[0]))
          .map(([n, c]) => <Row key={n} name={n} node={c} depth={depth+1}/>)}
      </div>
    );
  };

  return (
    <div style={{display:'flex', height:'100%'}}>
      <div style={{width:240, flex:'0 0 auto', borderRight:`1px solid ${OC.border}`,
                   overflow:'auto', background:OC.surface, padding:'6px 0'}}>
        {Object.entries(root.children || {})
          .sort((a,b) => (!!a[1].file - !!b[1].file) || a[0].localeCompare(b[0]))
          .map(([n, c]) => <Row key={n} name={n} node={c} depth={0}/>)}
      </div>
      <div style={{flex:1, minWidth:0, display:'flex', flexDirection:'column'}}>
        <div style={{padding:'8px 14px', borderBottom:`1px solid ${OC.border}`,
                     fontSize:12, color:OC.fg, fontFamily:'Geist Mono, monospace',
                     display:'flex', alignItems:'center', gap:8}}>
          <OIcon name="file" size={13} color={OC.mutedFg}/>{sel}
        </div>
        <pre style={{
          margin:0, flex:1, overflow:'auto', padding:'14px 16px',
          fontFamily:'Geist Mono, monospace', fontSize:12.5, lineHeight:'19px',
          color:'#1f2937', background:'#fff', whiteSpace:'pre',
        }}>{FILES[sel]}</pre>
      </div>
    </div>
  );
}

// Per-deployment audit sign-off panel (lives inside the Inspect modal).
function AuditPanel({ stageLabel, sha }) {
  const [audits, setAudits] = useStateO([
    { id:'a1', who:'security-agent', role:'Automated security scan', kind:'agent',
      status:'approved', at:'approved 2 days ago', note:'No critical CVEs, no secrets in diff.' },
    { id:'a2', who:'Jana Nováková', role:'Engineering lead', kind:'human',
      status:'approved', at:'signed off 1 day ago', note:'Payroll logic reviewed — looks correct.' },
    { id:'a3', who:'Compliance officer', role:'Required by policy', kind:'human',
      status:'pending', at:'awaiting sign-off', note:'' },
  ]);
  const required = audits.length;
  const done = audits.filter(a => a.status === 'approved').length;
  const allSigned = done === required;
  const meta = {
    approved: { bg:'#dcfce7', fg:'#15803d', label:'Approved', icon:'check' },
    pending:  { bg:'#fef9c3', fg:'#a16207', label:'Pending', icon:'clock' },
    rejected: { bg:'#fee2e2', fg:'#b91c1c', label:'Changes requested', icon:'x' },
  };
  return (
    <div style={{padding:'18px', display:'flex', flexDirection:'column', gap:12}}>
      <div style={{
        padding:'12px 14px', borderRadius:10,
        background: allSigned ? '#dcfce7' : '#eff6ff',
        border:`1px solid ${allSigned ? '#86efac' : '#bfdbfe'}`,
        display:'flex', alignItems:'center', gap:10,
      }}>
        <OIcon name={allSigned ? 'shield-check' : 'gavel'} size={16}
              color={allSigned ? '#15803d' : '#1d4ed8'}/>
        <div style={{flex:1, minWidth:0, fontSize:13, color:'#3f3f46', lineHeight:1.5}}>
          <strong style={{color:OC.fg}}>Promotion policy:</strong> this deployment must be audited and
          signed off by all required reviewers before it can be promoted to Production.
          {' '}<strong style={{color: allSigned ? '#15803d' : '#1d4ed8'}}>{done} of {required} complete.</strong>
        </div>
      </div>
      {audits.map(a => {
        const m = meta[a.status];
        return (
          <div key={a.id} style={{
            background:'#fff', border:`1px solid ${OC.border}`, borderRadius:10,
            padding:'12px 14px', display:'flex', alignItems:'flex-start', gap:12,
          }}>
            <div style={{
              width:32, height:32, borderRadius:'50%', flex:'0 0 auto',
              background: a.kind === 'agent' ? '#dbeafe' : OC.surface2,
              display:'inline-flex', alignItems:'center', justifyContent:'center',
            }}>
              <OIcon name={a.kind === 'agent' ? 'bot' : 'user'} size={15}
                    color={a.kind === 'agent' ? '#1d4ed8' : OC.muted}/>
            </div>
            <div style={{flex:1, minWidth:0}}>
              <div style={{display:'flex', alignItems:'center', gap:8, flexWrap:'wrap'}}>
                <span style={{fontSize:13, fontWeight:600, color:OC.fg}}>{a.who}</span>
                <span style={{fontSize:11, color:OC.muted}}>· {a.role}</span>
                <span style={{
                  display:'inline-flex', alignItems:'center', gap:4,
                  fontSize:10, fontWeight:700, padding:'1px 7px', borderRadius:9999,
                  background:m.bg, color:m.fg, letterSpacing:0.3, textTransform:'uppercase',
                }}>
                  <OIcon name={m.icon} size={10}/>{m.label}
                </span>
              </div>
              <div style={{fontSize:12, color:OC.muted, marginTop:3}}>{a.at}</div>
              {a.note && (
                <div style={{fontSize:12, color:'#3f3f46', marginTop:6, lineHeight:1.5,
                             paddingLeft:10, borderLeft:`2px solid ${OC.border}`}}>{a.note}</div>
              )}
              {a.status === 'pending' && (
                <div style={{display:'flex', gap:6, marginTop:10, flexWrap:'wrap'}}>
                  <button
                    onClick={() => setAudits(audits.map(x => x.id === a.id
                      ? {...x, status:'approved', at:'signed off just now'} : x))}
                    style={{
                      display:'inline-flex', alignItems:'center', gap:6, height:30, padding:'0 12px',
                      background:OC.primary, color:'#fff', border:`1px solid ${OC.primary}`, borderRadius:6,
                      fontSize:11, fontWeight:600, fontFamily:'inherit', cursor:'pointer',
                    }}><OIcon name="check" size={13}/>Sign off</button>
                  <button
                    onClick={() => setAudits(audits.map(x => x.id === a.id
                      ? {...x, status:'rejected', at:'changes requested just now'} : x))}
                    style={{
                      display:'inline-flex', alignItems:'center', gap:6, height:30, padding:'0 12px',
                      background:'#fff', color:'#b91c1c', border:`1px solid ${OC.border}`, borderRadius:6,
                      fontSize:11, fontWeight:600, fontFamily:'inherit', cursor:'pointer',
                    }}><OIcon name="x" size={13}/>Request changes</button>
                  <button
                    title="Ask a coding agent to audit this change"
                    style={{
                      display:'inline-flex', alignItems:'center', gap:6, height:30, padding:'0 12px',
                      background:'#fff', color:OC.fg, border:`1px solid ${OC.border}`, borderRadius:6,
                      fontSize:11, fontWeight:500, fontFamily:'inherit', cursor:'pointer',
                    }}><OIcon name="bot" size={13}/>Ask agent to audit</button>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DeploymentCard({ h, previous, currentSha, stageLabel, onViewFiles, audit }) {
  const [panel, setPanel] = useStateO(null); // 'scale'|'files'|'diff'|'secrets'|'audits'|'image'|null
  const [includeUserData, setIncludeUserData] = useStateO(false);
  const needsAudit = !!audit && audit.status === 'pending';
  const toggle = (id) => setPanel(p => p === id ? null : id);
  const imageOpen = panel === 'image';
  const setImageOpen = (v) => setPanel(typeof v === 'function' ? (v(imageOpen) ? 'image' : null) : (v ? 'image' : null));
  const dot = h.status === 'rolled-back' ? OC.amber
            : h.status === 'failed' ? OC.red
            : OC.green;
  const statusLabel = h.status === 'rolled-back' ? 'Rolled back'
                    : h.status === 'failed'      ? 'Failed'
                    : h.current                  ? 'Current'
                    : 'Deployed';
  const statusTone  = h.status === 'rolled-back' ? 'warning'
                    : h.status === 'failed'      ? 'danger'
                    : h.current                  ? 'primary'
                    : 'success';
  return (
    <div style={{
      background:'#fff', border:`1px solid ${h.current ? OC.primary : OC.border}`,
      borderRadius:10, padding:'14px 16px',
      boxShadow: h.current ? `0 0 0 3px ${OC.primarySoft}` : '0 1px 2px 0 rgba(0,0,0,0.03)',
      display:'flex', flexDirection:'column', gap:10,
    }}>
      <div style={{display:'flex', alignItems:'center', gap:10, flexWrap:'wrap'}}>
        <span style={{width:10, height:10, borderRadius:9999, background:dot, flex:'0 0 auto'}}/>
        <span style={{fontFamily:'Geist Mono, monospace', fontSize:13, fontWeight:600, color:OC.fg}}>
          {h.sha.slice(0, 12)}
        </span>
        <OPill tone={statusTone}>{statusLabel}{h.current ? ` on ${stageLabel}` : ''}</OPill>
        {audit && (
          <span title={audit.title || ''} style={{
            display:'inline-flex', alignItems:'center', gap:4,
            fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:9999,
            letterSpacing:0.3, textTransform:'uppercase',
            background: audit.status === 'passed' ? '#dcfce7'
                      : audit.status === 'pending' ? '#fef9c3' : '#fee2e2',
            color: audit.status === 'passed' ? '#15803d'
                  : audit.status === 'pending' ? '#a16207' : '#b91c1c',
          }}>
            <OIcon name={audit.status === 'passed' ? 'shield-check'
                       : audit.status === 'pending' ? 'shield' : 'shield-alert'} size={11}/>
            {audit.status === 'passed'
              ? <>Audited{audit.by && audit.by.length
                  ? <span style={{textTransform:'none', fontWeight:500, opacity:0.85}}>
                      {' · '}{audit.by.join(', ')}</span>
                  : null}</>
             : audit.status === 'pending' ? 'Audit pending' : 'Audit failed'}
          </span>
        )}
        <span style={{marginLeft:'auto', fontSize:11, color:OC.muted}}>
          {h.deployedAtAbs || h.deployedAt}
        </span>
        <div style={{display:'flex', gap:6}}>
          {h.current
            ? <OBtn variant="outline" size="sm" leftIcon="scaling" onClick={() => setPanel('scale')}>Scale</OBtn>
            : <OBtn variant="outline" size="sm" leftIcon="undo-2">Roll back</OBtn>}
          <span style={{position:'relative', display:'inline-flex'}}>
            <OBtn variant="primary" size="sm" leftIcon="search"
                  onClick={() => setPanel(needsAudit ? 'audits' : 'files')}>Inspect</OBtn>
            {needsAudit && (
              <span title="This deployment needs auditing" style={{
                position:'absolute', top:-4, right:-4, width:11, height:11, borderRadius:9999,
                background:'#dc2626', border:'2px solid #fff',
              }}/>
            )}
          </span>
        </div>
      </div>

      <div style={{fontSize:13, color:OC.fg, lineHeight:'19px'}}>
        {h.message}
      </div>

      <div style={{display:'flex', alignItems:'center', gap:14, flexWrap:'wrap',
                   fontSize:12, color:OC.muted}}>
        <span style={{display:'inline-flex', alignItems:'center', gap:4}}>
          <OIcon name="user" size={12}/>{h.who}
        </span>
        {h.stagedFrom && (
          <span style={{display:'inline-flex', alignItems:'center', gap:4}}>
            <OIcon name="git-merge" size={12}/>promoted from {h.stagedFrom}
          </span>
        )}
      </div>

      {panel !== null && ReactDOM.createPortal(
        <div onClick={() => setPanel(null)} style={{
          position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:1000,
          display:'flex', alignItems:'center', justifyContent:'center', padding:20,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            width:960, height:620, maxWidth:'96vw', maxHeight:'90vh', background:'#fff',
            border:`1px solid ${OC.border}`, borderRadius:12, overflow:'hidden',
            display:'flex', boxShadow:'0 25px 50px -12px rgba(0,0,0,0.35)',
          }}>
            {/* Left tab rail */}
            <div style={{
              width:210, flex:'0 0 auto', borderRight:`1px solid ${OC.border}`,
              background:OC.surface, display:'flex', flexDirection:'column',
            }}>
              <div style={{padding:'16px 16px 12px', borderBottom:`1px solid ${OC.border}`}}>
                <div style={{fontSize:13, fontWeight:700, color:OC.fg}}>Inspect</div>
                <div style={{fontSize:11, color:OC.muted, marginTop:2, fontFamily:'Geist Mono, monospace'}}>
                  {stageLabel} · {(h.sha||'').slice(0,7)}
                </div>
              </div>
              <div style={{padding:'8px', display:'flex', flexDirection:'column', gap:2}}>
                {[
                  ...(h.current ? [['scale','scaling','Scale']] : []),
                  ['files','files','Files'],
                  ['diff','git-compare','Diff vs current'],
                  ['secrets','key-round','Secrets snapshot'],
                  ...(audit ? [['audits','clipboard-check','Audits', needsAudit]] : []),
                  ['image','package','Download image'],
                ].map(([id,ic,label,dot]) => {
                  const on = panel === id;
                  return (
                    <button key={id} onClick={() => setPanel(id)} style={{
                      display:'flex', alignItems:'center', gap:9, width:'100%', textAlign:'left',
                      padding:'9px 10px', borderRadius:7, border:0,
                      background: on ? '#fff' : 'transparent',
                      boxShadow: on ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                      color: on ? OC.fg : OC.muted, fontSize:13, fontWeight: on ? 600 : 500,
                      fontFamily:'inherit', cursor:'pointer',
                    }}>
                      <OIcon name={ic} size={14} color={on ? OC.primary : OC.mutedFg}/>
                      <span style={{flex:1}}>{label}</span>
                      {dot && <span title="Needs auditing" style={{
                        width:8, height:8, borderRadius:9999, background:'#dc2626', flex:'0 0 auto',
                      }}/>}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Right content */}
            <div style={{flex:1, minWidth:0, display:'flex', flexDirection:'column'}}>
              <div style={{padding:'12px 16px', borderBottom:`1px solid ${OC.border}`,
                           display:'flex', alignItems:'center', gap:10}}>
                <div style={{flex:1, minWidth:0, fontSize:14, fontWeight:600, color:OC.fg}}>
                  {({scale:'Scale', files:'Files', diff:'Diff vs current',
                     secrets:'Secrets snapshot', audits:'Audits', image:'Download image'})[panel]}
                </div>
                <button onClick={() => setPanel(null)} title="Close" style={{
                  width:30, height:30, border:0, background:'transparent', cursor:'pointer',
                  color:OC.muted, display:'inline-flex', alignItems:'center', justifyContent:'center',
                }}><OIcon name="x" size={16}/></button>
              </div>

              <div style={{flex:1, minHeight:0, overflow:'auto'}}>
              {panel === 'scale' && (
                <div style={{padding:'18px', display:'flex', flexDirection:'column', gap:14}}>
                  <div style={{fontSize:13, color:'#3f3f46'}}>Number of running replicas for this stage.</div>
                  <div style={{display:'flex', alignItems:'center', gap:10}}>
                    {[1,2,3,4].map(n => (
                      <span key={n} style={{
                        width:40, height:40, borderRadius:8, display:'inline-flex',
                        alignItems:'center', justifyContent:'center', fontSize:14, fontWeight:600,
                        border:`1px solid ${n===2?OC.primary:OC.border}`,
                        background: n===2?OC.primarySoft:'#fff', color: n===2?OC.primary:OC.fg,
                        cursor:'pointer',
                      }}>{n}</span>
                    ))}
                    <span style={{fontSize:12, color:OC.muted, marginLeft:4}}>currently 2 replicas</span>
                  </div>
                  <div style={{display:'flex', justifyContent:'flex-end', gap:8}}>
                    <OBtn variant="primary" size="sm" leftIcon="check" onClick={() => setPanel(null)}>Apply</OBtn>
                  </div>
                </div>
              )}
              {panel === 'files' && <FileBrowser sha={h.sha}/>}
              {panel === 'audits' && <AuditPanel stageLabel={stageLabel} sha={h.sha}/>}
              {panel === 'diff' && (
                <DiffPanel viewOnly={false}
                  a={{ label:'previous', sha:(previous?.sha)||'', who:previous?.who, when:previous?.deployedAt }}
                  b={{ label:'this deployment', sha:h.sha||'', who:h.who, when:h.deployedAt }}/>
              )}
              {panel === 'secrets' && (
                <div style={{padding:'18px', display:'flex', flexDirection:'column', gap:8}}>
                  <div style={{fontSize:12, color:OC.muted}}>
                    The exact secret names &amp; versions baked into this deployment (values are never shown).
                  </div>
                  {[['DATABASE_URL','v4'],['MINIO_KEY','v2'],['TOGGL_TOKEN','v3'],['SENTRY_DSN','v1']].map(([k,v]) => (
                    <div key={k} style={{
                      display:'flex', alignItems:'center', gap:8, padding:'8px 10px',
                      background:OC.surface, border:`1px solid ${OC.border}`, borderRadius:6,
                      fontFamily:'Geist Mono, monospace', fontSize:12,
                    }}>
                      <OIcon name="key-round" size={12} color={OC.mutedFg}/>
                      <span style={{flex:1, color:OC.fg, fontWeight:600}}>{k}</span>
                      <span style={{color:OC.muted}}>•••••• · {v}</span>
                    </div>
                  ))}
                </div>
              )}
              {panel === 'image' && (
                <div style={{padding:'18px', display:'flex', flexDirection:'column', gap:14}}>
                  <p style={{margin:0, fontSize:13, color:'#3f3f46', lineHeight:1.6}}>
                    Bundles the full source code, container images, configuration and database
                    schema for this business process into a single file you can upload to another
                    workspace to recreate it exactly.
                  </p>
                  <div style={{display:'flex', flexDirection:'column', gap:6}}>
                    {[['box','Container images & source code'],
                      ['settings','Configuration & secrets templates'],
                      ['database','Database schema & migrations']].map(([ic,label]) => (
                      <div key={label} style={{display:'flex', alignItems:'center', gap:8, fontSize:13, color:OC.fg}}>
                        <OIcon name="check" size={14} color={OC.green}/>
                        <OIcon name={ic} size={13} color={OC.muted}/>{label}
                      </div>
                    ))}
                  </div>
                  <label style={{
                    display:'flex', alignItems:'flex-start', gap:10, padding:'12px 14px',
                    border:`1px solid ${includeUserData ? '#fcd34d' : OC.border}`,
                    background: includeUserData ? '#fffbeb' : '#fff', borderRadius:8, cursor:'pointer',
                  }}>
                    <input type="checkbox" checked={includeUserData}
                           onChange={e => setIncludeUserData(e.target.checked)} style={{marginTop:2, cursor:'pointer'}}/>
                    <div>
                      <div style={{fontSize:13, fontWeight:600, color:OC.fg}}>Include user data</div>
                      <div style={{fontSize:12, color:OC.muted, marginTop:2, lineHeight:1.5}}>
                        Adds all Postgres rows and MinIO files. The image will be much larger and
                        contains production data — handle it securely.
                      </div>
                    </div>
                  </label>
                  <div style={{display:'flex', alignItems:'center', gap:8}}>
                    <span style={{flex:1, fontSize:11, color:OC.muted}}>
                      Est. size {includeUserData ? '~3.8 GB' : '~640 MB'}
                    </span>
                    <OBtn variant="primary" size="sm" leftIcon="download" onClick={() => setPanel(null)}>
                      Download image
                    </OBtn>
                  </div>
                </div>
              )}
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}



function DiffPanel({ a, b, viewOnly }) {
  // mocked diff lines
  const files = [
    { path:'src/api/payroll.ts',           added:18, removed:6,  hunks: [
      { ctx: '@@ -42,12 +42,18 @@',
        lines: [
          { t:'ctx', s:'export async function syncPayroll(employeeId: string) {' },
          { t:'rem', s:'  const records = await togglFetch({ since: lastSync });' },
          { t:'add', s:'  const since = await getLastSync(employeeId);' },
          { t:'add', s:'  const records = await togglFetch({ since });' },
          { t:'add', s:'  if (!records.length) return { created: 0 };' },
          { t:'ctx', s:'  for (const r of records) {' },
          { t:'add', s:'    await db.payroll.upsert({ employeeId, ...r });' },
          { t:'ctx', s:'  }' },
        ],
      },
    ]},
    { path:'src/pages/Compensation.tsx',   added:42, removed:3 },
    { path:'src/lib/probation.ts',         added:11, removed:11 },
    { path:'helm/values-staging.yaml',     added:2,  removed:0  },
  ];

  // For "View files" mode, show the full file tree at this deployment instead of a diff.
  const fullTree = [
    'src/api/payroll.ts',
    'src/api/employees.ts',
    'src/api/onboarding.ts',
    'src/pages/Compensation.tsx',
    'src/pages/EmployeeDetail.tsx',
    'src/pages/Onboarding.tsx',
    'src/lib/probation.ts',
    'src/lib/toggl.ts',
    'src/lib/db.ts',
    'src/components/EmployeeCard.tsx',
    'src/components/PayslipTable.tsx',
    'helm/values-staging.yaml',
    'helm/values-prod.yaml',
    'package.json',
    'README.md',
  ];

  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      {/* Header */}
      <div style={{padding:'12px 22px', borderBottom:`1px solid ${OC.border}`,
                   display:'flex', alignItems:'center', gap:14, flexWrap:'wrap'}}>
        {viewOnly ? (
          <DiffSide label={b.label} sha={b.sha} when={b.when} who={b.who}/>
        ) : (
          <>
            <DiffSide label={a.label} sha={a.sha} when={a.when} who={a.who}/>
            <OIcon name="arrow-right" size={14} color={OC.mutedFg}/>
            <DiffSide label={b.label} sha={b.sha} when={b.when} who={b.who}/>
          </>
        )}
        <span style={{marginLeft:'auto', fontSize:12, color:OC.muted}}>
          {viewOnly
            ? `${fullTree.length} files in this deployment`
            : <>{files.length} files · <span style={{color:OC.green}}>+{files.reduce((n,f)=>n+f.added,0)}</span>
              {' / '}
              <span style={{color:OC.red}}>−{files.reduce((n,f)=>n+f.removed,0)}</span></>}
        </span>
      </div>

      {viewOnly ? (
        /* Full file tree */
        <div style={{flex:1, overflow:'auto', padding:'12px 22px 20px',
                     display:'flex', flexDirection:'column', gap:2}}>
          {fullTree.map(p => (
            <div key={p} style={{
              display:'flex', alignItems:'center', gap:10, fontSize:12,
              padding:'5px 8px', borderRadius:4,
            }}>
              <OIcon name="file" size={12} color={OC.muted}/>
              <span style={{flex:1, fontFamily:'Geist Mono, monospace', color:OC.fg}}>{p}</span>
              <OBtn variant="ghost" size="sm" leftIcon="external-link"/>
            </div>
          ))}
        </div>
      ) : (
        <>
          {/* File list */}
          <div style={{padding:'12px 22px', borderBottom:`1px solid ${OC.border}`,
                       display:'flex', flexDirection:'column', gap:4}}>
            {files.map(f => (
              <div key={f.path} style={{
                display:'flex', alignItems:'center', gap:10, fontSize:12,
                padding:'4px 8px', borderRadius:4,
              }}>
                <OIcon name="file" size={12} color={OC.muted}/>
                <span style={{flex:1, fontFamily:'Geist Mono, monospace', color:OC.fg,
                              overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                  {f.path}
                </span>
                <span style={{fontFamily:'Geist Mono, monospace', color:OC.green}}>+{f.added}</span>
                <span style={{fontFamily:'Geist Mono, monospace', color:OC.red}}>−{f.removed}</span>
              </div>
            ))}
          </div>

          {/* First hunk preview */}
          <div style={{flex:1, overflow:'auto', padding:'12px 22px 20px'}}>
            {files.filter(f => f.hunks).map(f => (
              <div key={f.path} style={{marginBottom:14}}>
                <div style={{
                  fontFamily:'Geist Mono, monospace', fontSize:12, fontWeight:600, color:OC.fg,
                  marginBottom:6,
                }}>{f.path}</div>
                {f.hunks.map((h, i) => (
                  <div key={i} style={{
                    border:`1px solid ${OC.border}`, borderRadius:6, overflow:'hidden',
                    fontFamily:'Geist Mono, monospace', fontSize:12, lineHeight:'18px',
                  }}>
                    <div style={{padding:'4px 10px', background:OC.surface, color:OC.muted}}>{h.ctx}</div>
                    {h.lines.map((l, j) => {
                      const bg = l.t === 'add' ? '#dcfce7' : l.t === 'rem' ? '#fee2e2' : '#fff';
                      const prefix = l.t === 'add' ? '+' : l.t === 'rem' ? '−' : ' ';
                      const color = l.t === 'add' ? '#166534' : l.t === 'rem' ? '#991b1b' : OC.fg;
                      return (
                        <div key={j} style={{display:'flex', background:bg, color}}>
                          <span style={{
                            width:24, padding:'0 6px', textAlign:'center',
                            color: l.t === 'ctx' ? OC.mutedFg : color,
                          }}>{prefix}</span>
                          <span style={{flex:1, padding:'0 8px', whiteSpace:'pre'}}>{l.s}</span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function DiffSide({ label, sha, when, who }) {
  return (
    <div style={{display:'flex', flexDirection:'column', minWidth:0}}>
      <div style={{fontSize:10, fontWeight:600, color:OC.muted, textTransform:'uppercase', letterSpacing:0.5}}>
        {label}
      </div>
      <div style={{display:'flex', alignItems:'baseline', gap:6}}>
        <span style={{fontFamily:'Geist Mono, monospace', fontSize:13, fontWeight:600, color:OC.fg}}>
          {sha.slice(0, 7)}
        </span>
        <span style={{fontSize:11, color:OC.muted}}>{when}</span>
      </div>
      {who && <div style={{fontSize:11, color:OC.muted}}>{who}</div>}
    </div>
  );
}

function synthHistory(aut, stageId) {
  const cur = aut.stages?.[stageId];
  if (!cur || !cur.sha) return [];
  return [
    { sha: cur.sha, deployedAt: cur.deployedAt, deployedAtAbs: cur.deployedAt,
      who: 'tomas@harmonum.ai', message: 'sync from worktree', status: 'deployed', current: true,
      stagedFrom: stageId === 'dev' ? 'main' : (stageId === 'staging' ? 'dev' : 'staging'),
      durationS: 132 },
  ];
}
