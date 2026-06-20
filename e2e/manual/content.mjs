/**
 * The editorial manual — copy lives here in version control; the walkthrough
 * only fills the screenshot SLOTS (by id). Each chapter teaches a feature and
 * ties it to what ISO/IEC 27001, DORA and NIS2 actually ask for. Standards
 * clauses are real; keep them accurate. "Go wide": every product feature area
 * is a chapter.
 *
 * A chapter slot {id,label,caption,dark} is matched to a captured PNG by `id`.
 */

export const MANUAL = {
  title: "Bitswan — The Operator's Handbook",
  subtitle: "The Operator's Handbook",
  edition: '2026 Edition',
  headline: 'Run it like it matters.',
  tagline: 'Business processes on infrastructure that defends itself.',
  blurb:
    'Blue-green production. One-click disaster-recovery rehearsals. Supply-chain ' +
    'scanning before anything ships. A GDPR record of processing that writes itself. ' +
    'Access control an auditor will actually like. This is the platform — and this ' +
    'manual, printed straight from a live system.',
  docNo: 'No. BSW-OH-01',
  coverShot: { id: 'cover' },

  manifestoTitle: 'Why teams put Bitswan in front of what matters',
  promises: [
    { title: 'Ship without holding your breath', body: 'Promote dev → staging → production across three blue-green slots over two persistent databases. The live slot never blinks; the standby is always one cutover away.' },
    { title: 'Rehearse the disaster before it happens', body: 'Restore any production backup into an isolated DR slot, verify it by hand, mark it recovery-tested, then swap it live with a single ingress cutover. No data move. No downtime.' },
    { title: 'Know what’s inside before it runs', body: 'Every image is scanned for CVEs before deploy. Waivers live in your source tree, not buried in config. Auditors get a clean, signed story.' },
    { title: 'Trust the device, not just the password', body: 'The first operator claims the server; every device after is approved. Identity is enforced at the gate — your processes run safely behind it.' },
  ],

  chapters: [
    {
      num: '01', eyebrow: 'Get in safely', title: 'Claim & device trust',
      lede: 'The first operator claims the server and becomes root admin. Their device becomes the first trusted device — and every device after is approved, not assumed.',
      slots: [{ id: 'onboard-claim', label: 'Live capture', caption: 'Bailey onboarding · “Claim this server”' }],
      sell: [
        'A password that leaks shouldn’t be the end of the story. Bailey binds access to <strong>trusted devices</strong>: Tomáš Novák signs in, claims the Meridian Foods server, and his laptop is enrolled as the first trusted device.',
        'From then on a new device must be <strong>approved by someone who already holds one</strong>. The gate sits in front of everything — the console and every workspace app run behind it.',
      ],
      steps: ['Sign in at the onboarding host.', 'Click <b>Claim this server</b> — you become root admin.', 'Your device is trusted; a cookie proves it.', 'Approve teammates’ devices from <b>People &amp; roles</b>.'],
      callout: { kind: 'Why it matters', text: 'Identity is enforced once, at the gate. Your business processes never have to reinvent authentication.' },
      standards: [
        { code: 'NIS2', clause: 'Art. 21(2)(j)', demand: '<b>Multi-factor authentication & secured access.</b> Device trust is a strong second factor bound to hardware — exactly the “MFA or continuous authentication” the directive expects.' },
        { code: 'ISO/IEC 27001', clause: 'A.5.15 / A.8.5', demand: '<b>Access control & secure authentication.</b> Access is granted per identity and per device, and centrally revocable.' },
        { code: 'DORA', clause: 'Art. 9(3)', demand: '<b>Strong authentication mechanisms.</b> Protection of ICT systems requires robust access control — the gate provides it uniformly.' },
      ],
    },
    {
      num: '02', eyebrow: 'Stand it up', title: 'Workspaces',
      lede: 'A workspace is an isolated home for a team’s business processes. Create one from the console; ownership and membership are explicit.',
      slots: [{ id: 'workspace-create', label: 'Live capture', caption: 'Server Console · creating the Meridian Foods workspace' }],
      sell: [
        'From the Bailey Server Console, Tomáš creates the <strong>Meridian Foods</strong> workspace. Creation is a live, streamed operation — you watch gitops, ingress and the dashboard come up.',
        'Each workspace is its own blast radius: separate processes, separate data, separate access. Finance’s invoice flow can’t reach anywhere it shouldn’t.',
      ],
      steps: ['Open <b>Workspaces</b> in the console.', 'Click <b>Create workspace</b>, name it.', 'Watch the live bring-up stream to done.', 'Open the workspace dashboard.'],
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.8.31', demand: '<b>Separation of development, test and production.</b> Workspaces and stages keep environments cleanly isolated.' },
        { code: 'NIS2', clause: 'Art. 21(2)(i)', demand: '<b>Asset management & access control.</b> Every workspace and its endpoints are inventoried and owned.' },
      ],
    },
    {
      num: '03', eyebrow: 'Say what it does', title: 'Describe the process',
      lede: 'Before code, intent. Each business process carries a living specification — what it does, for whom, and the rules it must keep.',
      slots: [{ id: 'description', label: 'Live capture', caption: 'Invoice Processing · the process specification' }],
      sell: [
        'Marek documents the <strong>Invoice Processing</strong> spec: ingest vendor invoices, validate totals and VAT against the PO, route anything over €5,000 for approval, post the rest to the ledger.',
        'The description is rich text with attachments and flowcharts — documentation that lives with the process, not in a wiki that drifts.',
      ],
      steps: ['Open the <b>Description</b> tab.', 'Write the spec; attach diagrams.', 'Save — it versions with the process.'],
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.5.37', demand: '<b>Documented operating procedures.</b> The process and its rules are written down and kept current alongside the code.' },
      ],
    },
    {
      num: '04', eyebrow: 'Prove it works', title: 'Requirements & tests',
      lede: 'Turn the rules into testable requirements. Each one has a status; the coding agent can run them.',
      slots: [{ id: 'requirements', label: 'Live capture', caption: 'Requirements & tests · invoice validation rules' }],
      sell: [
        'Meridian’s rules become checks: <strong>VAT matches the PO</strong>, <strong>over €5,000 needs approval</strong>, <strong>no duplicate invoice numbers</strong>. Each requirement tracks pass / fail / pending.',
        'Testing isn’t a separate ritual — it’s attached to the process and visible to the auditor.',
      ],
      steps: ['Open <b>Requirements &amp; tests</b>.', 'Add a requirement in plain language.', 'Run it via the coding agent.', 'Watch the status badge update.'],
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.8.29', demand: '<b>Security testing in development and acceptance.</b> Requirements are tested before changes are accepted.' },
        { code: 'DORA', clause: 'Art. 24–25', demand: '<b>Testing of ICT tools and systems.</b> A maintained, runnable test suite is the basis of the resilience-testing programme.' },
      ],
    },
    {
      num: '05', eyebrow: 'Ship changes', title: 'Sync & Deploy',
      lede: 'From a working copy to a healthy deployment — with a security check standing between you and production.',
      slots: [{ id: 'sync-deploy', label: 'Live capture', caption: 'Sync & Deploy · ready to ship to development' }, { id: 'checks-cve', label: 'Live capture', caption: 'Checks tab · CVEs of the image this deploy would build' }],
      sell: [
        'One button does the careful thing: commit work-in-progress, rebase onto main, fast-forward, roll out to development — <strong>tracking the single deploy it started</strong> instead of racing a second one.',
        'Before you promote, the <strong>Checks</strong> tab shows the exact CVEs of the image this deploy <em>would</em> build. Click any CVE for its advisory; mark what’s out of scope — into your source tree, where review can see it.',
      ],
      steps: ['Open <b>Sync &amp; Deploy</b>.', 'Review the <b>diff</b> and the <b>Checks</b> tab.', 'Press <b>Sync &amp; Deploy</b> — dev goes <b>Healthy</b>.', 'Promote when you’re ready.'],
      callout: { kind: 'Why it matters', text: 'The check happens on the image that will actually run — not last week’s scan. Security is a step in the flow, not a gate someone forgets.' },
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.8.8', demand: '<b>Management of technical vulnerabilities.</b> The image is CVE-scanned before it ships, with each finding linked to its advisory.' },
        { code: 'NIS2', clause: 'Art. 21(2)(e)', demand: '<b>Security in acquisition, development and maintenance, incl. vulnerability handling.</b> Waivers are versioned in-tree and reviewable.' },
        { code: 'DORA', clause: 'Art. 8–9', demand: '<b>ICT risk identification & protection.</b> Pre-deploy scanning makes risk identification automatic and auditable.' },
      ],
    },
    {
      num: '06', eyebrow: 'Know your ingredients', title: 'Supply chain',
      lede: 'A full software bill of materials for what you run — vulnerabilities ranked, accepted risks recorded.',
      slots: [{ id: 'supply-chain', label: 'Live capture', caption: 'Supply chain · SBOM with CVE severity rollup' }],
      sell: [
        'Every deployed image carries an SBOM. The Supply chain view ranks vulnerabilities by severity and shows the affected package, with links to osv.dev, NVD and GitHub advisories.',
        'Out-of-scope decisions are explicit, attributable and stored in source — not a screenshot in someone’s inbox.',
      ],
      steps: ['Open a stage → <b>Supply chain</b>.', 'Sort by severity; open a CVE.', 'Record any out-of-scope decision.'],
      standards: [
        { code: 'NIS2', clause: 'Art. 21(2)(d)', demand: '<b>Supply-chain security.</b> You can produce, on demand, exactly what is inside what you run.' },
        { code: 'ISO/IEC 27001', clause: 'A.5.7 / A.8.8', demand: '<b>Threat intelligence & vulnerability management.</b> Continuous visibility of known vulnerabilities in your dependencies.' },
      ],
    },
    {
      num: '07', eyebrow: 'Promote with confidence', title: 'Blue-green production',
      lede: 'Three app slots over two persistent databases. The live slot owns production; the standby owns DR; the third is your zero-downtime buffer.',
      slots: [{ id: 'deployments-prod', label: 'Live capture', caption: 'Deployments · Production healthy after promote' }],
      sell: [
        'Promote dev → staging → production and the idle slot comes up on the live database, ingress repoints, the old slot retires. Users never see a gap.',
        'Production is a state you can read at a glance: which slot is live, which is standby, what’s healthy.',
      ],
      steps: ['Open <b>Deployments → Development</b>.', 'Press <b>Promote</b> to staging, then production.', 'Confirm Production is <b>Healthy</b>.'],
      specs: [{ v: '3 slots', l: 'a / b / c app slots' }, { v: '2 DBs', l: 'persistent, slot-aware' }, { v: '0 s', l: 'downtime on promote' }],
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.8.32', demand: '<b>Change management.</b> Production changes follow a controlled, reversible promotion path.' },
        { code: 'DORA', clause: 'Art. 9', demand: '<b>Protection & prevention.</b> Minimise the impact of changes on the availability of critical functions.' },
      ],
    },
    {
      num: '08', eyebrow: 'Keep secrets secret', title: 'Secrets',
      lede: 'Per-stage environment secrets, write-gated by role and snapshotted with every deployment.',
      slots: [{ id: 'secrets', label: 'Live capture', caption: 'Production · environment secrets, role-gated' }],
      sell: [
        'The payment-gateway credentials and the approval threshold live as stage secrets. Members read; admins and auditors write. Every deployment captures the secret set in force at that moment.',
        'No secrets in the repo, no secrets in a chat thread.',
      ],
      steps: ['Open a stage → <b>Secrets</b>.', 'Add keys (gateway id, threshold…).', 'They’re injected at deploy, never committed.'],
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.8.24', demand: '<b>Use of cryptography & secret management.</b> Secrets are stored and injected securely, separated from source.' },
        { code: 'NIS2', clause: 'Art. 21(2)(h)', demand: '<b>Cryptography and, where appropriate, encryption.</b> Sensitive material is handled as such by default.' },
      ],
    },
    {
      num: '09', eyebrow: 'Capture the truth', title: 'Backups & retention',
      lede: 'Point-in-time snapshots of the live database and object storage, with a retention policy and an audit trail.',
      slots: [{ id: 'backups', label: 'Live capture', caption: 'Production · snapshot captured from the live DB' }],
      sell: [
        'A snapshot captures the <strong>live blue-green database</strong> — not a stale name — plus object storage. Retention is a policy, not a cron job someone half-remembers.',
        'Backups you can see, size, restore and clone between stages.',
      ],
      steps: ['Open <b>Production → Backups</b>.', 'Press <b>Create snapshot</b>.', 'See it listed with size and contents.', 'Set the retention policy.'],
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.8.13', demand: '<b>Information backup.</b> Backups are taken, retained and verifiable by restoration.' },
        { code: 'DORA', clause: 'Art. 12(1)', demand: '<b>Backup policies and procedures.</b> Scope and frequency are defined and enforced.' },
      ],
    },
    {
      num: '10', eyebrow: 'Sleep at night', title: 'Rehearse & restore',
      lede: 'A backup you’ve never restored is a rumor. Bitswan makes the rehearsal a routine — and the real thing a single swap.',
      slots: [{ id: 'dr-rehearse', label: 'Live capture', caption: 'Disaster Recovery · backup loaded into DR, recovery-tested' }],
      sell: [
        'Restore a production backup <strong>into the DR slot</strong> — never onto live production. Open it, confirm it’s whole. Only the backup actually loaded into DR can be <strong>marked recovery-tested</strong>.',
        'When you must go live, the <strong>Restore</strong> pill performs an ingress cutover: <code>-production</code> repoints to the verified slot. No data migration, no redeploy, no downtime.',
      ],
      steps: ['Take a production snapshot.', 'Go to <b>Disaster Recovery → Rehearse &amp; restore</b>.', '<b>Restore into DR</b>, verify, <b>Mark recovery-tested</b>.', 'Use the <b>Restore</b> pill to swap live when needed.'],
      specs: [{ v: '0 s', l: 'downtime on a swap' }, { v: 'Quarterly', l: 'default test cadence' }, { v: 'Verified', l: 'test only what’s loaded' }],
      standards: [
        { code: 'DORA', clause: 'Art. 11–12', demand: '<b>Response, recovery & restoration testing.</b> You must regularly test your ability to restore — here it’s a routine, and the last pass is recorded.' },
        { code: 'ISO/IEC 27001', clause: 'A.5.30 / A.8.13', demand: '<b>ICT readiness for continuity.</b> Backups are verified by restoration into an isolated slot.' },
        { code: 'NIS2', clause: 'Art. 21(2)(c)', demand: '<b>Business continuity & crisis management.</b> A zero-downtime swap means recovery doesn’t cost an outage.' },
      ],
    },
    {
      num: '11', eyebrow: 'Show your work', title: 'Deployment history',
      lede: 'A versioned, immutable audit log: every deploy, promotion, swap, backup and firewall change — with the diff and the secrets in force at the time.',
      slots: [{ id: 'history', label: 'Live capture', caption: 'Deployment history · the audit trail' }],
      sell: [
        'Who shipped what, when, on which commit, and what changed — including backup, restore, swap and retention events. Inspect any entry for its files, diff and secret snapshot.',
        'When an auditor asks “show me”, you open a tab.',
      ],
      steps: ['Open a stage → <b>History</b>.', 'Read the timeline of events.', 'Inspect an entry for diff and secrets.'],
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.8.15', demand: '<b>Logging.</b> Operational events are recorded and protected from tampering.' },
        { code: 'DORA', clause: 'Art. 13', demand: '<b>Learning and evolving.</b> A complete record supports post-incident review.' },
        { code: 'NIS2', clause: 'Art. 21(2)(b)', demand: '<b>Incident handling.</b> Reconstruct exactly what happened from the audit trail.' },
      ],
    },
    {
      num: '12', eyebrow: 'Control the edges', title: 'Firewall & data processing',
      lede: 'An egress allow-list with a GDPR data-processing record for every external host — approval workflow, versioning and the DPA on file.',
      slots: [{ id: 'firewall', label: 'Live capture', caption: 'Firewall · egress allow-list with GDPR records' }],
      sell: [
        'Meridian’s invoice flow may reach its vendor portals, the Czech business register and a payment gateway — and nothing else. Each allowed host carries a <strong>GDPR data-processing record</strong>: the purpose, whether personal data flows to that recipient, and the signed <strong>Data Processing Agreement</strong> on file.',
        'Egress is default-deny. A new destination can’t go live until someone completes its processing record — so your Article 30 register builds itself as the system is operated, instead of being reconstructed under audit pressure.',
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
      num: '13', eyebrow: 'Right people, right rights', title: 'People & roles',
      lede: 'A roster with explicit roles — operator, auditor, member — and per-person trusted devices you can approve or revoke.',
      slots: [{ id: 'people-roles', label: 'Live capture', caption: 'People & roles · the Meridian Foods roster' }],
      sell: [
        'Tomáš operates, Eva audits (read-only oversight, sets the recovery cadence), Marek and the team build. Roles are enforced server-side, not just hidden in the UI.',
        'Each person’s devices are visible; approve a new laptop, revoke a lost one — instantly, everywhere.',
      ],
      steps: ['Open <b>People &amp; roles</b> in the console.', 'Review roles across the team.', 'Approve or revoke devices per person.'],
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.5.18 / A.5.3', demand: '<b>Access rights & segregation of duties.</b> Operator, auditor and member are distinct roles with least privilege.' },
        { code: 'NIS2', clause: 'Art. 21(2)(i)', demand: '<b>Human-resources security & access control.</b> Access is role-based and reviewable.' },
        { code: 'DORA', clause: 'Art. 9(4)', demand: '<b>Access management on a need-to-know basis.</b> Auditors get oversight without write power.' },
      ],
    },
  ],
};
