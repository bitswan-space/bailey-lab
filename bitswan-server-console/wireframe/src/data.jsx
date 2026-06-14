// data.jsx — mock data for the workspace dashboard

const BUSINESS_PROCESSES = [
  { id: 'bitswan-presentation-for-cio', name: 'BitSwan-presentation-for-CIO' },
  { id: 'invoice-automation-revamp',    name: 'InvoiceAutomationRevamp' },
  { id: 'pl-2026',                       name: 'PL-2026' },
  { id: 'pl-2026-copy',                  name: 'PL-2026-copy' },
  { id: 'pl-2026-demo',                  name: 'PL-2026-demo' },
  { id: 'profit-loss-2026',              name: 'Profit-loss-2026' },
  { id: 'bonus-calculation-la',          name: 'bonus-calculation-LA' },
  { id: 'bonus-calculation-wd',          name: 'bonus-calculation-wd' },
  { id: 'hr-module',                     name: 'hr-module', active: true },
  { id: 'hrm-reporting-automation',      name: 'hrm-reporting-automation' },
  { id: 'invoice-automation',            name: 'invoice-automation' },
  { id: 'invoice-automation-copy',       name: 'invoice-automation-copy' },
  { id: 'la-bonus-automation',           name: 'la-bonus-automation' },
  { id: 'la-reporting-automation',       name: 'la-reporting-automation' },
  { id: 'partner-portal',                name: 'partner-portal' },
  { id: 'rezervacni-system',             name: 'rezervační-system' },
  { id: 'crm-sync',                      name: 'crm-sync' },
  { id: 'document-pipeline',             name: 'document-pipeline' },
];

// Worktrees per BP. main is the deployments view (no worktree).
const WORKTREES_BY_BP = {
  'hr-module': [
    { id: 'tomas',  name: 'tomas',  synced: true,  ahead: 0, behind: 0, mine: true },
    { id: 'pavel',  name: 'pavel',  synced: false, ahead: 4, behind: 12 },
    { id: 'jana',   name: 'jana',   synced: false, ahead: 1, behind: 12 },
  ],
  'invoice-automation': [
    { id: 'tomas',  name: 'tomas',  synced: false, ahead: 7, behind: 3, mine: true },
  ],
  'pl-2026': [
    { id: 'pavel',  name: 'pavel',  synced: true,  ahead: 0, behind: 0 },
    { id: 'tomas',  name: 'tomas',  synced: true,  ahead: 0, behind: 0, mine: true },
  ],
};

// Automations per BP, with per-stage deployment status.
// status: 'not-deployed' | 'deployed' | 'failed' | 'building'
const AUTOMATIONS_BY_BP = {
  'hr-module': [
    {
      id: 'backend-hr', name: 'backend-hr', kind: 'backend',
      stages: {
        dev:        { status: 'deployed', sha: 'a3f8c21d4e9b7f6c0a1d2e3f4b5c6d7e8f9a0b1c', deployedAt: '2 days ago' },
        staging:    { status: 'deployed', sha: '7b2e9d4a8c1f5e3b6d9a0c2e4f8b1d3a5c7e9b2d', deployedAt: '5 days ago' },
        production: { status: 'deployed', sha: 'f1c4e7a2b9d6c3e0f8a5b2d4c7e9f1a3b5d8c0e2', deployedAt: '11 days ago' },
      },
    },
    {
      id: 'external-frontend-hr', name: 'external-frontend-hr', kind: 'frontend-public',
      stages: {
        dev:        { status: 'deployed', sha: 'a3f8c21d4e9b7f6c0a1d2e3f4b5c6d7e8f9a0b1c', deployedAt: '2 days ago' },
        staging:    { status: 'deployed', sha: '7b2e9d4a8c1f5e3b6d9a0c2e4f8b1d3a5c7e9b2d', deployedAt: '5 days ago' },
        production: { status: 'building' },
      },
    },
    {
      id: 'internal-frontend-hr', name: 'internal-frontend-hr', kind: 'frontend-internal',
      stages: {
        dev:        { status: 'deployed', sha: 'a3f8c21d4e9b7f6c0a1d2e3f4b5c6d7e8f9a0b1c', deployedAt: '2 days ago' },
        staging:    { status: 'failed' },
        production: { status: 'not-deployed' },
      },
    },
    {
      id: 'selenium', name: 'selenium', kind: 'tests',
      stages: {
        dev:        { status: 'deployed', sha: '4d8e1c5a9b3f7e2d6a0c4f8b1e5d9a3c7f0b2e4d', deployedAt: '1 hour ago' },
        staging:    { status: 'not-deployed' },
        production: { status: 'not-deployed' },
      },
    },
  ],
  'invoice-automation': [
    {
      id: 'invoice-backend', name: 'invoice-backend', kind: 'backend',
      stages: {
        dev:        { status: 'deployed', sha: '9c3a7e1d5b8f2c6a4d0e8b3f7c1a5d9e2b4f6c8a', deployedAt: '4 hours ago' },
        staging:    { status: 'deployed', sha: '2e6b9d4a8c1f5e3b7d0a4c6e9f2b5d8a1c3e7f0b', deployedAt: '3 days ago' },
        production: { status: 'deployed', sha: '2e6b9d4a8c1f5e3b7d0a4c6e9f2b5d8a1c3e7f0b', deployedAt: '3 days ago' },
      },
    },
    {
      id: 'invoice-ui', name: 'invoice-ui', kind: 'frontend-internal',
      stages: {
        dev:        { status: 'deployed', sha: '9c3a7e1d5b8f2c6a4d0e8b3f7c1a5d9e2b4f6c8a', deployedAt: '4 hours ago' },
        staging:    { status: 'deployed', sha: '2e6b9d4a8c1f5e3b7d0a4c6e9f2b5d8a1c3e7f0b', deployedAt: '3 days ago' },
        production: { status: 'deployed', sha: '2e6b9d4a8c1f5e3b7d0a4c6e9f2b5d8a1c3e7f0b', deployedAt: '3 days ago' },
      },
    },
  ],
};

// Worktree-specific automations (live-dev only)
// liveDev: { status: 'stopped' | 'starting' | 'running' | 'failed', url?, port?, uptime?, logs? }
const WORKTREE_AUTOMATIONS = {
  'hr-module:tomas': [
    {
      id: 'backend-hr', name: 'backend-hr', kind: 'backend',
      liveDev: {
        status: 'running', url: 'https://medin-1-backend-hr-fslk-live-dev.medin.bswn.internal/', port: 8080, uptime: '12m',
        logs: [
          '[14:02:11] INFO  starting hot-reload watcher',
          '[14:02:12] INFO  serving on :8080',
          '[14:14:03] DEBUG GET /api/employees → 200 (47ms)',
          '[14:14:08] DEBUG POST /api/payroll → 201 (112ms)',
        ],
      },
    },
    {
      id: 'external-frontend-hr', name: 'external-frontend-hr', kind: 'frontend-public',
      liveDev: {
        status: 'running', url: 'https://medin-1-external-frontend-hr-fslk-live-dev.medin.bswn.internal/', port: 5173, uptime: '12m',
        logs: [
          '[14:02:14] vite v5.4.10  ready in 412ms',
          '[14:02:14] ➜  serving at https://medin-1-external-frontend-hr-fslk-live-dev.medin.bswn.internal/',
          '[14:13:48] hmr update src/pages/Employees.tsx',
        ],
      },
    },
    {
      id: 'internal-frontend-hr', name: 'internal-frontend-hr', kind: 'frontend-internal',
      liveDev: {
        status: 'stopped',
      },
    },
    {
      id: 'selenium', name: 'selenium', kind: 'tests',
      liveDev: {
        status: 'failed',
        logs: [
          '[14:01:55] ERROR could not connect to chromedriver',
          '[14:01:55] ERROR exited with status 1',
        ],
      },
    },
  ],
};

// Requirements per worktree
const REQUIREMENTS = {
  'hr-module:tomas': [
    { id: 'REQ-008', status: 'pass',    text: 'na listu Employees přidej search boxy pro:\n- position, department, contract type' },
    { id: 'REQ-009', status: 'pass',    text: 'na kartě zaměstnance v Contracts u DPP odstraň "monthly flat rate"' },
    { id: 'REQ-010', status: 'pass',    text: 'na listu Compensation přidej sloupec CONTRACT, kde když je xxx tak dej xxx:\n- HPP -> Monthly Flat Rate\n- DPP -> Hourly Rate\n- B2B -> Hourly Rate nebo Monthly Flat Rate' },
    { id: 'REQ-011', status: 'pass',    text: 'přidej list Compensation, dej ho do levého panelu pod Employees' },
    { id: 'REQ-012', status: 'pass',    text: 'karta zaměstnance:\n- když vyplním VALID FROM, tak automaticky dopočítej PROBATION END DATE jako +3 months, example VALID FROM: 13.03.2025 -> PROBATION END DATE: 13.06.2025' },
    { id: 'REQ-013', status: 'pending', text: 'TOGGLE\n- vytvoř konektor na toggl.com API\n- budeme se přihlašovat přes google účet\n- google účet admina dáme do secrets\n- toggl nám asi dá API klíč, ten dáme do secrets\n- po synchronizaci s Toggl se k lidem do záložky Payroll Record vytvoří nový record' },
    { id: 'REQ-014', status: 'pass',    text: 'List Settings' },
    { id: 'REQ-015', status: 'pass',    text: 'Onboarding checklist na kartě zaměstnance' },
  ],
};

// READMEs per BP
const READMES = {
  'hr-module': {
    title: 'HR Module',
    summary: 'Employee lifecycle management platform for internal HR teams. Covers onboarding, contracts, payroll, compensation tracking, and document management with Czech labor-law defaults (birth numbers, health insurers, tax discounts).',
    sections: [
      {
        heading: 'Main Features',
        items: [
          ['Dashboard', 'headcount KPIs (active / probation / terminated), department and contract-type breakdowns, recent hires, expiring documents, monthly payroll summary'],
          ['Employees', 'browse, search, multi-column sort; filter by status, position, department, contract type; create / edit / delete employee records; CSV bulk import (21+ fields, duplicate detection, auto-contract creation)'],
          ['Employee Detail', '8-tab card: Identification, Contact, Work Assignment, Financial & Tax, Contracts, Payroll Records, Salary Changes, Documents'],
          ['Contracts', 'HPP / DPP / DPČ / B2B / Internship; amendments history; hourly and/or monthly rates'],
          ['Payroll', 'monthly records with gross → net breakdown; salary change history with approval workflow'],
          ['Compensation', 'overview table of all employees with active contract rates'],
        ],
      },
      {
        heading: 'Integrations',
        items: [
          ['MinIO', 'object storage for uploaded documents and gallery images'],
          ['Toggl', 'time-tracking sync into payroll records (pending)'],
        ],
      },
    ],
  },
  'invoice-automation': {
    title: 'Invoice Automation',
    summary: 'Automated invoice ingestion from email and ERP. OCRs PDFs, classifies line items, validates against PO, posts to accounting.',
    sections: [
      {
        heading: 'Main Features',
        items: [
          ['Inbox', 'unified queue of incoming invoices from IMAP, ERP webhook, and manual upload'],
          ['Extraction', 'PDF/image OCR with vendor template matching; confidence scores per field'],
          ['Validation', 'three-way match against PO and goods receipt; flag exceptions for review'],
        ],
      },
    ],
  },
};

// Kind → icon + label
const KIND_META = {
  'backend':           { icon: 'cog',       label: 'Backend',           color: '#71717a' },
  'frontend-public':   { icon: 'globe',     label: 'Public frontend',   color: '#3b82f6' },
  'frontend-internal': { icon: 'lock',      label: 'Internal frontend', color: '#a855f7' },
  'tests':             { icon: 'package',   label: 'Tests',             color: '#f59e0b' },
};

// Per-stage deployment history. Key = `${bpId}:${automationId}:${stageId}`.
// Most recent first; the first entry is the currently-deployed one.
const DEPLOYMENT_HISTORY = {
  // ── backend-hr ────────────────────────────────────────────────────────────
  'hr-module:backend-hr:dev': [
    { sha:'a3f8c21d4e9b7f6c0a1d2e3f4b5c6d7e8f9a0b1c', deployedAt:'2 days ago',  deployedAtAbs:'May 05, 2026 · 11:02', who:'tomas@harmonum.ai', message:'sync from worktree tomas — toggl payroll sync + onboarding checklist polish', status:'deployed', current:true, stagedFrom:'worktree/tomas', durationS:128 },
    { sha:'b9e2c5f8a1d4b7e0c3f6a9b2d5e8c1f4a7b0d3e6', deployedAt:'3 days ago',  deployedAtAbs:'May 04, 2026 · 16:48', who:'pavel@harmonum.ai', message:'sync from worktree pavel — refactor employee detail tabs', status:'deployed', stagedFrom:'worktree/pavel', durationS:117 },
    { sha:'c1d4a7b0e3c6d9a2b5e8c1d4a7b0e3c6d9a2b5e8', deployedAt:'4 days ago',  deployedAtAbs:'May 03, 2026 · 10:21', who:'tomas@harmonum.ai', message:'sync from worktree tomas — wip toggl connector', status:'rolled-back', stagedFrom:'worktree/tomas', durationS:96 },
    { sha:'7b2e9d4a8c1f5e3b6d9a0c2e4f8b1d3a5c7e9b2d', deployedAt:'5 days ago',  deployedAtAbs:'May 02, 2026 · 14:21', who:'tomas@harmonum.ai', message:'sync from worktree tomas — toggl connector + onboarding checklist', status:'deployed', stagedFrom:'worktree/tomas', durationS:142 },
    { sha:'b4e1f8c2a7d9e3b6f1c4a8d2e5b9f3c6a0d4e8b1', deployedAt:'9 days ago',  deployedAtAbs:'Apr 28, 2026 · 09:04', who:'pavel@harmonum.ai', message:'sync from worktree pavel — compensation list + search filters', status:'deployed', stagedFrom:'worktree/pavel', durationS:138 },
    { sha:'c9f2a5b8d3e6c1f4a7b0d3e6c9f2a5b8d1e4c7f0', deployedAt:'14 days ago', deployedAtAbs:'Apr 23, 2026 · 16:48', who:'jana@harmonum.ai',  message:'fix probation date calculation rounding', status:'deployed', stagedFrom:'worktree/jana', durationS:121 },
  ],
  'hr-module:backend-hr:staging': [
    { sha:'7b2e9d4a8c1f5e3b6d9a0c2e4f8b1d3a5c7e9b2d', deployedAt:'5 days ago',  deployedAtAbs:'May 02, 2026 · 14:21', who:'tomas@harmonum.ai', message:'promote — toggl connector + onboarding checklist', status:'deployed', current:true,  stagedFrom:'dev', durationS:142 },
    { sha:'b4e1f8c2a7d9e3b6f1c4a8d2e5b9f3c6a0d4e8b1', deployedAt:'9 days ago',  deployedAtAbs:'Apr 28, 2026 · 09:04', who:'pavel@harmonum.ai', message:'promote — compensation list + search filters', status:'deployed', stagedFrom:'dev', durationS:138 },
    { sha:'c9f2a5b8d3e6c1f4a7b0d3e6c9f2a5b8d1e4c7f0', deployedAt:'14 days ago', deployedAtAbs:'Apr 23, 2026 · 16:48', who:'jana@harmonum.ai',  message:'fix probation date calculation rounding', status:'rolled-back', stagedFrom:'dev', durationS:121 },
    { sha:'d1e4c7f0a3b6d9e2c5f8a1b4d7e0c3f6a9b2d5e8', deployedAt:'18 days ago', deployedAtAbs:'Apr 19, 2026 · 11:12', who:'tomas@harmonum.ai', message:'promote — Compensation list, settings page', status:'deployed', stagedFrom:'dev', durationS:155 },
    { sha:'e8c1d4a7b0e3c6d9a2b5e8c1d4a7b0e3c6d9a2b5', deployedAt:'25 days ago', deployedAtAbs:'Apr 12, 2026 · 08:30', who:'pavel@harmonum.ai', message:'initial staging deploy', status:'deployed', stagedFrom:'dev', durationS:201 },
  ],
  'hr-module:backend-hr:production': [
    { sha:'f1c4e7a2b9d6c3e0f8a5b2d4c7e9f1a3b5d8c0e2', deployedAt:'11 days ago', deployedAtAbs:'Apr 26, 2026 · 09:30', who:'tomas@harmonum.ai', message:'promote — Compensation list + search filters', status:'deployed', current:true, stagedFrom:'staging', durationS:172 },
    { sha:'a4d7e0c3f6a9b2d5e8c1f4a7b0d3e6c9f2a5b8d1', deployedAt:'17 days ago', deployedAtAbs:'Apr 20, 2026 · 16:04', who:'tomas@harmonum.ai', message:'promote — settings page hotfix', status:'deployed', stagedFrom:'staging', durationS:168 },
    { sha:'b7e0c3f6a9b2d5e8c1f4a7b0d3e6c9f2a5b8d1e4', deployedAt:'24 days ago', deployedAtAbs:'Apr 13, 2026 · 10:50', who:'pavel@harmonum.ai', message:'promote — initial production cutover', status:'deployed', stagedFrom:'staging', durationS:243 },
  ],

  // ── external-frontend-hr ──────────────────────────────────────────────────
  'hr-module:external-frontend-hr:dev': [
    { sha:'a3f8c21d4e9b7f6c0a1d2e3f4b5c6d7e8f9a0b1c', deployedAt:'2 days ago',  deployedAtAbs:'May 05, 2026 · 11:02', who:'tomas@harmonum.ai', message:'sync from worktree tomas — onboarding self-serve UI', status:'deployed', current:true, stagedFrom:'worktree/tomas', durationS:84 },
    { sha:'2c5f8a1d4b7e0c3f6a9b2d5e8c1f4a7b0d3e6c9f', deployedAt:'4 days ago',  deployedAtAbs:'May 03, 2026 · 12:18', who:'pavel@harmonum.ai', message:'sync from worktree pavel — login redesign', status:'deployed', stagedFrom:'worktree/pavel', durationS:79 },
    { sha:'3d6f9b2e5c8d1f4a7b0e3c6d9a2b5e8c1f4a7b0d', deployedAt:'7 days ago',  deployedAtAbs:'Apr 30, 2026 · 09:11', who:'tomas@harmonum.ai', message:'sync from worktree tomas — i18n scaffolding', status:'deployed', stagedFrom:'worktree/tomas', durationS:91 },
  ],
  'hr-module:external-frontend-hr:staging': [
    { sha:'7b2e9d4a8c1f5e3b6d9a0c2e4f8b1d3a5c7e9b2d', deployedAt:'5 days ago',  deployedAtAbs:'May 02, 2026 · 14:25', who:'tomas@harmonum.ai', message:'promote — login redesign + i18n', status:'deployed', current:true, stagedFrom:'dev', durationS:88 },
    { sha:'4f7a0d3b6e9c2f5a8b1d4e7c0f3a6b9e2d5c8f1a', deployedAt:'12 days ago', deployedAtAbs:'Apr 25, 2026 · 11:40', who:'pavel@harmonum.ai', message:'promote — accessibility audit fixes', status:'deployed', stagedFrom:'dev', durationS:82 },
  ],

  // ── invoice-backend ───────────────────────────────────────────────────────
  'invoice-automation:invoice-backend:dev': [
    { sha:'9c3a7e1d5b8f2c6a4d0e8b3f7c1a5d9e2b4f6c8a', deployedAt:'4 hours ago', deployedAtAbs:'May 07, 2026 · 10:18', who:'tomas@harmonum.ai', message:'sync from worktree tomas — three-way match exception flow', status:'deployed', current:true, stagedFrom:'worktree/tomas', durationS:103 },
    { sha:'5e8c1f4a7b0d3e6c9f2a5b8d1e4c7f0a3b6e9d2c', deployedAt:'1 day ago',   deployedAtAbs:'May 06, 2026 · 15:42', who:'tomas@harmonum.ai', message:'sync from worktree tomas — vendor template matching', status:'deployed', stagedFrom:'worktree/tomas', durationS:99 },
    { sha:'6a9d2c5f8b1e4a7d0c3f6a9b2e5d8c1f4a7b0e3c', deployedAt:'2 days ago',  deployedAtAbs:'May 05, 2026 · 09:11', who:'tomas@harmonum.ai', message:'sync from worktree tomas — wip OCR confidence', status:'rolled-back', stagedFrom:'worktree/tomas', durationS:67 },
  ],
  'invoice-automation:invoice-backend:staging': [
    { sha:'2e6b9d4a8c1f5e3b7d0a4c6e9f2b5d8a1c3e7f0b', deployedAt:'3 days ago',  deployedAtAbs:'May 04, 2026 · 14:00', who:'tomas@harmonum.ai', message:'promote — vendor template matching', status:'deployed', current:true, stagedFrom:'dev', durationS:108 },
    { sha:'7c0f3a6b9e2d5c8f1a4b7e0d3c6f9a2b5d8e1c4f', deployedAt:'10 days ago', deployedAtAbs:'Apr 27, 2026 · 12:30', who:'pavel@harmonum.ai', message:'promote — initial staging cutover', status:'deployed', stagedFrom:'dev', durationS:188 },
  ],
  'invoice-automation:invoice-backend:production': [
    { sha:'2e6b9d4a8c1f5e3b7d0a4c6e9f2b5d8a1c3e7f0b', deployedAt:'3 days ago',  deployedAtAbs:'May 04, 2026 · 16:30', who:'tomas@harmonum.ai', message:'promote — vendor template matching', status:'deployed', current:true, stagedFrom:'staging', durationS:172 },
    { sha:'8d1f4a7b0e3c6d9a2b5e8c1f4a7b0e3c6d9a2b5e', deployedAt:'15 days ago', deployedAtAbs:'Apr 22, 2026 · 09:00', who:'tomas@harmonum.ai', message:'promote — initial production cutover', status:'deployed', stagedFrom:'staging', durationS:201 },
  ],
};

// Per-stage runtime metadata (status / state / replicas / checksum / external URL).
// Key = `${bpId}:${automationId}:${stageId}`
const STAGE_RUNTIME = {
  'hr-module:backend-hr:dev':         { state:'running', up:'2 days',   active:true,  replicas:1, externalUrl:'https://dev.hr.harmonum.ai' },
  'hr-module:backend-hr:staging':     { state:'running', up:'5 days',   active:true,  replicas:2, externalUrl:'https://stg.hr.harmonum.ai' },
  'hr-module:backend-hr:production':  { state:'running', up:'11 days',  active:true,  replicas:4, externalUrl:'https://hr.harmonum.ai' },
  'hr-module:external-frontend-hr:dev':        { state:'running', up:'2 days',   active:true,  replicas:1, externalUrl:'https://dev.hr.harmonum.ai' },
  'hr-module:external-frontend-hr:staging':    { state:'running', up:'5 days',   active:true,  replicas:2, externalUrl:'https://stg.hr.harmonum.ai' },
  'invoice-automation:invoice-backend:dev':        { state:'running', up:'4 hours',  active:true,  replicas:1, externalUrl:'https://dev.inv.harmonum.ai' },
  'invoice-automation:invoice-backend:staging':    { state:'running', up:'3 days',   active:true,  replicas:2, externalUrl:'https://stg.inv.harmonum.ai' },
  'invoice-automation:invoice-backend:production': { state:'running', up:'15 days',  active:true,  replicas:6, externalUrl:'https://inv.harmonum.ai' },
};

// Scale events — interleaved with deployments in the timeline.
// Key = `${bpId}:${automationId}:${stageId}`
const SCALE_EVENTS = {
  'hr-module:backend-hr:production': [
    { kind:'scale', at:'1 day ago',   atAbs:'May 06, 2026 · 09:18', who:'tomas@harmonum.ai', from:2, to:4, reason:'manual — anticipated payroll run load' },
    { kind:'scale', at:'8 days ago',  atAbs:'Apr 29, 2026 · 14:32', who:'autoscaler',        from:1, to:2, reason:'CPU > 70% sustained 5m' },
  ],
  'hr-module:backend-hr:staging': [
    { kind:'scale', at:'4 days ago',  atAbs:'May 03, 2026 · 11:00', who:'tomas@harmonum.ai', from:1, to:2, reason:'manual — load testing' },
  ],
  'invoice-automation:invoice-backend:production': [
    { kind:'scale', at:'2 days ago',  atAbs:'May 05, 2026 · 16:05', who:'autoscaler',        from:4, to:6, reason:'queue depth > 200' },
    { kind:'scale', at:'12 days ago', atAbs:'Apr 25, 2026 · 10:11', who:'pavel@harmonum.ai', from:2, to:4, reason:'manual — month-end close prep' },
  ],
};

// Promotion audit policy per stage transition (configurable).
// Key = `${bpId}:${stageId}` for the TARGET stage.
const AUDIT_POLICY = {
  'hr-module:staging':    { required: 1, allowAi: true,  roles:['developer','auditor'], description:'1 audit · AI audits permitted' },
  'hr-module:production': { required: 2, allowAi: false, roles:['auditor'],              description:'2 human auditor sign-offs · AI not permitted' },
  'invoice-automation:staging':    { required: 1, allowAi: true,  roles:['developer','auditor'], description:'1 audit · AI audits permitted' },
  'invoice-automation:production': { required: 2, allowAi: false, roles:['auditor'],              description:'2 human auditor sign-offs · AI not permitted' },
};

// Pending audits — sign-offs collected on a candidate sha for a target stage.
// Key = `${bpId}:${automationId}:${targetStageId}:${candidateSha}`
const PENDING_AUDITS = {
  'hr-module:backend-hr:production:7b2e9d4a8c1f5e3b6d9a0c2e4f8b1d3a5c7e9b2d': [
    {
      who:'claude-sonnet-4.5 (audit-ai)', role:'auditor', kind:'ai',
      signedAt:'May 06, 2026 · 13:48',
      verdict:'approve',
      advisory:true,
      report:'Static analysis: net +118/-31 LOC across 9 files. Migrations 0042–0044 are additive — new columns nullable with defaults; no destructive ALTERs. Three-way match introduces one new outbound call to `payouts.internal/v2/match` (already on allowlist). PII surface unchanged. Risk: low. Note: advisory only — production policy requires 2 human sign-offs.',
    },
    {
      who:'jana@harmonum.ai', role:'auditor', kind:'human',
      signedAt:'May 06, 2026 · 14:02',
      verdict:'approve',
      report:'Reviewed migrations 0042–0044 — backwards compatible. Three-way match touches invoice payouts; verified rollback path. No PII schema changes.',
    },
  ],
  'invoice-automation:invoice-backend:production:2e6b9d4a8c1f5e3b7d0a4c6e9f2b5d8a1c3e7f0b': [
    {
      who:'claude-sonnet-4.5 (audit-ai)', role:'auditor', kind:'ai',
      signedAt:'May 04, 2026 · 12:18',
      verdict:'approve',
      report:'Static analysis passed. Vendor template matching change: net +42/-3 LOC across 4 files. No new external network calls. SQL diff is additive (new index on `vendor_aliases.alias`). Risk: low.',
    },
  ],
};

// Current viewer (drives role-gated UI for audit sign-offs)
const CURRENT_USER = {
  email: 'tomas@harmonum.ai',
  name:  'Tomas',
  roles: ['developer', 'auditor'],
};

window.WD_DATA = {
  STAGE_RUNTIME,
  SCALE_EVENTS,
  AUDIT_POLICY,
  PENDING_AUDITS,
  CURRENT_USER,
  BUSINESS_PROCESSES,
  WORKTREES_BY_BP,
  AUTOMATIONS_BY_BP,
  WORKTREE_AUTOMATIONS,
  REQUIREMENTS,
  READMES,
  KIND_META,
  DEPLOYMENT_HISTORY,
};

