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
        'Device trust comes in <strong>three levels</strong>. <em>Untrusted</em> gets you nowhere. <em>Fully trusted</em> — the approved-device path above — reaches everything you have access to. In between sits the <strong>magic link</strong>: for a <strong>low-sensitivity production endpoint</strong> (say a public demo registration form), an admin or auditor who owns that endpoint can mint one from its <em>Share</em> dialog. Anyone who opens it and signs in gets their browser trusted for <em>that one endpoint only</em> — never fully, and never added to the access list. The endpoint’s ACL still decides who gets in; the magic link only spares you approving a code per device where the friction outweighs the risk. It is deliberately fenced in: production endpoints only, and the minter must both own the endpoint and hold the admin or auditor role.',
      ],
      steps: ['Sign in at the onboarding host.', 'Click <b>Claim this server</b> — you become root admin and this device is trusted.', 'A new device shows a code and waits for approval.', 'Approve it from a trusted device, or revoke it from <b>People &amp; roles</b>.', 'For a low-sensitivity production endpoint, mint a <b>magic link</b> from its Share dialog instead of approving each device.'],
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
      steps: ['Open <b>Your devices</b> in the console.', 'Review trusted devices and their badges.', '<b>Name each device</b> — click the pencil beside its name. Bailey labels a new device from its browser, so three browsers on one machine all read alike until you say which is which.', 'To admit a new browser, enter its code under <b>Link a device</b>.', '<b>Lost or stolen device?</b> Remove it here — its access is revoked everywhere, instantly. That, not a password reset, is the response.'],
      callout: { kind: 'If a device is stolen', text: 'Device-bound access means a stolen, unlocked laptop is a live session a password change can’t stop. The incident response is to <strong>remove the device</strong> — one click revokes its cookie across the console and every workspace app immediately. Keep devices named so you can identify the one to cut without hesitation.' },
      standards: [
        { code: 'SOC 2', clause: 'CC6.2 / CC6.3', demand: '<b>Access provisioning & de-provisioning.</b> Devices are granted and revoked centrally and immediately.' },
        { code: 'ISO/IEC 27001', clause: 'A.5.15 / A.8.1', demand: '<b>Access control & user-endpoint devices.</b> Trusted devices are enrolled, labelled and revocable.' },
        { code: 'NIS2', clause: 'Art. 21(2)(j)', demand: '<b>Secured access.</b> Hardware-bound trust is enrolled and managed per person.' },
      ],
    },

    // ───────────────────────── Inside the workspace ─────────────────────────
    {
      num: '05', eyebrow: 'Work in the open', title: 'Your copy & experiments',
      lede: 'Open a workspace and you land in its dashboard, already working in your own copy — an isolated branch where nothing you do touches main until you choose to. You are never asked to pick one. Everything else about copies — a colleague’s version, a throwaway experiment on one business process — sits behind a single Advanced menu.',
      slots: [
        { id: 'dashboard-open', label: 'Live capture', caption: 'Workspace dashboard · the business-process shell — your own copy is already active, and the top bar spends its width on the pipeline rather than on naming it' },
        { id: 'advanced-menu', label: 'Live capture', caption: 'Advanced · the whole copy tree in one menu — see a colleague’s version (expandable to their experiments on this business process), or start an experiment on it off your own copy' },
        { id: 'experiment', label: 'Live capture', caption: 'Inside an experiment · the green banner names the business process it is on and the experiment itself, and carries all four ways out — step back to your copy leaving it running, merge it back, take it wholesale, or discard it. There is no Deploy tab in here.' },
        { id: 'experiment-merge', label: 'Live capture', caption: 'Merging back · the experiment’s work fast-forwards into your own copy — and the experiment is discarded in the same move, leaving you on your copy' },
        { id: 'experiment-adopt', label: 'Live capture', caption: 'Use this version without merging · the fourth way out of an experiment — your copy becomes it wholesale, and what your copy held is parked as an experiment of its own, named after the moment' },
      ],
      sell: [
        'Every operator gets <strong>exactly one personal copy</strong> of the workspace, and it is created <em>for</em> them: the first time you open the dashboard, Bailey provisions your copy and selects it. There is no branch to name, no copy to create, and — deliberately — <strong>no copy control in the top bar at all</strong>: no dropdown, no chip, not even the copy’s name. The everyday answer to “whose copy is this?” is always “mine”, so the bar spends its width on the work instead: the business process, then Description → Coding Agent ↻ Requirements → Deploy, all of which happen <em>inside</em> your copy. It is your private branch: edit, build and preview without disturbing anyone else’s work or the live <em>main</em>.',
        'The two exceptions live under <strong>Advanced</strong>, on the far right. <strong>See a colleague’s version</strong> lists everyone else’s copy — expand one and you also see their experiments <em>on the business process you are looking at</em>. Open any of them and you land under an <strong>amber banner</strong>: <em>“You are viewing ⟨name⟩’s copy”</em> (or their named experiment), with one <em>Switch back to my copy</em> button. Nothing is locked down — their copy stays fully usable, because reading a colleague’s work is normal. The banner exists so you can never <em>mistake</em> their copy for yours.',
        'The other half is <strong>experiments</strong>. An experiment is a throwaway branch off <em>your own</em> copy <strong>on exactly one business process</strong>, and you name it by <strong>what you are trying</strong> — “Check vendor VAT-IDs against ARES” — never by a branch name; Bailey commits your copy’s current state of that process, branches from exactly that, and drops you in. A <strong>green banner</strong> reads <em>“You are in an experiment on ⟨business process⟩: ⟨title⟩”</em> and carries every way out of it. <strong>Back to my copy</strong> is the one that is not an ending: it puts you back on your own copy and <em>leaves the experiment running</em>, waiting under <b>Advanced</b> whenever you want it again — an experiment is somewhere you step in and out of, not only something you finish or throw away. The other three conclude it. <strong>Merge back into my copy</strong> fast-forwards the work into your copy, refreshes your copy’s live-dev — and then <strong>discards the experiment and puts you back on your own copy</strong>, because a merged experiment has no reason to exist. (If your copy moved on far enough to conflict, the merge doesn’t guess: it hands the rebase to the coding agent, working inside the experiment.) <strong>Discard experiment</strong> is a real delete — the branch, the files and its live-dev containers — behind a dialog that names the unmerged work it would destroy. The third ending is below.',
        'There is a fourth way out, and it is the one people ask for once an experiment goes <em>well</em>. Merging asks “combine these two versions”; sometimes the honest answer is “no — use that one”. <strong>Use this version without merging</strong> makes your copy <em>become</em> the experiment: no merge, no conflict to resolve, no choosing hunk by hunk. Nothing is lost doing it — whatever your copy held for that business process, uncommitted edits included, is <strong>parked first as an experiment of its own</strong>, titled <em>“My previous ⟨process⟩ work — ⟨2026-08-07 14:32⟩”</em> and waiting under <b>Advanced</b>; if there was genuinely nothing of yours to save, none is created and you are told so rather than handed an empty one. The experiment you took is then closed, because it <em>is</em> your copy now. And you land <strong>on top of main</strong> either way: if the experiment already contained main it fast-forwards and keeps its own commits; if the two had diverged, a single restore commit carries its content on top of main — so the very next Deploy is a plain fast-forward, with no Sync detour.',
        'A copy and an experiment are different <em>shapes</em>, and the difference is load-bearing. <strong>Your copy is the whole workspace</strong> — every business process in it, because it is where you work. <strong>An experiment is one business process</strong>, because each business process is its own git repository: an “experiment” spanning several would be several unrelated branches, merged back and thrown away together for no better reason than sharing a folder. So the <b>Advanced</b> menu lists only the experiments belonging to the process you are looking at (“No experiments on ⟨process⟩” when there are none), the server <strong>refuses</strong> to bring any other process into an experiment, and switching to another process while inside one <strong>takes you out of it</strong>, back to your own copy, with a line saying so. An experiment cannot quietly become a second copy of the workspace.',
        'An experiment can never reach main: inside one the <strong>Deploy tab is not even rendered</strong>, and the server refuses a publish from an experiment even if something asked. Work leaves an experiment only by being merged into the copy it branched from, and leaves your copy only through a deliberate <strong>Deploy</strong> (Ch&nbsp;10). That is one funnel, in one direction, with a person’s name on every hop.',
      ],
      steps: [
        'Press <b>Open</b> on the workspace to enter its dashboard — your own copy is already active.',
        'Open <b>Advanced</b> → <b>See a colleague’s version</b> to read someone else’s copy, or expand it to open one of their experiments (amber banner; <b>Switch back to my copy</b> when you’re done).',
        'Select the business process you want to try something on, then open <b>Advanced</b> → <b>Start a new experiment</b> and name what you’re trying; you land in it under the green banner, which names the process.',
        'Work in the experiment exactly as you would in your copy — same tabs, same live-dev, its own branch of that one process.',
        'Switching to a different business process leaves the experiment and puts you back on your own copy — an experiment belongs to one process, so it cannot follow you.',
        'Press <b>Merge back into my copy</b> when you like the result: the work lands in your copy and the experiment is discarded automatically.',
        'Or press <b>Use this version without merging</b> when the experiment simply <em>is</em> the answer: your copy becomes it, what your copy held is parked as a dated experiment you can still open, and the source experiment is closed.',
        'Press <b>Back to my copy</b> at any point to step out and leave it running — it stays under <b>Advanced</b> → <b>Experiments on ⟨process⟩</b>, with your work in it, until you come back.',
        'Or press <b>Discard experiment</b> to throw the whole thing away.',
        'Everything you build stays in your copy until you press <b>Deploy</b>.',
      ],
      callout: { kind: 'Why it matters', text: 'Isolated copies are environment separation by default, and experiments make it cheap: branch off your own copy, prove the idea, then merge it back or throw it away — the shared main is never at risk while you find out. Every hop is explicit and attributable, and the only route into main is a deliberate Deploy from your own copy.' },
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.8.31', demand: '<b>Separation of development, test and production.</b> A personal copy — and any experiment branched off it, scoped to a single business process — isolates work-in-progress from main and from every deployed stage; an experiment has no path to main at all.' },
        { code: 'ISO/IEC 27001', clause: 'A.8.32', demand: '<b>Change management.</b> A change travels a fixed, recorded route — experiment → your copy → main — with each hop an explicit, attributed action rather than an ambient side effect.' },
        { code: 'SOC 2', clause: 'CC8.1', demand: '<b>Change management.</b> Changes originate in an isolated copy and reach main only through a deliberate Deploy; nothing merges itself.' },
        { code: 'NIS2', clause: 'Art. 21(2)(e)', demand: '<b>Security in development.</b> Experimentation happens in a disposable branch of the developer’s own copy, so unreviewed work can never become the shared baseline.' },
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
      lede: 'Before code, intent. Each business process carries a living specification — typically what it does, for whom, and the rules it must keep.',
      slots: [
        { id: 'description', caption: 'Invoice Processing · the README spec, with the flowchart of the invoice lifecycle drawn into it' },
        { id: 'flowchart-editor', label: 'Live capture', caption: 'Flowchart editor · drawing the invoice flow node-by-node, no diagram syntax to learn' },
      ],
      sell: [
        'Marek documents the <strong>Invoice Processing</strong> spec right in the dashboard: ingest vendor invoices, validate totals and VAT against the PO, route anything over €5,000 for approval, post the rest to the ledger. The editor is rich text with Markdown shortcuts.',
        'For the process flow he doesn’t hand-write diagram code — he opens the <strong>flowchart editor</strong> from the toolbar and <strong>draws</strong> it: drop a node (Process, Decision or Terminal), drag from one node’s handle to another to connect them, label as he goes, then <em>Save diagram</em> drops the rendered flowchart straight into the spec. The description versions <em>with</em> the process — documentation that lives next to the code, not in a wiki that drifts. Edits autosave and the indicator confirms it (<b>Ctrl+S</b> saves at once if you’d rather not wait); the text becomes a version with the process at your next <b>Deploy</b> or <b>Sync</b>, not at the moment you save.',
      ],
      steps: ['Open the <b>Description</b> tab.', 'Write the spec in rich text.', 'Click the toolbar <b>Insert flowchart</b> button and <b>draw</b> the flow — add nodes, drag to connect, then <b>Save diagram</b>.', 'Edits <b>autosave</b>; <b>Ctrl+S</b> saves at once. Your text becomes a version with the process at your next <b>Deploy</b> or <b>Sync</b>.'],
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.5.37', demand: '<b>Documented operating procedures.</b> The process and its rules are written down and kept current alongside the code.' },
      ],
    },
    {
      num: '08', eyebrow: 'Build it', title: 'Coding Agent & requirements',
      lede: 'Describe the process, then let a coding agent build it — inside the workspace’s isolated sandbox — and pin the rules it must keep as runnable requirements.',
      slots: [
        { id: 'coding-agent', caption: 'Coding Agent · the automations of the invoice flow, each with its live-dev preview' },
        { id: 'file-editor', label: 'Live capture', caption: 'File editor · the Files sub-tab, opened on the backend worker’s automation.toml in your copy’s working tree' },
        { id: 'file-editor-saved', label: 'Live capture', caption: 'File editor · the memory policy edited to always-on and saved — in your copy’s working tree, and never on main until you press Deploy' },
        { id: 'live-dev', label: 'Live capture', caption: 'Live-dev · the automation running its live preview in your copy — click its frontend to open it' },
        { id: 'requirements', label: 'Live capture', caption: 'Requirements & tests · the rules the process must keep, as runnable specs' },
      ],
      sell: [
        'The <strong>Coding Agent</strong> works straight from your specification: a terminal and a file tree right in the workspace, writing the invoice-processing automation in your isolated copy you review before it ever reaches main. The point isn’t that there’s an agent — it’s <strong>where</strong> it runs. The agent runs <em>inside</em> Bailey, not beside it: it works in an isolated copy and, while it can reach the internet to do its job, it is <strong>walled off from your production data</strong> — it cannot reach the production database or the user data in it. Everything it produces still passes the <strong>Deploy</strong> tab and the CVE checks before it ships.',
        'You don’t have to go through the agent to change something. The Coding Agent tab’s <strong>Files</strong> sub-tab is a full editor over your copy’s working tree — open any file and edit it; edits autosave, and <b>⌘/Ctrl+S</b> saves at once if you’d rather not wait. Here we open the backend worker’s <code>automation.toml</code> and set its <code>memory_reservation_policy</code> to <em>always-on</em>: the worker does background processing with no inbound request to wake it, so it should stay resident rather than pause when idle (more on that in <em>Memory governance</em>). Like every change in a copy, the edit <strong>never touches main until you press Deploy</strong> — and it becomes a version on your branch at that same Deploy (or a Sync), not at the moment it saves.',
        'Each automation in your copy also gets a <strong>live-dev</strong> deployment — a running preview that auto-builds as you change code. To open a running automation you click its <strong>frontend</strong> (the frontend automation’s open link in the Environment panel) and click through the real thing in your copy before it touches main. The <strong>Requirements &amp; tests</strong> tab holds the spec’s rules as runnable checks — VAT matches the PO, invoices over €5,000 are held, duplicate invoice numbers never post twice — so “does it still do what we promised?” is a button, not a meeting. You don’t transcribe them: <strong>Build automation</strong> — on the <b>Description</b> tab, next to Save — hands the agent your specification, and it <em>proposes</em> the requirements it reads out of it. Proposals arrive with <b>AI-</b> ids for you to accept, reword or drop; the ones you write yourself get <b>REQ-</b>, so the list always says which rules came from you. <strong>Write tests</strong>, in this tab, sends the agent back to cover them with real tests.',
        'Every requirement carries a <b>status</b>, and it is not decoration — it is the agent’s queue. <b>Requirements next</b>, which is how the agent picks what to work on, hands it the first requirement in tree order that is <em>not</em> <b>pass</b>. Click a status to cycle it: send something back with <b>fail</b> or <b>retest</b> and the agent picks it up again; mark it <b>pass</b> and it stops there. <b>proposed</b> is the one status that means <em>not yet part of the contract</em> — test runs skip those, which is why the agent’s own suggestions land there instead of in the tested set. Worth knowing: marking <b>pass</b> by hand is <em>you</em> asserting the rule holds, not the tests proving it — whether a requirement actually has a test is tracked separately, and the two can disagree.',
      ],
      steps: ['Open the <b>Coding Agent</b> tab; start a session against your copy.', 'It builds the automation from the Description; the <b>live-dev</b> preview comes up.', 'Edit files by hand in the <b>Files</b> sub-tab when you need to — e.g. set a worker’s <b>memory_reservation_policy</b> to always-on — it autosaves, and the change rides your copy.', 'Click a running automation’s <b>frontend</b> to open it and click through it.', 'Open <b>Requirements &amp; tests</b>; accept or reword the agent’s <b>AI-</b> proposals, add any <b>REQ-</b> of your own, press <b>Write tests</b> to have them covered — then press <b>Deploy</b>.'],
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
      num: '10', eyebrow: 'Ship changes', title: 'Deploy',
      lede: 'Two steps, one direction, both about <b>one business process</b>. <b>Deploy</b> publishes this process into main and rolls it out to development; the <b>Sync</b> step appears first, and only when it must, to bring main’s new work into this process before you do. With the diff, the history and a security check standing between you and production.',
      slots: [
        { id: 'deploy-tab', label: 'Live capture', caption: 'Deploy · ready to publish invoice-processing into main and ship it to development' },
        { id: 'deploy-tab-history', label: 'Live capture', caption: 'History sub-tab · copy + main commits with deploy markers' },
        { id: 'checks-cve', label: 'Live capture', caption: 'Supply Chain Security sub-tab · CVEs of the image this deploy would build, plus the out-of-scope audit log' },
      ],
      sell: [
        'One button — <strong>Deploy</strong> — does the careful thing for the business process you’re on: commit its work-in-progress, <strong>fast-forward main to it</strong>, and roll it out to development — <strong>tracking the single deploy it started</strong> rather than racing a second one. While it works, the button reads <em>Working…</em> and a scrollable <strong>Build log</strong> opens beneath the header, streaming every line of the deploy — each container’s image build, the <code>build.sh</code> step that compiles the production bundle (<code>vite build</code> / <code>go build</code>), and the per-process <em>Prepared</em> markers — so a slow or silent build is never a mystery the way a single-line toast would leave it.',
        'Deploy is <strong>fast-forward-only, in both senses</strong>. It only ever moves main <em>forward</em> (main is a protected, fast-forward-only branch — Ch&nbsp;13), and it only ever publishes <em>this</em> business process: each process is its own repository, so shipping the invoice flow can never drag along a half-finished change in another one. Most of the time your copy already contains everything main has, and the button simply reads <strong>Deploy</strong>. But if a teammate published while you were working, your copy is <em>behind</em> — and Bailey refuses to paper over it. There is no greyed-out button to puzzle over: the action is <strong>replaced</strong> by a plain sentence, <em>“Main has changes you don’t have yet — sync first.”</em>, and a <strong>Go to Sync</strong> button.',
        'Sync is the answer almost every time, and it is the <em>first</em> one offered — but it is not the only honest one, and pretending otherwise is what sends people round the product with raw git. Beside it sits a deliberately quiet <strong>Deploy this version, overwriting main…</strong>. It opens a dialog that <em>reads main live</em> and lists every commit your copy does not have, by <strong>short sha, subject and author</strong> — these are colleagues, and “main has diverged” hides the one fact that would change your mind. If that list cannot be read, the button stays disabled and the dialog says why; understating the damage is not an option. Confirming means typing the business process’s own name, the same guard rail a production data restore uses.',
        'What it then does has <strong>exactly one outcome</strong>: <strong>main ends up holding exactly what your copy holds</strong> — including <em>dropping</em> anything main added that you do not have. There is no mode to pick and no merge rule to reason about. That choice used to be offered, and it was the wrong question: nobody can predict from a label whether a colleague’s unrelated file survives, and the two answers left main holding a version that existed in nobody’s copy. “Overwriting main” now means what it says, and the dialog states the loss before you confirm it.',
        'The <em>history</em> is a separate promise, and it is kept. Your commits are <strong>replayed</strong> onto main’s tip — each one arriving as itself, not flattened into a single “overwrite” — and where the replay alone would leave main’s extra files behind, <strong>one further commit</strong> makes the tree exactly yours. That commit is what drops them, visibly, in the log rather than silently in a rewrite. Main’s own commits stay underneath, reachable: nothing is rewritten, nothing is force-pushed, and the superseded work can still be read and recovered. The result is checked before it is published — if the published tree is not byte-identical to yours, nothing is published at all. And a conflict no rule can decide (one side deleted a file the other edited) <strong>changes nothing at all</strong> and hands the rebase to the coding agent, exactly as a blocked Sync does.',
        'The same primitive answers a question the Deployments tab used to leave hanging: <em>this</em> version is the one that worked — can I have it? Open any deployment’s <b>Inspect</b> and press <strong>Edit this version</strong>. Your copy of that business process becomes that exact deployed version, as a restore commit on top of main, so you are one commit ahead and none behind and can fix it and Deploy without syncing first. What your copy held is parked as a dated experiment, same as everywhere else. Only versions this workspace actually deployed <em>for that business process</em> are accepted — not an arbitrary commit id.',
        'On the <strong>development</strong> stage there is one more: <strong>Revert dev to this version</strong>. Dev deploys from main, so putting dev back is a change to <em>main</em> — made the only way main ever changes, by one new commit on top, attributed to you. The version that broke stays in the history and can be brought back the same way. The dialog says the consequence out loud rather than implying it: <strong>everyone else’s copy goes one commit behind on that process</strong> and their next Sync carries the revert in, with their own unpublished work replayed on top of it. That is the point — dev is shared, so one person’s fix to it is everybody’s. Staging and production have no such button: they go back through promote and rollback (Ch&nbsp;11–12), which are gated differently.',
        'That is what the <strong>Sync</strong> step is: main’s work coming <em>into</em> the business process you are on, and the one place divergence is ever resolved. It appears as the <strong>first</strong> tab — before Description — <em>only</em> while <em>that process’s</em> main carries commits your copy lacks, and <em>only</em> on your own copy; the moment you’re level again it disappears, because a step with nothing to do is noise. It names the actual incoming commits — subject and author — so “what did they change?” is answered before you take it. One button does it: <strong>Pull main into ⟨process⟩</strong>, which replays your work on top of theirs and refreshes the live-dev if the image changed. A genuine conflict is not swallowed either: it is handed to the coding agent to finish by hand. Take their work first, see it running in your own preview, then ship — so a deploy is never a merge that quietly buries someone else’s change.',
        '<strong>Sync is per business process, exactly like Deploy</strong>, and for the same reason: each process is its own git repository, so “behind main” is a fact about a <em>process</em>, never about your copy. Select a process that is level and there is no Sync step at all — even while another one in the same copy is twenty commits behind; select that one and the step is there, for it alone. Both readings come from the <em>same</em> measurement, so the Sync step and Deploy’s “sync first” can never disagree about where you stand. (Before this, Sync was copy-wide: a person working on one process was shown a Sync step and then a list of a completely different process’s commits as what would arrive.)',
        'Around the Deploy button are the three things you check before shipping: the <strong>Diff</strong> (exactly what becomes main), the <strong>History</strong> (your copy’s and main’s commits, with deploy markers), and the <strong>Supply Chain Security</strong> tab — the precise CVEs of the image this deploy <em>would</em> build.',
        'When a finding doesn’t apply — an unreachable code path, a false positive, a risk already handled elsewhere — mark it <strong>out of scope</strong> from the same tab. The decision is a property of the code, so it is written into the business process’s <strong>source tree</strong> (<code>cve-waivers.yaml</code>, versioned in git) with <strong>who marked it, when, and why</strong>, and rides the next Deploy to main alongside the code it concerns. Every out-of-scope CVE is then listed in a dedicated <strong>audit-log</strong> section — on this tab, where a reviewer can <strong>restore</strong> it to in-scope, and read-only on the production <strong>Supply chain</strong> tab, so an auditor sees exactly what was excluded, by whom, and on what grounds. Nothing is buried in config, and no marking is silent.',
      ],
      steps: [
        'Open <b>Deploy</b>.',
        'If a <b>Sync</b> tab is showing (or Deploy says “sync first”), a teammate moved main on <em>this</em> business process before you: open it, read the incoming commits, and press <b>Pull main into ⟨process⟩</b> — the tab disappears once you’re level. Another process being behind is its own Sync step, on its own tab.',
        'Review the <b>Diff</b>, the <b>History</b>, and the <b>Supply Chain Security</b> tab.',
        'Mark any non-applicable CVE <b>out of scope</b> — it’s recorded in your source tree with who/when/why.',
        'Press <b>Deploy</b> — your copy fast-forwards into main and dev goes <b>Healthy</b>.',
        'If your version is genuinely the right one and syncing is not what you mean, use <b>Deploy this version, overwriting main…</b> instead — read the list of whose commits it supersedes, note that main will end up holding <em>exactly</em> your version (anything main added that you do not have goes with it), and type the process name to confirm.',
        'To start from a version that is already running, open its <b>Inspect</b> in <b>Deployments</b> and press <b>Edit this version</b>; on <b>development</b>, <b>Revert dev to this version</b> puts the shared dev stage back (everyone picks it up on their next Sync).',
        'Promote when you’re ready.',
      ],
      callout: { kind: 'Why it matters', text: 'The check happens on the image that will actually run — not last week’s scan. And because publishing is fast-forward-only, you cannot ship over a colleague’s change: you take their work first, deliberately, then yours goes on top. Security and integration are steps in the flow, not gates someone forgets.' },
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.8.8', demand: '<b>Management of technical vulnerabilities.</b> The image is CVE-scanned before it ships, with each finding linked to its advisory.' },
        { code: 'NIS2', clause: 'Art. 21(2)(e)', demand: '<b>Security in acquisition, development and maintenance, incl. vulnerability handling.</b> Waivers are versioned in-tree and reviewable.' },
        { code: 'DORA', clause: 'Art. 8–9', demand: '<b>ICT risk identification & protection.</b> Pre-deploy scanning makes risk identification automatic and auditable.' },
        { code: 'SOC 2', clause: 'CC8.1', demand: '<b>Change management.</b> Commit, publish, deploy is one controlled, observable operation — and it is refused outright when the copy is not a fast-forward of main, so no change is released over an unreviewed one.' },
        { code: 'ISO/IEC 27001', clause: 'A.8.32', demand: '<b>Change management.</b> Integration is an explicit, attributed step (Sync) that is separate from release (Deploy), and each is scoped to one business process.' },
      ],
    },
    {
      num: '11', eyebrow: 'Promote with confidence', title: 'Staged deployment',
      lede: 'A change moves forward one stage at a time — dev → staging → production — and each hop is a blue-green cutover: the idle slot comes up on the live database, ingress repoints, the old slot retires. Three app slots over two persistent databases mean the live slot never blinks and the standby is always one cutover away.',
      slots: [
        { id: 'promote-progress', label: 'Live capture', caption: 'Promotion in flight (dev → staging) · the idle slot coming up, the live step streaming, before the cutover' },
        { id: 'promote-progress-prod', label: 'Live capture', caption: 'Promotion in flight (staging → production) · the standby slot building on the live database before the production cutover' },
        { id: 'deployments-prod', label: 'Live capture', caption: 'Deployments · Production Healthy after promotion, every stage green' },
      ],
      sell: [
        'Promote a stage and the idle slot comes up on that stage’s live database, ingress repoints to it, and the old slot retires. The pipeline streams its live step the whole way as the standby slot builds and starts, so a promotion is never a black box — and users never see a gap.',
        'What promotes is the <strong>image, verbatim</strong>: promotion re-deploys the exact bytes that were built and reviewed, even if the workspace source has moved on since. So what runs in production is precisely what was exercised in staging, not a fresh rebuild that might drift.',
        'Anyone on the team can promote <strong>dev → staging</strong>. Production is different: it is a <strong>gated</strong> step that opens only once staging has been frozen and audited — that is the next chapter. Either way, the pipeline is a state you can read at a glance: which slot is live, which is standby, what is <strong>Healthy</strong>, and the version each stage is current on.',
      ],
      steps: ['Open <b>Deployments</b>.', 'Press <b>Promote all to Staging</b> and watch the blue-green cutover come up <b>Healthy</b>.', 'Exercise the app on staging — its own data, never production’s.', 'Production is gated — freeze &amp; audit it first (next chapter), then <b>Promote to Production</b>.'],
      specs: [{ v: '3 slots', l: 'blue-green over 2 DBs' }, { v: '0 s', l: 'downtime on promote' }, { v: 'verbatim', l: 'the reviewed image ships' }],
      callout: { kind: 'Why it matters', text: 'Every promotion is a zero-downtime blue-green cutover of the exact reviewed image. You can promote in the middle of the day and roll back to the standby slot just as fast — the live slot never blinks.' },
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.8.31', demand: '<b>Separation of development, test and production.</b> A change is deployed through isolated stages, each on its own database and network.' },
        { code: 'SOC 2', clause: 'CC8.1', demand: '<b>Change management.</b> Changes reach production only through a deliberate, observable promotion of the reviewed image.' },
        { code: 'DORA', clause: 'Art. 9', demand: '<b>Protection & prevention.</b> Zero-downtime cutovers minimise the impact of changes on the availability of critical functions.' },
      ],
    },
    {
      num: '12', eyebrow: 'Four eyes on production', title: 'Freeze & audit',
      lede: 'Production is gated by four eyes, not two. An auditor freezes staging to lock the exact image under review, signs off against a policy you set, and only then does the Production promote unlock — with every freeze, policy change and sign-off recorded in bitswan.yaml.',
      slots: [
        { id: 'freeze-staging', label: 'Live capture', caption: 'Freeze staging · an auditor locks the staging image for review — dev → staging is closed until it is unfrozen' },
        { id: 'audit-signoff', label: 'Live capture', caption: 'Audit sign-off · an auditor reviews the frozen image and approves (or requests changes) with a note' },
        { id: 'audit-log', label: 'Live capture', caption: 'Audit log · every sign-off recorded with who, when and their verdict — persisted in bitswan.yaml' },
      ],
      sell: [
        '<strong>No one promotes straight to production.</strong> First an auditor or admin <strong>freezes staging</strong> — that locks the exact image under review (a fixed tag) and closes dev → staging, so the thing being audited can’t change underneath the review. A normal member never sees a Production promote button they can click; they hand off to an auditor, exactly as segregation-of-duties demands.',
        'You set the bar with an <strong>audit policy</strong>: how many auditor sign-offs (at least one) a frozen image needs before it may reach production. Each auditor reviews the frozen image and records a verdict — <strong>Approve</strong> or <strong>Request changes</strong> — with a note. Only when the policy is met does the Production promote unlock; a single “request changes” holds the line.',
        'Every change to the gate — the freeze, each policy change, and each sign-off — is written into <code>bitswan.yaml</code> and versioned in git, attributed to the acting auditor and appended to a fast-forward-only history. The audit record is not a screenshot in a ticket; it is a versioned artefact you can hand an auditor. Once the audited image reaches production, staging <strong>unfreezes automatically</strong> — no point holding the lock after release.',
      ],
      steps: ['As an auditor, press <b>Freeze</b> on the Staging node to lock the image under review.', 'Open the <b>Audits</b> tab, review the frozen image and <b>Approve</b> (or <b>Request changes</b>) with a note.', 'Once the sign-off policy is met, the <b>Promote to Production</b> button unlocks.', 'Promote — staging unfreezes automatically once production is live.'],
      specs: [{ v: '4 eyes', l: 'auditor sign-off to prod' }, { v: 'N sign-offs', l: 'policy you set' }, { v: 'append-only', l: 'audit log in git' }],
      callout: { kind: 'Who audited what, in bitswan.yaml', text: 'Every freeze, policy change and sign-off is committed to <code>bitswan.yaml</code> in the process’s own git repo — attributed to the acting auditor and appended to an immutable, fast-forward-only history. The audit log isn’t a promise; it’s a versioned record you can hand an auditor.' },
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.5.3', demand: '<b>Segregation of duties.</b> The person who builds a change cannot unilaterally release it to production — an independent auditor must sign off.' },
        { code: 'ISO/IEC 27001', clause: 'A.8.32', demand: '<b>Change management.</b> Production changes are reviewed and approved against a policy before release, then promoted verbatim.' },
        { code: 'SOC 2', clause: 'CC8.1', demand: '<b>Change approval.</b> Changes are authorised by required sign-offs recorded in a tamper-evident log before deployment.' },
        { code: 'DORA', clause: 'Art. 9', demand: '<b>Protection & prevention.</b> An independent sign-off gate limits the risk a change poses to critical functions.' },
      ],
    },
    {
      num: '13', eyebrow: 'Show your work', title: 'Deployment history & inspect',
      lede: 'A versioned, immutable audit log: every deploy, promotion, swap, backup and firewall change — and a per-deployment Inspect with the files, diff and secrets in force at the time.',
      slots: [
        { id: 'history', label: 'Live capture', caption: 'Deployment history · the audit trail of every event, with Inspect and Roll back on every entry that isn’t already running' },
        { id: 'inspect-modal', label: 'Live capture', caption: 'Inspect · the source file tree of exactly what this deployment ran' },
        { id: 'inspect-diff', label: 'Live capture', caption: 'Inspect → Diff vs current · what changed between this deployment and what’s live now' },
        { id: 'inspect-image', label: 'Live capture', caption: 'Inspect → Download image · the built image + schema bundle for offline audit' },
        { id: 'rollback-modal', label: 'Live capture', caption: 'Roll back · the confirmation before re-deploying a prior recorded version' },
      ],
      sell: [
        'Who shipped what, when, on which commit, and what changed — including backup, restore, swap and retention events. The history is derived from the versioned record, so it can’t be quietly edited. Each entry is a rollback point: <strong>Roll back</strong> re-deploys that exact recorded version (its image, verbatim) and records the action as a new <em>rolled back</em> entry at the top of the timeline — so recovering from a bad change is a click and a confirmation, not a scramble, and the recovery itself is auditable. Entries whose version is the one <em>already running</em> are marked <em>Currently deployed</em> and offer no actions, so there is never a rollback that goes nowhere.',
        'What makes the trail trustworthy is the canonical <code>main</code> branch itself: it is a <strong>protected branch that accepts only fast-forward merges</strong>. Every deploy advances <code>main</code> forward — never a force-push, never a rebase that rewrites what came before — so history can only be <strong>appended to, never rewritten</strong>. There is no <code>git push --force</code> that quietly erases a deploy, and no way for the operator (or anyone) to go back and edit the record of what shipped. The append-only commit graph <em>is</em> the audit log: it is immutable by construction, not by policy, so when an auditor asks whether the deployment history could have been tampered with, the answer is that the branch protection makes it impossible.',
        'Open <strong>Inspect</strong> on any deployment and you get the receipts across several tabs — <em>Diff vs current</em> (what changed versus what’s live), <em>Files</em> (the exact source tree it ran), <em>Secrets snapshot</em> (the secret set in force), <em>Download image</em> (the built image + schema bundle), and, on the current deployment, <em>Scale</em>. When an auditor asks “show me”, you open a tab.',
        'A record is not only something to read, so Inspect also carries the two things a person actually wants from an old version. <strong>Edit this version</strong> is the hotpatch: your copy of that business process <em>becomes</em> that deployed version, landed as a restore commit <strong>on top of main</strong> — one commit ahead, none behind — so you fix the thing where it broke and press Deploy, with no Sync detour in between and nothing of yours lost (whatever your copy held is parked as a dated experiment, as everywhere else). On the <strong>development</strong> stage there is also <strong>Revert dev to this version</strong>: dev deploys from main, so putting it back is one new commit on main, and the dialog says the consequence plainly — everyone’s copy goes a commit behind and their next Sync carries the revert in. Both are covered in full in Ch&nbsp;10; they live here because this is where you are standing when you need them.',
      ],
      steps: ['Open a stage → <b>Deployment history</b>.', 'Read the timeline of events.', 'Press <b>Inspect</b> on a prior entry; step through <b>Files</b>, <b>Diff vs current</b> (a real diff against what’s live) and <b>Download image</b>.', 'Press <b>Roll back</b> on a prior entry and confirm to re-deploy that exact recorded version.', 'To carry on working <em>from</em> a prior version rather than just re-running it, press <b>Edit this version</b>; on <b>development</b>, <b>Revert dev to this version</b> puts the shared stage back for everyone.'],
      callout: { kind: 'An audit log you can’t tamper with', text: 'The canonical <code>main</code> branch is protected and <strong>fast-forward-only</strong> — every deploy advances it forward, never a force-push or a rewrite. History can only be appended to, so the deployment record is immutable <em>by construction</em>. Even the operator cannot quietly edit what shipped: the branch protection, not a promise, is what makes the trail tamper-proof.' },
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.8.15', demand: '<b>Logging (integrity & tamper-protection).</b> Operational events are recorded on a fast-forward-only protected <code>main</code> — append-only and rewrite-proof, so the log is protected from tampering by construction, including by the operator.' },
        { code: 'DORA', clause: 'Art. 13', demand: '<b>Learning and evolving.</b> A complete record supports post-incident review.' },
        { code: 'NIS2', clause: 'Art. 21(2)(b)', demand: '<b>Incident handling.</b> Reconstruct exactly what happened from the audit trail.' },
        { code: 'SOC 2', clause: 'CC8.1', demand: '<b>Change management.</b> Every change is recorded with its diff and the config in force.' },
      ],
    },
    {
      num: '14', eyebrow: 'Keep secrets secret', title: 'Secrets',
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
      num: '15', eyebrow: 'See what’s running', title: 'Containers',
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
      num: '16', eyebrow: 'Capture the truth', title: 'Backups & retention',
      lede: 'Point-in-time snapshots of the live database and object storage, with a retention policy and an audit trail.',
      slots: [
        { id: 'snapshot-create', label: 'Live capture', caption: 'Create snapshot · label and stage, before it runs' },
        { id: 'backups', label: 'Live capture', caption: 'Production · snapshot captured from the live DB' },
      ],
      sell: [
        'The <strong>Create snapshot</strong> dialog lets you label a snapshot and pick its stage; confirm and a task captures the <strong>live blue-green database</strong> — not a stale name — plus object storage, streaming its progress per store (Postgres, CouchDB, Garage) so it never goes dark.',
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
      num: '17', eyebrow: 'Sleep at night', title: 'Rehearse & restore (DR)',
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
      num: '18', eyebrow: 'Control the edges', title: 'Firewall & data processing',
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
      num: '19', eyebrow: 'Know your ingredients', title: 'Supply chain',
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
      num: '20', eyebrow: 'Right people, right rights', title: 'People & roles',
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
      num: '21', eyebrow: 'Let the right people in', title: 'Sharing an endpoint',
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
      num: '22', eyebrow: 'Feed the watchtower', title: 'SIEM export & monitoring',
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
      num: '23', eyebrow: 'Deny by default', title: 'A teammate’s first login',
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
      num: '24', eyebrow: 'You decide who gets in', title: 'Approve the person & trust the device',
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
      num: '25', eyebrow: 'In, on a trusted device', title: 'Access granted',
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
    {
      num: '26', eyebrow: 'Make a mess safely', title: 'Memory governance & the on-demand pool',
      lede: 'Users spin up as many previews and processes as they like without starving the workloads that matter. Bailey reserves memory for the services that must stay up and lets everything else scale to zero — under pressure automatically, or on demand with a button — waking the moment someone touches it, whether it’s a dev preview or a production service.',
      slots: [
        { id: 'resource-management', label: 'Live capture', caption: 'Server Console · Resource management — the memory budget and per-process usage grouped by process and stage (asleep processes shown too), each with a Sleep control' },
        { id: 'containers-memory', label: 'Live capture', caption: 'Workspace dashboard · a business process’s containers, each showing live memory against its reservation' },
      ],
      sell: [
        'Every automation declares two things in <code>automation.toml</code>: a <strong>memory-reservation</strong> (how much it is budgeted, in MB) and a <strong>memory_reservation_policy</strong> — <em>always-on</em> for a backend that must never stop (it runs background work), or <em>on-demand</em> (the default) for everything that can be paused when idle and woken on access. The daemon reads these off the running containers and keeps a single, honest budget: host memory, minus a system reserve, minus a per-workspace infrastructure reserve, minus every always-on reservation, minus a sized <strong>on-demand pool</strong>.',
        'That pool is the trick that lets users keep <em>unlimited</em> rarely-used business processes without cost. It is sized to run the largest few on-demand services at once and grows only when someone deploys a genuinely large one — so small, idle processes never consume reserved memory. When the running on-demand set exceeds the pool, Bailey shuts down the least-recently-used ones; the next time a person opens one, a loading screen appears and it is back in seconds. Promotions and new workspaces that would not fit the reserved budget are refused up front, with a message that says exactly how much is short. And any container that outgrows its reservation raises a SIEM event and is flagged, in red, right on its Containers tab.',
        'You don’t have to wait for pressure. The Server Console’s <strong>Resource management</strong> page lists every business process grouped by process and stage with live totals — <em>including the ones already asleep</em> — and gives each a <strong>Sleep</strong> button, plus <strong>Sleep all on-demand</strong> for the whole page. Sleeping is a true scale-to-zero: the workers <em>and</em> the shared egress gateway are torn down, so a paused process costs nothing at all; always-on services simply ignore the button. Waking is universal — not just dev previews but on-demand <em>staging and production</em> come back on first access, behind a brief loading page, rehydrated straight from the deployed source of truth (no eviction bookkeeping to lose).',
      ],
      steps: [
        'Declare <b>memory-reservation</b> (and, for a background worker, <b>memory_reservation_policy = "always-on"</b>) in <code>automation.toml</code>.',
        'Open <b>Resource management</b> in the Server Console to see the host budget, the reserved breakdown and per-process usage grouped by process and stage.',
        'Promote or create a workspace — Bailey admits it only if it fits the reserved budget, else tells you the shortfall.',
        'Press <b>Sleep</b> on a process (or <b>Sleep all on-demand</b>) to scale it to zero now; leave idle ones alone and they are shut down under pressure anyway.',
        'Reopen an asleep process — dev, staging or production — and it <b>wakes automatically</b> behind a brief loading page.',
        'Watch for the red <b>over-reservation</b> flag on the Containers tab — it also lands in your SIEM feed.',
      ],
      callout: { kind: 'Reserve what matters; evict the rest', text: 'Always-on backends are guaranteed their memory; everything else lives in a bounded pool that scales to zero — on demand or under pressure — and wakes on first access. A busy workspace full of experiments can never starve production.' },
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.8.6', demand: '<b>Capacity management.</b> Memory is reserved, budgeted and admission-controlled from live host state; over-use is detected and alerted.' },
        { code: 'SOC 2', clause: 'A1.1', demand: '<b>Availability.</b> Critical (always-on) workloads keep their reserved capacity; non-critical ones are shed under pressure without losing their state.' },
        { code: 'NIS2', clause: 'Art. 21(2)(c)', demand: '<b>Business continuity & capacity.</b> Resource pressure is managed automatically so essential services stay available.' },
        { code: 'DORA', clause: 'Art. 9', demand: '<b>Performance & capacity.</b> ICT resource limits are governed and monitored, with alerts when a workload exceeds its budget.' },
      ],
    },
    {
      num: '27', eyebrow: 'Stay current', title: 'Keeping Bailey up to date',
      lede: 'Every component tells you when it’s behind, moving to the latest is one click — for a workspace or the server itself — every update is recorded (who moved what to which version, and when), and any of the last three versions is one click back.',
      slots: [{ id: 'updates', label: 'Live capture', caption: 'Server Console · Updates — running versions, the workspaces on the latest track, and the update history you can roll back from' }],
      sell: [
        'Bailey compares the image tags each workspace is actually running against the latest on its release track, and compares the running server binary against the latest published release. When something is behind it says so — a workspace <strong>owner</strong> sees an <em>Update available</em> badge on their workspace card in the Bailey admin, and an <strong>admin</strong> gets an <strong>Updates</strong> item in the nav that carries a small bubble the moment any component is out of date. Nothing is inferred from names or guessed: an update is only ever flagged when Bailey can read the deployed tag <em>and</em> resolve the latest one, so the badge always names the exact versions it’s comparing.',
        'The <strong>Updates</strong> view is the single place to see and act on this. It shows the automation server’s current version alongside the latest release, and lists every workspace that has an update with a per-workspace <strong>Update</strong> button — press it and Bailey regenerates that workspace’s deployment on the latest tags and redeploys. The automation server updates the same way, from its own <strong>Update</strong> button: the daemon downloads the official binary from the AOC this server is registered with (the same source the one-line installer uses, so “official” has one meaning), swaps it in atomically on the host, and restarts onto the new version — the console reconnects on its own. No shell, no host command: enterprise operators never touch a CLI.',
        'Every update — server or workspace — is recorded in a version ledger: <strong>who</strong> applied it, <strong>when</strong>, and the exact <strong>from → to</strong> version. That ledger is the <strong>Update history</strong> shown right on this page and streamed to your SIEM, and it is also the way back. Each update keeps the state it replaced as a restorable point, so <strong>Roll back</strong> returns the server or a workspace to any of the <strong>last three</strong> recorded versions in one click — the previous server binary, or a workspace’s previous deployment, verbatim. The rollback is itself recorded as a new <em>rolled back</em> entry, so recovering from a bad change is auditable rather than a scramble; keeping the window bounded to three is deliberate, so the restorable history can’t grow without limit.',
      ],
      steps: [
        'Watch for the <b>Updates</b> nav bubble (admins) or an <b>Update available</b> badge on your workspace card (owners).',
        'Open <b>Updates</b> to see the server’s current → latest version and the workspaces that are behind.',
        'Press a workspace’s <b>Update</b> button to move it to the latest track and redeploy, or the server’s <b>Update</b> button to move the automation server itself.',
        'Read <b>Update history</b> to see who updated what, to which version, and when — the same record your SIEM receives.',
        'If an update misbehaves, press <b>Roll back</b> on any of the last three recorded versions to restore it — the rollback is recorded too.',
      ],
      callout: { kind: 'Reversible by design', text: 'Every update keeps the state it replaced as a restorable point, so the server or a workspace rolls back to any of the last three recorded versions with one click — and the rollback is itself recorded. The version you were on is never more than a click away.' },
      standards: [
        { code: 'ISO/IEC 27001', clause: 'A.8.8', demand: '<b>Management of technical vulnerabilities.</b> Out-of-date components are surfaced and patched to a known-good latest, with a controlled way back.' },
        { code: 'SOC 2', clause: 'CC8.1', demand: '<b>Change management.</b> Version changes are visible, applied deliberately, and reversible.' },
        { code: 'NIS2', clause: 'Art. 21(2)(e)', demand: '<b>Vulnerability handling & patching.</b> Components report when they are behind and are updated from an authoritative source.' },
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
        { control: 'A.5.18', req: 'Access rights (least privilege, review)', status: 'provided', bailey: 'Operator / auditor / member roles, server-enforced', ch: '20', yours: 'Periodic access reviews' },
        { control: 'A.5.3', req: 'Segregation of duties', status: 'provided', bailey: 'Build vs release split: a member ships to staging; an independent auditor freezes, signs off and promotes to production', ch: '12', yours: 'Duty-conflict matrix' },
        { control: 'A.8.8', req: 'Management of technical vulnerabilities', status: 'provided', bailey: 'Pre-deploy CVE scan + in-tree waivers', ch: '10 · 19', yours: 'Triage & remediation SLAs' },
        { control: 'A.8.9', req: 'Configuration management', status: 'partial', bailey: 'bitswan.yaml is the declarative source of truth — freeze state, audit policy and sign-offs versioned in git', ch: '11 · 12', yours: 'Baseline definition & review' },
        { control: 'A.8.13', req: 'Information backup', status: 'provided', bailey: 'Per-stage snapshots + retention policy', ch: '16', yours: 'Offsite copy & retention targets' },
        { control: 'A.8.15 / A.8.16', req: 'Logging & monitoring', status: 'provided', bailey: 'Versioned deploy/event history, live container health, real-time SIEM export (OTLP)', ch: '13 · 15 · 22', yours: 'SIEM correlation rules, alerting' },
        { control: 'A.8.20 / A.8.21', req: 'Network & network-services security', status: 'provided', bailey: 'Default-deny egress allow-list per service', ch: '18', yours: 'Perimeter & internal segmentation policy' },
        { control: 'A.8.24', req: 'Use of cryptography & secrets', status: 'provided', bailey: 'Stage secrets, injected not committed; TLS at edge', ch: '14', yours: 'Key-management policy' },
        { control: 'A.8.31', req: 'Separation of dev/test/production', status: 'provided', bailey: 'Isolated copies + dev / staging / production stages', ch: '05 · 09 · 11', yours: '—' },
        { control: 'A.8.3', req: 'Information access restriction', status: 'provided', bailey: 'Workspaces scope access per tenancy + role; per-endpoint owner-managed sharing', ch: '02 · 21', yours: 'Membership reviews' },
        { control: 'A.8.32', req: 'Change management', status: 'provided', bailey: 'Reversible blue-green promotion + four-eyes freeze/audit gate + immutable history', ch: '11 · 12 · 13', yours: 'Change approval workflow' },
        { control: 'A.5.30', req: 'ICT readiness for business continuity', status: 'provided', bailey: 'DR slot + rehearsed, recorded recovery tests', ch: '17', yours: 'BCP/DR plan & RTO/RPO targets' },
      ],
    },
    {
      standard: 'SOC 2 (Trust Services Criteria)',
      blurb: 'The common-criteria and availability TSCs Bailey supports as a service component. Your audit still covers the organizational criteria (CC1–CC5), risk assessment and vendor management.',
      rows: [
        { control: 'CC6.1', req: 'Logical access security', status: 'provided', bailey: 'Device-trust gate fronting every endpoint', ch: '01 · 03', yours: 'Access policy & ownership' },
        { control: 'CC6.2 / CC6.3', req: 'Access provisioning & removal', status: 'provided', bailey: 'Central role + device grant/revoke', ch: '04 · 20', yours: 'Timely de-provisioning process' },
        { control: 'CC6.6', req: 'Boundary protection', status: 'provided', bailey: 'Default-deny egress allow-list', ch: '18', yours: 'Network perimeter design' },
        { control: 'CC6.7', req: 'Data in transit & at rest', status: 'provided', bailey: 'TLS at the edge (traefik) with managed cert lifecycle; backups encrypted', ch: '01 · 16', yours: 'Disk encryption on the Bailey host (at rest)' },
        { control: 'CC7.1', req: 'Vulnerability detection', status: 'provided', bailey: 'SBOM + CVE scan on the image that ships', ch: '19', yours: 'Remediation tracking' },
        { control: 'CC7.2', req: 'System monitoring', status: 'provided', bailey: 'Container health + event history + real-time SIEM export', ch: '13 · 15 · 22', yours: 'Alerting & on-call' },
        { control: 'CC8.1', req: 'Change management', status: 'provided', bailey: 'Promotion pipeline + freeze/audit sign-off gate + immutable deploy history', ch: '10 · 11 · 12 · 13', yours: 'Change authorization' },
        { control: 'A1.2', req: 'Backup & environmental protection', status: 'provided', bailey: 'Snapshots + standby DR slot', ch: '16 · 17', yours: 'Backup off-platform' },
        { control: 'A1.3', req: 'Recovery testing', status: 'provided', bailey: 'Rehearse-into-DR + recorded recovery tests', ch: '17', yours: 'Test cadence sign-off' },
      ],
    },
    {
      standard: 'DORA (Regulation (EU) 2022/2554)',
      blurb: 'The ICT risk-management articles Bailey operationalizes for financial entities. Governance, incident reporting to authorities, and third-party registers remain your obligation.',
      rows: [
        { control: 'Art. 8', req: 'Identification of ICT risk', status: 'provided', bailey: 'Pre-deploy supply-chain / CVE identification', ch: '19', yours: 'Risk register & classification' },
        { control: 'Art. 9(3)', req: 'Strong authentication & protection', status: 'provided', bailey: 'Device-trust gate', ch: '01', yours: 'Identity governance' },
        { control: 'Art. 9', req: 'Protection & prevention (change impact)', status: 'provided', bailey: 'Zero-downtime blue-green change path + independent sign-off gate', ch: '11 · 12', yours: 'Segregation policy' },
        { control: 'Art. 10', req: 'Detection of anomalous activity', status: 'provided', bailey: 'Container health + deploy/event history + real-time SIEM export', ch: '13 · 15 · 22', yours: 'Detection thresholds & alerting' },
        { control: 'Art. 11', req: 'Response & recovery', status: 'provided', bailey: 'One-cutover DR swap, no data move', ch: '17', yours: 'Crisis-management plan' },
        { control: 'Art. 12', req: 'Backup, restoration & testing', status: 'provided', bailey: 'Snapshots + rehearsed DR restores', ch: '16 · 17', yours: 'RTO/RPO & offsite policy' },
        { control: 'Art. 13', req: 'Learning & evolving', status: 'provided', bailey: 'Complete, inspectable deploy audit trail', ch: '13', yours: 'Post-incident review process' },
        { control: 'Art. 24–26', req: 'Resilience testing programme', status: 'partial', bailey: 'Runnable requirement tests + DR rehearsals', ch: '08 · 17', yours: 'TLPT for significant entities' },
      ],
    },
    {
      standard: 'NIS2 (Directive (EU) 2022/2555)',
      blurb: 'The Article 21(2) cybersecurity-risk-management measures Bailey delivers technically. Governance, training and incident notification to your CSIRT stay with you.',
      rows: [
        { control: 'Art. 21(2)(a)', req: 'Risk analysis & network security', status: 'partial', bailey: 'Default-deny egress with reviewed exceptions', ch: '18', yours: 'Risk-analysis methodology' },
        { control: 'Art. 21(2)(b)', req: 'Incident handling', status: 'partial', bailey: 'Reconstruct events from the audit trail', ch: '13', yours: 'Incident response & notification' },
        { control: 'Art. 21(2)(c)', req: 'Business continuity & backups', status: 'provided', bailey: 'Backups + zero-downtime DR swap', ch: '16 · 17', yours: 'BCP & crisis comms' },
        { control: 'Art. 21(2)(d)', req: 'Supply-chain security', status: 'provided', bailey: 'SBOM + CVE visibility per image', ch: '19', yours: 'Supplier assessment' },
        { control: 'Art. 21(2)(e)', req: 'Secure development & vuln handling', status: 'provided', bailey: 'Pre-deploy checks + versioned waivers', ch: '10', yours: 'SDLC policy' },
        { control: 'Art. 21(2)(h)', req: 'Cryptography', status: 'provided', bailey: 'Secret handling + TLS at the edge', ch: '14', yours: 'Crypto policy' },
        { control: 'Art. 21(2)(i)', req: 'Access control & asset management', status: 'provided', bailey: 'Roles + workspace/endpoint inventory + per-endpoint sharing', ch: '02 · 03 · 20 · 21', yours: 'Asset ownership' },
        { control: 'Art. 21(2)(j)', req: 'Multi-factor authentication', status: 'provided', bailey: 'Hardware-bound device trust', ch: '01 · 04', yours: 'Enrolment policy' },
      ],
    },
    {
      standard: 'GDPR (Regulation (EU) 2016/679)',
      blurb: 'The security-of-processing and accountability articles Bailey supports. Lawful basis, data-subject rights, DPIAs and breach notification remain controller obligations.',
      rows: [
        { control: 'Art. 30', req: 'Records of processing activities', status: 'provided', bailey: 'Per-egress data-processing record, auto-maintained', ch: '18', yours: 'Controller-level register' },
        { control: 'Art. 28', req: 'Processor obligations / DPAs', status: 'provided', bailey: 'DPA stored before egress is allowed', ch: '18', yours: 'Contract terms & due diligence' },
        { control: 'Art. 32', req: 'Security of processing', status: 'provided', bailey: 'Access control, secrets, backup & resilience', ch: '14 · 16 · 17', yours: 'Risk-based measures & review' },
        { control: 'Art. 5(1)(f)', req: 'Integrity & confidentiality', status: 'provided', bailey: 'Gated access + default-deny egress', ch: '01 · 18', yours: 'Data-handling policy' },
        { control: 'Art. 33', req: 'Breach notification', status: 'partial', bailey: 'Audit trail to reconstruct what happened', ch: '13', yours: '72-hour notification process' },
      ],
    },
  ],
};
