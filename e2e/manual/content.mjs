/**
 * The editorial manual — copy lives here in version control; the walkthrough
 * only fills the screenshot SLOTS (by id). Each chapter narrates a real step an
 * operator takes in the product — the click, the modal, the feature — and ties
 * it to what ISO/IEC 27001, SOC 2, DORA, NIS2 and GDPR actually ask for.
 * Standards clauses are real; keep them accurate. "Go wide": every screen,
 * modal and feature a real operator touches on the Meridian Foods walkthrough is
 * a chapter here, and every chapter is printed from a live capture.
 *
 * A chapter slot {id,label,caption,dark} is matched to a captured PNG by `id`.
 * Slot ids MUST match the `capture(dashPage, '<id>')` calls in
 * tests/walkthrough.spec.ts. A slot with no capture renders an honest
 * "capture pending" placeholder rather than failing the build.
 */

export const MANUAL = {
  title: "Bitswan Bailey — The Operator's Handbook",
  subtitle: "The Operator's Handbook",
  edition: '2026 Edition',
  headline: 'Run it like it matters.',
  tagline: 'Business processes on infrastructure that defends itself.',
  blurb:
    'Staged deployment. One-click disaster-recovery rehearsals. Supply-chain ' +
    'scanning before anything ships. A GDPR record of processing that writes itself. ' +
    'Access control an auditor will actually like. This is the platform — and this ' +
    'manual, printed straight from a live system.',
  coverShot: { id: 'cover' },

  manifestoTitle: 'Why teams put Bitswan in front of what matters',
  promises: [
    { title: 'Ship without holding your breath', body: 'Promote dev → staging → production across three blue-green slots over two persistent databases. The live slot never blinks; the standby is always one cutover away.' },
    { title: 'Rehearse the disaster before it happens', body: 'Restore any production backup into an isolated DR slot, verify it by hand, mark it recovery-tested, then swap it live with a single ingress cutover. No data move. No downtime.' },
    { title: 'Know what’s inside before it runs', body: 'Every image is scanned for CVEs before deploy. Waivers live in your source tree, not buried in config. Auditors get a clean, signed story.' },
    { title: 'Trust the device, not just the password', body: 'The first operator claims the server; every device after is approved. Identity is enforced at the gate — your processes run safely behind it.' },
  ],

  chapters: [
    // ───────────────────────── Onboarding & the console ─────────────────────
    {
      num: '01', eyebrow: 'Get in safely', title: 'Claim & device trust',
      lede: 'The first operator claims the server and becomes root admin. Their device becomes the first trusted device — and every device after is approved, not assumed.',
      slots: [{ id: 'onboard-claim', label: 'Live capture', caption: 'Bailey onboarding · signed in, about to claim the server' }],
      sell: [
        'A password that leaks shouldn’t be the end of the story. Bailey binds access to <strong>trusted devices</strong>: Tomáš Novák signs in through your identity provider, claims the Meridian Foods server, and the browser he claimed from is enrolled as the first trusted device — its cookie now proves the hardware, not just the credential.',
        'From then on a new device must be <strong>approved by someone who already holds one</strong>: it shows a six-digit code and waits, and a trusted operator links it from <em>Your devices → Link a device</em>. The gate sits in front of everything — the console and every workspace app run behind it.',
      ],
      steps: ['Sign in at the onboarding host.', 'Click <b>Claim this server</b> — you become root admin and this device is trusted.', 'A new device shows a code and waits for approval.', 'Approve it from a trusted device, or revoke it from <b>People &amp; roles</b>.'],
      callout: { kind: 'Why it matters', text: 'Identity is enforced once, at the gate. Your business processes never have to reinvent authentication — and a stolen password alone never reaches them.' },
      standards: [
        { code: 'NIS2', clause: 'Art. 21(2)(j)', demand: '<b>Multi-factor authentication & secured access.</b> Device trust is a strong second factor bound to hardware — exactly the “MFA or continuous authentication” the directive expects.' },
        { code: 'SOC 2', clause: 'CC6.1', demand: '<b>Logical access security.</b> The gate authenticates and authorizes every request before it reaches a workspace app.' },
        { code: 'ISO/IEC 27001', clause: 'A.5.15 / A.8.5', demand: '<b>Access control & secure authentication.</b> Access is granted per identity and per device, and centrally revocable.' },
        { code: 'DORA', clause: 'Art. 9(3)', demand: '<b>Strong authentication mechanisms.</b> Protection of ICT systems requires robust access control — the gate provides it uniformly.' },
      ],
    },
    {
      num: '02', eyebrow: 'Draw the boundary', title: 'Workspaces',
      lede: 'A workspace is the access-control boundary — an isolated tenancy with an explicit owner and members. Who can see and do what is decided per workspace.',
      slots: [{ id: 'workspace-create', caption: 'Server Console · the Workspaces view with the Meridian Foods workspace' }],
      sell: [
        'From the Bailey Server Console, Tomáš creates the <strong>Meridian Foods</strong> workspace and becomes its owner. Creation is a live, streamed operation — you watch gitops, ingress and the dashboard come up before the workspace appears with an <em>Open</em> button.',
        'A workspace is a blast radius for <strong>access</strong>: its own processes, its own data, and its own roster. Only the people granted into it — at the role you give them — can reach its apps. (Promoting code through dev → staging → production happens <em>inside</em> a process; that’s the stages, not the workspace — see Ch&nbsp;09.)',
      ],
      steps: ['Open <b>Workspaces</b> in the console.', 'Click <b>New workspace</b>, name it (lowercase, hyphenated) — you’re the owner.', 'Watch it provision; press <b>Open</b> to enter its dashboard.', 'Invite members at the role they need.'],
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.8.3 / A.5.15', demand: '<b>Information access restriction & access control.</b> A workspace scopes who can reach its processes and data; access is granted per workspace.' },
        { code: 'SOC 2', clause: 'CC6.3', demand: '<b>Role-based access.</b> Membership and roles are assigned per workspace and enforced server-side.' },
        { code: 'NIS2', clause: 'Art. 21(2)(i)', demand: '<b>Asset management & access control.</b> Every workspace and its endpoints are inventoried and owned.' },
      ],
    },
    {
      num: '03', eyebrow: 'See the estate', title: 'Server overview & endpoints',
      lede: 'Before you build, know what you’re running. The console’s overview and endpoint pages inventory every workspace, route and protected endpoint on the server.',
      slots: [
        { id: 'server-overview', label: 'Live capture', caption: 'Server Console · the server overview' },
        { id: 'endpoint-access', label: 'Live capture', caption: 'Server Console · endpoint access — every protected route and its owner' },
      ],
      sell: [
        'The <strong>Server overview</strong> is the operator’s situational awareness: how many workspaces, how many trusted devices, the health of the platform’s own services. <strong>Endpoint access</strong> lists every protected hostname the gate fronts — workspace dashboards, gitops, automation frontends — each with its owner and the workspace it belongs to.',
        'This is your live asset register. When an auditor asks “what is exposed, and who owns it?”, the answer is a page, not an afternoon.',
      ],
      steps: ['Open <b>Server overview</b> for platform health and counts.', 'Open <b>Endpoint access</b> to see every protected route.', 'Confirm each endpoint has the right owner and workspace.'],
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.5.9', demand: '<b>Inventory of information and other associated assets.</b> Every workspace and protected endpoint is enumerated from real, live state.' },
        { code: 'NIS2', clause: 'Art. 21(2)(i)', demand: '<b>Asset management.</b> The estate of exposed services is inventoried with ownership.' },
        { code: 'SOC 2', clause: 'CC6.1', demand: '<b>Logical access security.</b> Each endpoint sits behind the gate with an explicit owner.' },
      ],
    },
    {
      num: '04', eyebrow: 'Manage your hardware', title: 'Your devices',
      lede: 'Every browser that reaches the platform is a named, trusted device you can see, label and revoke. Lose a laptop and you cut its access everywhere, instantly.',
      slots: [{ id: 'devices', label: 'Live capture', caption: 'Server Console · Your devices — trusted hardware, with the root device badged' }],
      sell: [
        'The <strong>Your devices</strong> page lists the hardware tied to your identity: the <em>Root device</em> that claimed the server, any <em>Admin-approved</em> or <em>Linked</em> devices, which one is in use right now. This is also where you <strong>Link a device</strong> — type the six-digit code a new browser is showing and it’s let in.',
        'De-provisioning is a click: sign a device out and its cookie is revoked across the whole platform. No password reset cascade, no orphaned sessions.',
      ],
      steps: ['Open <b>Your devices</b> in the console.', 'Review trusted devices and their badges.', 'To admit a new browser, enter its code under <b>Link a device</b>.', 'Sign out a lost device to revoke it everywhere.'],
      standards: [
        { code: 'SOC 2', clause: 'CC6.2 / CC6.3', demand: '<b>Access provisioning & de-provisioning.</b> Devices are granted and revoked centrally and immediately.' },
        { code: 'ISO/IEC 27001', clause: 'A.5.15 / A.8.1', demand: '<b>Access control & user-endpoint devices.</b> Trusted devices are enrolled, labelled and revocable.' },
        { code: 'NIS2', clause: 'Art. 21(2)(j)', demand: '<b>Secured access.</b> Hardware-bound trust is enrolled and managed per person.' },
      ],
    },

    // ───────────────────────── Inside the workspace ─────────────────────────
    {
      num: '05', eyebrow: 'Work in the open', title: 'The workspace & copies',
      lede: 'Open a workspace and you land in its dashboard, working in your own personal copy — an isolated branch where nothing you do touches main until you choose to.',
      slots: [
        { id: 'dashboard-open', label: 'Live capture', caption: 'Workspace dashboard · the business-process shell, your personal copy active' },
        { id: 'copy-switcher', label: 'Live capture', caption: 'Copy switcher · your copy, its sync state, and “New copy”' },
      ],
      sell: [
        'Every operator gets a <strong>personal copy</strong> of the workspace — auto-created and auto-selected the moment you open the dashboard. It’s your private branch: edit, build and preview without disturbing anyone else’s work or the live <em>main</em>.',
        'The <strong>copy switcher</strong> (top-right) shows which copy is active, whether it’s synced with main, and lets you spin up a <em>New copy</em>. Promotion of your work into main happens deliberately, through Sync &amp; Deploy (Ch&nbsp;08) — never by accident.',
      ],
      steps: ['Press <b>Open</b> on the workspace to enter its dashboard.', 'Your personal copy is selected automatically.', 'Use the <b>copy switcher</b> to see sync state or start a new copy.', 'Everything you build stays in your copy until you Sync &amp; Deploy.'],
      callout: { kind: 'Why it matters', text: 'Isolated copies are environment separation by default: experimentation never risks the shared main, and every change reaches production only through a reviewed, deliberate path.' },
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.8.31', demand: '<b>Separation of development, test and production.</b> A personal copy isolates work-in-progress from main and from deployed stages.' },
        { code: 'SOC 2', clause: 'CC8.1', demand: '<b>Change management.</b> Changes originate in an isolated copy and reach main only through Sync &amp; Deploy.' },
      ],
    },
    {
      num: '06', eyebrow: 'Define the work', title: 'Business processes',
      lede: 'A business process is the unit you build, ship and operate. Create one, and the workspace scaffolds its automations ready to fill in.',
      slots: [
        { id: 'bp-switcher', label: 'Live capture', caption: 'Business-process switcher · select or create a process' },
        { id: 'bp-create', label: 'Live capture', caption: 'New business process · naming the invoice-processing process' },
      ],
      sell: [
        'Meridian’s accounts-payable lives in one business process: <strong>invoice-processing</strong>. The <strong>New business process</strong> modal takes a name (lowercase, hyphenated) and scaffolds its automations — a backend and a frontend — so there’s something real to describe, build and deploy.',
        'The process is the boundary for everything that follows: its description, its code, its CVE checks, its stages, its secrets, its backups and its firewall are all scoped to it.',
      ],
      steps: ['Open the <b>business-process switcher</b> (top-left).', 'Click <b>New business process</b>.', 'Name it in the modal; press <b>Create</b>.', 'The process is scaffolded and selected.'],
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.5.9', demand: '<b>Inventory of assets.</b> Each business process is a named, owned unit of the estate.' },
        { code: 'ISO/IEC 27001', clause: 'A.8.25', demand: '<b>Secure development lifecycle.</b> Work is organised per process, with its own pipeline and controls.' },
      ],
    },
    {
      num: '07', eyebrow: 'Say what it does', title: 'Describe the process',
      lede: 'Before code, intent. Each business process carries a living specification — what it does, for whom, and the rules it must keep.',
      slots: [{ id: 'description', caption: 'Invoice Processing · the README, with a Mermaid flowchart of the invoice lifecycle' }],
      sell: [
        'Marek documents the <strong>Invoice Processing</strong> spec right in the dashboard: ingest vendor invoices, validate totals and VAT against the PO, route anything over €5,000 for approval, post the rest to the ledger. The editor is rich text with Markdown shortcuts and renders fenced <code>mermaid</code> blocks as diagrams.',
        'The description versions <em>with</em> the process — documentation that lives next to the code, not in a wiki that drifts. Ctrl+S saves; the indicator confirms it.',
      ],
      steps: ['Open the <b>Description</b> tab.', 'Write the spec; use a <code>mermaid</code> block for the flow.', 'Press <b>Ctrl+S</b> — it versions with the process.'],
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.5.37', demand: '<b>Documented operating procedures.</b> The process and its rules are written down and kept current alongside the code.' },
      ],
    },
    {
      num: '08', eyebrow: 'Build it', title: 'Coding Agent & requirements',
      lede: 'Describe the process, then let a coding agent build it — inside the workspace’s isolated sandbox — and pin the rules it must keep as runnable requirements.',
      slots: [
        { id: 'coding-agent', caption: 'Coding Agent · building the invoice flow inside the workspace' },
        { id: 'requirements', label: 'Live capture', caption: 'Requirements & tests · the rules the process must keep, as runnable specs' },
      ],
      sell: [
        'The <strong>Coding Agent</strong> works straight from your specification: a terminal and a file tree right in the workspace, writing the invoice-processing automation in your isolated copy you review before it ever reaches main. The point isn’t that there’s an agent — it’s <strong>where</strong> it runs. The agent runs <em>inside</em> Bailey, not beside it: it can only reach hosts the firewall allows, sees only the secrets you’ve granted, and everything it produces still passes Sync &amp; Deploy and the CVE checks before it ships.',
        'The <strong>Requirements &amp; tests</strong> tab turns the spec’s rules into runnable checks — VAT matches the PO, invoices over €5,000 are held, duplicate invoice numbers never post twice — so “does it still do what we promised?” is a button, not a meeting.',
      ],
      steps: ['Open the <b>Coding Agent</b> tab; start a session against your copy.', 'It builds the automation from the Description.', 'Open <b>Requirements &amp; tests</b>; record the rules as runnable specs.', 'Review the diff, then <b>Sync &amp; Deploy</b>.'],
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.8.25 / A.8.31', demand: '<b>Secure development lifecycle & environment separation.</b> The agent builds in an isolated copy/sandbox, never touching production directly.' },
        { code: 'NIS2', clause: 'Art. 21(2)(e)', demand: '<b>Security in development.</b> Agent output is CVE-scanned and reviewed before deploy.' },
        { code: 'SOC 2', clause: 'CC6.6', demand: '<b>Boundary protection.</b> The agent’s egress is constrained by the workspace firewall allow-list.' },
        { code: 'DORA', clause: 'Art. 24–26', demand: '<b>Resilience testing.</b> Requirements are runnable specifications, re-run on demand.' },
      ],
    },
    {
      num: '09', eyebrow: 'Ship changes', title: 'Sync & Deploy',
      lede: 'From a working copy to a healthy deployment — with the diff, the history and a security check standing between you and production.',
      slots: [
        { id: 'sync-deploy', label: 'Live capture', caption: 'Sync & Deploy · ready to ship invoice-processing to development' },
        { id: 'sync-deploy-diff', label: 'Live capture', caption: 'Diff sub-tab · the files that become the new main' },
        { id: 'sync-deploy-history', label: 'Live capture', caption: 'History sub-tab · copy + main commits with deploy markers' },
        { id: 'checks-cve', label: 'Live capture', caption: 'Checks sub-tab · CVEs of the image this deploy would build' },
      ],
      sell: [
        'One button does the careful thing: commit work-in-progress, rebase your copy onto main, fast-forward, and roll out to development — <strong>tracking the single deploy it started</strong> rather than racing a second one. While it works, the button reads <em>Working…</em> and the live deploy step streams into a toast.',
        'Around the button are the three things you check before shipping: the <strong>Diff</strong> (exactly what becomes main), the <strong>History</strong> (your copy’s and main’s commits, with deploy markers), and the <strong>Checks</strong> tab — the precise CVEs of the image this deploy <em>would</em> build. Click any CVE for its advisory; record what’s out of scope into your source tree, where review can see it.',
      ],
      steps: ['Open <b>Sync &amp; Deploy</b>.', 'Review the <b>Diff</b>, the <b>History</b>, and the <b>Checks</b> tab.', 'Press <b>Sync &amp; Deploy</b> — dev goes <b>Healthy</b>.', 'Promote when you’re ready.'],
      callout: { kind: 'Why it matters', text: 'The check happens on the image that will actually run — not last week’s scan. Security is a step in the flow, not a gate someone forgets.' },
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.8.8', demand: '<b>Management of technical vulnerabilities.</b> The image is CVE-scanned before it ships, with each finding linked to its advisory.' },
        { code: 'NIS2', clause: 'Art. 21(2)(e)', demand: '<b>Security in acquisition, development and maintenance, incl. vulnerability handling.</b> Waivers are versioned in-tree and reviewable.' },
        { code: 'DORA', clause: 'Art. 8–9', demand: '<b>ICT risk identification & protection.</b> Pre-deploy scanning makes risk identification automatic and auditable.' },
        { code: 'SOC 2', clause: 'CC8.1', demand: '<b>Change management.</b> Commit, rebase, deploy is one controlled, observable operation.' },
      ],
    },
    {
      num: '10', eyebrow: 'Know your ingredients', title: 'Supply chain',
      lede: 'A full software bill of materials for what you run — vulnerabilities ranked, advisories one click away, accepted risks recorded.',
      slots: [
        { id: 'supply-chain', label: 'Live capture', caption: 'Supply chain · the SBOM/CVE panel for the deployed image' },
      ],
      sell: [
        'Every deployed image carries an SBOM. The <strong>Supply chain</strong> view ranks vulnerabilities by severity and shows the affected package; opening a CVE links straight to osv.dev, NVD and GitHub advisories so triage starts with the facts.',
        'Out-of-scope decisions are explicit, attributable and stored in source — not a screenshot in someone’s inbox. The scan runs on the image that actually ships, so the picture is never stale.',
      ],
      steps: ['Open a stage → <b>Supply chain</b>.', 'Sort by severity; open a CVE for its advisory.', 'Record any out-of-scope decision in-tree.'],
      standards: [
        { code: 'NIS2', clause: 'Art. 21(2)(d)', demand: '<b>Supply-chain security.</b> You can produce, on demand, exactly what is inside what you run.' },
        { code: 'SOC 2', clause: 'CC7.1', demand: '<b>Vulnerability detection.</b> The SBOM and CVE scan run on the image that actually ships.' },
        { code: 'ISO/IEC 27001', clause: 'A.5.7 / A.8.8', demand: '<b>Threat intelligence & vulnerability management.</b> Continuous visibility of known vulnerabilities in your dependencies.' },
      ],
    },
    {
      num: '11', eyebrow: 'Promote with confidence', title: 'Blue-green production',
      lede: 'Three app slots over two persistent databases. The live slot owns production; the standby owns DR; the third is your zero-downtime buffer.',
      slots: [{ id: 'deployments-prod', label: 'Live capture', caption: 'Deployments · Production Healthy after promote, every stage green' }],
      sell: [
        'Promote dev → staging → production and the idle slot comes up on the live database, ingress repoints, the old slot retires. Promotion re-deploys the source stage’s recorded image verbatim — what reaches production is exactly what you tested, even if the workspace source has moved on. Users never see a gap.',
        'Production is a state you can read at a glance: which slot is live, which is standby, what’s <strong>Healthy</strong>, and the version each stage is current on.',
      ],
      steps: ['Open <b>Deployments → Development</b>.', 'Press <b>Promote</b> to staging, then to production.', 'Watch each stage report <b>Healthy</b> on screen.', 'Confirm Production shows the version you shipped.'],
      specs: [{ v: '3 slots', l: 'a / b / c app slots' }, { v: '2 DBs', l: 'persistent, slot-aware' }, { v: '0 s', l: 'downtime on promote' }],
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.8.32', demand: '<b>Change management.</b> Production changes follow a controlled, reversible promotion path.' },
        { code: 'ISO/IEC 27001', clause: 'A.8.31', demand: '<b>Separation of development, test and production.</b> The dev / staging / production stages keep environments cleanly separated within a process.' },
        { code: 'DORA', clause: 'Art. 9', demand: '<b>Protection & prevention.</b> Minimise the impact of changes on the availability of critical functions.' },
      ],
    },
    {
      num: '12', eyebrow: 'See what’s running', title: 'Containers',
      lede: 'The live container roster for a stage — every service of the deployment, its health, and per-container Logs, Inspect, and start/stop controls.',
      slots: [{ id: 'containers', label: 'Live capture', caption: 'Production · the live containers of the current deployment' }],
      sell: [
        'The <strong>Containers</strong> section is the operator’s ground truth for a stage: each member of the deployment as a real running container, with its status. Open <em>Logs</em> to read what it’s doing, <em>Inspect</em> for its configuration, or restart/stop a single service without touching the rest.',
        'On Disaster Recovery, each container resolves to the standby slot’s own instance — so you operate the recovered app, not the live one.',
      ],
      steps: ['Open a stage → <b>Containers</b>.', 'Read status per service.', 'Use <b>Logs</b> / <b>Inspect</b> to investigate.', 'Restart or stop a single container if needed.'],
      standards: [
        { code: 'SOC 2', clause: 'CC7.2', demand: '<b>System monitoring.</b> Container health is visible per service, per stage.' },
        { code: 'DORA', clause: 'Art. 10', demand: '<b>Detection.</b> Operators can observe the live state of every running service.' },
        { code: 'ISO/IEC 27001', clause: 'A.8.16', demand: '<b>Monitoring activities.</b> The running estate is observable in real time.' },
      ],
    },
    {
      num: '13', eyebrow: 'Keep secrets secret', title: 'Secrets',
      lede: 'Per-stage environment secrets, write-gated by role, injected at deploy and snapshotted with every deployment.',
      slots: [
        { id: 'secrets', label: 'Live capture', caption: 'Production · environment secrets, role-gated' },
        { id: 'secrets-edit', label: 'Live capture', caption: 'Adding a stage secret — key + value, never committed to source' },
      ],
      sell: [
        'The payment-gateway credentials and the approval threshold live as <strong>stage secrets</strong>: shared names, per-stage values. Members read; admins and auditors write. You add a key and value right in the dashboard, and it’s injected on the next deploy of that stage — never written into the repo.',
        'Every deployment captures the secret set in force at that moment, so an Inspect of any historical deploy shows exactly which secrets it ran with. No secrets in the repo, no secrets in a chat thread.',
      ],
      steps: ['Open a stage → <b>Secrets</b>.', 'Add keys (gateway id, threshold…) with their values.', 'They’re injected at deploy, never committed.', 'Each deploy snapshots the secret set in force.'],
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.8.24', demand: '<b>Use of cryptography & secret management.</b> Secrets are stored and injected securely, separated from source.' },
        { code: 'NIS2', clause: 'Art. 21(2)(h)', demand: '<b>Cryptography and, where appropriate, encryption.</b> Sensitive material is handled as such by default.' },
        { code: 'GDPR', clause: 'Art. 32', demand: '<b>Security of processing.</b> Credentials that protect personal data are kept out of source and role-gated.' },
      ],
    },
    {
      num: '14', eyebrow: 'Capture the truth', title: 'Backups & retention',
      lede: 'Point-in-time snapshots of the live database and object storage, with a retention policy and an audit trail.',
      slots: [
        { id: 'snapshot-create', label: 'Live capture', caption: 'Create snapshot · label and stage, before it runs' },
        { id: 'backups', label: 'Live capture', caption: 'Production · snapshot captured from the live DB' },
      ],
      sell: [
        'The <strong>Create snapshot</strong> dialog lets you label a snapshot and pick its stage; confirm and a task captures the <strong>live blue-green database</strong> — not a stale name — plus object storage, streaming its progress per store (Postgres, CouchDB, MinIO) so it never goes dark.',
        'The result is a snapshot you can see, size, restore and clone between stages. Retention is a policy, not a cron job someone half-remembers.',
      ],
      steps: ['Open <b>Production → Backups</b>.', 'Press <b>Create snapshot</b>; label it.', 'Watch it run; it lists with size and contents.', 'Set the retention policy.'],
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.8.13', demand: '<b>Information backup.</b> Backups are taken, retained and verifiable by restoration.' },
        { code: 'DORA', clause: 'Art. 12(1)', demand: '<b>Backup policies and procedures.</b> Scope and frequency are defined and enforced.' },
        { code: 'SOC 2', clause: 'A1.2', demand: '<b>Backup.</b> Snapshots of live data are taken on demand and on policy.' },
      ],
    },
    {
      num: '15', eyebrow: 'Sleep at night', title: 'Rehearse & restore (DR)',
      lede: 'A backup you’ve never restored is a rumor. Bitswan makes the rehearsal a routine, the architecture legible, and the real cutover a single click.',
      slots: [
        { id: 'dr-rehearse', label: 'Live capture', caption: 'Disaster Recovery · backup loaded into DR, recovery-tested' },
        { id: 'dr-architecture', label: 'Live capture', caption: 'Disaster Recovery · how the blue-green slots and swap work' },
      ],
      sell: [
        'Restore a production backup <strong>into the DR slot</strong> — never onto live production. The restore streams its progress per store; when it lands, the slot is marked <em>In DR now</em>. Open it, confirm it’s whole, and only the backup actually loaded into DR can be <strong>marked recovery-tested</strong>. The <em>How it works</em> tab explains the blue-green slots and the cutover in plain terms.',
        'When you must go live, the <strong>Restore</strong> pill performs an ingress cutover — <em>Make Disaster Recovery the live Production?</em> — and <code>-production</code> repoints to the verified slot. No data migration, no redeploy, no downtime. (In a rehearsal you open that dialog to see it, then cancel.)',
      ],
      steps: ['Take a production snapshot (Ch&nbsp;14).', 'Go to <b>Disaster Recovery → Rehearse &amp; restore</b>.', '<b>Restore into DR</b>, verify, <b>Mark recovery-tested</b>.', 'Use the <b>Restore</b> pill to swap live when needed.'],
      specs: [{ v: '0 s', l: 'downtime on a swap' }, { v: 'Quarterly', l: 'default test cadence' }, { v: 'Verified', l: 'test only what’s loaded' }],
      standards: [
        { code: 'DORA', clause: 'Art. 11–12', demand: '<b>Response, recovery & restoration testing.</b> You must regularly test your ability to restore — here it’s a routine, and the last pass is recorded.' },
        { code: 'SOC 2', clause: 'A1.2 / A1.3', demand: '<b>Backup & recovery testing.</b> Restores are rehearsed into an isolated DR slot and the test is recorded.' },
        { code: 'ISO/IEC 27001', clause: 'A.5.30 / A.8.13', demand: '<b>ICT readiness for continuity.</b> Backups are verified by restoration into an isolated slot.' },
        { code: 'NIS2', clause: 'Art. 21(2)(c)', demand: '<b>Business continuity & crisis management.</b> A zero-downtime swap means recovery doesn’t cost an outage.' },
      ],
    },
    {
      num: '16', eyebrow: 'Show your work', title: 'Deployment history & inspect',
      lede: 'A versioned, immutable audit log: every deploy, promotion, swap, backup and firewall change — and a per-deployment Inspect with the files, diff and secrets in force at the time.',
      slots: [
        { id: 'history', label: 'Live capture', caption: 'Deployment history · the audit trail of every event' },
        { id: 'inspect-modal', label: 'Live capture', caption: 'Inspect a deployment · files, diff vs current, secrets snapshot, image' },
      ],
      sell: [
        'Who shipped what, when, on which commit, and what changed — including backup, restore, swap and retention events. The history is derived from the versioned record, so it can’t be quietly edited. Each entry is a rollback point.',
        'Open <strong>Inspect</strong> on any deployment and you get the receipts: the exact files, the diff versus what’s current, the <strong>secrets snapshot</strong> it ran with, and a download of the image. When an auditor asks “show me”, you open a tab.',
      ],
      steps: ['Open a stage → <b>Deployment history</b>.', 'Read the timeline of events.', 'Press <b>Inspect</b> on an entry for files, diff and secrets.', 'Roll back to any entry if you must.'],
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.8.15', demand: '<b>Logging.</b> Operational events are recorded and protected from tampering.' },
        { code: 'DORA', clause: 'Art. 13', demand: '<b>Learning and evolving.</b> A complete record supports post-incident review.' },
        { code: 'NIS2', clause: 'Art. 21(2)(b)', demand: '<b>Incident handling.</b> Reconstruct exactly what happened from the audit trail.' },
        { code: 'SOC 2', clause: 'CC8.1', demand: '<b>Change management.</b> Every change is recorded with its diff and the config in force.' },
      ],
    },
    {
      num: '17', eyebrow: 'Control the edges', title: 'Firewall & data processing',
      lede: 'An egress allow-list with a GDPR data-processing record for every external host — approval workflow, versioning and the DPA on file.',
      slots: [
        { id: 'firewall', label: 'Live capture', caption: 'Firewall · the egress allow-list with its GDPR data-processing records' },
      ],
      sell: [
        'Meridian’s invoice flow may reach its vendor portals, the Czech business register and a payment gateway — and nothing else. Egress is <strong>default-deny</strong>. Each allowed host carries a <strong>GDPR data-processing record</strong>: the purpose, whether personal data flows to that recipient, the lawful basis, and the signed <strong>Data Processing Agreement</strong> on file.',
        'A new destination can’t go live until someone completes its processing record — so your Article&nbsp;30 register builds itself as the system is operated, instead of being reconstructed under audit pressure.',
      ],
      steps: ['Open a stage → <b>Firewall</b>.', 'Review hosts waiting for approval.', 'Complete the <b>GDPR data-processing record</b> (purpose, personal data, lawful basis).', 'Attach the processor’s <b>DPA</b> and approve — the host is recorded and allowed.'],
      callout: { kind: 'GDPR, by construction', text: 'Every external recipient of data is recorded with its purpose and contract at the moment it’s allowed. The record of processing activities (Art. 30) and the processor agreements (Art. 28) are a by-product of running the system — not a spreadsheet someone keeps separately.' },
      standards: [
        { code: 'GDPR', clause: 'Art. 30', demand: '<b>Records of processing activities.</b> Each external recipient is logged with its purpose and whether personal data is transferred — the register maintained automatically.' },
        { code: 'GDPR', clause: 'Art. 28', demand: '<b>Processor obligations.</b> A Data Processing Agreement is stored on file for every host that processes personal data before egress is allowed.' },
        { code: 'NIS2', clause: 'Art. 21(2)(a)', demand: '<b>Risk-analysis & network security policies.</b> Default-deny egress with reviewed, documented exceptions.' },
        { code: 'ISO/IEC 27001', clause: 'A.8.20–8.21', demand: '<b>Network & network-service security.</b> Outbound connections are controlled per service.' },
      ],
    },
    {
      num: '18', eyebrow: 'Right people, right rights', title: 'People & roles',
      lede: 'A roster with explicit roles — operator, auditor, member — and per-person trusted devices you can approve or revoke.',
      slots: [{ id: 'people-roles', label: 'Live capture', caption: 'People & roles · the Meridian Foods roster' }],
      sell: [
        'Tomáš operates, Eva audits (read-only oversight, sets the recovery cadence), Marek and the team build. Roles are enforced server-side, not just hidden in the UI. This is also where pending devices are approved and lost ones revoked.',
        'Each person’s devices are visible; approve a new laptop, revoke a lost one — instantly, everywhere.',
      ],
      steps: ['Open <b>People &amp; roles</b> in the console.', 'Review roles across the team.', 'Approve a pending device by its code.', 'Revoke a device or change a role as people join and leave.'],
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.5.18 / A.5.3', demand: '<b>Access rights & segregation of duties.</b> Operator, auditor and member are distinct roles with least privilege.' },
        { code: 'SOC 2', clause: 'CC6.2 / CC6.3', demand: '<b>Access provisioning & de-provisioning.</b> Roles and per-person trusted devices are granted and revoked centrally.' },
        { code: 'NIS2', clause: 'Art. 21(2)(i)', demand: '<b>Human-resources security & access control.</b> Access is role-based and reviewable.' },
        { code: 'DORA', clause: 'Art. 9(4)', demand: '<b>Access management on a need-to-know basis.</b> Auditors get oversight without write power.' },
      ],
    },
  ],

  // ----------------------------------------------------------------------------
  // Reference appendix: per-standard technical-controls guides. At a glance, what
  // Bailey gives you vs. what you operate yourself, with a pointer to the chapter
  // that shows it. Status: 'provided' (✓), 'partial' (◑), 'yours' (○).
  // ----------------------------------------------------------------------------
  controlGuides: [
    {
      standard: 'ISO/IEC 27001:2022',
      blurb: 'Annex A technical controls. Bailey implements the platform-side controls below; the management-system controls (policies, risk assessment, HR, physical) remain yours.',
      rows: [
        { control: 'A.5.9', req: 'Inventory of assets', status: 'provided', bailey: 'Workspaces, endpoints and processes enumerated from live state', ch: '03 · 06', yours: 'Asset classification policy' },
        { control: 'A.5.15 / A.8.5', req: 'Access control & secure authentication', status: 'provided', bailey: 'Device-trust gate + OIDC at the platform edge', ch: '01 · 04', yours: 'Your IdP, joiner/leaver process' },
        { control: 'A.5.18', req: 'Access rights (least privilege, review)', status: 'provided', bailey: 'Operator / auditor / member roles, server-enforced', ch: '18', yours: 'Periodic access reviews' },
        { control: 'A.8.8', req: 'Management of technical vulnerabilities', status: 'provided', bailey: 'Pre-deploy CVE scan + in-tree waivers', ch: '09 · 10', yours: 'Triage & remediation SLAs' },
        { control: 'A.8.9', req: 'Configuration management', status: 'partial', bailey: 'bitswan.yaml as declarative source of truth', ch: '11', yours: 'Baseline definition & review' },
        { control: 'A.8.13', req: 'Information backup', status: 'provided', bailey: 'Per-stage snapshots + retention policy', ch: '14', yours: 'Offsite copy & retention targets' },
        { control: 'A.8.15 / A.8.16', req: 'Logging & monitoring', status: 'partial', bailey: 'Versioned deployment & event history; live container health', ch: '12 · 16', yours: 'SIEM aggregation, alerting' },
        { control: 'A.8.20 / A.8.21', req: 'Network & network-services security', status: 'provided', bailey: 'Default-deny egress allow-list per service', ch: '17', yours: 'Perimeter & internal segmentation policy' },
        { control: 'A.8.24', req: 'Use of cryptography & secrets', status: 'provided', bailey: 'Stage secrets, injected not committed; TLS at edge', ch: '13', yours: 'Key-management policy' },
        { control: 'A.8.31', req: 'Separation of dev/test/production', status: 'provided', bailey: 'Isolated copies + dev / staging / production stages', ch: '05 · 11', yours: '—' },
        { control: 'A.8.3', req: 'Information access restriction', status: 'provided', bailey: 'Workspaces scope access per tenancy + role', ch: '02', yours: 'Membership reviews' },
        { control: 'A.8.32', req: 'Change management', status: 'provided', bailey: 'Reversible blue-green promotion path + immutable history', ch: '11 · 16', yours: 'Change approval workflow' },
        { control: 'A.5.30', req: 'ICT readiness for business continuity', status: 'provided', bailey: 'DR slot + rehearsed, recorded recovery tests', ch: '15', yours: 'BCP/DR plan & RTO/RPO targets' },
      ],
    },
    {
      standard: 'SOC 2 (Trust Services Criteria)',
      blurb: 'The common-criteria and availability TSCs Bailey supports as a service component. Your audit still covers the organizational criteria (CC1–CC5), risk assessment and vendor management.',
      rows: [
        { control: 'CC6.1', req: 'Logical access security', status: 'provided', bailey: 'Device-trust gate fronting every endpoint', ch: '01 · 03', yours: 'Access policy & ownership' },
        { control: 'CC6.2 / CC6.3', req: 'Access provisioning & removal', status: 'provided', bailey: 'Central role + device grant/revoke', ch: '04 · 18', yours: 'Timely de-provisioning process' },
        { control: 'CC6.6', req: 'Boundary protection', status: 'provided', bailey: 'Default-deny egress allow-list', ch: '17', yours: 'Network perimeter design' },
        { control: 'CC6.7', req: 'Data in transit & at rest', status: 'provided', bailey: 'TLS at the edge (traefik) with managed cert lifecycle; backups encrypted', ch: '01 · 14', yours: 'Disk encryption on the Bailey host (at rest)' },
        { control: 'CC7.1', req: 'Vulnerability detection', status: 'provided', bailey: 'SBOM + CVE scan on the image that ships', ch: '10', yours: 'Remediation tracking' },
        { control: 'CC7.2', req: 'System monitoring', status: 'partial', bailey: 'Container health + event history', ch: '12 · 16', yours: 'Alerting & on-call' },
        { control: 'CC8.1', req: 'Change management', status: 'provided', bailey: 'Promotion pipeline + immutable deploy history', ch: '09 · 11 · 16', yours: 'Change authorization' },
        { control: 'A1.2', req: 'Backup & environmental protection', status: 'provided', bailey: 'Snapshots + standby DR slot', ch: '14 · 15', yours: 'Backup off-platform' },
        { control: 'A1.3', req: 'Recovery testing', status: 'provided', bailey: 'Rehearse-into-DR + recorded recovery tests', ch: '15', yours: 'Test cadence sign-off' },
      ],
    },
    {
      standard: 'DORA (Regulation (EU) 2022/2554)',
      blurb: 'The ICT risk-management articles Bailey operationalizes for financial entities. Governance, incident reporting to authorities, and third-party registers remain your obligation.',
      rows: [
        { control: 'Art. 8', req: 'Identification of ICT risk', status: 'provided', bailey: 'Pre-deploy supply-chain / CVE identification', ch: '10', yours: 'Risk register & classification' },
        { control: 'Art. 9(3)', req: 'Strong authentication & protection', status: 'provided', bailey: 'Device-trust gate', ch: '01', yours: 'Identity governance' },
        { control: 'Art. 9', req: 'Protection & prevention (change impact)', status: 'provided', bailey: 'Zero-downtime blue-green change path', ch: '11', yours: 'Segregation policy' },
        { control: 'Art. 10', req: 'Detection of anomalous activity', status: 'partial', bailey: 'Container health + deployment/event history', ch: '12 · 16', yours: 'Detection thresholds & alerting' },
        { control: 'Art. 11', req: 'Response & recovery', status: 'provided', bailey: 'One-cutover DR swap, no data move', ch: '15', yours: 'Crisis-management plan' },
        { control: 'Art. 12', req: 'Backup, restoration & testing', status: 'provided', bailey: 'Snapshots + rehearsed DR restores', ch: '14 · 15', yours: 'RTO/RPO & offsite policy' },
        { control: 'Art. 13', req: 'Learning & evolving', status: 'provided', bailey: 'Complete, inspectable deploy audit trail', ch: '16', yours: 'Post-incident review process' },
        { control: 'Art. 24–26', req: 'Resilience testing programme', status: 'partial', bailey: 'Runnable requirement tests + DR rehearsals', ch: '08 · 15', yours: 'TLPT for significant entities' },
      ],
    },
    {
      standard: 'NIS2 (Directive (EU) 2022/2555)',
      blurb: 'The Article 21(2) cybersecurity-risk-management measures Bailey delivers technically. Governance, training and incident notification to your CSIRT stay with you.',
      rows: [
        { control: 'Art. 21(2)(a)', req: 'Risk analysis & network security', status: 'partial', bailey: 'Default-deny egress with reviewed exceptions', ch: '17', yours: 'Risk-analysis methodology' },
        { control: 'Art. 21(2)(b)', req: 'Incident handling', status: 'partial', bailey: 'Reconstruct events from the audit trail', ch: '16', yours: 'Incident response & notification' },
        { control: 'Art. 21(2)(c)', req: 'Business continuity & backups', status: 'provided', bailey: 'Backups + zero-downtime DR swap', ch: '14 · 15', yours: 'BCP & crisis comms' },
        { control: 'Art. 21(2)(d)', req: 'Supply-chain security', status: 'provided', bailey: 'SBOM + CVE visibility per image', ch: '10', yours: 'Supplier assessment' },
        { control: 'Art. 21(2)(e)', req: 'Secure development & vuln handling', status: 'provided', bailey: 'Pre-deploy checks + versioned waivers', ch: '09', yours: 'SDLC policy' },
        { control: 'Art. 21(2)(h)', req: 'Cryptography', status: 'provided', bailey: 'Secret handling + TLS at the edge', ch: '13', yours: 'Crypto policy' },
        { control: 'Art. 21(2)(i)', req: 'Access control & asset management', status: 'provided', bailey: 'Roles + workspace/endpoint inventory', ch: '02 · 03 · 18', yours: 'Asset ownership' },
        { control: 'Art. 21(2)(j)', req: 'Multi-factor authentication', status: 'provided', bailey: 'Hardware-bound device trust', ch: '01 · 04', yours: 'Enrolment policy' },
      ],
    },
    {
      standard: 'GDPR (Regulation (EU) 2016/679)',
      blurb: 'The security-of-processing and accountability articles Bailey supports. Lawful basis, data-subject rights, DPIAs and breach notification remain controller obligations.',
      rows: [
        { control: 'Art. 30', req: 'Records of processing activities', status: 'provided', bailey: 'Per-egress data-processing record, auto-maintained', ch: '17', yours: 'Controller-level register' },
        { control: 'Art. 28', req: 'Processor obligations / DPAs', status: 'provided', bailey: 'DPA stored before egress is allowed', ch: '17', yours: 'Contract terms & due diligence' },
        { control: 'Art. 32', req: 'Security of processing', status: 'provided', bailey: 'Access control, secrets, backup & resilience', ch: '13 · 14 · 15', yours: 'Risk-based measures & review' },
        { control: 'Art. 5(1)(f)', req: 'Integrity & confidentiality', status: 'provided', bailey: 'Gated access + default-deny egress', ch: '01 · 17', yours: 'Data-handling policy' },
        { control: 'Art. 33', req: 'Breach notification', status: 'partial', bailey: 'Audit trail to reconstruct what happened', ch: '16', yours: '72-hour notification process' },
      ],
    },
  ],
};
