// console-data.jsx — mock data for the Bailey server console
// Everything the prototype reads lives here. Mutations happen on copies in app state.

// ─── The server identity ────────────────────────────────────────────────────
const SERVER = {
  name: 'harmonum-prod',
  host: 'bailey.harmonum.ai',
  region: 'eu-central · Frankfurt',
  version: 'Bailey 2.7.1',
  claimedBy: 'tomas@harmonum.ai',
  claimedAt: 'Mar 02, 2026',
  uptime: '71 days',
};

// ─── People on this server ──────────────────────────────────────────────────
// role: 'admin' | 'member' | 'auditor' | 'viewer'
// status: 'active' | 'invited' | 'suspended'
const USERS = [
  { id: 'tomas', name: 'Tomáš Beneš',  email: 'tomas@harmonum.ai', role: 'admin',
    status: 'active', color: '#093df5', lastActive: 'now', devices: 3, root: true },
  { id: 'pavel', name: 'Pavel Horák',  email: 'pavel@harmonum.ai', role: 'member',
    status: 'active', color: '#16a34a', lastActive: '2h ago', devices: 2 },
  { id: 'jana',  name: 'Jana Marešová', email: 'jana@harmonum.ai', role: 'auditor',
    status: 'active', color: '#a855f7', lastActive: '5h ago', devices: 1 },
  { id: 'eva',   name: 'Eva Dvořáková', email: 'eva@harmonum.ai',  role: 'member',
    status: 'active', color: '#dc2626', lastActive: '1d ago', devices: 2 },
  { id: 'martin', name: 'Martin Král',  email: 'martin@harmonum.ai', role: 'viewer',
    status: 'active', color: '#f59e0b', lastActive: '3d ago', devices: 1 },
  { id: 'alex',  name: 'Alex Mráz',    email: 'alex@harmonum.ai',  role: 'member',
    status: 'invited', color: '#2a9d90', lastActive: '—', devices: 0 },
];

// ─── Workspaces hosted on this server ───────────────────────────────────────
// status: 'active' | 'archived'
// dashboard: relative URL of the per-workspace dashboard
// apps: production-deployed apps you can open. kind: 'public' | 'internal'
//   appStatus: 'healthy' | 'degraded' | 'down'
const DASHBOARD_URL = 'Workspace Dashboard.html';

const WORKSPACES = [
  { id: 'ws-hr',      name: 'HR Platform',           owner: 'tomas',
    members: ['tomas', 'pavel', 'jana'], processes: 4, automations: 11,
    created: 'Mar 04, 2026', activity: '12m ago', status: 'active',
    dashboard: DASHBOARD_URL,
    apps: [
      { id: 'a-hr-portal', name: 'HR Self-Service', kind: 'public',   url: 'https://hr.harmonum.ai',        version: 'f1c4e7a', deployed: '11 days ago', appStatus: 'healthy' },
      { id: 'a-hr-admin',  name: 'HR Admin Console', kind: 'internal', url: 'https://admin.hr.harmonum.ai',  version: 'a3f8c21', deployed: '2 days ago',  appStatus: 'healthy' },
    ] },
  { id: 'ws-invoice', name: 'Invoice Automation',    owner: 'pavel',
    members: ['pavel', 'tomas'], processes: 2, automations: 5,
    created: 'Mar 12, 2026', activity: '4h ago', status: 'active',
    dashboard: DASHBOARD_URL,
    apps: [
      { id: 'a-inv-console', name: 'Invoice Console', kind: 'internal', url: 'https://inv.harmonum.ai', version: '2e6b9d4', deployed: '3 days ago', appStatus: 'healthy' },
    ] },
  { id: 'ws-finance', name: 'Finance & Reporting',   owner: 'jana',
    members: ['jana', 'eva', 'pavel'], processes: 3, automations: 8,
    created: 'Apr 01, 2026', activity: '1d ago', status: 'active',
    dashboard: DASHBOARD_URL,
    apps: [
      { id: 'a-fin-reports', name: 'Reporting Hub',  kind: 'internal', url: 'https://reports.harmonum.ai', version: 'c9f2a5b', deployed: '5 days ago',  appStatus: 'healthy' },
      { id: 'a-fin-board',   name: 'Board Dashboard', kind: 'internal', url: 'https://board.harmonum.ai',   version: 'd1e4c7f', deployed: '8 days ago',  appStatus: 'degraded' },
    ] },
  { id: 'ws-partner', name: 'Partner Portal',        owner: 'eva',
    members: ['eva', 'martin'], processes: 1, automations: 3,
    created: 'Apr 18, 2026', activity: '2d ago', status: 'active',
    dashboard: DASHBOARD_URL,
    apps: [
      { id: 'a-partner', name: 'Partner Portal', kind: 'public', url: 'https://partners.harmonum.ai', version: 'b7e0c3f', deployed: '6 days ago', appStatus: 'healthy' },
    ] },
  { id: 'ws-crm',     name: 'CRM Sync',              owner: 'tomas',
    members: ['tomas', 'pavel', 'eva', 'martin'], processes: 2, automations: 4,
    created: 'May 02, 2026', activity: '6h ago', status: 'active',
    dashboard: DASHBOARD_URL,
    apps: [
      { id: 'a-crm', name: 'CRM Sync Admin', kind: 'internal', url: 'https://crm.harmonum.ai', version: '5e8c1f4', deployed: '6 hours ago', appStatus: 'healthy' },
    ] },
  { id: 'ws-legacy',  name: 'Reservation System',    owner: 'pavel',
    members: ['pavel'], processes: 1, automations: 2,
    created: 'Jan 20, 2026', activity: '34d ago', status: 'archived',
    dashboard: DASHBOARD_URL, apps: [] },
];

// ─── The current viewer's own trusted devices (WhatsApp-style) ──────────────
// trustOrigin: 'root' | 'admin' | 'linked' — where this device's trust came from
const MY_DEVICES = [
  { id: 'd-mbp', name: 'MacBook Pro 16"', kind: 'laptop', current: true,
    browser: 'Chrome 128', os: 'macOS 15.2', ip: '94.142.x.x',
    location: 'Frankfurt, DE', lastActive: 'Active now',
    trustOrigin: 'root', added: 'Mar 02, 2026' },
  { id: 'd-iphone', name: 'iPhone 16 Pro', kind: 'phone', current: false,
    browser: 'Safari 18', os: 'iOS 18.2', ip: '94.142.x.x',
    location: 'Frankfurt, DE', lastActive: '20m ago',
    trustOrigin: 'linked', linkedFrom: 'MacBook Pro 16"', added: 'Mar 03, 2026' },
  { id: 'd-ipad', name: 'iPad Air', kind: 'tablet', current: false,
    browser: 'Safari 18', os: 'iPadOS 18.1', ip: '88.103.x.x',
    location: 'Prague, CZ', lastActive: '3d ago',
    trustOrigin: 'linked', linkedFrom: 'iPhone 16 Pro', added: 'Apr 10, 2026' },
];

// ─── Devices awaiting admin approval (created when a user signs in via OAuth) ─
// The admin must type `code` (shown on the user's screen) to confirm + approve.
const PENDING_DEVICES = [
  { id: 'p-alex', userName: 'Alex Mráz', userEmail: 'alex@harmonum.ai',
    firstDevice: true, kind: 'laptop', browser: 'Firefox 130', os: 'Ubuntu 24.04',
    ip: '212.96.x.x', location: 'Brno, CZ', requested: '4m ago',
    oauth: 'Keycloak SSO', code: '4821-7K39' },
  { id: 'p-martin', userName: 'Martin Král', userEmail: 'martin@harmonum.ai',
    firstDevice: false, kind: 'phone', browser: 'Chrome 128', os: 'Android 15',
    ip: '109.81.x.x', location: 'Ostrava, CZ', requested: '22m ago',
    oauth: 'Keycloak SSO', code: '5630-2BX8' },
];

// ─── A "new device" that's currently showing a PIN for the My-devices link flow.
// The trusted device enters this PIN to link it. (Prototype: hint shown in UI.)
const LINK_REQUEST = {
  pin: '519-374',
  kind: 'desktop', browser: 'Edge 128', os: 'Windows 11',
  ip: '94.142.x.x', location: 'Frankfurt, DE',
};

// ─── Per-user trusted devices (admin can view & revoke any of these) ────────
// Keyed by user id. The current admin (tomas) shares MY_DEVICES below.
const USER_DEVICES = {
  pavel: [
    { id: 'pv-1', name: 'ThinkPad X1', kind: 'laptop', browser: 'Firefox 130', os: 'Fedora 41',
      ip: '88.100.x.x', location: 'Prague, CZ', lastActive: '2h ago', trustOrigin: 'admin', added: 'Mar 12, 2026' },
    { id: 'pv-2', name: 'Pixel 9', kind: 'phone', browser: 'Chrome 128', os: 'Android 15',
      ip: '88.100.x.x', location: 'Prague, CZ', lastActive: '1d ago', trustOrigin: 'linked', linkedFrom: 'ThinkPad X1', added: 'Mar 14, 2026' },
  ],
  jana: [
    { id: 'jn-1', name: 'MacBook Air', kind: 'laptop', browser: 'Safari 18', os: 'macOS 15.2',
      ip: '195.113.x.x', location: 'Brno, CZ', lastActive: '5h ago', trustOrigin: 'admin', added: 'Apr 01, 2026' },
  ],
  eva: [
    { id: 'ev-1', name: 'Dell Latitude', kind: 'laptop', browser: 'Edge 128', os: 'Windows 11',
      ip: '37.188.x.x', location: 'Ostrava, CZ', lastActive: '1d ago', trustOrigin: 'admin', added: 'Apr 18, 2026' },
    { id: 'ev-2', name: 'iPhone 15', kind: 'phone', browser: 'Safari 18', os: 'iOS 18.2',
      ip: '37.188.x.x', location: 'Ostrava, CZ', lastActive: '3d ago', trustOrigin: 'linked', linkedFrom: 'Dell Latitude', added: 'Apr 20, 2026' },
  ],
  martin: [
    { id: 'mk-1', name: 'Galaxy S24', kind: 'phone', browser: 'Chrome 128', os: 'Android 15',
      ip: '109.81.x.x', location: 'Ostrava, CZ', lastActive: '3d ago', trustOrigin: 'admin', added: 'May 02, 2026' },
  ],
  alex: [],
};

// ─── Recovery / authenticator state for the current user ────────────────────
const RECOVERY = {
  totpActive: false,
  totpSecret: 'JBSW Y3DP EHPK 3PXP',
  recoveryCodes: [
    '7H2K-9QXM', '3PLR-8VND', 'M4ZT-1WQK', 'B9YC-6FHJ',
    'K2DN-5XRP', 'Q8WL-3MBT', 'V6JF-7HNC', 'R1XS-4KPD',
  ],
};

// ─── Recent security activity (for the Overview feed) ───────────────────────
const ACTIVITY = [
  { icon: 'shield-check', tone: 'success', who: 'tomas@harmonum.ai',
    text: 'approved a new device for jana@harmonum.ai', when: '2h ago' },
  { icon: 'smartphone', tone: 'primary', who: 'eva@harmonum.ai',
    text: 'linked iPhone 15 from a trusted device', when: '5h ago' },
  { icon: 'folder-plus', tone: 'primary', who: 'tomas@harmonum.ai',
    text: 'created workspace CRM Sync', when: '6h ago' },
  { icon: 'user-x', tone: 'danger', who: 'tomas@harmonum.ai',
    text: 'revoked a stale device for pavel@harmonum.ai', when: '1d ago' },
  { icon: 'key-round', tone: 'warning', who: 'jana@harmonum.ai',
    text: 'enabled authenticator-app recovery', when: '2d ago' },
  { icon: 'user-plus', tone: 'neutral', who: 'tomas@harmonum.ai',
    text: 'invited alex@harmonum.ai', when: '3d ago' },
];

// ─── Role legend ────────────────────────────────────────────────────────────
const ROLES = [
  { id: 'admin',   label: 'Admin',   tone: 'primary',
    desc: 'Approves devices, manages users & workspaces, owns server settings.' },
  { id: 'auditor', label: 'Auditor', tone: 'info',
    desc: 'Signs off on deploy promotions. Read access to all workspaces.' },
  { id: 'member',  label: 'Member',  tone: 'neutral',
    desc: 'Builds in workspaces they own or are added to.' },
  { id: 'viewer',  label: 'Viewer',  tone: 'outline',
    desc: 'Read-only access to assigned workspaces.' },
];

window.SC_DATA = {
  SERVER, USERS, WORKSPACES, MY_DEVICES, PENDING_DEVICES,
  LINK_REQUEST, RECOVERY, ACTIVITY, ROLES, USER_DEVICES,
  byId: (id) => USERS.find(u => u.id === id),
};
