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
    'Access control an auditor will actually like.',
  coverShot: { id: 'cover' },

  // The opening thesis — the first page after the cover. Why Bailey exists.
  thesis: {
    kicker: 'The thesis',
    title: 'You shouldn’t have to build the car.',
    body: [
      'For years, “business-process automation” has meant <strong>sheet-metal products</strong>: all the parts you need to build a car. A pile of screws, brackets and sub-assemblies — with a manual that quietly assumes you’ll weld the chassis, wire the loom and certify the brakes yourself. You wanted to move goods; you got a parts catalogue.',
      'The “off-the-shelf” platforms that promised to spare you the assembly were designed <strong>before the agentic-coding era</strong>. Next to what’s now possible, they’re <strong>toy cars</strong> — fine on a showroom floor, never built for the road you actually drive.',
      'Bailey is a real, fully functional <strong>business-process automation platform</strong> — ready and <strong>compliant</strong> out of the box, not a kit you assemble and certify yourself. Staged deployment, one-click disaster-recovery rehearsals, supply-chain scanning, device-bound access and a self-writing GDPR record are already in the chassis.',
      'So you can think about <strong>where you’re driving</strong> — not how to install the engine.',
    ],
  },

  manifestoTitle: 'Why teams put Bitswan in front of what matters',
  promises: [
    { title: 'Ship without holding your breath', body: 'Promote dev → staging → production across three blue-green slots over two persistent databases. The live slot never blinks; the standby is always one cutover away.' },
    { title: 'Rehearse the disaster before it happens', body: 'Restore any production backup into an isolated DR slot, verify it by hand, mark it recovery-tested, then swap it live with a single ingress cutover. No data move. No downtime.' },
    { title: 'Know what’s inside before it runs', body: 'Every image is scanned for CVEs before deploy. Waivers live in your source tree, not buried in config. Auditors get a clean, signed story.' },
    { title: 'Trust the device, not just the password', body: 'The first operator claims the server; every device after is explicitly approved. Bailey practises defence in depth — your processes stay protected even if a password leaks or your identity provider is compromised.' },
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
      callout: { kind: 'Why it matters', text: 'Bailey practises defence in depth. It is an isolated, self-protecting system using what we call end-to-end authentication — so a stolen password, or even a fully compromised identity-provider / SSO account, does not compromise Bailey or reach the business processes behind it.' },
      standards: [
        { code: 'NIS2', clause: 'Art. 21(2)(j)', demand: '<b>Multi-factor authentication & secured access.</b> Device trust is a strong second factor bound to hardware — exactly the “MFA or continuous authentication” the directive expects.' },
        { code: 'SOC 2', clause: 'CC6.1', demand: '<b>Logical access security.</b> The gate authenticates and authorizes every request before it reaches a workspace app.' },
        { code: 'ISO/IEC 27001', clause: 'A.5.15 / A.8.5', demand: '<b>Access control & secure authentication.</b> Access is granted per identity and per device, and centrally revocable.' },
        { code: 'DORA', clause: 'Art. 9(3)', demand: '<b>Strong authentication mechanisms.</b> Protection of ICT systems requires robust access control — the gate provides it uniformly.' },
      ],
    },
    {
      num: '02', eyebrow: 'Draw the boundary', title: 'Workspaces',
      lede: 'A workspace is a thematic access-control boundary — an isolated tenancy, scoped to a body of work and the team that does it. Who can see and do what is decided per workspace.',
      slots: [{ id: 'workspace-create', caption: 'Server Console · the Workspaces view with the Finance workspace' }],
      sell: [
        'Workspaces are <strong>thematic, not per-company</strong>. Meridian Foods automates invoice-processing as part of its finance work, so Tomáš creates a <strong>Finance</strong> workspace from the Bailey Server Console and becomes its owner. It is shared only with the people automating finance processes; a separate <em>Logistics</em> workspace would be its own tenancy, invisible to them. Creation is a live, streamed operation — you watch gitops, ingress and the dashboard come up before the workspace appears with an <em>Open</em> button.',
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
        'This is also your <strong>incident response for a stolen or lost device</strong>. Because access is bound to the device, not just the password, a thief who has an unlocked laptop already holds a valid session — rotating the password alone does not lock them out. <strong>Removing the device</strong> does: it revokes that device’s cookie across the entire platform instantly, so the console and every workspace app stop trusting it the moment you click. The drill is simple and fast — find the lost device in the list, remove it, done — which is exactly why every device is named and badged: so under pressure you can tell which one to cut.',
      ],
      steps: ['Open <b>Your devices</b> in the console.', 'Review trusted devices and their badges.', 'To admit a new browser, enter its code under <b>Link a device</b>.', '<b>Lost or stolen device?</b> Remove it here — its access is revoked everywhere, instantly. That, not a password reset, is the response.'],
      callout: { kind: 'If a device is stolen', text: 'Device-bound access means a stolen, unlocked laptop is a live session a password change can’t stop. The incident response is to <strong>remove the device</strong> — one click revokes its cookie across the console and every workspace app immediately. Keep devices named so you can identify the one to cut without hesitation.' },
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
        'The <strong>copy switcher</strong> (top-right) shows which copy is active, whether it’s synced with main, and lets you spin up a <em>New copy</em>. Promotion of your work into main happens deliberately, through Sync &amp; Deploy (Ch&nbsp;10) — never by accident.',
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
      slots: [
        { id: 'description', caption: 'Invoice Processing · the README spec, with the flowchart of the invoice lifecycle drawn into it' },
        { id: 'flowchart-editor', label: 'Live capture', caption: 'Flowchart editor · drawing the invoice flow node-by-node, no diagram syntax to learn' },
      ],
      sell: [
        'Marek documents the <strong>Invoice Processing</strong> spec right in the dashboard: ingest vendor invoices, validate totals and VAT against the PO, route anything over €5,000 for approval, post the rest to the ledger. The editor is rich text with Markdown shortcuts.',
        'For the process flow he doesn’t hand-write diagram code — he opens the <strong>flowchart editor</strong> from the toolbar and <strong>draws</strong> it: drop a node (Process, Decision or Terminal), drag from one node’s handle to another to connect them, label as he goes, then <em>Save diagram</em> drops the rendered flowchart straight into the spec. The description versions <em>with</em> the process — documentation that lives next to the code, not in a wiki that drifts. Ctrl+S saves; the indicator confirms it.',
      ],
      steps: ['Open the <b>Description</b> tab.', 'Write the spec in rich text.', 'Click the toolbar <b>Insert flowchart</b> button and <b>draw</b> the flow — add nodes, drag to connect, then <b>Save diagram</b>.', 'Press <b>Ctrl+S</b> — it versions with the process.'],
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.5.37', demand: '<b>Documented operating procedures.</b> The process and its rules are written down and kept current alongside the code.' },
      ],
    },
    {
      num: '08', eyebrow: 'Build it', title: 'Coding Agent & requirements',
      lede: 'Describe the process, then let a coding agent build it — inside the workspace’s isolated sandbox — and pin the rules it must keep as runnable requirements.',
      slots: [
        { id: 'coding-agent', caption: 'Coding Agent · the automations of the invoice flow, each with its live-dev preview' },
        { id: 'live-dev', label: 'Live capture', caption: 'Live-dev · the automation running its live preview in your copy — click its frontend to open it' },
        { id: 'requirements', label: 'Live capture', caption: 'Requirements & tests · the rules the process must keep, as runnable specs' },
      ],
      sell: [
        'The <strong>Coding Agent</strong> works straight from your specification: a terminal and a file tree right in the workspace, writing the invoice-processing automation in your isolated copy you review before it ever reaches main. The point isn’t that there’s an agent — it’s <strong>where</strong> it runs. The agent runs <em>inside</em> Bailey, not beside it: it works in an isolated copy and, while it can reach the internet to do its job, it is <strong>walled off from your production data</strong> — it cannot reach the production database or the user data in it. Everything it produces still passes Sync &amp; Deploy and the CVE checks before it ships.',
        'Each automation in your copy also gets a <strong>live-dev</strong> deployment — a running preview that auto-builds as you change code. To open a running automation you click its <strong>frontend</strong> (the frontend automation’s open link in the Environment panel) and click through the real thing in your copy before it touches main. The <strong>Requirements &amp; tests</strong> tab turns the spec’s rules into runnable checks — VAT matches the PO, invoices over €5,000 are held, duplicate invoice numbers never post twice — so “does it still do what we promised?” is a button, not a meeting.',
      ],
      steps: ['Open the <b>Coding Agent</b> tab; start a session against your copy.', 'It builds the automation from the Description; the <b>live-dev</b> preview comes up.', 'Click a running automation’s <b>frontend</b> to open it and click through it.', 'Open <b>Requirements &amp; tests</b>; record the rules as runnable specs, then <b>Sync &amp; Deploy</b>.'],
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.8.25 / A.8.31', demand: '<b>Secure development lifecycle & environment separation.</b> The agent builds in an isolated copy/sandbox, never touching production directly.' },
        { code: 'NIS2', clause: 'Art. 21(2)(e)', demand: '<b>Security in development.</b> Agent output is CVE-scanned and reviewed before deploy.' },
        { code: 'SOC 2', clause: 'CC6.6', demand: '<b>Boundary protection.</b> The agent’s egress is constrained by the workspace firewall allow-list.' },
        { code: 'DORA', clause: 'Art. 24–26', demand: '<b>Resilience testing.</b> Requirements are runnable specifications, re-run on demand.' },
      ],
    },
    {
      num: '09', eyebrow: 'Separate the blast radius', title: 'Dev, staging & production',
      lede: 'A business process promotes through three stages — Development, Staging and Production — and each one runs on its own database, its own file store and its own isolated Docker network. The data of one stage is never the data of another, and the stages literally cannot reach each other.',
      slots: [{ id: 'stages', label: 'Live capture', caption: 'Deployments · the dev → staging → production pipeline, each stage its own isolated database + file store' }],
      sell: [
        'Meridian’s invoice-processing process doesn’t go straight to production. It promotes through three stages — <strong>Development → Staging → Production</strong> — and the point of the split is isolation: each stage has <strong>its own database, its own file store and its own Docker network</strong>, so the records, attachments and ledger entries in one stage are never the records of another — and because the networks are separate, the stages <strong>literally cannot talk to each other</strong>. User and production data is <strong>never shared</strong> across the line. That means you can run the application in dev and exercise it hard in staging — wrong totals, malformed VAT numbers, deliberate edge cases — <strong>without ever touching real production data</strong>, because the data simply isn’t there to touch.',
        'The split is also <strong>who</strong>, not just <strong>where</strong>. Because production is its own stage with its own gate, an experienced team member can <strong>audit and review the code before it reaches production</strong>: a member builds and ships through dev and staging, and promotion to production is a deliberate, reviewable step rather than an accident. That separation of duties — build over here, sign off over there — is exactly what an auditor expects to see, and it falls out of the stage model rather than being bolted on.',
      ],
      steps: ['Open <b>Deployments</b> and read the pipeline: <b>Development</b>, <b>Staging</b>, <b>Production</b>.', 'Build and test in <b>Development</b> against its own isolated database and file store.', 'Promote to <b>Staging</b> and exercise the app on staging’s own data — never production’s.', 'Have an experienced reviewer sign off before the deliberate promotion to <b>Production</b>.'],
      callout: { kind: 'Why it matters', text: 'Three stages, three databases, three file stores, three isolated Docker networks — the stages cannot even reach one another. Testing in dev and staging can never expose or corrupt real production data, and production changes pass through a reviewable promotion — separation of duties and environment isolation, by construction.' },
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.8.31', demand: '<b>Separation of development, test and production environments.</b> Dev, staging and production each run on their own database, file store and Docker network — the stages cannot reach one another and production data is never present in a test stage.' },
        { code: 'SOC 2', clause: 'CC8.1', demand: '<b>Change management.</b> Changes are built and tested in lower stages and reach production only through a deliberate, reviewable promotion.' },
        { code: 'GDPR', clause: 'Art. 5(1)(c)', demand: '<b>Data minimisation.</b> Real personal data lives only in production; dev and staging are tested without using production user data.' },
      ],
    },
    {
      num: '10', eyebrow: 'Ship changes', title: 'Sync & Deploy',
      lede: 'From a working copy to a healthy deployment — with the diff, the history and a security check standing between you and production.',
      slots: [
        { id: 'sync-deploy', label: 'Live capture', caption: 'Sync & Deploy · ready to ship invoice-processing to development' },
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
      num: '11', eyebrow: 'Promote with confidence', title: 'Blue-green production',
      lede: 'Three app slots over two persistent databases. The live slot owns production; the standby owns DR; the third is your zero-downtime buffer.',
      slots: [
        { id: 'promote-progress', label: 'Live capture', caption: 'Promotion in flight (dev → staging) · the idle slot coming up, the live step streaming, before the cutover' },
        { id: 'promote-progress-prod', label: 'Live capture', caption: 'Promotion in flight (staging → production) · the standby slot building on the live database before the production cutover' },
        { id: 'deployments-prod', label: 'Live capture', caption: 'Deployments · Production Healthy after promote, every stage green' },
      ],
      sell: [
        'Promote dev → staging → production and the idle slot comes up on the live database, ingress repoints, the old slot retires. The pipeline tells you what it’s doing the whole way — the stage card streams its live step as the standby slot builds and starts. Promotion re-deploys the source stage’s recorded image verbatim — what reaches production is exactly what you tested, even if the workspace source has moved on. Users never see a gap.',
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
      num: '12', eyebrow: 'Show your work', title: 'Deployment history & inspect',
      lede: 'A versioned, immutable audit log: every deploy, promotion, swap, backup and firewall change — and a per-deployment Inspect with the files, diff and secrets in force at the time.',
      slots: [
        { id: 'history', label: 'Live capture', caption: 'Deployment history · the audit trail of every event, with Inspect and Roll back per entry' },
        { id: 'inspect-modal', label: 'Live capture', caption: 'Inspect · the source file tree of exactly what this deployment ran' },
        { id: 'inspect-diff', label: 'Live capture', caption: 'Inspect → Diff vs current · what changed between this deployment and what’s live now' },
        { id: 'inspect-image', label: 'Live capture', caption: 'Inspect → Download image · the built image + schema bundle for offline audit' },
        { id: 'rollback-modal', label: 'Live capture', caption: 'Roll back · the confirmation before re-deploying a prior recorded version' },
      ],
      sell: [
        'Who shipped what, when, on which commit, and what changed — including backup, restore, swap and retention events. The history is derived from the versioned record, so it can’t be quietly edited. Each entry is a rollback point: <strong>Roll back</strong> re-deploys that exact recorded version (its image, verbatim) and records the action as a new <em>rolled back</em> entry at the top of the timeline — so recovering from a bad change is a click and a confirmation, not a scramble, and the recovery itself is auditable.',
        'What makes the trail trustworthy is the canonical <code>main</code> branch itself: it is a <strong>protected branch that accepts only fast-forward merges</strong>. Every deploy advances <code>main</code> forward — never a force-push, never a rebase that rewrites what came before — so history can only be <strong>appended to, never rewritten</strong>. There is no <code>git push --force</code> that quietly erases a deploy, and no way for the operator (or anyone) to go back and edit the record of what shipped. The append-only commit graph <em>is</em> the audit log: it is immutable by construction, not by policy, so when an auditor asks whether the deployment history could have been tampered with, the answer is that the branch protection makes it impossible.',
        'Open <strong>Inspect</strong> on any deployment and you get the receipts across several tabs — <em>Files</em> (the exact source tree it ran), <em>Diff vs current</em> (what changed versus what’s live), <em>Secrets snapshot</em> (the secret set in force), <em>Download image</em> (the built image + schema bundle), and, on the current deployment, <em>Scale</em>. When an auditor asks “show me”, you open a tab.',
      ],
      steps: ['Open a stage → <b>Deployment history</b>.', 'Read the timeline of events.', 'Press <b>Inspect</b> on a prior entry; step through <b>Files</b>, <b>Diff vs current</b> (a real diff against what’s live) and <b>Download image</b>.', 'Press <b>Roll back</b> on a prior entry and confirm to re-deploy that exact recorded version.'],
      callout: { kind: 'An audit log you can’t tamper with', text: 'The canonical <code>main</code> branch is protected and <strong>fast-forward-only</strong> — every deploy advances it forward, never a force-push or a rewrite. History can only be appended to, so the deployment record is immutable <em>by construction</em>. Even the operator cannot quietly edit what shipped: the branch protection, not a promise, is what makes the trail tamper-proof.' },
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.8.15', demand: '<b>Logging (integrity & tamper-protection).</b> Operational events are recorded on a fast-forward-only protected <code>main</code> — append-only and rewrite-proof, so the log is protected from tampering by construction, including by the operator.' },
        { code: 'DORA', clause: 'Art. 13', demand: '<b>Learning and evolving.</b> A complete record supports post-incident review.' },
        { code: 'NIS2', clause: 'Art. 21(2)(b)', demand: '<b>Incident handling.</b> Reconstruct exactly what happened from the audit trail.' },
        { code: 'SOC 2', clause: 'CC8.1', demand: '<b>Change management.</b> Every change is recorded with its diff and the config in force.' },
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
      num: '14', eyebrow: 'See what’s running', title: 'Containers',
      lede: 'The live container roster for a stage — every service of the deployment, its health, and per-container Logs, Inspect, and start/stop controls.',
      slots: [
        { id: 'containers', label: 'Live capture', caption: 'Production · the live containers of the current deployment' },
        { id: 'container-logs', label: 'Live capture', caption: 'Container logs · the live log stream of a running service, read straight from the deployment' },
        { id: 'container-inspect', label: 'Live capture', caption: 'Container inspect · the service’s configuration — identity, image, network — at a glance' },
      ],
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
      num: '15', eyebrow: 'Capture the truth', title: 'Backups & retention',
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
      num: '16', eyebrow: 'Sleep at night', title: 'Rehearse & restore (DR)',
      lede: 'A backup you’ve never restored is a rumor. Bitswan makes the rehearsal a routine, the architecture legible, and the real cutover a single click.',
      slots: [
        { id: 'dr-rehearse', label: 'Live capture', caption: 'Disaster Recovery · backup loaded into DR, recovery-tested' },
        { id: 'dr-architecture', label: 'Live capture', caption: 'Disaster Recovery · how the blue-green slots and swap work' },
      ],
      sell: [
        'Restore a production backup <strong>into the DR slot</strong> — never onto live production. The restore streams its progress per store; when it lands, the slot is marked <em>In DR now</em>. Open it, confirm it’s whole, and only the backup actually loaded into DR can be <strong>marked recovery-tested</strong>. The <em>How it works</em> tab explains the blue-green slots and the cutover in plain terms.',
        'When you must go live, the <strong>Restore</strong> pill performs an ingress cutover — <em>Make Disaster Recovery the live Production?</em> — and <code>-production</code> repoints to the verified slot. No data migration, no redeploy, no downtime. (In a rehearsal you open that dialog to see it, then cancel.)',
      ],
      steps: ['Take a production snapshot (Ch&nbsp;15).', 'Go to <b>Disaster Recovery → Rehearse &amp; restore</b>.', '<b>Restore into DR</b>, verify, <b>Mark recovery-tested</b>.', 'Use the <b>Restore</b> pill to swap live when needed.'],
      specs: [{ v: '0 s', l: 'downtime on a swap' }, { v: 'Quarterly', l: 'default test cadence' }, { v: 'Verified', l: 'test only what’s loaded' }],
      standards: [
        { code: 'DORA', clause: 'Art. 11–12', demand: '<b>Response, recovery & restoration testing.</b> You must regularly test your ability to restore — here it’s a routine, and the last pass is recorded.' },
        { code: 'SOC 2', clause: 'A1.2 / A1.3', demand: '<b>Backup & recovery testing.</b> Restores are rehearsed into an isolated DR slot and the test is recorded.' },
        { code: 'ISO/IEC 27001', clause: 'A.5.30 / A.8.13', demand: '<b>ICT readiness for continuity.</b> Backups are verified by restoration into an isolated slot.' },
        { code: 'NIS2', clause: 'Art. 21(2)(c)', demand: '<b>Business continuity & crisis management.</b> A zero-downtime swap means recovery doesn’t cost an outage.' },
      ],
    },
    {
      num: '17', eyebrow: 'Control the edges', title: 'Firewall & data processing',
      lede: 'An egress allow-list with a GDPR data-processing record for every external host — approval workflow, versioning and the DPA on file.',
      slots: [
        { id: 'firewall', label: 'Live capture', caption: 'Firewall · the egress allow-list and its posture (Monitoring in dev, Enforcing in production)' },
        { id: 'firewall-gdpr', label: 'Live capture', caption: 'GDPR data-processing record · the Article 30 form an operator completes before egress is allowed' },
      ],
      sell: [
        'Meridian’s invoice flow really does reach out — on startup and on a loop it connects to its vendor portals, the Czech business register (<code>ares.gov.cz</code>, vendor VAT-ID checks) and the payment gateway. With an egress gateway watching a stage, the firewall reads the SNI/Host of every outbound connection: egress is <strong>default-deny</strong> in staging and production; in dev it observes and surfaces each unlisted destination under <strong>Needs review</strong> for an operator to approve or deny.',
        'Approving a host opens its <strong>data-processing record</strong>. The operator first answers whether any user/personal data is sent at all; if it is, the form asks <em>what</em> data leaves, <em>what it’s used for</em>, whether it’s <em>stored</em> there (No / Transient / Yes), the processor’s <em>jurisdiction</em>, and takes the signed <strong>Data Processing Agreement (PDF)</strong>. Save the record and the host is allowed. So your Article&nbsp;30 register and your Article&nbsp;28 DPA file build themselves as the system is operated, instead of being reconstructed under audit pressure.',
      ],
      steps: ['Open a stage → <b>Firewall</b> (wait for it to load the live posture).', 'Find the real outbound host under <b>Needs review</b> and press <b>Approve</b>.', 'Answer “No user data?”, or fill <b>what data</b> / <b>purpose</b> / <b>stored?</b> / <b>jurisdiction</b>.', 'Attach the processor’s <b>DPA (PDF)</b> and press <b>Approve &amp; record</b> — the host is recorded and allowed.'],
      callout: { kind: 'GDPR, by construction', text: 'Every external recipient of data is recorded with its purpose and contract at the moment it’s allowed. The record of processing activities (Art. 30) and the processor agreements (Art. 28) are a by-product of running the system — not a spreadsheet someone keeps separately.' },
      standards: [
        { code: 'GDPR', clause: 'Art. 30', demand: '<b>Records of processing activities.</b> Each external recipient is logged with its purpose and whether personal data is transferred — the register maintained automatically.' },
        { code: 'GDPR', clause: 'Art. 28', demand: '<b>Processor obligations.</b> A Data Processing Agreement is stored on file for every host that processes personal data before egress is allowed.' },
        { code: 'NIS2', clause: 'Art. 21(2)(a)', demand: '<b>Risk-analysis & network security policies.</b> Default-deny egress with reviewed, documented exceptions.' },
        { code: 'ISO/IEC 27001', clause: 'A.8.20–8.21', demand: '<b>Network & network-service security.</b> Outbound connections are controlled per service.' },
      ],
    },
    {
      num: '18', eyebrow: 'Know your ingredients', title: 'Supply chain',
      lede: 'A full software bill of materials for what you run — vulnerabilities ranked, advisories one click away, accepted risks recorded.',
      slots: [
        { id: 'supply-chain', label: 'Live capture', caption: 'Supply chain · the SBOM/CVE panel for the deployed image' },
        { id: 'supply-chain-cve', label: 'Live capture', caption: 'CVE advisory detail · severity, CVSS score and description — what the operator triages before waiving or patching' },
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
      num: '19', eyebrow: 'Right people, right rights', title: 'People & roles',
      lede: 'A roster with explicit roles — operator, auditor, member — and per-person trusted devices you can approve or revoke.',
      slots: [{ id: 'people-roles', label: 'Live capture', caption: 'People & roles · the Meridian Foods roster' }],
      sell: [
        'Tomáš operates (admin), Eva audits, Marek and the team build (members). Roles are resolved from Bailey’s own user-role store and enforced <strong>server-side</strong> — not merely hidden in the UI. This is also where pending devices are approved and lost ones revoked.',
        'The <strong>auditor</strong> role is not simply read-only. An auditor reviews everything <em>and</em> holds the <strong>governance</strong> controls a compliance owner needs: they can set the recovery-test cadence and approve a production egress host’s data-processing record. What they cannot do is operate the pipeline — no deploying or promoting code, no managing people, roles or devices, no touching the server’s admin settings. A <strong>member</strong> does the day-to-day build/ship work but cannot change governance settings; an <strong>admin</strong> holds everything. That split is the segregation of duties an auditor signs off on — the person who sets the recovery cadence and vets a new data recipient is deliberately <em>not</em> the person who ships the code.',
      ],
      steps: ['Open <b>People &amp; roles</b> in the console.', 'Review roles across the team.', 'Approve a pending device by its code.', 'Revoke a device or change a role as people join and leave.'],
      callout: { kind: 'What an auditor can actually do', text: 'An auditor is read-only on the <em>operational</em> pipeline (no deploy, promote, people/role or device management, no server admin) but holds the <em>governance</em> controls: setting the recovery-test cadence and approving a production egress host’s GDPR data-processing record. Oversight with authority over compliance settings — deliberately separated from the authority to ship code.' },
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.5.18 / A.5.3', demand: '<b>Access rights & segregation of duties.</b> Admin, auditor and member are distinct, server-enforced roles: the auditor’s governance authority is separated from the member’s build/ship authority.' },
        { code: 'SOC 2', clause: 'CC6.2 / CC6.3', demand: '<b>Access provisioning & de-provisioning.</b> Roles and per-person trusted devices are granted and revoked centrally.' },
        { code: 'NIS2', clause: 'Art. 21(2)(i)', demand: '<b>Human-resources security & access control.</b> Access is role-based and reviewable.' },
        { code: 'DORA', clause: 'Art. 9(4)', demand: '<b>Access management on a need-to-know basis.</b> Each role gets only the rights its duties require — auditors hold governance (recovery cadence, processing-record approval) but not deploy/promote; members ship but cannot change governance settings.' },
      ],
    },
    {
      num: '20', eyebrow: 'Let the right people in', title: 'Sharing an endpoint',
      lede: 'Every protected app the gate fronts — including the frontends your operators build and deploy — can be shared, by its owner, with named people or groups, at view or owner level, without touching anyone else’s access.',
      slots: [
        { id: 'share-modal', label: 'Live capture', caption: 'Share endpoint · sharing a deployed automation’s own frontend (a Bailey-protected endpoint) with a teammate at User level' },
      ],
      sell: [
        'Access is deny-by-default: only people you invite can open an endpoint. Crucially, this is not just the dashboard — the <strong>frontend Meridian’s invoice-processing automation deploys is itself a Bailey-protected endpoint</strong>. Open that frontend and Bailey’s own chrome wraps it, with a <strong>Share</strong> button for its owner. From there the owner grants access to a person (by email) or a whole identity-provider group, choosing <em>User</em> (open and use it) or <em>Owner</em> (also manage who else can). Grants are recorded with who granted them and when, and a user who hits a wall can <em>request access</em>, which surfaces to the owner to approve or deny — so access is a deliberate decision with a trail, not a shared password.',
        'The same mechanism fronts everything: a workspace dashboard, gitops, and every automation frontend an operator creates. Adding a member to the Meridian Foods workspace is a grant on the workspace’s endpoint; letting a teammate into a deployed invoice app is a grant on that app’s endpoint. Because every grant is per-endpoint and owner-managed, there is no god-mode admin quietly reading everything — least privilege is the default, and revoking is as immediate as granting.',
      ],
      steps: ['Open a deployed automation’s <b>frontend</b> (it’s a Bailey-protected endpoint); click <b>Share</b> in its chrome.', 'Type a person’s email (or a <code>/group</code>); pick <b>User</b> or <b>Owner</b>.', 'Press <b>Add</b> — access is effective immediately and recorded.', 'Approve or deny any pending access requests; <b>Remove</b> to revoke.'],
      callout: { kind: 'Why it matters', text: 'Sharing is per-endpoint, owner-driven and recorded. Access control isn’t a central list someone forgets to prune — it’s the owner of each app deciding, in the open, exactly who can reach it, and revoking the instant they shouldn’t.' },
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.5.15 / A.8.3', demand: '<b>Access control & information access restriction.</b> Access to each endpoint is granted explicitly, per principal, by its owner.' },
        { code: 'SOC 2', clause: 'CC6.1 / CC6.3', demand: '<b>Logical access & role-based access.</b> Endpoints are deny-by-default; grants carry a role and an attributable grantor.' },
        { code: 'NIS2', clause: 'Art. 21(2)(i)', demand: '<b>Access control.</b> Who can reach which service is explicit, owner-managed and revocable.' },
        { code: 'GDPR', clause: 'Art. 5(1)(f) / Art. 32', demand: '<b>Integrity & confidentiality.</b> Personal data behind an endpoint is reachable only by explicitly granted principals.' },
      ],
    },
    {
      num: '21', eyebrow: 'Feed the watchtower', title: 'SIEM export & monitoring',
      lede: 'Stream the server’s security audit log — access approvals, role and device changes, workspace events — to your SIEM over OpenTelemetry, as it happens.',
      slots: [
        { id: 'siem-form', label: 'Live capture', caption: 'SIEM forwarding · the config form — the OTLP endpoint base URL and the protocol, filled in before Save & connect' },
        { id: 'siem', label: 'Live capture', caption: 'SIEM forwarding · connected — the connectivity test passed; the same audit events, forwarded live' },
      ],
      sell: [
        'Bailey keeps its own security audit trail, but your SOC wants everything in one place. The <strong>SIEM forwarding</strong> card (Server overview) points Bailey at an external <strong>OpenTelemetry</strong> ingestor and mirrors every security event there in real time: device-trust changes, role changes, workspace creation, access approvals.',
        'You give it two things. The <strong>Ingestor URL</strong> is your collector’s <strong>OTLP base URL</strong> — just the host (and port), e.g. <code>https://collector.example.com</code>; Bailey appends the <code>/v1/logs</code> path itself, so you never spell out the signal path. The <strong>Protocol</strong> picks how the logs are framed: <strong>OTLP/HTTP</strong> (protobuf over HTTPS, the simplest to route through a proxy) or <strong>OTLP/gRPC</strong> (a streaming gRPC channel, lower-overhead at volume) — match whichever your collector listens on. An optional bearer <em>Auth token</em> authenticates the stream.',
        'Press <strong>Save &amp; connect</strong> and Bailey runs a live connectivity test, so you see <em>Connected</em> (or the exact error) before you rely on it, and the card then shows when the last event was delivered. This is how Bailey’s audit story plugs into the monitoring and detection your standards expect: the events exist regardless, and the export makes them available to correlation, alerting and long-term retention in the system your analysts already watch.',
      ],
      steps: ['Open <b>Server overview</b>; find <b>SIEM forwarding</b>.', 'Click <b>Configure ingestor</b>; enter the <b>Ingestor URL</b>, pick the <b>Protocol</b>, add an <b>Auth token</b> if needed.', 'Press <b>Save &amp; connect</b> — it tests the connection and shows Connected or the error.', 'Watch the live status and last-delivered time; <b>Edit</b> or <b>Disable</b> as needed.'],
      callout: { kind: 'Monitoring, where you already look', text: 'The audit events are produced no matter what; SIEM export simply forwards them, live, into your existing detection and retention pipeline — so monitoring and alerting happen in the tool your team already runs, not in a console they have to remember to open.' },
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.8.15 / A.8.16', demand: '<b>Logging & monitoring.</b> Security events are exportable, in real time, to centralized monitoring and retention.' },
        { code: 'SOC 2', clause: 'CC7.2', demand: '<b>System monitoring.</b> Audit events feed an external SIEM for correlation and alerting.' },
        { code: 'DORA', clause: 'Art. 10', demand: '<b>Detection of anomalous activities.</b> Real-time event export enables continuous detection in your SOC.' },
        { code: 'NIS2', clause: 'Art. 21(2)(b)', demand: '<b>Incident handling.</b> Centralized, exported events shorten detection and support reconstruction.' },
      ],
    },

    // ─────────────────────── Onboarding a teammate ──────────────────────────
    // The other side of the gate (Ch 01/04): a real second user (Marek
    // Horváth) arriving on a new device, and the admin (Tomáš) deciding —
    // deliberately, in the open — whether he and his device get in.
    {
      num: '22', eyebrow: 'Deny by default', title: 'A teammate’s first login',
      lede: 'A new teammate signs in through your identity provider from their own laptop — and gets nothing. Identity alone is not access: Bailey is deny-by-default, and an unknown device waits at the gate.',
      slots: [{ id: 'onboard-newuser-pending', label: 'Live capture', caption: 'New device · Marek is signed in, but the device isn’t trusted — a 6-digit code and “Waiting for an admin…”' }],
      sell: [
        'Marek Horváth joins Meridian as a process developer. He opens Bailey on his own laptop and signs in with his Meridian identity — a perfectly valid login. He still sees <strong>none of the product</strong>. Instead the gate stops him with <em>“Trust this device”</em>: “You’re signed in, but this device isn’t trusted yet.” His browser shows a large <strong>6-digit code</strong> labelled <em>“Your code”</em>, the prompt to <em>“Read this code to an admin”</em>, and a spinner: <em>“Waiting for an admin…”</em>',
        'This is <strong>deny-by-default</strong> made concrete. A leaked or phished password is not enough to reach anything, because access is bound to <em>this hardware</em>, not just the credential — and this hardware is unknown. The code is a <strong>presence proof</strong>: an admin will only let the device in after Marek reads them the number off his own screen, so a stolen identity-provider account on an attacker’s machine never clears the gate. Nothing — no workspace, no app, no console — is reachable until someone who already holds trust says yes.',
      ],
      steps: ['A new teammate signs in at the Bailey host on their own device.', 'The gate shows <b>Trust this device</b> — they are signed in but not trusted.', 'Their device displays a <b>6-digit code</b> and waits.', 'Nothing in the product is reachable until an admin approves the device.'],
      callout: { kind: 'Why it matters', text: 'A valid login is not access. By binding trust to the device and requiring a present, trusted admin to admit it, a stolen password — or a whole compromised identity-provider account — still reaches nothing on its own.' },
      standards: [
        { code: 'NIS2', clause: 'Art. 21(2)(j)', demand: '<b>Multi-factor authentication & secured access.</b> Device trust is a hardware-bound second factor; identity alone never grants access.' },
        { code: 'ISO/IEC 27001', clause: 'A.5.15 / A.8.5', demand: '<b>Access control & secure authentication.</b> Access is deny-by-default and granted per device, not per credential.' },
        { code: 'SOC 2', clause: 'CC6.1', demand: '<b>Logical access security.</b> A new principal is denied at the gate until explicitly authorized.' },
        { code: 'DORA', clause: 'Art. 9(3)', demand: '<b>Strong authentication mechanisms.</b> Robust access control gates every new device before it reaches a system.' },
      ],
    },
    {
      num: '23', eyebrow: 'You decide who gets in', title: 'Approve the person & trust the device',
      lede: 'Approval is a deliberate, present-tense act. The admin sees the pending device in People & roles, confirms the person is really there by the code on their screen, and trusts the device — admitting the user in one move.',
      slots: [
        { id: 'onboard-admin-approve', label: 'Live capture', caption: 'People & roles · Marek’s “Device awaiting approval” bar — the admin types the code from his screen' },
        { id: 'onboard-admin-approved', label: 'Live capture', caption: 'People & roles · the device trusted, the pending request cleared' },
      ],
      sell: [
        'Back in the Server Console, Tomáš opens <strong>People &amp; roles</strong>. Marek’s request surfaces inline, under his name, as a <em>“Device awaiting approval”</em> bar — badged <em>First device</em>, with how long it’s been waiting. The prompt is explicit: <em>ask Marek to read you the code shown on his device, then type it below</em>. The code is never sent to the admin by the server — that is the whole point. Tomáš must hear it from Marek (in person, on a call), which proves Marek is physically present at that device.',
        'Tomáš types the six digits and presses <strong>Trust this device</strong>. In one action this <strong>enrols the user and trusts the device</strong>: Marek becomes a real device owner and his laptop is now a trusted device, badged and revocable like any other (Ch&nbsp;04). The request clears. There is no quiet auto-admit and no “deny” to forget about — unapproved devices simply expire. Who gets in, and on which hardware, is a decision a trusted admin makes in the open, with a presence check — exactly the control an auditor wants to see.',
      ],
      steps: ['Open <b>People &amp; roles</b> in the console.', 'Find the teammate’s <b>Device awaiting approval</b> bar.', 'Ask them to read you the <b>6-digit code</b> on their screen; type it in.', 'Press <b>Trust this device</b> — the person is enrolled and the device trusted.'],
      callout: { kind: 'A presence check, not a rubber stamp', text: 'The server never reveals the code to the approver — the admin has to get it from the person, in real time. That converts “approve a request” into “confirm a present, identified human on a specific device”, so a remote attacker holding only stolen credentials can’t be approved.' },
      standards: [
        { code: 'SOC 2', clause: 'CC6.2 / CC6.3', demand: '<b>Access provisioning.</b> A new principal and device are granted access centrally, by an authorized admin, with a presence check.' },
        { code: 'ISO/IEC 27001', clause: 'A.5.16 / A.5.18', demand: '<b>Identity & access-rights management.</b> Enrolment of a user and device is an explicit, authorized, recorded act.' },
        { code: 'NIS2', clause: 'Art. 21(2)(j)', demand: '<b>Secured access.</b> Device trust is admitted only by an already-trusted admin, with out-of-band code confirmation.' },
        { code: 'DORA', clause: 'Art. 9(4)', demand: '<b>Access on a need-to-know basis.</b> Access is conferred deliberately by an admin, not assumed from a login.' },
      ],
    },
    {
      num: '24', eyebrow: 'In, on a trusted device', title: 'Access granted',
      lede: 'The moment the admin trusts it, the teammate’s device is let through — no re-login, no second step. And the same console that admitted the device is where you cut it, the instant a laptop is lost or a person leaves.',
      slots: [{ id: 'onboard-newuser-granted', label: 'Live capture', caption: 'New device · approved and redirected through the gate — access now granted on Marek’s laptop' }],
      sell: [
        'Marek’s laptop never stopped waiting at the gate. The instant Tomáš trusts the device, the gate clears it — Marek’s screen leaves the <em>“Waiting for an admin…”</em> state and he lands on exactly what he was reaching for. From now on his device carries its own trust cookie: he comes and goes without re-approval, alongside the operator, each on their own trusted hardware.',
        'Crucially, trust is <strong>per-device and reversible from one place</strong>. Marek’s laptop now appears in the roster like any other trusted device — and the same People &amp; roles / Your devices surface that admitted it is where you <strong>remove</strong> it. If that laptop is lost or stolen, or Marek leaves Meridian, you don’t scramble to rotate passwords across a dozen apps: you find the device (or the person) and revoke it, and its access to the console and every workspace app is gone instantly (Ch&nbsp;04). Onboarding and offboarding are the same lever, pulled in opposite directions — admit a device to let someone in, cut a device to lock a stolen laptop or a departing employee out.',
      ],
      steps: ['The teammate’s device, still waiting, is admitted the moment it’s trusted.', 'It redirects straight into what they were granted — no re-login.', 'The device now appears in the roster, badged and revocable.', '<b>Lost device or leaver?</b> Remove the device (or person) here — access is revoked everywhere, instantly.'],
      callout: { kind: 'Onboarding and offboarding are one lever', text: 'Admitting a device and revoking it are the same control. A stolen laptop or a departing employee isn’t a password-reset fire drill — it’s one click to remove the device, and its access to the console and every workspace app ends immediately.' },
      standards: [
        { code: 'SOC 2', clause: 'CC6.2 / CC6.3', demand: '<b>Access provisioning & de-provisioning.</b> A device is admitted and, just as immediately, revocable centrally when lost or on a leaver.' },
        { code: 'ISO/IEC 27001', clause: 'A.5.15 / A.8.1', demand: '<b>Access control & user-endpoint devices.</b> Per-device trust is granted, badged and revoked from one place.' },
        { code: 'NIS2', clause: 'Art. 21(2)(j)', demand: '<b>Secured access.</b> Hardware-bound trust is admitted and revoked per device and per person.' },
        { code: 'DORA', clause: 'Art. 9', demand: '<b>Protection & prevention.</b> Immediate device revocation contains a lost device or a departing insider.' },
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
        { control: 'A.5.18', req: 'Access rights (least privilege, review)', status: 'provided', bailey: 'Operator / auditor / member roles, server-enforced', ch: '19', yours: 'Periodic access reviews' },
        { control: 'A.8.8', req: 'Management of technical vulnerabilities', status: 'provided', bailey: 'Pre-deploy CVE scan + in-tree waivers', ch: '10 · 18', yours: 'Triage & remediation SLAs' },
        { control: 'A.8.9', req: 'Configuration management', status: 'partial', bailey: 'bitswan.yaml as declarative source of truth', ch: '11', yours: 'Baseline definition & review' },
        { control: 'A.8.13', req: 'Information backup', status: 'provided', bailey: 'Per-stage snapshots + retention policy', ch: '15', yours: 'Offsite copy & retention targets' },
        { control: 'A.8.15 / A.8.16', req: 'Logging & monitoring', status: 'provided', bailey: 'Versioned deploy/event history, live container health, real-time SIEM export (OTLP)', ch: '12 · 14 · 21', yours: 'SIEM correlation rules, alerting' },
        { control: 'A.8.20 / A.8.21', req: 'Network & network-services security', status: 'provided', bailey: 'Default-deny egress allow-list per service', ch: '17', yours: 'Perimeter & internal segmentation policy' },
        { control: 'A.8.24', req: 'Use of cryptography & secrets', status: 'provided', bailey: 'Stage secrets, injected not committed; TLS at edge', ch: '13', yours: 'Key-management policy' },
        { control: 'A.8.31', req: 'Separation of dev/test/production', status: 'provided', bailey: 'Isolated copies + dev / staging / production stages', ch: '05 · 09 · 11', yours: '—' },
        { control: 'A.8.3', req: 'Information access restriction', status: 'provided', bailey: 'Workspaces scope access per tenancy + role; per-endpoint owner-managed sharing', ch: '02 · 20', yours: 'Membership reviews' },
        { control: 'A.8.32', req: 'Change management', status: 'provided', bailey: 'Reversible blue-green promotion path + immutable history', ch: '11 · 12', yours: 'Change approval workflow' },
        { control: 'A.5.30', req: 'ICT readiness for business continuity', status: 'provided', bailey: 'DR slot + rehearsed, recorded recovery tests', ch: '16', yours: 'BCP/DR plan & RTO/RPO targets' },
      ],
    },
    {
      standard: 'SOC 2 (Trust Services Criteria)',
      blurb: 'The common-criteria and availability TSCs Bailey supports as a service component. Your audit still covers the organizational criteria (CC1–CC5), risk assessment and vendor management.',
      rows: [
        { control: 'CC6.1', req: 'Logical access security', status: 'provided', bailey: 'Device-trust gate fronting every endpoint', ch: '01 · 03', yours: 'Access policy & ownership' },
        { control: 'CC6.2 / CC6.3', req: 'Access provisioning & removal', status: 'provided', bailey: 'Central role + device grant/revoke', ch: '04 · 19', yours: 'Timely de-provisioning process' },
        { control: 'CC6.6', req: 'Boundary protection', status: 'provided', bailey: 'Default-deny egress allow-list', ch: '17', yours: 'Network perimeter design' },
        { control: 'CC6.7', req: 'Data in transit & at rest', status: 'provided', bailey: 'TLS at the edge (traefik) with managed cert lifecycle; backups encrypted', ch: '01 · 15', yours: 'Disk encryption on the Bailey host (at rest)' },
        { control: 'CC7.1', req: 'Vulnerability detection', status: 'provided', bailey: 'SBOM + CVE scan on the image that ships', ch: '18', yours: 'Remediation tracking' },
        { control: 'CC7.2', req: 'System monitoring', status: 'provided', bailey: 'Container health + event history + real-time SIEM export', ch: '12 · 14 · 21', yours: 'Alerting & on-call' },
        { control: 'CC8.1', req: 'Change management', status: 'provided', bailey: 'Promotion pipeline + immutable deploy history', ch: '10 · 11 · 12', yours: 'Change authorization' },
        { control: 'A1.2', req: 'Backup & environmental protection', status: 'provided', bailey: 'Snapshots + standby DR slot', ch: '15 · 16', yours: 'Backup off-platform' },
        { control: 'A1.3', req: 'Recovery testing', status: 'provided', bailey: 'Rehearse-into-DR + recorded recovery tests', ch: '16', yours: 'Test cadence sign-off' },
      ],
    },
    {
      standard: 'DORA (Regulation (EU) 2022/2554)',
      blurb: 'The ICT risk-management articles Bailey operationalizes for financial entities. Governance, incident reporting to authorities, and third-party registers remain your obligation.',
      rows: [
        { control: 'Art. 8', req: 'Identification of ICT risk', status: 'provided', bailey: 'Pre-deploy supply-chain / CVE identification', ch: '18', yours: 'Risk register & classification' },
        { control: 'Art. 9(3)', req: 'Strong authentication & protection', status: 'provided', bailey: 'Device-trust gate', ch: '01', yours: 'Identity governance' },
        { control: 'Art. 9', req: 'Protection & prevention (change impact)', status: 'provided', bailey: 'Zero-downtime blue-green change path', ch: '11', yours: 'Segregation policy' },
        { control: 'Art. 10', req: 'Detection of anomalous activity', status: 'provided', bailey: 'Container health + deploy/event history + real-time SIEM export', ch: '12 · 14 · 21', yours: 'Detection thresholds & alerting' },
        { control: 'Art. 11', req: 'Response & recovery', status: 'provided', bailey: 'One-cutover DR swap, no data move', ch: '16', yours: 'Crisis-management plan' },
        { control: 'Art. 12', req: 'Backup, restoration & testing', status: 'provided', bailey: 'Snapshots + rehearsed DR restores', ch: '15 · 16', yours: 'RTO/RPO & offsite policy' },
        { control: 'Art. 13', req: 'Learning & evolving', status: 'provided', bailey: 'Complete, inspectable deploy audit trail', ch: '12', yours: 'Post-incident review process' },
        { control: 'Art. 24–26', req: 'Resilience testing programme', status: 'partial', bailey: 'Runnable requirement tests + DR rehearsals', ch: '08 · 16', yours: 'TLPT for significant entities' },
      ],
    },
    {
      standard: 'NIS2 (Directive (EU) 2022/2555)',
      blurb: 'The Article 21(2) cybersecurity-risk-management measures Bailey delivers technically. Governance, training and incident notification to your CSIRT stay with you.',
      rows: [
        { control: 'Art. 21(2)(a)', req: 'Risk analysis & network security', status: 'partial', bailey: 'Default-deny egress with reviewed exceptions', ch: '17', yours: 'Risk-analysis methodology' },
        { control: 'Art. 21(2)(b)', req: 'Incident handling', status: 'partial', bailey: 'Reconstruct events from the audit trail', ch: '12', yours: 'Incident response & notification' },
        { control: 'Art. 21(2)(c)', req: 'Business continuity & backups', status: 'provided', bailey: 'Backups + zero-downtime DR swap', ch: '15 · 16', yours: 'BCP & crisis comms' },
        { control: 'Art. 21(2)(d)', req: 'Supply-chain security', status: 'provided', bailey: 'SBOM + CVE visibility per image', ch: '18', yours: 'Supplier assessment' },
        { control: 'Art. 21(2)(e)', req: 'Secure development & vuln handling', status: 'provided', bailey: 'Pre-deploy checks + versioned waivers', ch: '10', yours: 'SDLC policy' },
        { control: 'Art. 21(2)(h)', req: 'Cryptography', status: 'provided', bailey: 'Secret handling + TLS at the edge', ch: '13', yours: 'Crypto policy' },
        { control: 'Art. 21(2)(i)', req: 'Access control & asset management', status: 'provided', bailey: 'Roles + workspace/endpoint inventory + per-endpoint sharing', ch: '02 · 03 · 19 · 20', yours: 'Asset ownership' },
        { control: 'Art. 21(2)(j)', req: 'Multi-factor authentication', status: 'provided', bailey: 'Hardware-bound device trust', ch: '01 · 04', yours: 'Enrolment policy' },
      ],
    },
    {
      standard: 'GDPR (Regulation (EU) 2016/679)',
      blurb: 'The security-of-processing and accountability articles Bailey supports. Lawful basis, data-subject rights, DPIAs and breach notification remain controller obligations.',
      rows: [
        { control: 'Art. 30', req: 'Records of processing activities', status: 'provided', bailey: 'Per-egress data-processing record, auto-maintained', ch: '17', yours: 'Controller-level register' },
        { control: 'Art. 28', req: 'Processor obligations / DPAs', status: 'provided', bailey: 'DPA stored before egress is allowed', ch: '17', yours: 'Contract terms & due diligence' },
        { control: 'Art. 32', req: 'Security of processing', status: 'provided', bailey: 'Access control, secrets, backup & resilience', ch: '13 · 15 · 16', yours: 'Risk-based measures & review' },
        { control: 'Art. 5(1)(f)', req: 'Integrity & confidentiality', status: 'provided', bailey: 'Gated access + default-deny egress', ch: '01 · 17', yours: 'Data-handling policy' },
        { control: 'Art. 33', req: 'Breach notification', status: 'partial', bailey: 'Audit trail to reconstruct what happened', ch: '12', yours: '72-hour notification process' },
      ],
    },
  ],
};
