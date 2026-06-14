// console-app.jsx — server console shell: nav, router, scene switching, state

const { C: AC, Icon: AIcon, Btn: ABtn, Pill: APill, useLucide: useALucide } = window.WD_SHELL;
const { Avatar: AAvatar, Toast: AToast } = window.SC_UI;
const { OverviewView, WorkspacesView } = window.SC_WORKSPACES;
const { UsersView, ApprovalsView } = window.SC_PEOPLE;
const { DevicesView, SecurityView } = window.SC_DEVICES;
const { BootstrapScene, ApprovalScene, RecoveryScene } = window.SC_SCENES;
const { useState: useA, useEffect: useAE, useRef: useAR } = React;

// deep-ish clone of the seed data so mutations don't touch the source
function seedData() {
  const D = window.SC_DATA;
  return {
    workspaces: D.WORKSPACES.map(w => ({ ...w, members: [...w.members] })),
    users: D.USERS.map(u => ({ ...u })),
    myDevices: D.MY_DEVICES.map(d => ({ ...d })),
    pending: D.PENDING_DEVICES.map(p => ({ ...p })),
    recovery: { ...D.RECOVERY, recoveryCodes: [...D.RECOVERY.recoveryCodes] },
    userDevices: Object.fromEntries(Object.entries(D.USER_DEVICES).map(([k, v]) => [k, v.map(d => ({ ...d }))])),
  };
}

const NAV = [
  { group: 'Workspace', items: [
    { id: 'workspaces', label: 'Workspaces', icon: 'layout-grid' },
  ]},
  { group: 'Your account', items: [
    { id: 'devices',  label: 'Your devices',        icon: 'laptop' },
    { id: 'security', label: 'Security & recovery', icon: 'key-round' },
  ]},
  { group: 'Admin', items: [
    { id: 'overview',  label: 'Server overview',  icon: 'gauge' },
    { id: 'users',     label: 'People & roles',   icon: 'users' },
    { id: 'approvals', label: 'Device approvals', icon: 'shield-check', badge: 'pending' },
  ]},
];

function NavItem({ item, active, badge, onClick }) {
  const [h, setH] = useA(false);
  return (
    <button onClick={onClick} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)} style={{
      display: 'flex', alignItems: 'center', gap: 10, width: '100%', height: 36, padding: '0 10px',
      border: 0, borderRadius: 8, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', fontSize: 13.5,
      background: active ? '#fff' : (h ? AC.surface2 : 'transparent'),
      boxShadow: active ? `inset 0 0 0 1px ${AC.border}, 0 1px 2px rgba(0,0,0,0.04)` : 'none',
      color: active ? AC.fg : '#3f3f46', fontWeight: active ? 600 : 500, transition: 'background 120ms',
    }}>
      <AIcon name={item.icon} size={16} color={active ? AC.primary : AC.mutedFg} />
      <span style={{ flex: 1 }}>{item.label}</span>
      {badge > 0 && <span style={{
        minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9999, background: AC.amber, color: '#fff',
        fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{badge}</span>}
    </button>
  );
}

function SceneMenu({ onPick }) {
  const [open, setOpen] = useA(false);
  const ref = useAR(null);
  useAE(() => {
    if (!open) return;
    const onDown = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const items = [
    { id: 'bootstrap', label: 'First-admin claim', icon: 'flag', desc: 'Fresh, unclaimed server' },
    { id: 'approval', label: 'Awaiting approval', icon: 'shield-alert', desc: 'New device, post-login' },
    { id: 'recovery', label: 'Account recovery', icon: 'key-round', desc: 'Locked out everywhere' },
  ];
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen(o => !o)} style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', height: 32, padding: '0 10px',
        border: `1px dashed ${AC.borderHi}`, borderRadius: 8, background: 'transparent', cursor: 'pointer',
        fontFamily: 'inherit', fontSize: 12, color: AC.muted, fontWeight: 500 }}>
        <AIcon name="monitor-play" size={14} color={AC.mutedFg} />
        <span style={{ flex: 1, textAlign: 'left' }}>Preview sign-in states</span>
        <AIcon name="chevron-up" size={13} color={AC.mutedFg} />
      </button>
      {open && (
        <div style={{ position: 'absolute', bottom: '100%', left: 0, right: 0, marginBottom: 6,
          background: '#fff', border: `1px solid ${AC.border}`, borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
          padding: 6, zIndex: 60 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: AC.mutedFg, textTransform: 'uppercase', letterSpacing: 0.5, padding: '6px 8px 4px' }}>Prototype scenes</div>
          {items.map(it => (
            <button key={it.id} onClick={() => { onPick(it.id); setOpen(false); }} style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px', borderRadius: 7,
              border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}
              onMouseEnter={e => e.currentTarget.style.background = AC.surface}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
              <AIcon name={it.icon} size={15} color={AC.muted} />
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: AC.fg }}>{it.label}</div>
                <div style={{ fontSize: 11, color: AC.muted }}>{it.desc}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Console({ data, setData, toast, scene, setScene }) {
  const [route, setRoute] = useA('workspaces');
  const currentUser = data.users.find(u => u.id === 'tomas');
  const openUrl = (url, name) => {
    try { window.open(url, '_blank', 'noopener'); } catch (e) {}
    toast(`Opening ${name || url}…`, 'info');
  };
  const ctx = { data, setData, toast, go: setRoute, currentUser, openUrl };
  const pendingCount = data.pending.length;

  const views = {
    workspaces: WorkspacesView, overview: OverviewView, users: UsersView,
    approvals: ApprovalsView, devices: DevicesView, security: SecurityView,
  };
  const View = views[route] || WorkspacesView;

  return (
    <div style={{ display: 'flex', height: '100%', background: AC.bg }}>
      {/* Sidebar */}
      <aside style={{ width: 248, flex: '0 0 auto', background: AC.surface, borderRight: `1px solid ${AC.border}`,
        display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 16px 14px', borderBottom: `1px solid ${AC.border}`, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: AC.fg, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}>
            <AIcon name="hexagon" size={18} color="#fff" />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: AC.fg, lineHeight: '16px', whiteSpace: 'nowrap' }}>{window.SC_DATA.SERVER.name}</div>
            <div style={{ fontSize: 11, color: AC.muted, fontFamily: 'Geist Mono, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Bailey server</div>
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '12px 10px' }}>
          {NAV.map(sec => (
            <div key={sec.group} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: AC.mutedFg, textTransform: 'uppercase', letterSpacing: 0.5, padding: '4px 10px 6px' }}>{sec.group}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {sec.items.map(it => (
                  <NavItem key={it.id} item={it} active={route === it.id}
                    badge={it.badge === 'pending' ? pendingCount : 0} onClick={() => setRoute(it.id)} />
                ))}
              </div>
            </div>
          ))}
        </div>

        <div style={{ borderTop: `1px solid ${AC.border}`, padding: 10 }}>
          <SceneMenu onPick={setScene} />
        </div>
      </aside>

      {/* Main */}
      <main style={{ flex: 1, minWidth: 0, overflow: 'auto', background: AC.bg }}>
        <div style={{ maxWidth: 1080, margin: '0 auto', padding: '32px 36px 64px' }}>
          <View ctx={ctx} />
        </div>
      </main>
    </div>
  );
}

function App() {
  const [data, setData] = useA(seedData);
  const [scene, setScene] = useA('console');
  const [toast, setToastState] = useA(null);
  const toastTimer = useAR(null);

  const showToast = (text, tone = 'info') => {
    setToastState({ text, tone });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastState(null), 2600);
  };

  useALucide();
  useAE(() => { if (window.lucide) window.lucide.createIcons(); });
  useAE(() => { const id = setInterval(() => window.lucide && window.lucide.createIcons(), 400); return () => clearInterval(id); }, []);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Console data={data} setData={setData} toast={showToast} scene={scene} setScene={setScene} />
      {scene === 'bootstrap' && <BootstrapScene onClaim={() => { setScene('console'); showToast('Server claimed — you are the root admin', 'success'); }} />}
      {scene === 'approval' && <ApprovalScene
        onApproved={() => { setScene('console'); showToast('Device approved — welcome in', 'success'); }}
        goConsole={() => setScene('console')} />}
      {scene === 'recovery' && <RecoveryScene
        onRecovered={() => { setScene('console'); showToast('Recovered — this device is now trusted', 'success'); }}
        goConsole={() => setScene('console')} />}
      <AToast toast={toast} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
