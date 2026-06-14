// app.jsx — wires the variants into a design canvas

const { Sidebar: AppSidebar, TopBar: AppTopBar, C: AC } = window.WD_SHELL;
const { DeploymentsView } = window.WD_DEPLOYMENTS;
const { WorktreeView } = window.WD_WORKTREE;

// One workspace frame configurable per artboard
function WorkspaceFrame({
  initialBpId = 'hr-module',
  initialScope = { type: 'deployments' },
  initialWtTab = 'agents',
  layout = 'horizontal',
  density = 'comfortable',
  sidebarWidth = 260,
  readmeHidden = false,
  width = 1280,
  height = 820,
}) {
  const [bpId, setBpId] = React.useState(initialBpId);
  const [scope, setScope] = React.useState(initialScope);
  const [wtTab, setWtTab] = React.useState(initialWtTab);
  const [specEditKey, setSpecEditKey] = React.useState(0);

  const bp = window.WD_DATA.BUSINESS_PROCESSES.find(b => b.id === bpId)
    || window.WD_DATA.BUSINESS_PROCESSES[0];
  const worktrees = window.WD_DATA.WORKTREES_BY_BP[bp.id] || [];
  const wt = scope.type === 'worktree' ? worktrees.find(w => w.id === scope.id) : null;

  function handleSelectBp(newId) {
    setBpId(newId);
    const newWts = window.WD_DATA.WORKTREES_BY_BP[newId] || [];
    if (scope.type === 'worktree') {
      if (newWts.length > 0) setScope({ type: 'worktree', id: newWts[0].id });
      else setScope({ type: 'deployments' });
    }
  }

  function handleNewBp() {
    const user = (window.WD_DATA.CURRENT_USER?.name || 'user').toLowerCase();
    const base = `${user}s-business-process`;
    const n = window.WD_DATA.BUSINESS_PROCESSES.filter(b => b.id.startsWith(base)).length + 1;
    const id = `${base}-${n}`;
    const name = `${user}'s-business-process-${n}`;
    window.WD_DATA.BUSINESS_PROCESSES.push({ id, name });
    window.WD_DATA.WORKTREES_BY_BP[id] = [
      { id: user, name: user, synced: true, ahead: 0, behind: 0, mine: true },
    ];
    setBpId(id);
    setScope({ type: 'worktree', id: user });
    setWtTab('specification');
    setSpecEditKey(k => k + 1);  // tell the spec tab to enter name-edit mode
  }

  return (
    <div style={{
      width, height, background: AC.bg,
      display:'flex', flexDirection:'column', overflow:'hidden',
      fontFamily:"Inter, ui-sans-serif, system-ui, sans-serif", color: AC.fg,
    }}>
      <AppTopBar scope={scope} onScope={setScope} worktrees={worktrees}
                 activeBpId={bp.id} onSelectBp={handleSelectBp} onNewBp={handleNewBp}
                 wtTab={wtTab} onWtTab={setWtTab} activeWt={wt}/>
      <div style={{flex:1, minHeight:0, display:'flex', overflow:'hidden'}}>
        <div style={{flex:1, minWidth:0, minHeight:0, display:'flex', flexDirection:'column'}}>
          {scope.type === 'deployments'
            ? <DeploymentsView bp={bp} layout={layout}
                               density={density} readmeHidden={readmeHidden}/>
            : wt && <WorktreeView bp={bp} wt={wt} density={density}
                                  tab={wtTab} onTab={setWtTab} specEditKey={specEditKey}/>}
        </div>
      </div>
    </div>
  );
}

// little helper: render the worktree view but force a specific tab via a key trick
function WorktreeFrameWithTab({ bpId='hr-module', wtId='tomas', tab='agents',
                               openDiff=false, width=1280, height=820 }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!openDiff || !ref.current) return;
    const t = setTimeout(() => {
      const allBtns = ref.current.querySelectorAll('button');
      for (const b of allBtns) {
        const txt = (b.textContent || '').trim();
        if (/^Diff\b/i.test(txt) && b.title && b.title.toLowerCase().includes('view diff')) {
          b.click(); break;
        }
      }
    }, 120);
    return () => clearTimeout(t);
  }, [openDiff]);
  return (
    <div ref={ref} style={{width, height}}>
      <WorkspaceFrame
        initialBpId={bpId}
        initialScope={{ type:'worktree', id: wtId }}
        initialWtTab={openDiff ? 'files' : tab}
        width={width} height={height}/>
    </div>
  );
}

// Helper: deployments view, but jump to the Automation tab on mount.
function DeploymentsAutomationFrame({ bpId='hr-module', layout='row', width=1280, height=820 }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!ref.current) return;
    const t = setTimeout(() => {
      const buttons = ref.current.querySelectorAll('button');
      for (const b of buttons) {
        if ((b.textContent || '').trim() === 'Automation') { b.click(); break; }
      }
    }, 60);
    return () => clearTimeout(t);
  }, []);
  return (
    <div ref={ref} style={{width, height}}>
      <WorkspaceFrame
        initialBpId={bpId}
        initialScope={{ type:'deployments' }}
        layout={layout} width={width} height={height}/>
    </div>
  );
}

function App() {
  React.useEffect(() => { if (window.lucide) window.lucide.createIcons(); });
  React.useEffect(() => {
    const id = setInterval(() => window.lucide && window.lucide.createIcons(), 500);
    return () => clearInterval(id);
  }, []);

  const W = 1280, H = 820;

  return (
    <DesignCanvas title="Workspace Dashboard"
                  subtitle="Deployments + worktree views, shadcn/ui (New York). Drag artboards to reorder · click ⤢ to focus.">

      <DCSection id="worktree-tabs" title="Worktree — tabbed (latest)"
                 description="Tabs: Agents · Specification · Requirements · Files. Agents is the default; the frontends manager + dev-secrets button live in its sidebar.">
        <DCArtboard id="wt-spec" label="Specification — markdown editor + Build automation"
                    width={W} height={H}>
          <WorktreeFrameWithTab tab="specification" width={W} height={H}/>
        </DCArtboard>
        <DCArtboard id="wt-agents" label="Agents — session list + claude terminal"
                    width={W} height={H}>
          <WorktreeFrameWithTab tab="agents" width={W} height={H}/>
        </DCArtboard>
        <DCArtboard id="wt-reqs" label="Requirements — table with editable rows"
                    width={W} height={H}>
          <WorktreeFrameWithTab tab="requirements" width={W} height={H}/>
        </DCArtboard>
        <DCArtboard id="wt-files" label="Files — explorer + opened file"
                    width={W} height={H}>
          <WorktreeFrameWithTab tab="files" width={W} height={H}/>
        </DCArtboard>
        <DCArtboard id="wt-diff" label="Diff — opened from Files tab"
                    width={W} height={H}>
          <WorktreeFrameWithTab tab="files" openDiff width={W} height={H}/>
        </DCArtboard>
      </DCSection>

      <DCSection id="deployments" title="Deployments view"
                 description="The other half of the workspace — manages dev/staging/production for the whole business process. Single-page layout: promotion strip · specification · testable requirements.">
        <DCArtboard id="dep-automation-row" label="Deployments — promotion strip + spec + requirements"
                    width={W} height={H}>
          <WorkspaceFrame initialScope={{ type:'deployments' }}
                          width={W} height={H}/>
        </DCArtboard>
      </DCSection>

    </DesignCanvas>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
