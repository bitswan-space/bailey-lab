// worktree.jsx — tabbed worktree view: Overview / Agents / Requirements / Files / Diff

const { C: WC, Icon: WIcon, Pill: WPill, Btn: WBtn, useLucide: WuseLucide } = window.WD_SHELL;
const { SectionHeader: WSectionHeader, ReadmeCard: WReadmeCard, statusMeta: depStatusMeta,
  CardForLayout: WCardForLayout, CardHeader: WCardHeader, StageCell: WStageCell } =
window.WD_DEPLOYMENTS;

const { useState: useStateW, useMemo: useMemoW } = React;

// ─── Live-dev card variants (used inside Overview) ──────────────────────────
function liveDevMeta(status) {
  switch (status) {
    case 'running':return { label: 'Running', dot: WC.green, pulse: true };
    case 'starting':return { label: 'Starting', dot: WC.primary, pulse: true };
    case 'failed':return { label: 'Failed', dot: WC.red, pulse: false };
    default:return { label: 'Stopped', dot: '#a1a1aa', pulse: false };
  }
}

function StatusDot({ color, pulse }) {
  return (
    <span style={{ position: 'relative', width: 8, height: 8, display: 'inline-block' }}>
      {pulse && <span style={{
        position: 'absolute', inset: 0, borderRadius: 9999, background: color, opacity: 0.5,
        animation: 'wd-pulse 1.6s ease-out infinite'
      }} />}
      <span style={{
        position: 'relative', display: 'block', width: 8, height: 8, borderRadius: 9999, background: color
      }} />
    </span>);

}

// ─── Live-dev card — one column, horizontal-style ───────────────────────────
// Mirrors the Deployments horizontal card: read-only, no action buttons,
// link icon next to the stage name. Clicking the cell opens the inspect dialog
// (no promote in worktrees).
function LiveDevCardSimple({ aut, onInspect, onConfigure }) {
  const ld = aut.liveDev;
  const meta = liveDevMeta(ld.status);
  const stage = {
    short: 'Live-dev',
    label: 'Live-dev',
    status: ld.status,
    sha: null, // worktrees don't have a deployed SHA — shown as "—"
    deployedAt: ld.uptime ? `up ${ld.uptime}` : null,
    url: ld.url || null,
    meta
  };
  return (
    <div style={{
      background: '#fff', border: `1px solid ${WC.border}`, borderRadius: 12,
      boxShadow: '0 1px 2px 0 rgba(0,0,0,0.04)', overflow: 'hidden'
    }}>
      <WCardHeader aut={aut} onConfigure={onConfigure} onInspect={onInspect} />
      <WStageCell stage={stage} isLast onClick={onInspect} />
    </div>);

}

// ─── Tab nav ────────────────────────────────────────────────────────────────
// 2x2 grid tab nav, lives at the top of the worktree right sidebar.
// ─── Sync & Deploy tab ──────────────────────────────────────────────────────
function SyncDeployTab({ wtKey, wt, bp }) {
  const diffData = window.WD_WT_DATA.WT_DIFFS[wtKey] || { files: [] };
  const adds = diffData.files.reduce((a, f) => a + (f.adds || 0), 0);
  const dels = diffData.files.reduce((a, f) => a + (f.dels || 0), 0);
  const [view, setView] = useStateW('summary'); // 'summary' (default) | 'diff'

  const SubTab = ({ id, icon, label }) => {
    const on = view === id;
    return (
      <button onClick={() => setView(id)} style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        height: 38, padding: '0 4px', marginBottom: -1, background: 'transparent',
        border: 0, borderBottom: on ? `2px solid ${WC.fg}` : '2px solid transparent',
        color: on ? WC.fg : WC.muted, fontSize: 13, fontWeight: on ? 600 : 500,
        fontFamily: 'inherit', cursor: 'pointer'
      }}>
        <WIcon name={icon} size={13} color={on ? WC.fg : WC.mutedFg} />
        {label}
      </button>);

  };

  return (
    <div style={{ flex: 1, overflow: 'hidden', background: WC.bg, display: 'flex',
      flexDirection: 'column' }}>
      {/* Explainer + action */}
      <div style={{
        padding: '22px 28px', borderBottom: `1px solid ${WC.border}`, background: '#fff',
        display: 'flex', alignItems: 'flex-start', gap: 18
      }}>
        <div style={{
          width: 44, height: 44, borderRadius: 10, background: WC.primarySoft,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto'
        }}>
          <WIcon name="rocket" size={22} color={WC.primary} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: WC.fg, letterSpacing: -0.2 }}>
            Sync &amp; Deploy
          </div>
          <div style={{ fontSize: 13, color: WC.muted, marginTop: 5, lineHeight: 1.6, maxWidth: 560 }}>
            This rebases <strong style={{ color: WC.fg, fontFamily: 'Geist Mono, monospace' }}>{wt.name}</strong> onto
            the <strong style={{ color: WC.fg }}>main code area</strong>, then builds and deploys every
            container in this business process to <strong style={{ color: WC.fg }}>dev</strong>. Your
            changes below become the new main once the deploy succeeds.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 12 }} data-comment-anchor="ba8decbffe-div-110-11">
            {wt.synced ?
            <WPill tone="success">Up to date with main</WPill> :
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10,
              fontSize: 12, color: WC.muted }}>
                  <span style={{ color: WC.amber, fontWeight: 600 }}>↓ {wt.behind} behind</span>
                  <span style={{ color: WC.green, fontWeight: 600 }}>↑ {wt.ahead} ahead</span>
                </span>}
            <span style={{ fontSize: 12, color: WC.muted, fontFamily: 'Geist Mono, monospace' }}>
              {diffData.files.length} file{diffData.files.length === 1 ? '' : 's'} ·
              <span style={{ color: WC.green, marginLeft: 4 }}>+{adds}</span>
              <span style={{ margin: '0 4px' }}>·</span>
              <span style={{ color: WC.red }}>−{dels}</span>
            </span>
          </div>
        </div>
        <button
          disabled={wt.synced}
          title={wt.synced ? 'Already up to date with main' : 'Rebase onto main and deploy to dev'}
          style={{
            flex: '0 0 auto',
            display: 'inline-flex', alignItems: 'center', gap: 8,
            height: 40, padding: '0 18px',
            background: wt.synced ? '#fff' : WC.primary,
            border: `1px solid ${wt.synced ? WC.border : WC.primary}`,
            borderRadius: 8,
            color: wt.synced ? WC.mutedFg : '#fff',
            fontSize: 14, fontWeight: 600, fontFamily: 'inherit',
            cursor: wt.synced ? 'not-allowed' : 'pointer'
          }}>
          
          <WIcon name="rocket" size={16} color={wt.synced ? WC.mutedFg : '#fff'} />
          Sync &amp; Deploy
        </button>
      </div>

      {/* Summary / Diff sub-tabs */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 18, padding: '0 28px',
        background: '#fff', borderBottom: `1px solid ${WC.border}`
      }}>
        <SubTab id="summary" icon="sparkles" label="Summary" />
        <SubTab id="diff" icon="git-pull-request" label="Diff" />
      </div>

      {/* Body */}
      {view === 'summary' ?
      <ChangeSummary wtKey={wtKey} diffData={diffData} /> :

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <DiffTab wtKey={wtKey} />
          </div>
      }
    </div>);

}

// AI-generated, plain-language summary of what changed in this worktree.
function ChangeSummary({ wtKey, diffData }) {
  const data = (window.WD_WT_DATA.WT_CHANGE_SUMMARY || {})[wtKey];
  const summary = data || {
    headline: 'Payroll sync and onboarding polish',
    paragraph: 'This update connects payroll to the Toggl time-tracking integration so hours flow through automatically, and tidies up the new-hire onboarding checklist. No breaking changes to existing employee records.',
    points: [
    'Payroll now pulls billable hours from Toggl on a nightly schedule.',
    'The onboarding checklist gained two steps and clearer copy.',
    'Fixed a rounding error in the gross-to-net salary calculation.'],

    risk: 'Low risk · touches payroll calculations — worth a quick review before promoting to staging.'
  };
  return (
    <div style={{ flex: 1, overflow: 'auto', background: WC.bg, padding: '24px 28px' }}>
      <div style={{ maxWidth: 760 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <span style={{
            width: 26, height: 26, borderRadius: 7, background: WC.primarySoft,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto'
          }}>
            <WIcon name="sparkles" size={14} color={WC.primary} />
          </span>
          <span style={{ fontSize: 11, fontWeight: 600, color: WC.muted, letterSpacing: 0.5,
            textTransform: 'uppercase' }}>AI summary of changes</span>
        </div>

        <div style={{ fontSize: 18, fontWeight: 700, color: WC.fg, letterSpacing: -0.2 }}>
          {summary.headline}
        </div>
        <p style={{ fontSize: 14, color: '#3f3f46', lineHeight: 1.65, margin: '8px 0 0' }}>
          {summary.paragraph}
        </p>

        <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {summary.points.map((p, i) =>
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span style={{
              marginTop: 3, width: 18, height: 18, borderRadius: 9999, flex: '0 0 auto',
              background: WC.green + '1a',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center'
            }}>
                <WIcon name="check" size={11} color={WC.green} />
              </span>
              <span style={{ fontSize: 14, color: '#3f3f46', lineHeight: 1.55 }}>{p}</span>
            </div>
          )}
        </div>

        {summary.risk &&
        <div style={{
          marginTop: 18, padding: '10px 14px', borderRadius: 8,
          background: '#fffbeb', border: '1px solid #fcd34d',
          display: 'flex', alignItems: 'flex-start', gap: 8,
          fontSize: 13, color: '#92400e', lineHeight: 1.5
        }}>
            <WIcon name="alert-triangle" size={15} color="#d97706" style={{ flex: '0 0 auto', marginTop: 1 }} />
            {summary.risk}
          </div>
        }

        <div style={{
          marginTop: 18, paddingTop: 14, borderTop: `1px solid ${WC.border}`,
          fontSize: 12, color: WC.muted
        }}>
          Summarised from {diffData.files.length} changed file{diffData.files.length === 1 ? '' : 's'}.
          Switch to the <strong style={{ color: WC.fg }}>Diff</strong> tab for the line-by-line changes.
        </div>
      </div>
    </div>);

}

// ─── Worktree header tab bar (horizontal, top of the worktree view) ─────────
function WtHeaderTabs({ active, onChange, counts, synced, onSyncDeploy }) {
  const tabs = [
  { id: 'agents', label: 'Agents', icon: 'bot', count: counts.agents },
  { id: 'specification', label: 'Spec', icon: 'file-text' },
  { id: 'requirements', label: 'Requirements', icon: 'check-square', count: counts.requirements },
  { id: 'files', label: 'Files', icon: 'folder-tree' }];

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 2, padding: '0 16px',
      background: '#fff', borderBottom: `1px solid ${WC.border}`
    }}>
      {tabs.map((t) => {
        const isAct = t.id === active;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 7,
              padding: '12px 14px', background: 'transparent',
              border: 0, borderBottom: isAct ? `2px solid ${WC.fg}` : '2px solid transparent',
              marginBottom: -1,
              fontSize: 13, fontWeight: isAct ? 600 : 500,
              color: isAct ? WC.fg : WC.muted, cursor: 'pointer', fontFamily: 'inherit'
            }}>
            
            <WIcon name={t.icon} size={14} color={isAct ? WC.fg : WC.mutedFg} />
            {t.label}
            {typeof t.count === 'number' && t.count > 0 &&
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 9999,
              background: isAct ? WC.fg : WC.border,
              color: isAct ? '#fff' : WC.muted
            }}>{t.count}</span>
            }
          </button>);

      })}
      <div style={{ marginLeft: 'auto' }}>
        <button
          onClick={synced ? undefined : onSyncDeploy}
          disabled={synced}
          title={synced ? 'Up to date with main' : 'Rebase onto main and deploy'}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            height: 32, padding: '0 14px',
            background: synced ? '#fff' : WC.primary,
            border: `1px solid ${synced ? WC.border : WC.primary}`,
            borderRadius: 7,
            color: synced ? WC.mutedFg : '#fff',
            fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
            cursor: synced ? 'not-allowed' : 'pointer',
            transition: 'background 120ms'
          }}
          onMouseEnter={(e) => {if (!synced) e.currentTarget.style.background = WC.primaryHi || WC.primary;}}
          onMouseLeave={(e) => {if (!synced) e.currentTarget.style.background = WC.primary;}}>
          
          <WIcon name="rocket" size={14} color={synced ? WC.mutedFg : '#fff'} />
          Sync &amp; Deploy
        </button>
      </div>
    </div>);

}

// ─── Worktree header tab bar — OLD 2x2 grid (kept for reference) ────────────
function WtTabGrid({ active, onChange, counts, synced, onSyncDeploy }) {
  const items = [
  { id: 'specification', label: 'Spec', icon: 'file-text' },
  { id: 'requirements', label: 'Requirements', icon: 'check-square', count: counts.requirements },
  { id: 'files', label: 'Files', icon: 'folder-tree' }];

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6,
      padding: '12px 12px 10px', borderBottom: `1px solid ${WC.border}`
    }}>
      {items.map((t) => {
        const isAct = t.id === active;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            title={t.label}
            style={{
              position: 'relative',
              display: 'flex', alignItems: 'center', gap: 7,
              padding: '8px 10px',
              background: isAct ? WC.surface2 : '#fff',
              border: `1px solid ${isAct ? WC.borderHi : WC.border}`,
              borderRadius: 7,
              color: isAct ? WC.fg : WC.muted,
              fontFamily: 'inherit', fontSize: 12, fontWeight: isAct ? 600 : 500,
              cursor: 'pointer',
              transition: 'background 120ms, color 120ms, border-color 120ms',
              textAlign: 'left'
            }}
            onMouseEnter={(e) => {if (!isAct) e.currentTarget.style.background = WC.surface;}}
            onMouseLeave={(e) => {if (!isAct) e.currentTarget.style.background = '#fff';}}>
            
            <WIcon name={t.icon} size={13} color={isAct ? WC.fg : WC.mutedFg} />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t.label}
            </span>
            <span style={{
              minWidth: 16, height: 16, padding: '0 4px',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 9, fontWeight: 700, borderRadius: 9999,
              background: isAct ? WC.fg : WC.border,
              color: isAct ? '#fff' : WC.muted,
              opacity: typeof t.count === 'number' && t.count > 0 ? 1 : 0,
              pointerEvents: typeof t.count === 'number' && t.count > 0 ? 'auto' : 'none'
            }}>{t.count || ''}</span>
          </button>);

      })}
      {/* Sync & Deploy — sits next to Files in the 4th cell */}
      <button
        onClick={synced ? undefined : onSyncDeploy}
        disabled={synced}
        title={synced ? 'Up to date with main' : 'Rebase onto main and deploy'}
        style={{
          display: 'flex', alignItems: 'center', gap: 7,
          padding: '8px 10px',
          background: synced ? '#fff' : WC.primary,
          border: `1px solid ${synced ? WC.border : WC.primary}`,
          borderRadius: 7,
          color: synced ? WC.mutedFg : '#fff',
          fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
          cursor: synced ? 'not-allowed' : 'pointer',
          textAlign: 'left',
          transition: 'background 120ms'
        }}
        onMouseEnter={(e) => {if (!synced) e.currentTarget.style.background = WC.primaryHi || WC.primary;}}
        onMouseLeave={(e) => {if (!synced) e.currentTarget.style.background = WC.primary;}}>
        
        <WIcon name="rocket" size={13} color={synced ? WC.mutedFg : '#fff'} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          Sync &amp; Deploy
        </span>
      </button>
    </div>);

}

// (legacy left icon rail — replaced by WtTabGrid, kept for reference)
function WtRail({ active, onChange, counts }) {
  const tabs = [
  { id: 'agents', label: 'Agents', icon: 'bot', count: counts.agents },
  { id: 'specification', label: 'Spec', icon: 'file-text' },
  { id: 'requirements', label: 'Requirements', icon: 'check-square', count: counts.requirements },
  { id: 'files', label: 'Files', icon: 'folder-tree' }];

  return (
    <div style={{
      width: 72, background: '#fff', borderRight: `1px solid ${WC.border}`,
      display: 'flex', flexDirection: 'column', padding: '10px 8px', gap: 4,
      flex: '0 0 auto'
    }}>
      {tabs.map((t) => {
        const isAct = t.id === active;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            title={t.label}
            style={{
              position: 'relative',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
              padding: '10px 6px',
              background: isAct ? WC.surface2 : 'transparent',
              border: 0, borderRadius: 8,
              color: isAct ? WC.fg : WC.muted,
              fontFamily: 'inherit', fontSize: 10, fontWeight: isAct ? 600 : 500,
              cursor: 'pointer',
              transition: 'background 120ms, color 120ms'
            }}
            onMouseEnter={(e) => {if (!isAct) e.currentTarget.style.background = WC.surface;}}
            onMouseLeave={(e) => {if (!isAct) e.currentTarget.style.background = 'transparent';}}>
            
            <span style={{
              position: 'absolute', left: -8, top: 8, bottom: 8, width: 3,
              borderRadius: '0 3px 3px 0', background: WC.fg,
              opacity: isAct ? 1 : 0,
              transition: 'opacity 120ms'
            }} />
            <WIcon name={t.icon} size={18} color={isAct ? WC.fg : WC.mutedFg} />
            <span style={{ lineHeight: 1.1, textAlign: 'center' }}>{t.label}</span>
            <span style={{
              position: 'absolute', top: 4, right: 8,
              minWidth: 16, height: 16, padding: '0 4px',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 9, fontWeight: 700, borderRadius: 9999,
              background: isAct ? WC.fg : WC.border,
              color: isAct ? '#fff' : WC.muted,
              opacity: typeof t.count === 'number' && t.count > 0 ? 1 : 0,
              pointerEvents: typeof t.count === 'number' && t.count > 0 ? 'auto' : 'none'
            }}>{t.count || ''}</span>
          </button>);

      })}
    </div>);

}

// (legacy horizontal tab bar — kept for reference, no longer used)
function WtTabs({ active, onChange, counts, right }) {
  const tabs = [
  { id: 'agents', label: 'Agents', icon: 'bot', count: counts.agents },
  { id: 'specification', label: 'Specification', icon: 'file-text' },
  { id: 'requirements', label: 'Requirements', icon: 'check-square', count: counts.requirements },
  { id: 'files', label: 'Files', icon: 'folder-tree' }];

  return (
    <div style={{
      display: 'flex', gap: 0, padding: '0 28px', background: '#fff',
      borderBottom: `1px solid ${WC.border}`, alignItems: 'center'
    }}>
      {tabs.map((t) => {
        const isAct = t.id === active;
        return (
          <button key={t.id} onClick={() => onChange(t.id)} style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '12px 16px', background: 'transparent',
            border: 0, borderBottom: isAct ? `2px solid ${WC.fg}` : '2px solid transparent',
            marginBottom: -1,
            fontSize: 13, fontWeight: isAct ? 600 : 500,
            color: isAct ? WC.fg : WC.muted, cursor: 'pointer', fontFamily: 'inherit'
          }}>
            <WIcon name={t.icon} size={13} color={isAct ? WC.fg : WC.mutedFg} />
            {t.label}
            {typeof t.count === 'number' && t.count > 0 &&
            <span style={{
              fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 9999,
              background: isAct ? WC.surface2 : 'transparent',
              color: isAct ? WC.fg : WC.muted,
              border: isAct ? '0' : `1px solid ${WC.border}`
            }}>{t.count}</span>
            }
          </button>);

      })}
      {right &&
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8,
        paddingLeft: 14 }}>
          {right}
        </div>
      }
    </div>);

}

// ─── Overview tab ───────────────────────────────────────────────────────────
function OverviewTab({ bp, wt, automations, readme, density, onInspect, onConfigure }) {
  const padding = density === 'compact' ? '16px 28px' : '24px 28px';
  const mainContainers = automations.filter((a) => a.kind !== 'tests');
  const testContainers = automations.filter((a) => a.kind === 'tests');

  const renderGrid = (items, withAdd) =>
  <div style={{
    display: 'grid', gap: 18, marginTop: 14,
    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))'
  }}>
      {items.map((a) => <LiveDevCardSimple key={a.id} aut={a}
    onInspect={() => onInspect && onInspect(a)}
    onConfigure={() => onConfigure && onConfigure(a)} />)}
      {withAdd &&
    <button style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
      background: 'transparent', border: `1.5px dashed ${WC.borderHi}`, borderRadius: 12,
      color: WC.muted, padding: '24px', minHeight: 140,
      cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 500
    }}>
          <WIcon name="plus" size={18} />
          New container
          <span style={{ fontSize: 11, color: WC.mutedFg, fontWeight: 400 }}>from template</span>
        </button>
    }
    </div>;


  return (
    <div style={{
      flex: 1, overflow: 'auto', background: WC.bg,
      padding, display: 'flex', flexDirection: 'column', gap: 28
    }}>
      <div>
        <WSectionHeader
          eyebrow="Automation"
          title={bp.name}
          helper={`${mainContainers.length} container${mainContainers.length === 1 ? '' : 's'} · live-dev with hot-reload.`}
          right={<WBtn variant="primary" size="sm" leftIcon="play">Start live-dev</WBtn>} />
        
        {renderGrid(mainContainers, true)}
      </div>

      {testContainers.length > 0 &&
      <div style={{
        paddingLeft: 18,
        borderLeft: `2px solid ${WC.border}`
      }}>
          <WSectionHeader
          eyebrow="Testing"
          title={`${testContainers.length} test container${testContainers.length === 1 ? '' : 's'}`}
          helper="End-to-end and integration tests. Runs independently of the automation." />
        
          {renderGrid(testContainers, false)}
        </div>
      }
    </div>);

}

// ─── Specification tab — Word-like rich-text editor ─────────────────────────
function SpecificationTab({ readme, density, inline = false, bpName = 'Specification', editNameKey = 0, onBuild }) {
  const [dirty, setDirty] = useStateW(false);
  const initialHtml = React.useMemo(() => readmeToHtml(readme), [readme]);
  const [name, setName] = useStateW(bpName);
  const [editingName, setEditingName] = useStateW(false);
  React.useEffect(() => {setName(bpName);}, [bpName]);
  // When a brand-new BP is created, jump straight into name-edit mode.
  React.useEffect(() => {if (editNameKey > 0) setEditingName(true);}, [editNameKey]);

  return (
    <div style={inline ? {
      background: WC.bg, display: 'flex', flexDirection: 'column'
    } : {
      flex: 1, overflow: 'hidden', background: WC.bg,
      display: 'flex', flexDirection: 'column'
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '14px 28px', background: '#fff',
        borderBottom: `1px solid ${WC.border}`
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: WC.fg, letterSpacing: -0.2,
            display: 'flex', alignItems: 'center', gap: 8 }}>
            {editingName ?
            <input
              autoFocus
              defaultValue={name}
              onBlur={(e) => {setName(e.target.value.trim() || name);setEditingName(false);}}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.target.blur();
                if (e.key === 'Escape') setEditingName(false);
              }}
              style={{
                fontSize: 15, fontWeight: 600, color: WC.fg,
                padding: '2px 8px', border: `1px solid ${WC.fg}`, borderRadius: 5,
                fontFamily: 'inherit', minWidth: 200
              }} /> :


            <>
                {name}
                <button
                onClick={() => setEditingName(true)}
                title="Rename business process"
                style={{
                  width: 26, height: 26, padding: 0, borderRadius: 6,
                  border: `1px solid transparent`, background: 'transparent',
                  color: WC.muted, cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center'
                }}
                onMouseEnter={(e) => {e.currentTarget.style.background = WC.surface2;
                  e.currentTarget.style.borderColor = WC.border;
                  e.currentTarget.style.color = WC.fg;}}
                onMouseLeave={(e) => {e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.borderColor = 'transparent';
                  e.currentTarget.style.color = WC.muted;}}>
                
                  <WIcon name="pencil" size={13} />
                </button>
              </>
            }
            {dirty && <span style={{ fontSize: 11, color: WC.amber, fontWeight: 500 }}>
              · unsaved changes</span>}
          </div>
          <div style={{ fontSize: 12, color: WC.muted, marginTop: 3 }}>
            Describe your business process
          </div>
        </div>
        <WBtn variant="default" size="sm" leftIcon="save" disabled={!dirty}>Save</WBtn>
        <WBtn variant="primary" size="sm" leftIcon="bot"
        onClick={onBuild}
        title="Send this description to the coding agent and open the Coding Agent tab">
          Build automation
        </WBtn>
      </div>

      <RichTextEditor
        initialHtml={initialHtml}
        density={density}
        onDirtyChange={setDirty}
        inline={inline}
        placeholder="Describe your business process — what it does, who uses it, and what success looks like…" />
      
    </div>);

}

// ─── Reusable rich-text editor (used by Specification + agent Plan editor) ──
function RichTextEditor({ initialHtml, density, onDirtyChange,
  placeholder = 'Start writing…',
  pageWidth = 820, inline = false }) {
  const padding = density === 'compact' ? '20px 28px' : '32px 56px';
  const editorRef = React.useRef(null);
  const [active, setActive] = useStateW({});
  const dirtyRef = React.useRef(false);
  const markDirty = () => {
    if (!dirtyRef.current) {
      dirtyRef.current = true;
      onDirtyChange && onDirtyChange(true);
    }
  };

  React.useEffect(() => {
    if (editorRef.current) {
      editorRef.current.innerHTML = initialHtml || '';
      dirtyRef.current = false;
      onDirtyChange && onDirtyChange(false);
    }
  }, [initialHtml]);

  const refreshActive = () => {
    if (!document.queryCommandState) return;
    const block = document.queryCommandValue && document.queryCommandValue('formatBlock');
    setActive({
      bold: document.queryCommandState('bold'),
      italic: document.queryCommandState('italic'),
      ul: document.queryCommandState('insertUnorderedList'),
      ol: document.queryCommandState('insertOrderedList'),
      h1: /h1/i.test(block || ''),
      h2: /h2/i.test(block || ''),
      h3: /h3/i.test(block || ''),
      quote: /blockquote/i.test(block || '')
    });
  };

  const cmd = (name, value) => {
    editorRef.current && editorRef.current.focus();
    document.execCommand(name, false, value);
    markDirty();
    refreshActive();
  };
  const setBlock = (tag) => cmd('formatBlock', tag);

  const ToolBtn = ({ icon, title, onClick, isActive, label }) =>
  <button onMouseDown={(e) => e.preventDefault()} onClick={onClick} title={title}
  style={{
    height: 30, minWidth: label ? undefined : 30, padding: label ? '0 10px' : 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    background: isActive ? WC.surface2 : 'transparent',
    color: isActive ? WC.fg : '#3f3f46',
    border: `1px solid ${isActive ? WC.borderHi : 'transparent'}`,
    borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
    fontSize: 12, fontWeight: 500
  }}
  onMouseEnter={(e) => {if (!isActive) e.currentTarget.style.background = WC.surface;}}
  onMouseLeave={(e) => {if (!isActive) e.currentTarget.style.background = 'transparent';}}>
      <WIcon name={icon} size={14} />
      {label}
    </button>;

  const Divider = () =>
  <span style={{ width: 1, height: 18, background: WC.border, margin: '0 4px' }} />;


  return (
    <>
      {/* Formatting toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap',
        padding: '8px 28px', background: '#fff',
        borderBottom: `1px solid ${WC.border}`
      }}>
        <ToolBtn icon="heading-1" title="Heading 1"
        isActive={active.h1} onClick={() => setBlock('H1')} />
        <ToolBtn icon="heading-2" title="Heading 2"
        isActive={active.h2} onClick={() => setBlock('H2')} />
        <ToolBtn icon="heading-3" title="Heading 3"
        isActive={active.h3} onClick={() => setBlock('H3')} />
        <ToolBtn icon="pilcrow" title="Paragraph"
        onClick={() => setBlock('P')} />
        <Divider />
        <ToolBtn icon="bold" title="Bold (Ctrl+B)"
        isActive={active.bold} onClick={() => cmd('bold')} />
        <ToolBtn icon="italic" title="Italic (Ctrl+I)"
        isActive={active.italic} onClick={() => cmd('italic')} />
        <ToolBtn icon="underline" title="Underline (Ctrl+U)"
        onClick={() => cmd('underline')} />
        <ToolBtn icon="strikethrough" title="Strikethrough"
        onClick={() => cmd('strikeThrough')} />
        <ToolBtn icon="code" title="Inline code"
        onClick={() => {
          const sel = window.getSelection && window.getSelection();
          if (!sel || !sel.toString()) return;
          document.execCommand('insertHTML', false,
          `<code style="background:#f1f5f9;padding:1px 5px;border-radius:3px;font-family:Geist Mono,monospace;font-size:0.92em">${escapeHtml(sel.toString())}</code>`);
          markDirty();
        }} />
        <Divider />
        <ToolBtn icon="list" title="Bullet list"
        isActive={active.ul} onClick={() => cmd('insertUnorderedList')} />
        <ToolBtn icon="list-ordered" title="Numbered list"
        isActive={active.ol} onClick={() => cmd('insertOrderedList')} />
        <ToolBtn icon="quote" title="Quote"
        isActive={active.quote} onClick={() => setBlock('BLOCKQUOTE')} />
        <ToolBtn icon="indent-increase" title="Indent"
        onClick={() => cmd('indent')} />
        <ToolBtn icon="indent-decrease" title="Outdent"
        onClick={() => cmd('outdent')} />
        <Divider />
        <ToolBtn icon="link" title="Insert link"
        onClick={() => {
          const url = window.prompt('Link URL:', 'https://');
          if (url) cmd('createLink', url);
        }} />
        <ToolBtn icon="minus" title="Horizontal rule"
        onClick={() => document.execCommand('insertHorizontalRule')} />
        <Divider />
        <ToolBtn icon="undo-2" title="Undo (Ctrl+Z)"
        onClick={() => cmd('undo')} />
        <ToolBtn icon="redo-2" title="Redo (Ctrl+Shift+Z)"
        onClick={() => cmd('redo')} />
      </div>

      {/* Editable canvas — Word-like page */}
      <div style={inline ?
      { background: WC.bg } :
      { flex: 1, overflow: 'auto', background: WC.bg }}>
        <div style={{
          maxWidth: pageWidth, margin: '24px auto 40px',
          background: '#fff', border: `1px solid ${WC.border}`,
          borderRadius: 6, boxShadow: '0 1px 3px rgba(0,0,0,0.04)'
        }}>
          <div
            ref={editorRef}
            contentEditable suppressContentEditableWarning
            spellCheck
            data-placeholder={placeholder}
            onInput={() => {markDirty();refreshActive();}}
            onKeyUp={refreshActive}
            onMouseUp={refreshActive}
            onFocus={refreshActive}
            className="wd-doc"
            style={{
              minHeight: 600, padding,
              outline: 'none',
              fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
              fontSize: 15, lineHeight: 1.7, color: WC.fg
            }} />
          
        </div>
      </div>

      <style>{`
        .wd-doc h1 { font-family: Roboto, Inter; font-size: 30px; font-weight: 700;
                     letter-spacing: -0.5px; margin: 0 0 12px; color: ${WC.fg}; }
        .wd-doc h2 { font-size: 22px; font-weight: 700; letter-spacing: -0.3px;
                     margin: 26px 0 8px; color: ${WC.fg}; }
        .wd-doc h3 { font-size: 17px; font-weight: 600; letter-spacing: -0.2px;
                     margin: 20px 0 6px; color: ${WC.fg}; }
        .wd-doc p  { margin: 0 0 12px; color: #3f3f46; }
        .wd-doc ul, .wd-doc ol { margin: 0 0 14px 0; padding-left: 26px;
                                 display: flex; flex-direction: column; gap: 4px; }
        .wd-doc li { color: #3f3f46; }
        .wd-doc strong { font-weight: 600; color: ${WC.fg}; }
        .wd-doc blockquote { margin: 12px 0; padding: 6px 16px;
                             border-left: 3px solid ${WC.borderHi};
                             color: ${WC.muted}; font-style: italic; }
        .wd-doc a { color: ${WC.primary}; text-decoration: underline;
                    text-underline-offset: 2px; }
        .wd-doc hr { border: 0; border-top: 1px solid ${WC.border}; margin: 18px 0; }
        .wd-doc:empty::before {
          content: attr(data-placeholder);
          color: ${WC.mutedFg};
        }
      `}</style>
    </>);

}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function readmeToHtml(readme) {
  if (!readme) return '';
  let html = `<h1>${escapeHtml(readme.title)}</h1>`;
  html += `<p>${escapeHtml(readme.summary)}</p>`;
  for (const sec of readme.sections) {
    html += `<h2>${escapeHtml(sec.heading)}</h2>`;
    html += '<ul>';
    for (const [term, desc] of sec.items) {
      html += `<li><strong>${escapeHtml(term)}</strong> — ${escapeHtml(desc)}</li>`;
    }
    html += '</ul>';
  }
  return html;
}

// ─── Agents tab ─────────────────────────────────────────────────────────────
const AGENT_KIND_META = {
  agent: { icon: 'bot', label: 'Agent', color: '#3b82f6', bg: '#dbeafe' },
  sync: { icon: 'git-pull-request-arrow', label: 'Sync', color: '#a855f7', bg: '#f3e8ff' },
  testing: { icon: 'flask-conical', label: 'Testing', color: '#f59e0b', bg: '#fef3c7' }
};

function AgentSessionRow({ s, active, onClick, onDelete }) {
  const km = AGENT_KIND_META[s.kind] || AGENT_KIND_META.agent;
  const [hover, setHover] = useStateW(false);
  return (
    <button onClick={onClick}
    onMouseEnter={() => setHover(true)}
    onMouseLeave={() => setHover(false)}
    style={{
      position: 'relative',
      display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
      padding: '12px 14px', background: active ? WC.surface2 : '#fff',
      border: 0, borderBottom: `1px solid ${WC.border}`,
      borderLeft: active ? `3px solid ${WC.fg}` : '3px solid transparent',
      cursor: 'pointer', fontFamily: 'inherit'
    }}>
      <div title={km.label} style={{
        width: 28, height: 28, borderRadius: 6, background: km.bg,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto'
      }}>
        <WIcon name={km.icon} size={14} color={km.color} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: WC.fg,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          paddingRight: hover ? 24 : 0 }}>
          {s.name}
        </div>
        <div style={{ fontSize: 11, color: WC.muted, fontFamily: 'Geist Mono, monospace',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {km.label.toLowerCase()} · {s.lastActive}
        </div>
      </div>
      {hover && onDelete &&
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => {e.stopPropagation();onDelete(s);}}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();e.stopPropagation();onDelete(s);
          }
        }}
        title={`Delete session "${s.name}"`}
        style={{
          position: 'absolute', top: 10, right: 10,
          width: 22, height: 22, borderRadius: 5,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          color: WC.muted, background: 'transparent',
          border: `1px solid transparent`,
          cursor: 'pointer'
        }}
        onMouseEnter={(e) => {e.currentTarget.style.background = '#fff';
          e.currentTarget.style.color = '#dc2626';
          e.currentTarget.style.borderColor = WC.border;}}
        onMouseLeave={(e) => {e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = WC.muted;
          e.currentTarget.style.borderColor = 'transparent';}}>
        
          <WIcon name="trash-2" size={12} />
        </span>
      }
    </button>);

}

// Simple confirm modal used for destructive actions in the worktree view.
function ConfirmModal({ open, title, message, confirmLabel = 'Delete', cancelLabel = 'Cancel',
  danger = true, onConfirm, onCancel }) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => {if (e.key === 'Escape') onCancel?.();};
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);
  React.useEffect(() => {if (open && window.lucide) window.lucide.createIcons();});
  if (!open) return null;
  return (
    <div onClick={onCancel} style={{
      position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 440, maxWidth: '92%', background: '#fff',
        border: `1px solid ${WC.border}`, borderRadius: 12, overflow: 'hidden',
        boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)'
      }}>
        <div style={{ padding: '20px 22px 14px', display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 9999,
            background: danger ? '#fee2e2' : WC.surface2,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            flex: '0 0 auto'
          }}>
            <WIcon name="alert-triangle" size={16} color={danger ? '#dc2626' : WC.fg} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: WC.fg }}>{title}</div>
            <div style={{ fontSize: 13, color: WC.muted, marginTop: 6, lineHeight: 1.55 }}>
              {message}
            </div>
          </div>
        </div>
        <div style={{
          padding: '12px 22px', background: WC.surface,
          display: 'flex', justifyContent: 'flex-end', gap: 8,
          borderTop: `1px solid ${WC.border}`
        }}>
          <WBtn variant="ghost" size="sm" onClick={onCancel}>{cancelLabel}</WBtn>
          <button
            onClick={onConfirm}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              height: 32, padding: '0 14px',
              background: danger ? '#dc2626' : WC.fg, color: '#fff',
              border: 0, borderRadius: 6, fontSize: 13, fontWeight: 600,
              fontFamily: 'inherit', cursor: 'pointer'
            }}>
            
            <WIcon name="trash-2" size={13} />
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>);

}

function AgentTerminal({ session }) {
  const term = {
    bg: '#1e1e1e', bg2: '#252526', fg: '#cccccc', dim: '#858585',
    green: '#16c60c', cyan: '#3a96dd', yellow: '#f9f1a5', accent: '#0078d4', border: '#3c3c3c'
  };
  if (!session) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#fff', color: WC.muted, fontSize: 13
      }}>
        Select a session — or start a new one.
      </div>);

  }
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden',
      background: term.bg
    }}>
      <div style={{
        height: 34, background: term.bg2, borderBottom: `1px solid ${term.border}`,
        display: 'flex', alignItems: 'center', padding: '0 12px', gap: 8,
        fontFamily: 'Geist Mono, monospace', fontSize: 11, color: term.dim
      }}>
        <span style={{ color: term.cyan }}>●</span>
        <span style={{ color: term.fg, fontWeight: 600 }}>claude</span>
        <span>·</span>
        <span>{session.branch}</span>
        <span>·</span>
        <span>{session.model}</span>
        <span style={{ marginLeft: 'auto' }}>tokens {session.tokens} · {session.elapsed}</span>
      </div>
      <div style={{
        flex: 1, overflow: 'auto', padding: '14px 16px',
        fontFamily: 'Geist Mono, monospace', fontSize: 12.5, lineHeight: 1.6,
        color: term.fg
      }}>
        <div style={{ color: term.dim }}>╭─ {session.name} {'─'.repeat(Math.max(0, 70 - session.name.length))}╮</div>
        <div style={{ color: term.dim }}>│</div>
        <div>│  <span style={{ color: term.cyan }}>You</span> › Map OPEX line items to budget categories using fuzzy matching.</div>
        <div style={{ color: term.dim }}>│</div>
        <div>│  <span style={{ color: term.green }}>●</span> <span style={{ color: term.fg }}>Working on it…</span></div>
        <div style={{ color: term.green }}>│    ✓ Read OPEX schema (12 columns, 4 categories)</div>
        <div style={{ color: term.green }}>│    ✓ Built fuzzy matcher (Levenshtein ≤ 2)</div>
        <div style={{ color: term.green }}>│    ✓ Added <span style={{ color: term.yellow }}>opex_overrides</span> table migration</div>
        <div style={{ color: term.yellow }}>│    ◐ Running tests… <span style={{ color: term.dim }}>(pytest tests/test_opex_mapping.py)</span></div>
        <div style={{ color: term.dim }}>│    ○ Update REQ-043 status</div>
        <div style={{ color: term.dim }}>│</div>
        <div style={{ color: term.dim }}>╰{'─'.repeat(72)}╯</div>
        <div style={{ color: term.green, marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>▸</span>
          <span style={{
            display: 'inline-block', width: 8, height: 14, background: term.fg,
            animation: 'wd-blink 1s steps(2, start) infinite'
          }} />
        </div>
      </div>
      <div style={{
        height: 22, background: term.accent, color: '#fff',
        display: 'flex', alignItems: 'center', padding: '0 10px', gap: 14,
        fontSize: 11
      }}>
        <span>⎇ {session.branch}</span>
        <span>● {session.status}</span>
        <span>tokens {session.tokens}</span>
        <div style={{ flex: 1 }} />
        <span>UTF-8</span>
        <span>LF</span>
      </div>
    </div>);

}

// ─── Plan editor — uses the rich-text editor ─────────────────────────────────
function planMarkdownToHtml(md) {
  if (!md) return '';
  const lines = md.split('\n');
  let html = '';
  let ulOpen = false;
  let olOpen = false;
  const closeLists = () => {
    if (ulOpen) {html += '</ul>';ulOpen = false;}
    if (olOpen) {html += '</ol>';olOpen = false;}
  };
  const inline = (s) => escapeHtml(s).
  replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').
  replace(/`([^`]+)`/g, '<code style="background:#f1f5f9;padding:1px 5px;border-radius:3px;font-family:Geist Mono,monospace;font-size:0.92em">$1</code>');
  for (const raw of lines) {
    const t = raw.trim();
    if (t.startsWith('# ')) {closeLists();html += `<h1>${inline(t.slice(2))}</h1>`;} else
    if (t.startsWith('## ')) {closeLists();html += `<h2>${inline(t.slice(3))}</h2>`;} else
    if (t.startsWith('### ')) {closeLists();html += `<h3>${inline(t.slice(4))}</h3>`;} else
    if (t.startsWith('- [ ] ')) {if (!ulOpen) {closeLists();html += '<ul>';ulOpen = true;}
      html += `<li>☐ ${inline(t.slice(6))}</li>`;} else
    if (t.startsWith('- [x] ') || t.startsWith('- [X] ')) {if (!ulOpen) {closeLists();html += '<ul>';ulOpen = true;}
      html += `<li>☑ ${inline(t.slice(6))}</li>`;} else
    if (t.startsWith('- ')) {if (!ulOpen) {closeLists();html += '<ul>';ulOpen = true;}
      html += `<li>${inline(t.slice(2))}</li>`;} else
    if (/^\d+\.\s/.test(t)) {if (!olOpen) {closeLists();html += '<ol>';olOpen = true;}
      html += `<li>${inline(t.replace(/^\d+\.\s/, ''))}</li>`;} else
    if (t) {closeLists();html += `<p>${inline(t)}</p>`;}
  }
  closeLists();
  return html;
}

function PlanEditorPane({ session }) {
  const md = (window.WD_WT_DATA.WT_AGENT_PLANS || {})[session?.id] || '';
  const initialHtml = React.useMemo(() => planMarkdownToHtml(md), [session?.id]);
  const [dirty, setDirty] = useStateW(false);
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden',
      background: WC.bg }}>
      <div style={{ padding: '10px 28px', background: '#fff',
        borderBottom: `1px solid ${WC.border}`,
        display: 'flex', alignItems: 'center', gap: 10 }}>
        <WIcon name="map" size={13} color={WC.muted} />
        <div style={{ flex: 1, fontSize: 13, color: WC.muted }}>
          Plan that the agent is following — edit to steer its work
          {dirty && <span style={{ color: WC.amber, marginLeft: 8, fontWeight: 500 }}>
            · unsaved changes</span>}
        </div>
        <WBtn variant="default" size="xs" leftIcon="sparkles">Suggest changes</WBtn>
        <WBtn variant="primary" size="xs" leftIcon="save" disabled={!dirty}>Save plan</WBtn>
      </div>
      <RichTextEditor
        initialHtml={initialHtml}
        placeholder="No plan yet — write what the agent should do, step by step."
        onDirtyChange={setDirty} />
      
    </div>);

}

// ─── Browser pane — a live browser window the agent drives via Playwright ────
function BrowserPane({ session, bp, wt }) {
  const host = `${(wt?.name || 'dev').replace(/[^a-z0-9-]/gi,'-')}.${(bp?.name||'app')}.dev.harmonum.ai`;
  const url = `https://${host}/employees`;

  // Scripted Playwright action sequence the agent runs in a loop.
  const steps = React.useMemo(() => [
    { x: 50, y: 22, action: "click",    target: 'button "Add employee"',  caption: 'Opening the new-employee form' },
    { x: 38, y: 45, action: "fill",     target: 'input#name',             caption: 'Typing "Marek Horák"' },
    { x: 38, y: 56, action: "fill",     target: 'input#email',            caption: 'Typing "marek@harmonum.ai"' },
    { x: 38, y: 67, action: "selectOption", target: 'select#team',        caption: 'Selecting team "Finance"' },
    { x: 30, y: 80, action: "click",    target: 'button "Save"',          caption: 'Submitting the form' },
    { x: 70, y: 14, action: "waitFor",  target: 'text="Saved"',           caption: 'Waiting for confirmation toast' },
  ], []);

  const [i, setI] = useStateW(0);
  const [clicking, setClicking] = useStateW(false);
  const [running, setRunning] = useStateW(true);
  const [log, setLog] = useStateW([]);

  React.useEffect(() => {
    if (!running) return;
    let alive = true;
    const cur = steps[i];
    // click ripple a moment after the cursor arrives
    const t1 = setTimeout(() => { if (alive) setClicking(true); }, 900);
    const t2 = setTimeout(() => {
      if (!alive) return;
      setClicking(false);
      setLog(l => [{ id: Date.now(), action: cur.action, target: cur.target, caption: cur.caption }, ...l].slice(0, 20));
      setI(n => (n + 1) % steps.length);
    }, 1500);
    return () => { alive = false; clearTimeout(t1); clearTimeout(t2); };
  }, [i, running, steps]);

  const cur = steps[i];

  const ctrlBtn = {
    width: 28, height: 28, borderRadius: 6, border: `1px solid ${WC.border}`,
    background: '#fff', color: WC.muted, cursor: 'pointer', flex: '0 0 auto',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center'
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
                  background: WC.bg, overflow: 'hidden' }}>
      {/* Agent-control banner */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px',
        background: '#eff6ff', borderBottom: `1px solid #bfdbfe`, color: '#1d4ed8',
        fontSize: 12.5
      }}>
        <span style={{ position: 'relative', display: 'inline-flex', width: 16, height: 16,
                       alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}>
          {running && <span style={{ position: 'absolute', inset: 0, borderRadius: 9999,
                                     background: '#2563eb55', animation: 'wd-pulse 1.6s ease-out infinite' }} />}
          <WIcon name="bot" size={13} color="#2563eb" />
        </span>
        <span style={{ flex: 1 }}>
          <strong style={{ fontWeight: 600 }}>{session?.name || 'Agent'}</strong> is controlling this
          browser via Playwright — <span style={{ fontFamily: 'Geist Mono, monospace' }}>{cur.caption}</span>
        </span>
        <button onClick={() => setRunning(r => !r)} style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, height: 26, padding: '0 10px',
          borderRadius: 6, border: `1px solid #bfdbfe`, background: '#fff', color: '#1d4ed8',
          fontSize: 11, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer'
        }}>
          <WIcon name={running ? 'pause' : 'play'} size={12} color="#1d4ed8" />
          {running ? 'Pause' : 'Resume'}
        </button>
      </div>

      {/* Browser chrome */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                    background: '#fff', borderBottom: `1px solid ${WC.border}` }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <button style={ctrlBtn}><WIcon name="arrow-left" size={14} /></button>
          <button style={ctrlBtn}><WIcon name="arrow-right" size={14} /></button>
          <button style={ctrlBtn}><WIcon name="rotate-cw" size={13} /></button>
        </div>
        <div style={{
          flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, height: 30,
          padding: '0 12px', borderRadius: 8, background: WC.surface,
          border: `1px solid ${WC.border}`, fontSize: 12.5, color: WC.fg,
          fontFamily: 'Geist Mono, ui-monospace, monospace'
        }}>
          <WIcon name="lock" size={12} color={WC.green} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{url}</span>
        </div>
        <span style={{ fontSize: 11, color: WC.muted, flex: '0 0 auto' }}>Playwright · Chromium</span>
      </div>

      {/* Viewport with the controlled page + agent cursor */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden',
                    background: '#fff' }}>
        <MockEmployeesPage activeStep={cur} />

        {/* agent cursor */}
        <div style={{
          position: 'absolute', left: `${cur.x}%`, top: `${cur.y}%`,
          transform: 'translate(-2px,-2px)',
          transition: 'left 800ms cubic-bezier(.4,0,.2,1), top 800ms cubic-bezier(.4,0,.2,1)',
          pointerEvents: 'none', zIndex: 5
        }}>
          {clicking && (
            <span style={{
              position: 'absolute', left: -10, top: -10, width: 28, height: 28,
              borderRadius: 9999, border: `2px solid ${WC.primary}`,
              animation: 'wd-click 500ms ease-out'
            }} />
          )}
          <svg width="20" height="22" viewBox="0 0 20 22" style={{
            filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.35))'
          }}>
            <path d="M2 2 L2 16 L6 12 L9 19 L12 18 L9 11 L15 11 Z"
                  fill="#fff" stroke="#111" strokeWidth="1.3" strokeLinejoin="round" />
          </svg>
          <span style={{
            position: 'absolute', left: 18, top: 14, whiteSpace: 'nowrap',
            background: WC.fg, color: '#fff', fontSize: 10.5, fontWeight: 600,
            padding: '2px 7px', borderRadius: 5, fontFamily: 'Geist Mono, monospace'
          }}>{cur.action}</span>
        </div>
      </div>

      {/* Action log */}
      <div style={{ height: 132, flex: '0 0 auto', borderTop: `1px solid ${WC.border}`,
                    background: '#0c0c0e', overflow: 'auto', padding: '8px 0' }}>
        {log.length === 0 && (
          <div style={{ padding: '10px 16px', fontSize: 12, color: '#71717a',
                        fontFamily: 'Geist Mono, monospace' }}>
            Waiting for the first action…
          </div>
        )}
        {log.map(e => (
          <div key={e.id} style={{
            display: 'flex', alignItems: 'baseline', gap: 10, padding: '3px 16px',
            fontFamily: 'Geist Mono, monospace', fontSize: 12, lineHeight: '18px'
          }}>
            <span style={{ color: '#34d399', fontWeight: 600, minWidth: 92 }}>{e.action}</span>
            <span style={{ color: '#a5b4fc' }}>{e.target}</span>
            <span style={{ color: '#52525b', marginLeft: 'auto' }}>ok</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// The web page the agent is driving — a simple employees admin screen.
function MockEmployeesPage({ activeStep }) {
  const field = (label, id, value, focused) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: '#334155' }}>{label}</label>
      <div style={{
        height: 34, borderRadius: 7, border: `1.5px solid ${focused ? '#2563eb' : '#e2e8f0'}`,
        background: focused ? '#eff6ff' : '#fff', display: 'flex', alignItems: 'center',
        padding: '0 10px', fontSize: 13, color: value ? '#0f172a' : '#94a3b8'
      }}>{value || `Enter ${label.toLowerCase()}…`}</div>
    </div>
  );
  const target = activeStep?.target || '';
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden',
                  fontFamily: 'Inter, system-ui, sans-serif' }}>
      {/* page top bar */}
      <div style={{ height: 52, borderBottom: '1px solid #e2e8f0', display: 'flex',
                    alignItems: 'center', justifyContent: 'space-between', padding: '0 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 26, height: 26, borderRadius: 7, background: '#1d4ed8' }} />
          <span style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>People</span>
        </div>
        <div style={{
          height: 30, padding: '0 14px', borderRadius: 7, background: '#1d4ed8', color: '#fff',
          display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600,
          boxShadow: target.includes('Add employee') ? '0 0 0 3px #93c5fd' : 'none'
        }}>+ Add employee</div>
      </div>

      {/* form card */}
      <div style={{ padding: '28px 24px', display: 'flex', justifyContent: 'center' }}>
        <div style={{
          width: 460, maxWidth: '90%', background: '#fff', border: '1px solid #e2e8f0',
          borderRadius: 12, padding: '20px 22px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
          display: 'flex', flexDirection: 'column', gap: 14
        }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#0f172a' }}>New employee</div>
          {field('Name', 'name', target.includes('#name') ? 'Marek Horák' : '', target.includes('#name'))}
          {field('Email', 'email', target.includes('#email') ? 'marek@harmonum.ai' : '', target.includes('#email'))}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#334155' }}>Team</label>
            <div style={{
              height: 34, borderRadius: 7, border: `1.5px solid ${target.includes('#team') ? '#2563eb' : '#e2e8f0'}`,
              background: target.includes('#team') ? '#eff6ff' : '#fff', display: 'flex',
              alignItems: 'center', justifyContent: 'space-between', padding: '0 10px',
              fontSize: 13, color: target.includes('#team') ? '#0f172a' : '#94a3b8'
            }}>
              <span>{target.includes('#team') ? 'Finance' : 'Select team…'}</span>
              <span style={{ color: '#94a3b8' }}>▾</span>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <div style={{ height: 34, padding: '0 16px', borderRadius: 7, border: '1px solid #e2e8f0',
                          display: 'inline-flex', alignItems: 'center', fontSize: 13, color: '#475569' }}>Cancel</div>
            <div style={{
              height: 34, padding: '0 18px', borderRadius: 7, background: '#16a34a', color: '#fff',
              display: 'inline-flex', alignItems: 'center', fontSize: 13, fontWeight: 600,
              boxShadow: target.includes('Save') ? '0 0 0 3px #86efac' : 'none'
            }}>Save</div>
          </div>
        </div>
      </div>

      {/* confirmation toast */}
      {target.includes('Saved') && (
        <div style={{
          position: 'absolute', top: 64, right: 24, background: '#0f172a', color: '#fff',
          padding: '10px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600,
          display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.2)'
        }}>
          <span style={{ color: '#4ade80' }}>✓</span> Saved
        </div>
      )}
    </div>
  );
}

// ─── Notes pane — agent + user notes ─────────────────────────────────────────
function NotesPane({ session }) {
  const initialNotes = (window.WD_WT_DATA.WT_AGENT_NOTES || {})[session?.id] || [];
  const [notes, setNotes] = useStateW(initialNotes);
  const [draft, setDraft] = useStateW('');
  React.useEffect(() => {
    setNotes((window.WD_WT_DATA.WT_AGENT_NOTES || {})[session?.id] || []);
  }, [session?.id]);

  const addNote = () => {
    const text = draft.trim();
    if (!text) return;
    setNotes([{ id: `u${Date.now()}`, who: 'user', at: 'just now', text }, ...notes]);
    setDraft('');
  };

  return (
    <div style={{
      flex: 1, overflow: 'auto', background: WC.bg,
      padding: '18px 28px 28px', display: 'flex', flexDirection: 'column', gap: 14
    }}>
      <div style={{
        background: '#fff', border: `1px solid ${WC.border}`, borderRadius: 10,
        padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10,
        maxWidth: 780
      }}>
        <textarea
          value={draft} onChange={(e) => setDraft(e.target.value)}
          placeholder="New note — capture a decision, an open question, or context the agent should remember…"
          rows={2}
          style={{
            width: '100%', boxSizing: 'border-box',
            border: `1px solid ${WC.border}`, borderRadius: 6, padding: '8px 10px',
            fontFamily: 'inherit', fontSize: 13, lineHeight: 1.5, color: WC.fg,
            outline: 'none', resize: 'vertical', background: WC.surface
          }} />
        
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: WC.muted }}>
            {notes.length} note{notes.length === 1 ? '' : 's'} · agent + user
          </span>
          <div style={{ flex: 1 }} />
          <WBtn variant="primary" size="sm" leftIcon="plus"
          onClick={addNote}
          disabled={!draft.trim()}>
            New note
          </WBtn>
        </div>
      </div>

      {notes.length === 0 &&
      <div style={{
        padding: '48px 16px', textAlign: 'center', color: WC.muted, fontSize: 13,
        border: `1.5px dashed ${WC.border}`, borderRadius: 10, maxWidth: 780
      }}>
          No notes yet. The agent saves notes here when you tell it to remember
          something — or you can add your own.
        </div>
      }

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 780 }}>
        {notes.map((n) => {
          const fromAgent = n.who === 'agent';
          return (
            <div key={n.id} style={{
              background: '#fff', border: `1px solid ${WC.border}`, borderRadius: 10,
              padding: '12px 14px', display: 'flex', gap: 12
            }}>
              <div style={{
                width: 28, height: 28, borderRadius: '50%',
                background: fromAgent ? '#dbeafe' : WC.surface2,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto'
              }}>
                <WIcon name={fromAgent ? 'bot' : 'user'} size={14}
                color={fromAgent ? '#1d4ed8' : WC.muted} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: WC.fg,
                    textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    {fromAgent ? 'Agent' : 'You'}
                  </span>
                  <span style={{ fontSize: 11, color: WC.muted }}>· {n.at}</span>
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.6, color: WC.fg, whiteSpace: 'pre-wrap' }}>
                  {n.text}
                </div>
              </div>
              <button title="Delete note" style={{
                background: 'transparent', border: 0, cursor: 'pointer',
                color: WC.mutedFg, padding: 4, alignSelf: 'flex-start'
              }}>
                <WIcon name="trash-2" size={13} />
              </button>
            </div>);

        })}
      </div>
    </div>);

}

// Inline mini-toolbar shown right under the active agent session row.
// Replaces the SessionSubtabs strip that used to live in the right pane.
function SessionToolbar({ subtab, onChange }) {
  const buttons = [
  { id: 'chat', label: 'Chat', icon: 'message-square' },
  { id: 'plan', label: 'Plan', icon: 'map' },
  { id: 'notes', label: 'Notes', icon: 'sticky-note' }];

  return (
    <div style={{
      display: 'flex', gap: 4,
      padding: '8px 12px 10px 14px',
      background: WC.surface2,
      borderBottom: `1px solid ${WC.border}`
    }}>
      {buttons.map((b) => {
        const isAct = b.id === subtab;
        return (
          <button
            key={b.id}
            onClick={() => onChange(b.id)}
            title={b.label}
            style={{
              flex: 1,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              height: 26, padding: '0 6px',
              background: isAct ? '#fff' : 'transparent',
              border: `1px solid ${isAct ? WC.border : 'transparent'}`,
              boxShadow: isAct ? '0 1px 2px rgba(0,0,0,0.04)' : 'none',
              borderRadius: 5,
              fontSize: 11, fontWeight: 600,
              color: isAct ? WC.fg : WC.muted,
              fontFamily: 'inherit',
              cursor: 'pointer',
              transition: 'background 120ms, color 120ms'
            }}
            onMouseEnter={(e) => {if (!isAct) e.currentTarget.style.color = WC.fg;}}
            onMouseLeave={(e) => {if (!isAct) e.currentTarget.style.color = WC.muted;}}>
            
            <WIcon name={b.icon} size={11} />
            {b.label}
          </button>);

      })}
    </div>);

}

// ─── Session sub-tabs (Chat / Plan editor / Notes) ──────────────────────────
function SessionSubtabs({ active, onChange, session }) {
  const tabs = [
  { id: 'chat', label: 'Chat', icon: 'message-square' },
  { id: 'plan', label: 'Plan editor', icon: 'map' },
  { id: 'notes', label: 'Notes', icon: 'sticky-note' }];

  const km = AGENT_KIND_META[session?.kind] || AGENT_KIND_META.agent;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 0,
      padding: '0 18px', background: '#fff',
      borderBottom: `1px solid ${WC.border}`, height: 42, flexShrink: 0
    }}>
      {session &&
      <>
          <div style={{
          width: 24, height: 24, borderRadius: 5, background: km.bg,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          marginRight: 8
        }}>
            <WIcon name={km.icon} size={12} color={km.color} />
          </div>
          <span style={{ fontSize: 13, fontWeight: 600, color: WC.fg,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          maxWidth: 220, marginRight: 14 }}>
            {session.name}
          </span>
          <span style={{ width: 1, height: 18, background: WC.border, margin: '0 6px 0 0' }} />
        </>
      }
      {tabs.map((t) => {
        const isAct = t.id === active;
        return (
          <button key={t.id} onClick={() => onChange(t.id)} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '0 14px', height: 42, background: 'transparent',
            border: 0, borderBottom: isAct ? `2px solid ${WC.fg}` : '2px solid transparent',
            marginBottom: -1,
            fontSize: 13, fontWeight: isAct ? 600 : 500,
            color: isAct ? WC.fg : WC.muted, cursor: 'pointer', fontFamily: 'inherit'
          }}>
            <WIcon name={t.icon} size={12} color={isAct ? WC.fg : WC.mutedFg} />
            {t.label}
          </button>);

      })}
    </div>);

}

function AgentsTab({ wtKey, bp, wt, automations, selId, subtab }) {
  const sessions = window.WD_WT_DATA.WT_AGENT_SESSIONS[wtKey] || [];
  // One agent per business process — always the first session.
  const sel = sessions[0];
  const [tab2, setTab2] = useStateW('chat');
  React.useEffect(() => {setTab2('chat');}, [wtKey]);
  const [showDiff, setShowDiff] = useStateW(false);
  React.useEffect(() => {setShowDiff(false);}, [tab2, wtKey]);
  const diffData = window.WD_WT_DATA.WT_DIFFS[wtKey] || { files: [] };

  const ToolBtn = ({ id, icon, label }) => {
    const on = tab2 === id;
    return (
      <button onClick={() => setTab2(id)} style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        height: 34, padding: '0 4px', marginBottom: -1, background: 'transparent',
        border: 0, borderBottom: on ? `2px solid ${WC.fg}` : '2px solid transparent',
        color: on ? WC.fg : WC.muted, fontSize: 13, fontWeight: on ? 600 : 500,
        fontFamily: 'inherit', cursor: 'pointer'
      }}>
        <WIcon name={icon} size={13} color={on ? WC.fg : WC.mutedFg} />
        {label}
      </button>);

  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {sel ?
      <>
          <div style={{
          display: 'flex', alignItems: 'center', gap: 18, padding: '0 22px',
          background: '#fff', borderBottom: `1px solid ${WC.border}`
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingRight: 6,
            borderRight: `1px solid ${WC.border}`, height: 38, marginRight: 2 }}>
              <span style={{ width: 7, height: 7, borderRadius: 9999,
              background: sel.status === 'running' ? WC.green : WC.mutedFg }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: WC.fg }}>{sel.name}</span>
            </div>
            <ToolBtn id="chat" icon="message-square" label="Chat" />
            <ToolBtn id="plan" icon="map" label="Plan" />
            <ToolBtn id="notes" icon="sticky-note" label="Notes" />
            <ToolBtn id="files" icon="folder" label="Files" />
            <ToolBtn id="browser" icon="globe" label="Browser" />
          </div>
          {tab2 === 'chat' && <AgentTerminal session={sel} />}
          {tab2 === 'plan' && <PlanEditorPane session={sel} />}
          {tab2 === 'notes' && <NotesPane session={sel} />}
          {tab2 === 'browser' && <BrowserPane session={sel} bp={bp} wt={wt} />}
          {tab2 === 'files' && !showDiff &&
            <FilesTab wtKey={wtKey} diffCount={diffData.files.length}
              onShowDiff={() => setShowDiff(true)} />}
          {tab2 === 'files' && showDiff &&
            <DiffTab wtKey={wtKey} onBack={() => setShowDiff(false)} />}
        </> :

      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#fff', color: WC.muted, fontSize: 13
      }}>
          No agent running yet.
        </div>
      }
    </div>);

}

// Right-side worktree context column: frontends, worker containers, secrets.
// One agent per business process, so no session list lives here.
function WtSidebar({ wtKey, bp, automations }) {
  const { SecretsEditor } = window.WD_OVERLAYS;
  const [collapsed, setCollapsed] = useStateW(false);

  const wtAuts = automations && automations.length ?
  automations :
  window.WD_DATA.WORKTREE_AUTOMATIONS?.[wtKey] || [];
  const initialFrontends = wtAuts.
  filter((a) => typeof a.kind === 'string' && a.kind.startsWith('frontend')).
  map((a) => ({
    id: a.id, name: a.name, kind: a.kind,
    url: a.liveDev?.url,
    status: a.liveDev?.status || 'stopped'
  }));
  const [frontends, setFrontends] = useStateW(initialFrontends);
  React.useEffect(() => {setFrontends(initialFrontends);}, [wtKey]);
  const [renaming, setRenaming] = useStateW(null);

  const initialWorkers = wtAuts.
  filter((a) => typeof a.kind === 'string' &&
  !a.kind.startsWith('frontend') && a.kind !== 'tests').
  map((a) => ({ id: a.id, name: a.name, kind: a.kind, status: a.liveDev?.status || 'stopped' }));
  const [workers, setWorkers] = useStateW(initialWorkers);
  React.useEffect(() => {setWorkers(initialWorkers);}, [wtKey]);
  const [renamingWorker, setRenamingWorker] = useStateW(null);

  const [secretsOpen, setSecretsOpen] = useStateW(false);

  // Collapsed: thin rail with an expand button.
  if (collapsed) {
    return (
      <div style={{
        width: 44, background: '#fff', borderLeft: `1px solid ${WC.border}`,
        display: 'flex', flexDirection: 'column', alignItems: 'center', flex: '0 0 auto',
        paddingTop: 10, gap: 4
      }}>
        <button onClick={() => setCollapsed(false)} title="Expand panel" style={{
          width: 30, height: 30, border: `1px solid ${WC.border}`, borderRadius: 6,
          background: '#fff', color: WC.muted, cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center'
        }}><WIcon name="panel-right-open" size={15} /></button>
        <div style={{ width: 24, height: 1, background: WC.border, margin: '6px 0' }} />
        <WIcon name="layout" size={15} color={WC.mutedFg} style={{ marginTop: 6 }} />
        <WIcon name="boxes" size={15} color={WC.mutedFg} style={{ marginTop: 10 }} />
        <WIcon name="key-round" size={15} color={WC.mutedFg} style={{ marginTop: 10 }} />
      </div>);

  }

  const sectionHead = (icon, label, count) =>
  <div style={{
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 10, fontWeight: 600, color: WC.muted, letterSpacing: 0.5,
    textTransform: 'uppercase'
  }}>
      <WIcon name={icon} size={11} color={WC.mutedFg} />
      {label}
      {typeof count === 'number' &&
    <span style={{ marginLeft: 'auto', color: WC.mutedFg, fontWeight: 500, letterSpacing: 0 }}>{count}</span>}
    </div>;


  return (
    <div style={{
      width: 300, background: '#fff', borderLeft: `1px solid ${WC.border}`,
      display: 'flex', flexDirection: 'column', flex: '0 0 auto'
    }}>
      {/* Header with collapse */}
      <div style={{
        display: 'flex', alignItems: 'center', padding: '10px 12px',
        borderBottom: `1px solid ${WC.border}`
      }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: WC.muted, letterSpacing: 0.5,
          textTransform: 'uppercase', flex: 1 }}>Environment</span>
        <button onClick={() => setCollapsed(true)} title="Collapse panel" style={{
          width: 28, height: 28, border: `1px solid transparent`, borderRadius: 6,
          background: 'transparent', color: WC.muted, cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center'
        }}
        onMouseEnter={(e) => {e.currentTarget.style.background = WC.surface2;}}
        onMouseLeave={(e) => {e.currentTarget.style.background = 'transparent';}}>
          <WIcon name="panel-right-close" size={15} /></button>
      </div>

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0,
        display: 'flex', flexDirection: 'column' }}>
        {/* Frontends block */}
        <div style={{ padding: '12px 14px 12px', borderBottom: `1px solid ${WC.border}`,
          display: 'flex', flexDirection: 'column', gap: 6 }}>
          {sectionHead('layout', 'Frontends', frontends.length)}
          {frontends.length === 0 &&
          <div style={{ fontSize: 11, color: WC.muted, padding: '4px 0' }}>No frontends yet.</div>
          }
          {frontends.map((f) =>
          <FrontendRow key={f.id} frontend={f}
          renaming={renaming === f.id}
          onStartRename={() => setRenaming(f.id)}
          onRename={(name) => {setFrontends(frontends.map((x) => x.id === f.id ? { ...x, name } : x));setRenaming(null);}}
          onCancelRename={() => setRenaming(null)}
          onDelete={() => setFrontends(frontends.filter((x) => x.id !== f.id))} />
          )}
          <button
            onClick={() => {
              const id = `frontend-${Date.now()}`;
              setFrontends([...frontends, { id, name: 'new-frontend', kind: 'frontend-internal', url: null, status: 'stopped' }]);
              setRenaming(id);
            }}
            style={dashBtn}
            title="Add a new frontend container">
            <WIcon name="plus" size={13} />Add frontend</button>
        </div>

        {/* Worker containers block */}
        <div style={{ padding: '12px 14px 12px', borderBottom: `1px solid ${WC.border}`,
          display: 'flex', flexDirection: 'column', gap: 6 }}>
          {sectionHead('boxes', 'Worker containers', workers.length)}
          {workers.length === 0 &&
          <div style={{ fontSize: 11, color: WC.muted, padding: '4px 0' }}>No worker containers yet.</div>
          }
          {workers.map((w) =>
          <FrontendRow key={w.id} frontend={w}
          renaming={renamingWorker === w.id}
          onStartRename={() => setRenamingWorker(w.id)}
          onRename={(name) => {setWorkers(workers.map((x) => x.id === w.id ? { ...x, name } : x));setRenamingWorker(null);}}
          onCancelRename={() => setRenamingWorker(null)}
          onDelete={() => setWorkers(workers.filter((x) => x.id !== w.id))} />
          )}
          <button
            onClick={() => {
              const id = `worker-${Date.now()}`;
              setWorkers([...workers, { id, name: 'new-worker', kind: 'backend', status: 'stopped' }]);
              setRenamingWorker(id);
            }}
            style={dashBtn}
            title="Add a new worker container">
            <WIcon name="plus" size={13} />Add worker container</button>
        </div>

        {/* Secrets block — inline editable */}
        <div style={{ padding: '12px 14px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button onClick={() => setSecretsOpen((o) => !o)} style={{
            display: 'flex', alignItems: 'center', gap: 6, width: '100%',
            background: 'transparent', border: 0, padding: 0, cursor: 'pointer',
            fontSize: 10, fontWeight: 600, color: WC.muted, letterSpacing: 0.5,
            textTransform: 'uppercase', fontFamily: 'inherit'
          }}>
            <WIcon name="key-round" size={11} color={WC.mutedFg} />
            Dev secrets
            <WIcon name={secretsOpen ? 'chevron-up' : 'chevron-down'} size={13}
            color={WC.mutedFg} style={{ marginLeft: 'auto' }} />
          </button>
          {secretsOpen ?
          <SecretsEditor stageId="dev" bpName={bp?.name || wtKey.split(':')[0]} /> :
          <div style={{ fontSize: 11, color: WC.muted }}>
                Environment variables &amp; API keys for this worktree. Click to edit.
              </div>}
        </div>
      </div>
    </div>);

}

// Shared dashed "add" button style for sidebar sections.
const dashBtn = {
  marginTop: 4,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  height: 30, padding: '0 10px',
  background: '#fff', border: `1.5px dashed ${WC.borderHi}`, borderRadius: 6,
  color: WC.muted, fontSize: 12, fontWeight: 500, fontFamily: 'inherit',
  cursor: 'pointer'
};

// Row in the Frontends section: open button, inline rename, delete.
function FrontendRow({ frontend, renaming, onStartRename, onRename, onCancelRename, onDelete }) {
  const m = window.WD_DATA.KIND_META[frontend.kind] || { icon: 'globe', color: WC.muted };
  const [hover, setHover] = useStateW(false);
  const canOpen = !!frontend.url;
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '4px 6px', borderRadius: 6,
        background: hover ? WC.surface : 'transparent',
        transition: 'background 120ms'
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}>
      
      <WIcon name={m.icon} size={13} color={m.color} />
      {renaming ?
      <input
        autoFocus
        defaultValue={frontend.name}
        onBlur={(e) => onRename(e.target.value.trim() || frontend.name)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.target.blur();
          if (e.key === 'Escape') onCancelRename();
        }}
        style={{
          flex: 1, minWidth: 0,
          fontSize: 12, padding: '3px 6px',
          border: `1px solid ${WC.fg}`, borderRadius: 4,
          fontFamily: 'Geist Mono, ui-monospace, monospace'
        }} /> :


      <a
        href={canOpen ? frontend.url : undefined}
        target="_blank" rel="noreferrer"
        title={canOpen ? `Open ${frontend.url}` : `${frontend.name} — not running`}
        style={{
          flex: 1, minWidth: 0, fontSize: 12,
          fontFamily: 'Geist Mono, ui-monospace, monospace',
          color: canOpen ? WC.fg : WC.muted,
          textDecoration: 'none',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          cursor: canOpen ? 'pointer' : 'default',
          display: 'inline-flex', alignItems: 'center', gap: 4
        }}>
        
          {frontend.name}
          {canOpen && <WIcon name="external-link" size={10}
        style={{ opacity: 0.6, flexShrink: 0 }} />}
        </a>
      }
      <span style={{
        width: 5, height: 5, borderRadius: 9999, flex: '0 0 auto',
        background: frontend.status === 'running' ? '#16a34a' :
        frontend.status === 'failed' ? '#dc2626' :
        '#a1a1aa'
      }} />
      {!renaming &&
      <div style={{ display: 'flex', gap: 0, opacity: hover ? 1 : 0,
        transition: 'opacity 120ms' }}>
          <FrontendActionBtn icon="pencil" title="Rename"
        onClick={onStartRename} />
          <FrontendActionBtn icon="trash-2" title="Delete"
        onClick={() => {
          if (confirm(`Delete frontend "${frontend.name}"?`)) onDelete();
        }} />
        </div>
      }
    </div>);

}

function FrontendActionBtn({ icon, title, onClick }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 22, height: 22, padding: 0, border: 0, background: 'transparent',
        borderRadius: 4, cursor: 'pointer', color: WC.muted,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center'
      }}
      onMouseEnter={(e) => {e.currentTarget.style.background = WC.surface2;
        e.currentTarget.style.color = WC.fg;}}
      onMouseLeave={(e) => {e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = WC.muted;}}>
      
      <WIcon name={icon} size={11} />
    </button>);

}

// ─── Requirements tab ───────────────────────────────────────────────────────
const REQ_STATUS = {
  pass: { bg: '#dcfce7', fg: '#15803d', label: 'PASS' },
  review: { bg: '#fef3c7', fg: '#b45309', label: 'REVIEW' },
  todo: { bg: '#f1f5f9', fg: '#475569', label: 'TODO' },
  fail: { bg: '#fee2e2', fg: '#b91c1c', label: 'FAIL' }
};
const REQ_CYCLE = ['todo', 'review', 'pass', 'fail'];

function RequirementsTab({ wtKey, inline = false }) {
  const initial = window.WD_WT_DATA.WT_REQUIREMENTS[wtKey] || [];
  const [reqs, setReqs] = useStateW(initial);
  React.useEffect(() => {setReqs(window.WD_WT_DATA.WT_REQUIREMENTS[wtKey] || []);}, [wtKey]);
  const [selected, setSelected] = useStateW(initial[0]?.id);
  const [editing, setEditing] = useStateW(null);
  const [editingDetail, setEditingDetail] = useStateW(null);
  const [checked, setChecked] = useStateW(new Set());
  const [query, setQuery] = useStateW('');
  const [statusFilter, setStatusFilter] = useStateW('all');
  const [expanded, setExpanded] = useStateW(new Set(initial[0] ? [initial[0].id] : []));
  const [runAt, setRunAt] = useStateW({});
  React.useEffect(() => {setRunAt({});}, [wtKey]);

  const runTest = (id) => {
    setReqs((rs) => rs.map((r) => r.id === id ? { ...r, status: 'pass' } : r));
    setRunAt((m) => ({ ...m, [id]: 'just now' }));
  };

  const cycle = (id) => setReqs(reqs.map((r) => r.id === id ?
  { ...r, status: REQ_CYCLE[(REQ_CYCLE.indexOf(r.status) + 1) % REQ_CYCLE.length] } : r));
  const toggleCheck = (id) => {
    const next = new Set(checked);
    next.has(id) ? next.delete(id) : next.add(id);
    setChecked(next);
  };
  const toggleExpand = (id) => {
    const next = new Set(expanded);
    next.has(id) ? next.delete(id) : next.add(id);
    setExpanded(next);
  };

  const filtered = reqs.filter((r) => {
    const q = query.trim().toLowerCase();
    const matchQ = !q || r.id.toLowerCase().includes(q) || r.text.toLowerCase().includes(q) ||
    (r.detail || '').toLowerCase().includes(q);
    const matchS = statusFilter === 'all' || r.status === statusFilter;
    return matchQ && matchS;
  });
  const allChecked = filtered.length > 0 && filtered.every((r) => checked.has(r.id));
  const someChecked = filtered.some((r) => checked.has(r.id)) && !allChecked;
  const toggleAll = () => {
    const next = new Set(checked);
    if (allChecked) filtered.forEach((r) => next.delete(r.id));else
    filtered.forEach((r) => next.add(r.id));
    setChecked(next);
  };

  const counts = reqs.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});

  const runAllTests = () => {
    const ids = filtered.map((r) => r.id);
    setReqs((rs) => rs.map((r) => ids.includes(r.id) ? { ...r, status: 'pass' } : r));
    setRunAt((m) => {const next = { ...m };ids.forEach((id) => next[id] = 'just now');return next;});
  };

  // markdown-ish renderer
  const renderInline = (s) => s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <b key={i}>{p.slice(2, -2)}</b>;
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i} style={{
      background: '#f1f5f9', padding: '1px 5px', borderRadius: 2,
      fontFamily: 'Geist Mono, monospace', fontSize: 11
    }}>{p.slice(1, -1)}</code>;
    return p;
  });
  const renderDetail = (md) => {
    if (!md) return <i style={{ opacity: 0.5 }}>No detail yet — click Edit detail to add.</i>;
    const lines = md.split('\n');
    const blocks = [];let bullets = [];let bk = null;
    const flush = (k) => {if (bullets.length) {
        const Tag = bk === 'ol' ? 'ol' : 'ul';
        blocks.push(<Tag key={`b-${k}`} style={{ margin: '4px 0 10px 18px', padding: 0 }}>
        {bullets.map((b, i) => <li key={i} style={{ marginBottom: 3 }}>{renderInline(b)}</li>)}
      </Tag>);
        bullets = [];bk = null;
      }};
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('- ')) {if (bk === 'ol') flush(i);bk = 'ul';bullets.push(t.slice(2));} else
      if (/^\d+\.\s/.test(t)) {if (bk === 'ul') flush(i);bk = 'ol';bullets.push(t.replace(/^\d+\.\s/, ''));} else
      {flush(i);if (t) blocks.push(<p key={i} style={{ margin: '0 0 8px' }}>{renderInline(t)}</p>);}
    });
    flush('end');
    return blocks;
  };

  return (
    <div style={inline ?
    { background: WC.bg, padding: '20px 28px' } :
    { flex: 1, overflow: 'auto', background: WC.bg, padding: '20px 28px' }}>
      {/* Search + filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center' }}>
        <div style={{
          flex: 1, maxWidth: 380, height: 32, background: '#fff',
          border: `1px solid ${WC.border}`, borderRadius: 6,
          display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px'
        }}>
          <WIcon name="search" size={13} color={WC.mutedFg} />
          <input value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search requirements by ID, text, detail…"
          style={{ flex: 1, border: 0, outline: 0, fontSize: 12, fontFamily: 'inherit',
            background: 'transparent', color: WC.fg }} />
          {query &&
          <button onClick={() => setQuery('')} style={{
            background: 'transparent', border: 0, cursor: 'pointer',
            color: WC.muted, fontSize: 12, padding: 0
          }}>✕</button>
          }
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {['all', 'todo', 'review', 'pass', 'fail'].map((s) =>
          <button key={s} onClick={() => setStatusFilter(s)} style={{
            padding: '6px 10px', fontSize: 11, fontWeight: 500,
            border: `1px solid ${statusFilter === s ? WC.fg : WC.border}`,
            background: statusFilter === s ? WC.fg : '#fff',
            color: statusFilter === s ? '#fff' : WC.muted,
            borderRadius: 6, cursor: 'pointer', textTransform: 'capitalize', fontFamily: 'inherit'
          }}>{s}</button>
          )}
        </div>
        <span style={{ fontSize: 11, color: WC.muted, marginLeft: 'auto' }}>
          {filtered.length === reqs.length ? `${reqs.length} requirements` : `${filtered.length} of ${reqs.length}`}
        </span>
      </div>

      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 600, color: WC.fg, letterSpacing: -0.2 }}>Requirements &amp; tests</div>
          <div style={{ fontSize: 11, color: WC.muted, marginTop: 4 }}>
            {reqs.length} total · <b style={{ color: '#15803d' }}>{counts.pass || 0} pass</b> ·
            <b style={{ color: '#b45309' }}> {counts.review || 0} review</b> ·
            <b style={{ color: '#475569' }}> {counts.todo || 0} todo</b>
            {counts.fail ? <> · <b style={{ color: '#b91c1c' }}>{counts.fail} fail</b></> : null}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {checked.size > 0 &&
          <span style={{ fontSize: 11, color: WC.muted }}>{checked.size} selected</span>
          }
          <WBtn variant="default" size="sm" leftIcon="play"
          onClick={runAllTests}
          title="Run the test for every requirement shown">
            Run all tests
          </WBtn>
          <WBtn variant="default" size="sm" leftIcon="plus"
          onClick={() => {
            const nums = reqs.map((x) => parseInt((x.id.match(/REQ-(\d+)/) || [])[1] || '0', 10));
            const next = (Math.max(0, ...nums) + 1).toString().padStart(3, '0');
            const newId = `REQ-${next}`;
            const newReq = { id: newId, status: 'todo', text: 'New requirement', depth: 0, detail: '' };
            setReqs([...reqs, newReq]);setSelected(newId);setEditing(newId);
          }}>New requirement</WBtn>
          <WBtn variant="primary" size="sm" leftIcon="bot"
          style={{ opacity: checked.size === 0 ? 0.5 : 1 }}>
            Run agent on {checked.size > 0 ? `${checked.size} selected` : 'selected'}
          </WBtn>
        </div>
      </div>

      {/* Table */}
      <div style={{
        background: '#fff', border: `1px solid ${WC.border}`, borderRadius: 8, overflow: 'hidden'
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '8px 14px',
          fontSize: 10, fontWeight: 600, color: WC.muted, letterSpacing: 1,
          textTransform: 'uppercase', borderBottom: `1px solid ${WC.border}`, background: WC.surface
        }}>
          <span style={{ width: 22, display: 'flex', alignItems: 'center' }}>
            <input type="checkbox" checked={allChecked}
            ref={(el) => {if (el) el.indeterminate = someChecked;}}
            onChange={toggleAll}
            style={{ cursor: 'pointer', margin: 0 }} />
          </span>
          <span style={{ width: 14 }} />
          <span style={{ width: 70 }}>ID</span>
          <span style={{ width: 60 }}>Status</span>
          <span style={{ flex: 1 }}>Description</span>
          <span style={{ width: 80 }}>Last run</span>
          <span style={{ width: 78 }} />
        </div>

        {filtered.map((r) => {
          const isSel = selected === r.id;
          const isEdit = editing === r.id;
          const isExp = expanded.has(r.id);
          const s = REQ_STATUS[r.status];
          return (
            <React.Fragment key={r.id}>
              <div onClick={() => {setSelected(r.id);toggleExpand(r.id);}} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 14px', paddingLeft: 14 + (r.depth || 0) * 18,
                borderBottom: isExp ? 'none' : `1px solid ${WC.border}`,
                background: isSel ? WC.surface : 'transparent',
                borderLeft: `3px solid ${isSel ? WC.fg : 'transparent'}`,
                cursor: 'pointer'
              }}>
                <span style={{ width: 22, display: 'flex', alignItems: 'center' }}
                onClick={(e) => {e.stopPropagation();toggleCheck(r.id);}}>
                  <input type="checkbox" checked={checked.has(r.id)}
                  onChange={() => toggleCheck(r.id)}
                  onClick={(e) => e.stopPropagation()}
                  style={{ cursor: 'pointer', margin: 0 }} />
                </span>
                <span style={{ width: 14, color: WC.mutedFg, fontSize: 9,
                  transform: isExp ? 'rotate(90deg)' : 'none',
                  transition: 'transform 0.15s', display: 'inline-block' }}>▶</span>
                <span style={{ width: 70, fontFamily: 'Geist Mono, monospace',
                  fontSize: 11, fontWeight: 600, color: WC.fg }}>{r.id}</span>
                <span onClick={(e) => {e.stopPropagation();cycle(r.id);}}
                style={{ width: 60, cursor: 'pointer' }}>
                  <span style={{
                    display: 'inline-block', padding: '2px 6px', borderRadius: 3,
                    background: s.bg, color: s.fg, fontSize: 9, fontWeight: 700
                  }}>{s.label}</span>
                </span>
                {isEdit ?
                <input autoFocus defaultValue={r.text}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {setReqs(reqs.map((x) => x.id === r.id ? { ...x, text: e.target.value } : x));setEditing(null);}}
                onKeyDown={(e) => {if (e.key === 'Enter') e.target.blur();if (e.key === 'Escape') setEditing(null);}}
                style={{ flex: 1, fontSize: 12, padding: '4px 6px',
                  border: `1px solid ${WC.fg}`, borderRadius: 3, fontFamily: 'inherit' }} /> :

                <span style={{ flex: 1, fontSize: 12, lineHeight: 1.5,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                onDoubleClick={(e) => {e.stopPropagation();setEditing(r.id);}}>
                    {r.text}
                  </span>
                }
                <span style={{ width: 80, fontSize: 11, color: WC.muted }}>
                  {runAt[r.id] || (r.status === 'pass' ? '12m ago' : r.status === 'review' ? '1m ago' : '—')}
                </span>
                <span style={{ width: 78, textAlign: 'right', display: 'flex', gap: 2,
                  justifyContent: 'flex-end' }}>
                  <button onClick={(e) => {e.stopPropagation();runTest(r.id);}}
                  title="Run test for this requirement" style={{
                    background: 'transparent', border: 0, cursor: 'pointer',
                    color: WC.green, fontSize: 13, padding: '2px 6px'
                  }}><WIcon name="play" size={12} /></button>
                  <button onClick={(e) => {e.stopPropagation();setEditing(r.id);}}
                  title="Rename" style={{
                    background: 'transparent', border: 0, cursor: 'pointer',
                    color: WC.muted, fontSize: 13, padding: '2px 6px'
                  }}><WIcon name="pencil" size={12} /></button>
                </span>
              </div>
              {isExp &&
              <div style={{
                padding: `12px 18px 16px ${14 + (r.depth || 0) * 18 + 22 + 14 + 12}px`,
                background: WC.surface, borderBottom: `1px solid ${WC.border}`,
                fontSize: 12, lineHeight: 1.6, color: '#3f3f46'
              }}>
                  {editingDetail === r.id ?
                <div onClick={(e) => e.stopPropagation()}>
                      <textarea autoFocus defaultValue={r.detail || ''}
                  onBlur={(e) => {setReqs(reqs.map((x) => x.id === r.id ? { ...x, detail: e.target.value } : x));setEditingDetail(null);}}
                  onKeyDown={(e) => {if (e.key === 'Escape') setEditingDetail(null);
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.target.blur();}}
                  placeholder="Markdown detail — supports **bold**, `code`, - bullets, 1. numbered…"
                  style={{
                    width: '100%', minHeight: 120, padding: 10,
                    border: `1px solid ${WC.fg}`, borderRadius: 4,
                    fontSize: 12, lineHeight: 1.6, fontFamily: 'Geist Mono, monospace',
                    background: '#fff', resize: 'vertical', outline: 'none'
                  }} />
                    </div> :

                <>
                      {renderDetail(r.detail)}
                      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                        <WBtn variant="ghost" size="xs" leftIcon="pencil"
                    onClick={(e) => {e.stopPropagation();setEditingDetail(r.id);}}>
                          Edit detail
                        </WBtn>
                        <WBtn variant="ghost" size="xs" leftIcon="plus">Add child</WBtn>
                        <WBtn variant="ghost" size="xs" leftIcon="bot">Run agent on this</WBtn>
                      </div>
                    </>
                }
                </div>
              }
            </React.Fragment>);

        })}

        {filtered.length === 0 &&
        <div style={{ padding: '40px 20px', textAlign: 'center', color: WC.muted, fontSize: 13 }}>
            No requirements match your filter.
          </div>
        }
      </div>
    </div>);

}

// ─── Files tab ──────────────────────────────────────────────────────────────
function FileTreeRow({ node, depth, openPath, onOpen, path, selectedPaths, onToggleSelect }) {
  const [open, setOpen] = useStateW(!!node.open);
  const fullPath = path ? `${path}/${node.name}` : node.name;
  if (node.kind === 'folder') {
    return (
      <>
        <button onClick={() => setOpen(!open)} style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
          padding: `3px 8px 3px ${8 + depth * 14}px`,
          background: 'transparent', border: 0, color: WC.fg, fontSize: 12,
          cursor: 'pointer', fontFamily: 'inherit', height: 24
        }}>
          <WIcon name={open ? 'chevron-down' : 'chevron-right'} size={11} color={WC.mutedFg} />
          <WIcon name={open ? 'folder-open' : 'folder'} size={13}
          color={open ? WC.primary : WC.muted} />
          <span>{node.name}</span>
        </button>
        {open && node.children && node.children.map((c) =>
        <FileTreeRow key={c.name} node={c} depth={depth + 1}
        openPath={openPath} onOpen={onOpen} path={fullPath}
        selectedPaths={selectedPaths} onToggleSelect={onToggleSelect} />
        )}
      </>);

  }
  const active = openPath === fullPath;
  const checked = selectedPaths && selectedPaths.has(fullPath);
  const cTone = node.changed === 'A' ? WC.green :
  node.changed === 'M' ? WC.amber :
  node.changed === 'D' ? WC.red : WC.muted;
  return (
    <div className="wd-file-row"
    style={{
      display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
      padding: `3px 8px 3px ${8 + depth * 14}px`,
      background: active ? WC.surface2 : 'transparent',
      color: active ? WC.fg : '#3f3f46', fontSize: 12,
      fontFamily: 'inherit', height: 24, cursor: 'pointer',
      borderLeft: active ? `2px solid ${WC.fg}` : '2px solid transparent'
    }}
    onClick={() => onOpen(fullPath)}>
      <input
        type="checkbox"
        checked={!!checked}
        onChange={() => onToggleSelect(fullPath)}
        onClick={(e) => e.stopPropagation()}
        title="Select for agent reference"
        className="wd-file-check"
        style={{
          margin: 0, width: 13, height: 13, cursor: 'pointer',
          opacity: checked ? 1 : undefined,
          accentColor: WC.primary
        }} />
      
      <WIcon name="file" size={12} color={WC.mutedFg} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {node.name}
      </span>
      {node.changed &&
      <span style={{
        fontSize: 10, fontWeight: 700, color: cTone,
        fontFamily: 'Geist Mono, monospace'
      }}>{node.changed}</span>
      }
    </div>);

}

function FilesTab({ wtKey, diffCount = 0, onShowDiff }) {
  const data = window.WD_WT_DATA.WT_FILES[wtKey] || {
    tree: [], open: null, contents: {}
  };
  const [openPath, setOpenPath] = useStateW(data.open);
  const [selected, setSelected] = useStateW(new Set());
  const [textSel, setTextSel] = useStateW(null); // { from, to } 1-indexed or null
  const [toast, setToast] = useStateW(null);
  const preRef = React.useRef(null);

  React.useEffect(() => {
    setOpenPath(data.open);
    setSelected(new Set());
    setTextSel(null);
  }, [wtKey]);

  React.useEffect(() => {setTextSel(null);}, [openPath]);

  const content = data.contents[openPath] || (openPath ? `// ${openPath}\n// (file contents not loaded)\n` : '');
  const lines = content.split('\n');

  const toggleSelect = (p) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(p) ? next.delete(p) : next.add(p);
      return next;
    });
  };

  const formatRef = (path, range) => {
    if (range) return `@${path}:${range.from === range.to ? range.from : `${range.from}-${range.to}`}`;
    return `@${path}`;
  };

  const copyToClipboard = async (text) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      }
    } catch (e) {}
    setToast(text.length > 60 ? text.slice(0, 60) + '…' : text);
    setTimeout(() => setToast(null), 1800);
  };

  const copySelectedFiles = () => {
    if (selected.size === 0) return;
    const refs = [...selected].map((p) => formatRef(p, null)).join('\n');
    copyToClipboard(refs);
  };

  const copyOpenFile = () => {
    if (!openPath) return;
    copyToClipboard(formatRef(openPath, textSel));
  };

  // Compute selection line range when user releases mouse over the <pre>
  const handleSelectionChange = () => {
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || !preRef.current) {setTextSel(null);return;}
    const range = sel.getRangeAt(0);
    if (!preRef.current.contains(range.commonAncestorContainer)) {setTextSel(null);return;}
    const pre = preRef.current;
    const fullText = pre.textContent || '';
    // Build a fresh range from start of <pre> to the selection start to count newlines.
    const startWalker = document.createRange();
    startWalker.setStart(pre, 0);
    startWalker.setEnd(range.startContainer, range.startOffset);
    const before = startWalker.toString();
    const endWalker = document.createRange();
    endWalker.setStart(pre, 0);
    endWalker.setEnd(range.endContainer, range.endOffset);
    const beforeEnd = endWalker.toString();
    const from = (before.match(/\n/g) || []).length + 1;
    const to = (beforeEnd.match(/\n/g) || []).length + 1;
    setTextSel({ from, to });
  };

  return (
    <div style={{ flex: 1, overflow: 'hidden', display: 'flex', background: WC.bg, position: 'relative' }}>
      <div style={{
        width: 280, background: '#fff', borderRight: `1px solid ${WC.border}`,
        display: 'flex', flexDirection: 'column'
      }}>
        <div style={{
          padding: '10px 12px', borderBottom: `1px solid ${WC.border}`,
          fontSize: 10, fontWeight: 600, color: WC.muted, letterSpacing: 0.5,
          textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 6
        }}>
          <span style={{ flex: 1 }}>Explorer</span>
          {diffCount > 0 &&
          <button
            onClick={onShowDiff}
            title={`View diff — ${diffCount} changed file${diffCount === 1 ? '' : 's'}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              height: 24, padding: '0 8px',
              background: WC.surface2, color: WC.fg,
              border: `1px solid ${WC.border}`, borderRadius: 6,
              fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
              textTransform: 'uppercase', fontFamily: 'inherit',
              cursor: 'pointer'
            }}>
            
              <WIcon name="git-pull-request" size={11} />
              Diff
              <span style={{
              padding: '1px 5px', borderRadius: 9999,
              background: '#fff', color: WC.muted,
              fontSize: 9, fontWeight: 700,
              border: `1px solid ${WC.border}`
            }}>{diffCount}</span>
            </button>
          }
          <WBtn variant="ghost" size="xs" leftIcon="plus" />
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '6px 0' }}>
          {data.tree.map((n) =>
          <FileTreeRow key={n.name} node={n} depth={0}
          openPath={openPath} onOpen={setOpenPath} path=""
          selectedPaths={selected} onToggleSelect={toggleSelect} />
          )}
        </div>

        {/* Selection action bar */}
        {selected.size > 0 &&
        <div style={{
          padding: '10px 12px', borderTop: `1px solid ${WC.border}`,
          background: WC.surface,
          display: 'flex', flexDirection: 'column', gap: 8
        }}>
            <div style={{ fontSize: 11, color: WC.fg, display: 'flex', alignItems: 'center', gap: 6 }}>
              <WIcon name="check-square" size={12} color={WC.primary} />
              <b>{selected.size}</b> file{selected.size === 1 ? '' : 's'} selected
              <button onClick={() => setSelected(new Set())} title="Clear selection"
            style={{
              marginLeft: 'auto', background: 'transparent', border: 0,
              color: WC.muted, cursor: 'pointer', fontSize: 11, padding: 0
            }}>
                clear
              </button>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <WBtn variant="default" size="xs" leftIcon="copy"
            style={{ flex: 1 }} onClick={copySelectedFiles}>
                Copy reference
              </WBtn>
              <WBtn variant="primary" size="xs" leftIcon="bot"
            style={{ flex: 1 }} onClick={() => {
              copySelectedFiles();
              setToast('Sent to agent — ' + selected.size + ' file(s)');
            }}>
                Send to chat
              </WBtn>
            </div>
          </div>
        }
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#fff', minWidth: 0 }}>
        <div style={{
          minHeight: 38, borderBottom: `1px solid ${WC.border}`, background: WC.surface,
          display: 'flex', alignItems: 'center', padding: '0 14px', gap: 10,
          fontSize: 12, color: WC.muted, fontFamily: 'Geist Mono, monospace'
        }}>
          <WIcon name="file" size={12} color={WC.mutedFg} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {openPath || 'No file open'}
          </span>
          <span style={{ fontSize: 10 }}>· {lines.length} lines</span>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {textSel &&
            <span style={{ fontSize: 11, color: WC.primary, fontWeight: 500,
              fontFamily: 'Geist Mono, monospace' }}>
                {textSel.from === textSel.to ?
              `L${textSel.from} selected` :
              `L${textSel.from}–L${textSel.to} selected`}
              </span>
            }
            <WBtn variant="default" size="xs" leftIcon="copy"
            onClick={copyOpenFile}
            disabled={!openPath}
            title="Copy a reference the agent can resolve"
            style={{ fontFamily: 'inherit' }}>
              {textSel ? 'Copy reference (range)' : 'Copy file reference'}
            </WBtn>
          </div>
        </div>

        <div style={{
          flex: 1, overflow: 'auto', display: 'flex',
          fontFamily: 'Geist Mono, monospace', fontSize: 12.5, lineHeight: '19px',
          position: 'relative'
        }}>
          <div style={{
            padding: '12px 8px 12px 14px', color: WC.mutedFg, textAlign: 'right',
            background: WC.surface, borderRight: `1px solid ${WC.border}`, userSelect: 'none'
          }}>
            {lines.map((_, i) => {
              const inRange = textSel && i + 1 >= textSel.from && i + 1 <= textSel.to;
              return (
                <div key={i} style={{
                  color: inRange ? WC.primary : WC.mutedFg,
                  fontWeight: inRange ? 600 : 400
                }}>{i + 1}</div>);

            })}
          </div>
          <pre
            ref={preRef}
            onMouseUp={handleSelectionChange}
            onKeyUp={handleSelectionChange}
            style={{
              margin: 0, padding: '12px 16px', flex: 1, color: WC.fg,
              whiteSpace: 'pre', overflow: 'auto'
            }}>{content}</pre>
        </div>
      </div>

      {/* Toast */}
      {toast &&
      <div style={{
        position: 'absolute', bottom: 18, left: '50%', transform: 'translateX(-50%)',
        background: '#0f172a', color: '#fff', borderRadius: 8, padding: '8px 14px',
        fontSize: 12, fontFamily: 'Geist Mono, monospace',
        boxShadow: '0 10px 25px rgba(0,0,0,0.2)',
        display: 'flex', alignItems: 'center', gap: 8, zIndex: 20,
        maxWidth: '80%'
      }}>
          <WIcon name="check" size={13} color="#86efac" />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Copied · <span style={{ color: '#cbd5e1' }}>{toast}</span>
          </span>
        </div>
      }

      <style>{`
        .wd-file-row:hover { background: ${WC.surface}; }
        .wd-file-row .wd-file-check { opacity: 0.55; }
        .wd-file-row:hover .wd-file-check,
        .wd-file-row .wd-file-check:checked { opacity: 1; }
      `}</style>
    </div>);

}

// ─── Diff tab ───────────────────────────────────────────────────────────────
function DiffFileRow({ f, active, onClick }) {
  const tone = f.kind === 'A' ? WC.green : f.kind === 'D' ? WC.red : WC.amber;
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
      padding: '8px 12px', background: active ? WC.surface2 : 'transparent',
      border: 0, borderBottom: `1px solid ${WC.border}`,
      borderLeft: active ? `2px solid ${WC.fg}` : '2px solid transparent',
      cursor: 'pointer', fontFamily: 'inherit', minHeight: 48
    }}>
      <span style={{
        fontSize: 10, fontWeight: 700, color: tone, fontFamily: 'Geist Mono, monospace',
        background: tone + '18', padding: '2px 5px', borderRadius: 3, flexShrink: 0
      }}>{f.kind}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 12, color: WC.fg, fontFamily: 'Geist Mono, monospace',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl',
          textAlign: 'left'
        }}>{f.path}</div>
        <div style={{ fontSize: 10, color: WC.muted, fontFamily: 'Geist Mono, monospace', marginTop: 1 }}>
          <span style={{ color: WC.green }}>+{f.adds}</span>
          <span style={{ margin: '0 4px', color: WC.muted }}>·</span>
          <span style={{ color: WC.red }}>−{f.dels}</span>
        </div>
      </div>
    </button>);

}

function DiffView({ diff }) {
  if (!diff) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#fff', color: WC.muted, fontSize: 13
      }}>
        Select a file to see its diff.
      </div>);

  }
  const lines = diff.split('\n');
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', background: '#fff',
      overflow: 'hidden'
    }}>
      <div style={{
        padding: '10px 16px', borderBottom: `1px solid ${WC.border}`,
        fontSize: 11, color: WC.muted, fontFamily: 'Geist Mono, monospace',
        background: WC.surface
      }}>
        Unified diff · vs <span style={{ color: WC.fg, fontWeight: 600 }}>main</span>
      </div>
      <div style={{
        flex: 1, overflow: 'auto', padding: '10px 0',
        fontFamily: 'Geist Mono, monospace', fontSize: 12.5, lineHeight: '18px'
      }}>
        {lines.map((l, i) => {
          let bg = 'transparent',fg = WC.fg;
          if (l.startsWith('+++') || l.startsWith('---')) {fg = WC.muted;} else
          if (l.startsWith('@@')) {bg = '#f1f5f9';fg = '#3b82f6';} else
          if (l.startsWith('+')) {bg = '#dcfce7';fg = '#15803d';} else
          if (l.startsWith('-')) {bg = '#fee2e2';fg = '#b91c1c';}
          return (
            <div key={i} style={{
              padding: '0 16px', background: bg, color: fg, whiteSpace: 'pre'
            }}>{l || ' '}</div>);

        })}
      </div>
    </div>);

}

function DiffTab({ wtKey, onBack }) {
  const data = window.WD_WT_DATA.WT_DIFFS[wtKey] || { files: [], selected: null, diff: '' };
  const [sel, setSel] = useStateW(data.selected);
  React.useEffect(() => {setSel(data.selected);}, [wtKey]);
  // For demo — show same diff regardless; in real app fetch per-file.
  const showDiff = sel ? data.diff : '';
  return (
    <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: WC.bg }}>
      {onBack &&
      <div style={{
        padding: '10px 14px', borderBottom: `1px solid ${WC.border}`, background: '#fff',
        display: 'flex', alignItems: 'center', gap: 10
      }}>
          <button onClick={onBack} style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          height: 28, padding: '0 10px',
          background: '#fff', border: `1px solid ${WC.border}`, borderRadius: 6,
          fontSize: 12, fontWeight: 500, color: WC.fg, fontFamily: 'inherit',
          cursor: 'pointer'
        }}>
            <WIcon name="arrow-left" size={13} />
            Back to files
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <WIcon name="git-pull-request" size={13} color={WC.muted} />
            <span style={{ fontSize: 13, fontWeight: 600, color: WC.fg }}>Diff</span>
            <span style={{ fontSize: 11, color: WC.muted }}>
              · {data.files.length} changed file{data.files.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>
      }
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <div style={{
          width: 340, background: '#fff', borderRight: `1px solid ${WC.border}`,
          display: 'flex', flexDirection: 'column'
        }}>
        <div style={{
            padding: '10px 14px', borderBottom: `1px solid ${WC.border}`,
            display: 'flex', flexDirection: 'column', gap: 2
          }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: WC.muted, letterSpacing: 0.5,
              textTransform: 'uppercase' }}>Changed files</div>
          <div style={{ fontSize: 11, color: WC.muted, fontFamily: 'Geist Mono, monospace' }}>
            {data.files.length} files ·
            <span style={{ color: WC.green, marginLeft: 4 }}>+{data.files.reduce((a, f) => a + f.adds, 0)}</span>
            <span style={{ margin: '0 4px' }}>·</span>
            <span style={{ color: WC.red }}>−{data.files.reduce((a, f) => a + f.dels, 0)}</span>
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {data.files.map((f) =>
            <DiffFileRow key={f.path} f={f}
            active={f.path === sel} onClick={() => setSel(f.path)} />
            )}
        </div>
      </div>
      <DiffView diff={showDiff} />
      </div>
    </div>);

}

// ─── WorktreeView (header + tabs) ───────────────────────────────────────────
function WorktreeView({ bp, wt, density = 'comfortable', tab: tabProp, onTab, specEditKey = 0 }) {
  WuseLucide();
  const wtKey = `${bp.id}:${wt.id}`;
  const automations = window.WD_DATA.WORKTREE_AUTOMATIONS[wtKey] || [];
  const readme = window.WD_DATA.READMES[bp.id];
  const reqs = window.WD_WT_DATA.WT_REQUIREMENTS[wtKey] || [];
  const sessions = window.WD_WT_DATA.WT_AGENT_SESSIONS[wtKey] || [];
  const diffData = window.WD_WT_DATA.WT_DIFFS[wtKey] || { files: [] };

  // Tab is controlled by the parent (lives in the TopBar flow), with a local
  // fallback so the component still works standalone.
  const [tabLocal, setTabLocal] = useStateW('agents');
  const tab = tabProp != null ? tabProp : tabLocal;
  const setTab = onTab || setTabLocal;
  const [showDiff, setShowDiff] = useStateW(false);
  React.useEffect(() => {setShowDiff(false);}, [tab, wtKey]);

  // Lifted session state — sidebar drives Agents tab selection.
  const [selId, setSelId] = useStateW(sessions[0]?.id);
  const [subtab, setSubtab] = useStateW('chat');
  React.useEffect(() => {setSelId(sessions[0]?.id);setSubtab('chat');}, [wtKey]);
  React.useEffect(() => {setSubtab('chat');}, [selId]);

  const [configAut, setConfigAut] = useStateW(null);
  const [inspectAut, setInspectAut] = useStateW(null);
  const { ConfigureOverlay, InspectOverlay } = window.WD_OVERLAYS;

  return (
    <div style={{
      flex: 1, overflow: 'hidden', background: WC.bg,
      display: 'flex'
    }}>
      {/* Main content area — driven by selected tab */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {tab === 'specification' && <SpecificationTab readme={readme} density={density} bpName={bp.name} editNameKey={specEditKey} onBuild={() => setTab('agents')} />}
        {tab === 'requirements' && <RequirementsTab wtKey={wtKey} />}
        {tab === 'sync-deploy' && <SyncDeployTab wtKey={wtKey} wt={wt} bp={bp} />}
        {tab === 'agents' && <AgentsTab wtKey={wtKey} bp={bp} wt={wt}
        automations={automations} />}
        {tab === 'files' && !showDiff &&
        <FilesTab wtKey={wtKey}
        diffCount={diffData.files.length}
        onShowDiff={() => setShowDiff(true)} />
        }
        {tab === 'files' && showDiff &&
        <DiffTab wtKey={wtKey} onBack={() => setShowDiff(false)} />
        }
      </div>

      {/* Right sidebar — only on the Agents tab */}
      {tab === 'agents' &&
      <WtSidebar
        wtKey={wtKey}
        bp={bp}
        automations={automations} />

      }

      <ConfigureOverlay open={!!configAut} aut={configAut} mode="liveDev" onClose={() => setConfigAut(null)} />
      <InspectOverlay open={!!inspectAut} aut={inspectAut} mode="liveDev" onClose={() => setInspectAut(null)} />
    </div>);

}

window.WD_WORKTREE = { WorktreeView };