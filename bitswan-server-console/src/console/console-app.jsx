import React from 'react';
// console-app.jsx — server console shell: nav, router, scene switching, state

const { C: AC, Icon: AIcon, Btn: ABtn, Pill: APill, useLucide: useALucide } = window.WD_SHELL;
const { Avatar: AAvatar, Toast: AToast } = window.SC_UI;
const { OverviewView, WorkspacesView } = window.SC_WORKSPACES;
const { UsersView, ApprovalsView } = window.SC_PEOPLE;
const { DevicesView, SecurityView } = window.SC_DEVICES;
const { BootstrapScene, ApprovalScene, RecoveryScene } = window.SC_SCENES;
const { Api } = window.SC_API;
const { useState: useA, useEffect: useAE, useRef: useAR } = React;

// initialData() builds the empty app state. NOTHING here is mock/seed data —
// every list starts empty and is populated only from the live APIs. The views
// render loading/error/empty states until their endpoint lands; they never
// fall back to fabricated values (the user must never see mock data).
function initialData() {
  return {
    // ── Live-wired slices (populated by the APIs on load) ──
    workspaces: [],      // GET /bailey/api/workspaces
    myDevices: [],       // GET /bailey/api/devices
    pending: [],         // GET /bailey/api/approvals
    // Recovery: TOTP enrolment status is synced from gate-state on load;
    // recoveryCodes holds only the plaintext set generated THIS session
    // (the backend stores hashes and returns codes once), so start empty.
    recovery: { totpActive: false, recoveryCodes: [] },
    // Live identity + load status.
    me: null,            // { email, isAdmin }
    // Live overview (counts + identity card + activity feed) and people
    // roster, fetched from /bailey/api/overview and /bailey/api/people. Null
    // until loaded; the views render loading/error/empty from load+error.
    overview: null,      // { counts, identity, activity }
    people: null,        // [{ name,email,role,workspaceCount,deviceCount,lastActive,invited }]
    peopleWarning: null, // partial-enumeration `error` string from /people (200 + error)
    load: { devices: 'idle', approvals: 'idle', workspaces: 'idle', whoami: 'idle', overview: 'idle', people: 'idle' },
    error: {},           // { devices, approvals, workspaces, whoami, overview, people }
  };
}

// serverHost is the hostname the console is actually served from — the real
// origin, not a seeded label. Used for the sidebar + page headers.
function serverHost() {
  try { return window.location.hostname || ''; } catch (e) { return ''; }
}

// ── Adapters: backend DTO → the shapes the existing components render ──

// /bailey/api/devices → { devices:[{id,name,paired_at,last_seen,is_current,origin}] }
// The device cards want kind/browser/os/location/ip/lastActive/added; the
// backend only tracks id/name/timestamps/origin, so the cosmetic fields are
// derived/blank rather than invented.
function adaptDevice(d) {
  return {
    id: d.id,
    name: d.name || 'Unnamed device',
    kind: 'laptop',
    current: !!d.is_current,            // is THIS the device I'm viewing from
    browser: '', os: '', ip: '', location: '',
    lastActive: d.last_seen ? `Last seen ${formatWhen(d.last_seen)}` : '—',
    added: d.paired_at ? formatWhen(d.paired_at) : '—',
    // How the device became trusted — a SEPARATE axis from `current`. Comes
    // from the real backend `origin` ("root" = claim/TOFU; "linked" = approved/
    // self-trusted). Defaults to "linked" for legacy rows with no recorded
    // origin. Never derive this from is_current.
    trustOrigin: d.origin === 'root' ? 'root' : 'linked',
  };
}

// /bailey/api/approvals → { pending:[{email,issued_at,age_seconds}] }
// The approvals view keys on .id, shows .userName/.userEmail/.code etc.
// The backend deliberately does NOT return the code (the admin types the
// code read off the user's screen — that's the trust step), so .code is
// left empty and the matcher accepts the typed value as-is.
function adaptApproval(p) {
  return {
    id: p.email,
    userName: p.email,
    userEmail: p.email,
    firstDevice: true,
    kind: 'laptop',
    browser: '', os: '', ip: '', location: '',
    requested: ageLabel(p.age_seconds),
    oauth: 'Keycloak SSO',
    code: '', // not provided by backend — admin enters it from the user's screen
  };
}

// /bailey/api/workspaces → { caller_email, workspaces:[{name,dashboard_url,
//   editor_url,gitops_url,dashboard_role,editor_role,gitops_role,is_owner,
//   is_trashed}] }
// Maps onto the workspace-card shape. Members/processes/automations/apps
// aren't exposed by this endpoint, so they're empty; ownership comes from
// is_owner, and the primary "open" link is the workspace dashboard.
function adaptWorkspace(w, callerEmail) {
  return {
    id: w.name,
    name: w.name,
    owner: w.is_owner ? callerEmail : (w.dashboard_role || w.editor_role || w.gitops_role || ''),
    members: [], // TODO(api): membership list not exposed by /workspaces
    processes: 0, automations: 0,
    created: '', activity: '',
    status: w.is_trashed ? 'archived' : 'active',
    dashboard: w.dashboard_url || w.gitops_url || w.editor_url || '#',
    editorUrl: w.editor_url, gitopsUrl: w.gitops_url,
    isOwner: !!w.is_owner,
    isTrashed: !!w.is_trashed,
    apps: [],
    live: true,
  };
}

// /bailey/api/people → { people:[{name,email,role,workspace_count,
//   device_count,last_active,invited}], error? }
// Maps the snake_case DTO onto the camelCase fields the People view reads.
// last_active is an optional timestamp; render blank when absent (no
// fabricated "now"). name == email from the backend until a profile source
// exists — passed through verbatim (no local-part heuristics).
function adaptPerson(p) {
  return {
    id: p.email,
    name: p.name || p.email,
    email: p.email,
    role: p.role || 'member',
    workspaceCount: p.workspace_count || 0,
    deviceCount: p.device_count || 0,
    lastActive: p.last_active ? formatWhen(p.last_active) : '',
    invited: !!p.invited,
  };
}

// /bailey/api/overview → { counts, identity, activity }. Maps the identity
// card + activity feed onto the shapes OverviewView renders. uptime_sec →
// a human label; region/claimed_at may be empty (rendered as a dash).
function adaptOverview(o) {
  const id = o.identity || {};
  const counts = o.counts || {};
  return {
    counts: {
      workspaces: counts.workspaces || 0,
      people: counts.people || 0,
      trustedDevices: counts.trusted_devices || 0,
      pendingApprovals: counts.pending_approvals || 0,
    },
    identity: {
      claimedBy: id.claimed_by || '',
      claimedAt: id.claimed_at ? formatWhen(id.claimed_at) : '',
      version: id.version || '',
      online: id.online !== false,
      region: id.region || '',
      uptime: uptimeLabel(id.uptime_sec),
      startTime: id.start_time || '',
    },
    activity: (o.activity || []).map(adaptActivity),
  };
}

// One audit-log event → the row OverviewView renders. The backend feed is
// {ts,actor,action,target}; map the action verb to an icon/tone and a
// readable phrase. Unknown actions fall back to a neutral generic row
// rather than being dropped.
const ACTIVITY_KINDS = {
  'device.approve':   { icon: 'shield-check', tone: 'success', verb: 'approved a device for' },
  'device.revoke':    { icon: 'user-x',       tone: 'danger',  verb: 'revoked a device for' },
  'totp.enrol':       { icon: 'key-round',    tone: 'warning', verb: 'enrolled an authenticator' },
  'server.claim':     { icon: 'flag',         tone: 'primary', verb: 'claimed this server' },
  'workspace.create': { icon: 'folder-plus',  tone: 'primary', verb: 'created workspace' },
  'workspace.trash':  { icon: 'trash-2',      tone: 'danger',  verb: 'trashed workspace' },
};
function adaptActivity(a) {
  const k = ACTIVITY_KINDS[a.action] || { icon: 'activity', tone: 'neutral', verb: a.action || 'did something' };
  const target = a.target || '';
  return {
    icon: k.icon,
    tone: k.tone,
    who: a.actor || '',
    text: target ? `${k.verb} ${target}` : k.verb,
    when: a.ts ? formatWhen(a.ts) : '',
  };
}

function uptimeLabel(secs) {
  if (secs == null) return '';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

function formatWhen(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}
function ageLabel(secs) {
  if (secs == null) return '';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
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
    { id: 'approvals', label: 'New user approvals', icon: 'shield-check', badge: 'pending' },
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

function Console({ data, setData, toast, refresh }) {
  const [route, setRoute] = useA('workspaces');
  // Current user: the live whoami identity. Until whoami resolves we use a
  // neutral empty identity — never a fabricated seed user.
  const currentUser = data.me
    ? {
        id: data.me.email,
        email: data.me.email,
        name: data.me.email,
        role: data.me.isAdmin ? 'admin' : 'member',
        isAdmin: data.me.isAdmin,
      }
    : { id: '', email: '', name: '', role: 'member', isAdmin: false };
  const openUrl = (url, name) => {
    try { window.open(url, '_blank', 'noopener'); } catch (e) {}
    toast(`Opening ${name || url}…`, 'info');
  };
  const ctx = { data, setData, toast, go: setRoute, currentUser, openUrl, refresh };
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
            <div style={{ fontSize: 14, fontWeight: 700, color: AC.fg, lineHeight: '16px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{serverHost() || 'Bailey'}</div>
            <div style={{ fontSize: 11, color: AC.muted, fontFamily: 'Geist Mono, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Bailey server</div>
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '12px 10px' }}>
          {/* Hide the Admin section for a confirmed non-admin (whoami
              loaded with isAdmin=false). Before whoami resolves we leave
              it visible so the chrome doesn't flicker. */}
          {NAV.filter(sec => !(sec.group === 'Admin' && data.me && !data.me.isAdmin)).map(sec => (
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

// pickScene maps a /bailey/api/gate-state response to the scene the SPA should
// render, per the backend's scene-selection rule. `recoverIntent` is true when
// the URL carries an explicit recovery entry (?recover). Evaluated in order:
//   1. recovery intent      → 'recovery'
//   2. trusted              → 'console' (gate cleared — render the app)
//   3. unclaimed & can_claim → 'bootstrap' (first-admin claim)
//   4. unclaimed & !can_claim → 'waiting' (claimed by someone else / not eligible)
//   5. claimed but untrusted → 'approval'
function pickScene(gs, recoverIntent) {
  if (recoverIntent) return 'recovery';
  if (!gs) return 'console';
  if (gs.trusted) return 'console';
  if (!gs.claimed) return gs.can_claim ? 'bootstrap' : 'waiting';
  return 'approval';
}

function hasRecoverIntent() {
  try {
    const p = new URLSearchParams(window.location.search);
    return p.has('recover') || p.get('return') === 'recover' || window.location.pathname.replace(/\/+$/, '') === '/recover';
  } catch (e) { return false; }
}

// Neutral full-screen spinner shown while gate-state is in flight, so the SPA
// never flashes the wrong scene before it knows the device-trust status.
function GateSpinner() {
  return (
    <div style={{ position: 'absolute', inset: 0, background: AC.surface,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
      <div style={{ width: 32, height: 32, borderRadius: 8, background: AC.fg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <AIcon name="hexagon" size={18} color="#fff" />
      </div>
      <AIcon name="loader" size={20} color={AC.muted} />
    </div>
  );
}

// Full-screen "not eligible to claim" message for the unclaimed-but-can't-claim
// case (the server is waiting to be claimed by an eligible admin).
function WaitingScene() {
  return (
    <div style={{ position: 'absolute', inset: 0, background: AC.surface,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ width: 420, maxWidth: '100%', background: '#fff', border: `1px solid ${AC.border}`,
        borderRadius: 16, boxShadow: '0 20px 50px rgba(0,0,0,0.10)', padding: '30px 30px 26px', textAlign: 'center' }}>
        <div style={{ width: 52, height: 52, borderRadius: 13, background: AC.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
          <AIcon name="clock" size={24} color={AC.muted} />
        </div>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: AC.fg }}>Waiting to be claimed</h1>
        <p style={{ margin: '8px auto 0', fontSize: 13.5, color: AC.muted, lineHeight: '20px', maxWidth: 340 }}>
          This Bailey server hasn't been claimed yet, and your account isn't eligible to claim it. Ask the person setting up this server to sign in first.
        </p>
      </div>
    </div>
  );
}

function App() {
  const [data, setData] = useA(initialData);
  // gate: { status:'loading'|'ok'|'error', state, error } from gate-state.
  const [gate, setGate] = useA({ status: 'loading', state: null, error: null });
  const [toast, setToastState] = useA(null);
  const toastTimer = useAR(null);

  const loadGate = useAR();
  loadGate.current = async () => {
    setGate(g => ({ ...g, status: 'loading' }));
    try {
      const s = await Api.gateState();
      setGate({ status: 'ok', state: s, error: null });
    } catch (e) {
      setGate({ status: 'error', state: null, error: e.message });
    }
  };

  const showToast = (text, tone = 'info') => {
    setToastState({ text, tone });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastState(null), 2600);
  };

  // ── Live data loaders ──────────────────────────────────────────────
  // Each refetches one API list and writes it into the matching state
  // slice along with its load/error status. Used both on mount and after
  // a mutation so the UI reflects the backend.
  const setLoad = (key, status) =>
    setData(d => ({ ...d, load: { ...d.load, [key]: status } }));
  const setErr = (key, msg) =>
    setData(d => ({ ...d, error: { ...d.error, [key]: msg || undefined } }));

  const loadWhoami = useAR();
  loadWhoami.current = async () => {
    setLoad('whoami', 'loading');
    try {
      const r = await Api.whoami();
      const email = (r && r.headers && (r.headers['X-Forwarded-Email'] || r.headers['X-Auth-Request-Email'])) || '';
      setData(d => ({ ...d, me: { email, isAdmin: !!(r && r.is_admin) } }));
      setLoad('whoami', 'ok'); setErr('whoami', null);
    } catch (e) { setLoad('whoami', 'error'); setErr('whoami', e.message); }
  };

  const loadDevices = useAR();
  loadDevices.current = async () => {
    setLoad('devices', 'loading');
    try {
      const r = await Api.devices();
      setData(d => ({ ...d, myDevices: (r.devices || []).map(adaptDevice) }));
      setLoad('devices', 'ok'); setErr('devices', null);
    } catch (e) { setLoad('devices', 'error'); setErr('devices', e.message); }
  };

  const loadApprovals = useAR();
  loadApprovals.current = async () => {
    setLoad('approvals', 'loading');
    try {
      const r = await Api.approvals();
      setData(d => ({ ...d, pending: (r.pending || []).map(adaptApproval) }));
      setLoad('approvals', 'ok'); setErr('approvals', null);
    } catch (e) { setLoad('approvals', 'error'); setErr('approvals', e.message); }
  };

  const loadWorkspaces = useAR();
  loadWorkspaces.current = async () => {
    setLoad('workspaces', 'loading');
    try {
      const r = await Api.workspaces();
      const caller = (r && r.caller_email) || '';
      setData(d => ({ ...d, workspaces: (r.workspaces || []).map(w => adaptWorkspace(w, caller)) }));
      setLoad('workspaces', 'ok'); setErr('workspaces', null);
    } catch (e) { setLoad('workspaces', 'error'); setErr('workspaces', e.message); }
  };

  const loadOverview = useAR();
  loadOverview.current = async () => {
    setLoad('overview', 'loading');
    try {
      const r = await Api.overview();
      setData(d => ({ ...d, overview: adaptOverview(r) }));
      setLoad('overview', 'ok'); setErr('overview', null);
    } catch (e) { setLoad('overview', 'error'); setErr('overview', e.message); }
  };

  const loadPeople = useAR();
  loadPeople.current = async () => {
    setLoad('people', 'loading');
    try {
      const r = await Api.people();
      // /people degrades gracefully: a 200 may carry an `error` describing a
      // partial-enumeration failure. Keep the roster AND surface the warning;
      // only a thrown ApiError becomes a full error state.
      setData(d => ({
        ...d,
        people: (r.people || []).map(adaptPerson),
        peopleWarning: r.error || null,
      }));
      setLoad('people', 'ok'); setErr('people', null);
    } catch (e) { setLoad('people', 'error'); setErr('people', e.message); }
  };

  // refresh(list) re-fetches one (or all) live lists. Passed through ctx
  // so a view's mutation handler can sync after writing to the backend.
  const refresh = useAR();
  refresh.current = (which) => {
    const all = { devices: loadDevices, approvals: loadApprovals, workspaces: loadWorkspaces, whoami: loadWhoami, overview: loadOverview, people: loadPeople };
    if (which && all[which]) return all[which].current();
    return Promise.all(Object.values(all).map(r => r.current()));
  };

  // Resolve the device-trust gate first.
  useAE(() => { loadGate.current(); }, []);

  // The scene is driven SOLELY by the real gate-state (plus an explicit
  // ?recover URL intent) — there is no preview/override path.
  const recoverIntent = hasRecoverIntent();
  const scene = pickScene(gate.state, recoverIntent);

  // Only load the console data lists once the gate is cleared (trusted) — the
  // console APIs are gated, so calling them while untrusted would error.
  useAE(() => {
    if (gate.status !== 'ok') return;
    if (scene !== 'console') return;
    // Reflect real TOTP enrolment from gate-state into the recovery slice so
    // Security & recovery shows the true "Active / Not set up" state. The
    // backup-codes plaintext is only ever returned once (on enroll/regenerate),
    // so we don't synthesize codes here — the card just knows enrolment exists.
    if (gate.state) {
      setData(d => ({ ...d, recovery: { ...d.recovery, totpActive: !!gate.state.totp_enrolled } }));
    }
    loadWhoami.current();
    loadDevices.current();
    loadApprovals.current();
    loadWorkspaces.current();
    // Admin-only endpoints (403 for non-admins). The Admin nav section is
    // hidden once whoami confirms isAdmin=false, so a non-admin won't reach
    // these views; if they did, the 403 surfaces as the view's error state.
    loadOverview.current();
    loadPeople.current();
  }, [gate.status, scene]);

  useALucide();
  useAE(() => { if (window.lucide) window.lucide.createIcons(); });
  useAE(() => { const id = setInterval(() => window.lucide && window.lucide.createIcons(), 400); return () => clearInterval(id); }, []);

  // After a successful claim/approval/recovery the device's trust state has
  // changed on the backend — re-fetch gate-state so pickScene re-evaluates and
  // advances to the console. The scene is never set imperatively.
  const reloadGate = () => loadGate.current();

  // While gate-state is loading we show a neutral spinner so we never flash the
  // wrong scene. A gate-state error is treated as "not signed in / not trusted"
  // and we surface it inline rather than silently assuming a state.
  if (gate.status === 'loading') {
    return <div style={{ position: 'relative', width: '100%', height: '100%' }}><GateSpinner /></div>;
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Console data={data} setData={setData} toast={showToast} refresh={(w) => refresh.current(w)} />
      {gate.status === 'error' && (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '10px 16px', background: AC.red,
          color: '#fff', fontSize: 12.5, textAlign: 'center', zIndex: 90 }}>
          Couldn't load device-trust state: {gate.error}
        </div>
      )}
      {scene === 'waiting' && <WaitingScene />}
      {scene === 'bootstrap' && <BootstrapScene
        onClaim={() => { showToast('Server claimed — you are the root admin', 'success'); reloadGate(); }} />}
      {scene === 'approval' && <ApprovalScene
        gateState={gate.state}
        onApproved={() => { showToast('Device approved — welcome in', 'success'); reloadGate(); }}
        goConsole={reloadGate} />}
      {scene === 'recovery' && <RecoveryScene
        gateState={gate.state}
        onRecovered={() => { showToast('Recovered — this device is now trusted', 'success'); reloadGate(); }}
        goConsole={reloadGate} />}
      <AToast toast={toast} />
    </div>
  );
}

// main.jsx owns mounting (so window.lucide is configured before first render).
window.SC_APP = App;
// Published for the views (real server host, not a seeded label) + tests.
window.SC_HELPERS = { serverHost, pickScene, initialData };