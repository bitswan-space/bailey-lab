// shell.jsx — sidebar (BPs) + topbar (deployments / worktree switcher)

const { useState, useMemo } = React;

const C = {
  bg:        '#ffffff',
  fg:        '#09090b',
  muted:     '#71717a',
  mutedFg:   '#a1a1aa',
  border:    '#e4e4e7',
  borderHi:  '#d4d4d8',
  surface:   '#fafafa',
  surface2:  '#f4f4f5',
  primary:   '#093df5',
  primaryHi: '#0735d0',
  primarySoft:'#eef2ff',
  green:     '#16a34a',
  greenSoft: '#dcfce7',
  red:       '#dc2626',
  redSoft:   '#fee2e2',
  amber:     '#f59e0b',
  amberSoft: '#fef3c7',
  blueSoft:  '#dbeafe',
};

function Icon({ name, size = 14, color, style }) {
  return <i data-lucide={name} style={{ width: size, height: size, color, display:'inline-block', ...style }}></i>;
}

// re-render lucide icons whenever a component mounts/updates
function useLucide() {
  React.useEffect(() => {
    if (window.lucide) window.lucide.createIcons();
  });
}

function Pill({ tone = 'neutral', children, size = 'sm' }) {
  const tones = {
    neutral:  { bg: C.surface2,  fg: C.muted,    bd: 'transparent' },
    success:  { bg: C.greenSoft, fg: '#15803d',  bd: 'transparent' },
    danger:   { bg: C.redSoft,   fg: '#b91c1c',  bd: 'transparent' },
    warning:  { bg: C.amberSoft, fg: '#a16207',  bd: 'transparent' },
    primary:  { bg: C.primarySoft, fg: C.primary, bd: 'transparent' },
    info:     { bg: '#ede9fe',     fg: '#6d28d9',  bd: 'transparent' },
    outline:  { bg: 'transparent', fg: C.fg, bd: C.border },
  };
  const t = tones[tone];
  const sz = size === 'xs'
    ? { padding: '1px 6px', fontSize: 10, lineHeight: '14px' }
    : { padding: '2px 8px', fontSize: 11, lineHeight: '16px' };
  return (
    <span style={{
      ...sz,
      background: t.bg, color: t.fg,
      border: `1px solid ${t.bd}`,
      borderRadius: 9999, fontWeight: 600,
      letterSpacing: 0.2, textTransform: 'uppercase',
      display: 'inline-flex', alignItems: 'center', gap: 4,
      whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

function Btn({ variant = 'default', size = 'sm', children, leftIcon, rightIcon, onClick, style, disabled, title }) {
  const sizes = {
    xs: { h: 26, px: 8,  fs: 12 },
    sm: { h: 32, px: 12, fs: 13 },
    md: { h: 36, px: 14, fs: 14 },
    lg: { h: 40, px: 16, fs: 14 },
  }[size];
  const variants = {
    primary: { bg: C.primary, fg: '#fff', bd: C.primary, hover: C.primaryHi },
    default: { bg: C.bg, fg: C.fg, bd: C.border, hover: C.surface2 },
    ghost:   { bg: 'transparent', fg: C.fg, bd: 'transparent', hover: C.surface2 },
    outline: { bg: C.bg, fg: C.fg, bd: C.border, hover: C.surface2 },
    danger:  { bg: C.bg, fg: C.red, bd: C.border, hover: C.redSoft },
    soft:    { bg: C.surface2, fg: C.fg, bd: 'transparent', hover: C.border },
  }[variant];
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button" onClick={onClick} disabled={disabled} title={title}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        height: sizes.h, padding: `0 ${sizes.px}px`, fontSize: sizes.fs,
        background: hover && !disabled ? variants.hover : variants.bg,
        color: variants.fg, border: `1px solid ${variants.bd}`, borderRadius: 6,
        fontFamily: 'inherit', fontWeight: 500, cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        whiteSpace: 'nowrap', transition: 'background 150ms',
        ...style,
      }}>
      {leftIcon && <Icon name={leftIcon} size={sizes.fs + 1}/>}
      {children}
      {rightIcon && <Icon name={rightIcon} size={sizes.fs + 1}/>}
    </button>
  );
}

// ─── Sidebar — Business Processes (compact list w/ search) ──────────────────
function Sidebar({ activeBpId, onSelectBp, density = 'comfortable', width = 260 }) {
  useLucide();
  const [query, setQuery] = useState('');
  const bps = window.WD_DATA.BUSINESS_PROCESSES;
  const filtered = useMemo(
    () => bps.filter(b => b.name.toLowerCase().includes(query.toLowerCase())),
    [query, bps]
  );
  const rowH = density === 'compact' ? 26 : 30;
  const fs = density === 'compact' ? 12 : 13;

  return (
    <aside style={{
      width, height: '100%', background: C.surface, borderRight: `1px solid ${C.border}`,
      display: 'flex', flexDirection: 'column', flexShrink: 0,
    }}>
      {/* Search */}
      <div style={{padding:'14px 12px 6px'}}>
        <div style={{position:'relative'}}>
          <Icon name="search" size={13} color={C.mutedFg}
                style={{position:'absolute', left:9, top:9}}/>
          <input
            placeholder="Search business processes…"
            value={query} onChange={e => setQuery(e.target.value)}
            style={{
              width:'100%', height:30, paddingLeft:28, paddingRight:10,
              border:`1px solid ${C.border}`, borderRadius:6, background:'#fff',
              fontFamily:'inherit', fontSize:12, color:C.fg, outline:'none',
            }}/>
        </div>
      </div>

      {/* Section label + count */}
      <div style={{
        display:'flex', alignItems:'center', justifyContent:'space-between',
        padding:'6px 14px 4px',
      }}>
        <div style={{
          fontSize:10, fontWeight:600, color:C.muted, letterSpacing:0.5,
          textTransform:'uppercase'
        }}>Business Processes</div>
        <button title="New business process" style={{
          width:20, height:20, padding:0, background:'transparent', border:0,
          color:C.muted, cursor:'pointer', borderRadius:4,
          display:'inline-flex', alignItems:'center', justifyContent:'center',
        }}><Icon name="plus" size={13}/></button>
      </div>

      {/* List */}
      <div style={{flex:1, overflow:'auto', padding:'2px 8px 10px'}}>
        {filtered.map(bp => {
          const active = bp.id === activeBpId;
          const wts = window.WD_DATA.WORKTREES_BY_BP[bp.id];
          return (
            <button key={bp.id} onClick={() => onSelectBp(bp.id)} style={{
              display:'flex', alignItems:'center', gap:8, width:'100%',
              padding:`0 8px`, height: rowH, borderRadius:6, border:0,
              background: active ? '#fff' : 'transparent',
              boxShadow: active ? `inset 0 0 0 1px ${C.border}, 0 1px 2px rgba(0,0,0,0.04)` : 'none',
              color: active ? C.fg : '#3f3f46',
              fontWeight: active ? 500 : 400, fontSize: fs,
              cursor:'pointer', textAlign:'left', fontFamily:'inherit',
              transition: 'background 120ms',
            }}>
              <Icon name={active ? 'folder-open' : 'folder'}
                    size={13} color={active ? C.primary : C.mutedFg}/>
              <span style={{flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                {bp.name}
              </span>
              {wts && wts.length > 0 && (
                <span style={{
                  fontSize:10, color:C.muted, fontWeight:500,
                  background: active ? C.surface2 : 'transparent',
                  padding:'1px 6px', borderRadius:9999,
                }}>{wts.length}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Resources footer */}
      <div style={{borderTop:`1px solid ${C.border}`, padding:'8px', display:'flex', flexDirection:'column', gap:2}}>
        <SidebarLink icon="circle-help" label="User guide"/>
        <SidebarLink icon="archive" label="Backups"/>
      </div>

    </aside>
  );
}

// ─── BP switcher (pop-out, replaces the left sidebar) ───────────────────────
// Aggregate coding-agent status across all worktrees of a BP.
// Returns 'working' | 'done' | 'idle' | 'none'.
function bpAgentStatus(bpId) {
  const wts = window.WD_DATA.WORKTREES_BY_BP[bpId] || [];
  let any = false, running = false, done = false, idle = false;
  wts.forEach(wt => {
    const sessions = (window.WD_WT_DATA?.WT_AGENT_SESSIONS || {})[`${bpId}:${wt.id}`] || [];
    sessions.filter(s => s.kind === 'agent').forEach(s => {
      any = true;
      if (s.status === 'running') running = true;
      else if (s.summary) done = true;       // finished a task (has a result summary)
      else idle = true;                        // idle/paused, nothing completed
    });
  });
  if (running) return 'working';
  if (done) return 'done';
  if (idle) return 'idle';
  return any ? 'idle' : 'none';
}

const AGENT_STATUS_META = {
  working: { icon:'bot',          color:'#2563eb', pulse:true,  label:'Agent working' },
  done:    { icon:'check-circle', color:'#16a34a', pulse:false, label:'Agent completed its tasks' },
  idle:    { icon:'pause-circle', color:'#a16207', pulse:false, label:'Agent idle' },
  none:    { icon:'circle-dashed',color:'#a1a1aa', pulse:false, label:'No agent running' },
};

// Status badge: pulsing bot when working, otherwise a static status glyph.
function AgentStatusBadge({ status, size = 14, showNone = false }) {
  const m = AGENT_STATUS_META[status] || AGENT_STATUS_META.none;
  if (status === 'none' && !showNone) return null;
  return (
    <span title={m.label} style={{
      position:'relative', display:'inline-flex', alignItems:'center', justifyContent:'center',
      width:size+4, height:size+4, flex:'0 0 auto',
    }}>
      {m.pulse && (
        <span style={{
          position:'absolute', inset:0, borderRadius:9999,
          background:`${m.color}55`, animation:'wd-pulse 1.6s ease-out infinite',
        }}/>
      )}
      <Icon name={m.icon} size={size} color={m.color}/>
    </span>
  );
}

function BpSwitcher({ activeBpId, onSelectBp, onNewBp }) {
  useLucide();
  const bps = window.WD_DATA.BUSINESS_PROCESSES;
  const active = bps.find(b => b.id === activeBpId) || bps[0];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = React.useRef(null);
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  // Close on outside click
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const filtered = useMemo(
    () => bps.filter(b => b.name.toLowerCase().includes(query.toLowerCase())),
    [query, bps]
  );

  return (
    <div ref={rootRef} style={{position:'relative'}}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Switch business process (⌘K)"
        style={{
          display:'inline-flex', alignItems:'center', gap:8,
          height:34, padding:'0 10px 0 12px',
          background: open ? C.surface : '#fff',
          border:`1px solid ${C.border}`,
          borderRadius:8,
          fontFamily:'inherit', cursor:'pointer',
        }}
        onMouseEnter={(e) => { if (!open) e.currentTarget.style.background = C.surface; }}
        onMouseLeave={(e) => { if (!open) e.currentTarget.style.background = '#fff'; }}
      >
        <Icon name="folder-open" size={13} color={C.primary}/>
        <span style={{
          fontSize:10, fontWeight:600, color:C.mutedFg,
          letterSpacing:0.5, textTransform:'uppercase', marginRight:2,
        }}>Business process</span>
        <span style={{
          fontSize:13, fontWeight:600, color:C.fg,
          maxWidth:240, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
        }}>{active?.name || 'Select a process'}</span>
        {active && <AgentStatusBadge status={bpAgentStatus(active.id)}/>}
        <Icon name="chevrons-up-down" size={13} color={C.mutedFg}/>
      </button>

      {open && (
        <div style={{
          position:'absolute', top:'100%', left:0, marginTop:6,
          width:360, maxHeight:420,
          background:'#fff', border:`1px solid ${C.border}`, borderRadius:10,
          boxShadow:'0 8px 24px rgba(0,0,0,0.10)',
          display:'flex', flexDirection:'column', zIndex:50,
          overflow:'hidden',
        }}>
          {/* Search */}
          <div style={{padding:'10px 10px 8px', borderBottom:`1px solid ${C.border}`}}>
            <div style={{position:'relative'}}>
              <Icon name="search" size={13} color={C.mutedFg}
                    style={{position:'absolute', left:10, top:9}}/>
              <input
                ref={inputRef}
                placeholder="Search business processes…"
                value={query} onChange={e => setQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && filtered[0]) {
                    onSelectBp(filtered[0].id);
                    setOpen(false); setQuery('');
                  }
                }}
                style={{
                  width:'100%', height:32, paddingLeft:30, paddingRight:10,
                  border:`1px solid ${C.border}`, borderRadius:6, background:'#fff',
                  fontFamily:'inherit', fontSize:13, color:C.fg, outline:'none',
                }}/>
            </div>
          </div>

          {/* List */}
          <div style={{flex:1, minHeight:0, overflow:'auto', padding:'4px 6px'}}>
            {filtered.length === 0 && (
              <div style={{padding:'24px 12px', textAlign:'center', color:C.muted, fontSize:12}}>
                No matches.
              </div>
            )}
            {filtered.map(bp => {
              const isActive = bp.id === activeBpId;
              const wts = window.WD_DATA.WORKTREES_BY_BP[bp.id];
              return (
                <button
                  key={bp.id}
                  onClick={() => { onSelectBp(bp.id); setOpen(false); setQuery(''); }}
                  style={{
                    display:'flex', alignItems:'center', gap:9, width:'100%',
                    padding:'7px 10px', height:32, borderRadius:6, border:0,
                    background: isActive ? C.surface : 'transparent',
                    color: isActive ? C.fg : '#3f3f46',
                    fontWeight: isActive ? 500 : 400, fontSize:13,
                    cursor:'pointer', textAlign:'left', fontFamily:'inherit',
                    transition:'background 120ms',
                  }}
                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = C.surface; }}
                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
                >
                  <Icon name={isActive ? 'folder-open' : 'folder'}
                        size={13} color={isActive ? C.primary : C.mutedFg}/>
                  <span style={{flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                    {bp.name}
                  </span>
                  <AgentStatusBadge status={bpAgentStatus(bp.id)} size={12}/>
                  {wts && wts.length > 0 && (
                    <span style={{
                      fontSize:10, color:C.muted, fontWeight:500,
                      padding:'1px 6px', borderRadius:9999,
                      border:`1px solid ${C.border}`,
                    }}>{wts.length}</span>
                  )}
                  {isActive && <Icon name="check" size={13} color={C.primary}/>}
                </button>
              );
            })}
          </div>

          {/* Footer */}
          <div style={{
            display:'flex', gap:6, padding:'8px 10px',
            borderTop:`1px solid ${C.border}`, background:C.surface,
          }}>
            <button
              onClick={() => { setOpen(false); onNewBp && onNewBp(); }}
              style={{
                flex:1, display:'inline-flex', alignItems:'center', justifyContent:'center', gap:5,
                height:30, border:`1px dashed ${C.borderHi}`, borderRadius:6,
                background:'#fff', color:C.muted, fontSize:12, fontWeight:500,
                fontFamily:'inherit', cursor:'pointer',
              }}
            >
              <Icon name="plus" size={12}/>
              New business process
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Inline SVG icons (React-owned — Lucide never rewrites these) ───────────
const SVGI = {
  base: (size, color, children, extra) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
         style={{flex:'0 0 auto', ...(extra||{})}}>{children}</svg>
  ),
};
function InlineIcon({ name, size = 14, color = 'currentColor', style }) {
  const c = (children) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
         style={{flex:'0 0 auto', ...style}}>{children}</svg>
  );
  switch (name) {
    case 'file-text': return c(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></>);
    case 'check-square': return c(<><path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></>);
    case 'bot': return c(<><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></>);
    case 'rocket': return c(<><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></>);
    case 'server': return c(<><rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/></>);
    case 'chevron-right': return c(<path d="m9 18 6-6-6-6"/>);
    case 'cycle': return c(<><path d="M3 2v6h6"/><path d="M21 22v-6h-6"/><path d="M21 8a9 9 0 0 0-15-3.5L3 8"/><path d="M3 16a9 9 0 0 0 15 3.5l3-3.5"/></>);
    default: return c(<circle cx="12" cy="12" r="9"/>);
  }
}

// ─── Top bar — switcher between Deployments and worktrees ───────────────────
function SidebarLink({ icon, label }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display:'flex', alignItems:'center', gap:10, width:'100%',
        padding:'0 10px', height:30, borderRadius:6, border:0,
        background: hover ? C.surface2 : 'transparent',
        color: '#3f3f46', fontSize: 13,
        cursor:'pointer', textAlign:'left', fontFamily:'inherit',
      }}>
      <Icon name={icon} size={14} color={C.muted}/>
      {label}
    </button>
  );
}

function TopBar({ scope, onScope, worktrees, activeBpId, onSelectBp, onNewBp,
                 wtTab, onWtTab, activeWt }) {
  useLucide();
  const isDep = scope.type === 'deployments';
  const wts = worktrees || [];
  // Worktree that flow steps target: the active one, else the user's own.
  const targetWt = activeWt || wts.find(w => w.mine) || wts[0];
  const synced = targetWt ? targetWt.synced : true;

  const goWt = (tab) => {
    if (!targetWt) return;
    onScope({ type:'worktree', id: targetWt.id });
    onWtTab && onWtTab(tab);
  };

  // A single step in the pipeline flow.
  const FlowStep = ({ icon, label, active, onClick, disabled, accent }) => (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        display:'inline-flex', alignItems:'center', gap:7,
        height:34, padding:'0 14px',
        background: active ? (accent ? C.primary : C.surface2)
                  : (accent ? C.primary : 'transparent'),
        border:`1px solid ${active ? (accent ? C.primary : C.borderHi)
                          : (accent ? C.primary : 'transparent')}`,
        borderRadius:8,
        color: accent ? '#fff' : (active ? C.fg : C.muted),
        fontFamily:'inherit', fontSize:13, fontWeight: active || accent ? 600 : 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        whiteSpace:'nowrap',
        transition:'background 120ms, color 120ms',
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        if (accent) e.currentTarget.style.background = C.primaryHi || C.primary;
        else if (!active) e.currentTarget.style.background = C.surface;
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        if (accent) e.currentTarget.style.background = C.primary;
        else if (!active) e.currentTarget.style.background = 'transparent';
      }}
    >
      <InlineIcon name={icon} size={14}
        color={accent ? '#fff' : (active ? C.fg : C.mutedFg)}/>
      {label}
    </button>
  );

  const Arrow = ({ cycle }) => (
    <span style={{display:'inline-flex', alignItems:'center', color:C.borderHi,
                  padding:'0 1px'}}>
      <InlineIcon name={cycle ? 'cycle' : 'chevron-right'} size={15} color={C.mutedFg}/>
    </span>
  );

  return (
    <div style={{
      display:'flex', alignItems:'center', gap:0, padding:'10px 24px',
      borderBottom:`1px solid ${C.border}`, background:'#fff',
    }}>
      {/* BP switcher replaces the always-on sidebar */}
      <div style={{display:'flex', alignItems:'center', marginRight:12}}>
        <BpSwitcher activeBpId={activeBpId} onSelectBp={onSelectBp} onNewBp={onNewBp}/>
      </div>
      <div style={{width:1, height:24, background:C.border, margin:'0 12px 0 0'}}/>

      {/* Pipeline flow: Spec → Requirements → Agents → Sync & Deploy → Deployments */}
      <div style={{display:'flex', alignItems:'center', gap:4}}>
        <FlowStep icon="file-text"    label="Description"
                  active={!isDep && wtTab === 'specification'}
                  onClick={() => goWt('specification')} disabled={!targetWt}/>
        <Arrow/>
        <FlowStep icon="bot"          label="Coding Agent"
                  active={!isDep && wtTab === 'agents'}
                  onClick={() => goWt('agents')} disabled={!targetWt}/>
        <Arrow cycle/>
        <FlowStep icon="check-square" label="Requirements &amp; tests"
                  active={!isDep && wtTab === 'requirements'}
                  onClick={() => goWt('requirements')} disabled={!targetWt}/>
        <Arrow/>
        <FlowStep icon="rocket"       label="Sync &amp; Deploy"
                  active={!isDep && wtTab === 'sync-deploy'}
                  disabled={!targetWt}
                  onClick={() => goWt('sync-deploy')}/>
        <Arrow/>
        <FlowStep icon="server"       label="Deployments"
                  active={isDep}
                  onClick={() => onScope({ type:'deployments' })}/>
      </div>

      {/* Worktree switcher — pop-out on the right */}
      <div style={{marginLeft:'auto', display:'flex', alignItems:'center'}}>
        <WorktreeSwitcher scope={scope} onScope={onScope} worktrees={worktrees}/>
      </div>
    </div>
  );
}

// ─── Worktree switcher (right-aligned pop-out) ──────────────────────────────
// Each user always has an auto-created worktree (flagged `mine`). Others'
// worktrees are listed below a divider.
function WorktreeSwitcher({ scope, onScope, worktrees }) {
  const wts = worktrees || [];
  const isWt = scope.type === 'worktree';
  const active = isWt && wts.find(w => w.id === scope.id);
  const mine = wts.find(w => w.mine) || wts[0];
  const [open, setOpen] = useState(false);
  const rootRef = React.useRef(null);

  // Local drag-reorder state for the "other worktrees" list.
  const otherIds = wts.filter(w => !w.mine).map(w => w.id);
  const [order, setOrder] = useState(otherIds);
  React.useEffect(() => {
    // keep order in sync if the set of worktrees changes
    setOrder(prev => {
      const kept = prev.filter(id => otherIds.includes(id));
      const added = otherIds.filter(id => !kept.includes(id));
      return [...kept, ...added];
    });
  }, [otherIds.join(',')]);
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);

  const reorder = (fromId, toId) => {
    if (!fromId || fromId === toId) return;
    setOrder(prev => {
      const next = [...prev];
      const fi = next.indexOf(fromId);
      const ti = next.indexOf(toId);
      if (fi < 0 || ti < 0) return prev;
      next.splice(fi, 1);
      next.splice(ti, 0, fromId);
      return next;
    });
  };

  const IconGrip = ({ size = 13, color = 'currentColor' }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color}
         style={{flex:'0 0 auto'}}>
      <circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/>
      <circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/>
      <circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>
    </svg>
  );

  // Inline SVGs (React-owned) — Lucide never rewrites these, so toggling the
  // dropdown can't trigger the <i>→<svg> insertBefore crash.
  const IconBranch = ({ size = 13, color = 'currentColor' }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
         style={{flex:'0 0 auto'}}>
      <line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/>
      <circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>
    </svg>
  );
  const IconChevrons = ({ size = 13, color = 'currentColor' }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
         style={{flex:'0 0 auto'}}>
      <path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>
    </svg>
  );
  const IconCheck = ({ size = 13, color = 'currentColor', hidden }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
         style={{flex:'0 0 auto', visibility: hidden ? 'hidden' : 'visible'}}>
      <path d="M20 6 9 17l-5-5"/>
    </svg>
  );
  const IconPlus = ({ size = 12, color = 'currentColor' }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
         style={{flex:'0 0 auto'}}>
      <path d="M5 12h14"/><path d="M12 5v14"/>
    </svg>
  );

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const SyncDot = ({ wt, show = true }) => (
    <span style={{
      width:7, height:7, borderRadius:9999, flex:'0 0 auto',
      background: wt && wt.synced ? '#16a34a' : '#d97706',
      visibility: show && wt ? 'visible' : 'hidden',
    }}/>
  );

  const renderRow = (wt, draggable = false) => {
    const isActive = isWt && scope.id === wt.id;
    const isDragging = dragId === wt.id;
    const isOver = overId === wt.id && dragId !== wt.id;
    return (
      <div
        key={wt.id}
        draggable={draggable}
        onDragStart={draggable ? (e) => { setDragId(wt.id); e.dataTransfer.effectAllowed = 'move'; } : undefined}
        onDragOver={draggable ? (e) => { e.preventDefault(); setOverId(wt.id); } : undefined}
        onDrop={draggable ? (e) => { e.preventDefault(); reorder(dragId, wt.id); setDragId(null); setOverId(null); } : undefined}
        onDragEnd={draggable ? () => { setDragId(null); setOverId(null); } : undefined}
        style={{
          display:'flex', alignItems:'center', gap:4, width:'100%',
          borderRadius:6,
          opacity: isDragging ? 0.4 : 1,
          boxShadow: isOver ? `inset 0 2px 0 ${C.primary}` : 'none',
        }}
      >
        {draggable && (
          <span title="Drag to reorder" style={{
            display:'inline-flex', alignItems:'center', justifyContent:'center',
            width:18, flex:'0 0 auto', cursor:'grab', color:C.mutedFg,
            alignSelf:'stretch',
          }}
            onMouseDown={(e) => e.stopPropagation()}>
            <IconGrip color={C.mutedFg}/>
          </span>
        )}
        <button
          onClick={() => { onScope({ type:'worktree', id: wt.id }); setOpen(false); }}
          style={{
            display:'flex', alignItems:'center', gap:9, flex:1, minWidth:0,
            padding:'8px 10px', borderRadius:6, border:0,
            background: isActive ? C.surface : 'transparent',
            color: isActive ? C.fg : '#3f3f46',
            fontWeight: isActive ? 600 : 400, fontSize:13,
            cursor:'pointer', textAlign:'left', fontFamily:'inherit',
            transition:'background 120ms',
          }}
          onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = C.surface; }}
          onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
        >
          <IconBranch color={isActive ? C.primary : C.mutedFg}/>
          <span style={{flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis',
                        whiteSpace:'nowrap', fontFamily:'Geist Mono, ui-monospace, monospace'}}>
            {wt.name}
          </span>
          {wt.mine && (
            <span style={{
              fontSize:9, fontWeight:700, letterSpacing:0.4, textTransform:'uppercase',
              color:C.muted, padding:'1px 6px', borderRadius:9999,
              border:`1px solid ${C.border}`,
            }}>You</span>
          )}
          <SyncDot wt={wt}/>
          <IconCheck color={C.primary} hidden={!isActive}/>
        </button>
      </div>
    );
  };

  const others = order.map(id => wts.find(w => w.id === id)).filter(Boolean);

  return (
    <div ref={rootRef} style={{position:'relative'}}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Switch worktree"
        style={{
          display:'inline-flex', alignItems:'center', gap:8,
          height:34, padding:'0 10px 0 12px',
          background: open ? C.surface : '#fff',
          border:`1px solid ${active ? C.primary : C.border}`,
          borderRadius:8, fontFamily:'inherit', cursor:'pointer',
        }}
        onMouseEnter={(e) => { if (!open) e.currentTarget.style.background = C.surface; }}
        onMouseLeave={(e) => { if (!open) e.currentTarget.style.background = '#fff'; }}
      >
        <IconBranch color={active ? C.primary : C.mutedFg}/>
        <span style={{
          fontSize:13, fontWeight:600, color: C.fg,
          maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
          fontFamily:'Geist Mono, ui-monospace, monospace',
        }}>{(active || mine) ? (active || mine).name : '—'}</span>
        <SyncDot wt={active || mine} show={!!(active || mine)}/>
        <IconChevrons color={C.mutedFg}/>
      </button>

      {open && (
        <div style={{
          position:'absolute', top:'100%', right:0, marginTop:6,
          width:320, maxHeight:420,
          background:'#fff', border:`1px solid ${C.border}`, borderRadius:10,
          boxShadow:'0 8px 24px rgba(0,0,0,0.10)',
          display:'flex', flexDirection:'column', zIndex:50, overflow:'hidden',
        }}>
          <div style={{flex:1, minHeight:0, overflow:'auto', padding:'6px'}}>
            {mine && (
              <>
                <div style={{
                  padding:'6px 10px 4px', fontSize:10, fontWeight:600,
                  color:C.mutedFg, letterSpacing:0.5, textTransform:'uppercase',
                }}>Your worktree</div>
                {renderRow(mine)}
              </>
            )}
            {others.length > 0 && (
              <>
                <div style={{
                  padding:'10px 10px 4px', fontSize:10, fontWeight:600,
                  color:C.mutedFg, letterSpacing:0.5, textTransform:'uppercase',
                  display:'flex', alignItems:'center', gap:6,
                }}>
                  Teammates
                  <span style={{
                    display:'inline-flex', alignItems:'center', gap:3,
                    fontSize:9, fontWeight:600, color:C.muted, letterSpacing:0.3,
                    textTransform:'none',
                  }}>
                    <Icon name="eye" size={10} color={C.mutedFg}/>view only
                  </span>
                </div>
                {others.map(w => renderRow(w, true))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CommitHash({ sha, length = 7, color }) {
  const [copied, setCopied] = React.useState(false);
  if (!sha) return <span style={{fontStyle:'italic', color:C.muted}}>—</span>;
  const short = sha.slice(0, length);
  const onCopy = (e) => {
    e.stopPropagation();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(sha).catch(() => {});
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <button onClick={onCopy} title={`Copy ${sha}`} style={{
      display:'inline-flex', alignItems:'center', gap:5,
      padding:'2px 6px', borderRadius:4, border:0, background:'transparent',
      fontFamily:'Geist Mono, monospace', fontSize:11,
      color: color || C.muted, cursor:'pointer', fontWeight:500,
      lineHeight:1.4,
    }}
    onMouseEnter={(e) => e.currentTarget.style.background = C.surface}
    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
      <span>{short}</span>
      <Icon name={copied ? 'check' : 'copy'} size={10}
            color={copied ? C.green : C.muted}/>
    </button>
  );
}

function SwitchTab({ active, onClick, icon, label, sub, tone }) {
  return (
    <button onClick={onClick} style={{
      display:'flex', flexDirection:'column', alignItems:'flex-start', gap:1,
      padding:'8px 14px 10px', background: active ? '#fff' : 'transparent',
      border:0, borderBottom: active ? `2px solid ${C.primary}` : '2px solid transparent',
      cursor:'pointer', fontFamily:'inherit', minWidth:120,
    }}>
      <span style={{display:'flex', alignItems:'center', gap:6,
                    fontSize:13, fontWeight: active ? 600 : 500,
                    color: active ? C.fg : '#52525b'}}>
        <Icon name={icon} size={13} color={active ? C.primary : C.mutedFg}/>
        {label}
      </span>
      {sub && (
        <span style={{
          fontSize:10, color: tone === 'success' ? C.green
                          : tone === 'warning' ? C.amber
                          : C.muted,
          fontWeight:500, paddingLeft:19,
        }}>{sub}</span>
      )}
    </button>
  );
}

window.WD_SHELL = { C, Icon, Pill, Btn, Sidebar, TopBar, useLucide, CommitHash, BpSwitcher };
