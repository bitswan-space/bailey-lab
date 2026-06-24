/**
 * The protagonist of the manual: Meridian Foods s.r.o., a mid-market Central
 * European food distributor running its vendor **invoice-processing** on Bitswan.
 *
 * Everything here is entered into the REAL system through the REAL UI during the
 * walkthrough — it is demo *content*, not mocked backend data. Names are Czech /
 * Slovak / German to match where Bitswan actually lives. Keep it coherent: the
 * same cast, vendors and invoices recur across every screenshot so the manual
 * reads as one true story.
 */

export const COMPANY = {
  name: 'Meridian Foods s.r.o.',
  short: 'Meridian Foods',
  city: 'Brno, CZ',
  blurb: 'A regional food distributor processing several thousand vendor invoices a month.',
};

/** The business process we create through the Server Console UI. */
export const BP = {
  // Must satisfy the workspace/BP name rule: ^[a-z][a-z0-9-]{1,32}$
  slug: 'invoice-processing',
  title: 'Invoice Processing',
  description:
    'Ingests vendor invoices (PDF + EDI), validates totals and VAT against the ' +
    'purchase order, routes anything over €5,000 for human approval, and posts ' +
    'approved invoices to the ledger. Runs for Meridian Foods s.r.o.',
  // The README the walkthrough TYPES into the Description editor — prose +
  // Markdown shortcuts only. The process FLOW is NOT typed as a mermaid block;
  // the walkthrough DRAWS it with the flowchart editor (the toolbar "Insert
  // flowchart" button → FlowchartEditorModal → Save diagram), which is how a
  // real operator builds the diagram. Built as a line array for readability.
  readme: [
    '# Invoice Processing',
    '',
    'Automated accounts-payable for **Meridian Foods s.r.o.** — ingest vendor invoices,',
    'validate them against the purchase order, route the big ones for a human, and post',
    'the rest straight to the ledger.',
    '',
    '## What it does',
    '',
    '1. **Ingest** — pull invoices (PDF + EDI) from vendor portals and the shared inbox.',
    '2. **Validate** — match totals and VAT against the purchase order.',
    '3. **Approve** — anything over **€5,000** is held for a human; the rest auto-approves.',
    '4. **Post** — approved invoices post to the ledger and the vendor is paid via the gateway.',
    '',
    '## The flow',
    '',
    'The lifecycle is drawn below as a flowchart.',
    '',
    '## Rules it must keep',
    '',
    '- VAT total must match the purchase order within €0.01.',
    '- Invoices over €5,000 require human approval before posting.',
    '- A duplicate invoice number must never post twice.',
  ].join('\n'),
  // The MEANINGFUL v2 source change the walkthrough makes after v1 is deployed:
  // a concrete new business rule (manager approval tier) plus a new recorded
  // field. Appended to the Description so it produces a NON-trivial diff that
  // shows up in Deployment history → Inspect → "Diff vs current" and gives the
  // rollback rehearsal a genuine prior version to roll back to. Editorial copy
  // lives here in version control, not inline in the spec.
  readmeV2Addition: [
    '',
    '## Manager approval tier (v2)',
    '',
    'Invoices over **€5,000** are held for **manager approval** before posting —',
    'they are routed to the assigned approving manager and recorded as *pending*',
    'until signed off. The approving manager and the approval timestamp are stored',
    'on the invoice record.',
    '',
    '- New field: `approving_manager` — the manager who must sign off a held invoice.',
    '- New field: `approved_at` — when the hold was cleared (null while pending).',
  ].join('\n'),
};

/** The workspace created via the Bailey Server Console. Workspaces are THEMATIC,
 * not per-company: Meridian Foods runs a "finance" workspace for its finance-
 * automation team (invoice-processing lives here), and would run a separate
 * "logistics" workspace — shared with, and visible to, different people. */
export const WORKSPACE = {
  name: 'finance',
  title: 'Finance',
};

/**
 * The cast. The first to sign in claims the Bailey server and becomes root
 * admin (operator); the others appear on the People & roles roster with the
 * roles the standards expect you to separate (operator / auditor / member).
 */
export interface Person {
  name: string;
  email: string;
  role: 'admin' | 'auditor' | 'member';
  title: string;
  origin: 'CZ' | 'SK' | 'DE';
}

export const OPERATOR: Person = {
  name: 'Tomáš Novák',
  email: 'tomas.novak@meridianfoods.cz',
  role: 'admin',
  title: 'Platform operator — claims the server, owns deployments',
  origin: 'CZ',
};

/**
 * The SECOND login identity used for the onboarding story: a regular Meridian
 * teammate who is NOT the server root admin. Tomáš claims the server first (and
 * so becomes root admin); Marek is just another identity in the OIDC realm with
 * no Bailey access until the admin approves him and his device under the
 * deny-by-default posture. The walkthrough logs in AS Marek from a "new device"
 * to drive the self-request → admin-approve flow for real.
 *
 * These are real, seeded credentials in the mock Keycloak realm
 * (e2e/keycloak/realm-export.json) and are surfaced into e2e/.env by
 * e2e/bringup.sh as E2E_TEAMMATE_EMAIL / E2E_TEAMMATE_PASSWORD (see
 * e2e/fixtures/bitswan.ts ENV.teammateEmail / ENV.teammatePassword).
 */
export const TEAMMATE: Person = {
  name: 'Marek Horváth',
  email: 'marek.horvath@meridianfoods.cz',
  role: 'member',
  title: 'Process developer — onboards as a new, unprivileged user + device',
  origin: 'SK',
};

/** Marek's mock-Keycloak password (matches realm-export.json). */
export const TEAMMATE_PASSWORD = 'meridian-member';

export const CAST: Person[] = [
  OPERATOR,
  { name: 'Eva Müller', email: 'eva.mueller@meridianfoods.cz', role: 'auditor', title: 'Compliance auditor — read-only oversight, sets recovery cadence', origin: 'DE' },
  TEAMMATE,
  { name: 'Jana Dvořáková', email: 'jana.dvorakova@meridianfoods.cz', role: 'member', title: 'Finance operations', origin: 'CZ' },
  { name: 'Lukas Bauer', email: 'lukas.bauer@meridianfoods.cz', role: 'member', title: 'Treasury & payments', origin: 'DE' },
];

/**
 * Egress allow-list entries for the Firewall feature: the external hosts an
 * invoice processor legitimately talks to. Regional vendors + a Czech payment
 * gateway. These get approved/recorded with the GDPR data-processing form.
 */
export interface EgressHost {
  host: string;
  purpose: string;
  processesPersonalData: boolean;
}

export const EGRESS: EgressHost[] = [
  { host: 'moravia-produkty.cz', purpose: 'Vendor invoice portal (produce)', processesPersonalData: false },
  { host: 'donau-logistik.de', purpose: 'Freight vendor EDI endpoint', processesPersonalData: false },
  { host: 'tatra-trans.sk', purpose: 'Vendor invoice portal (logistics)', processesPersonalData: false },
  { host: 'api.gopay.com', purpose: 'Payment gateway — settles approved invoices', processesPersonalData: true },
  { host: 'ares.gov.cz', purpose: 'Czech business register — vendor VAT-ID validation', processesPersonalData: true },
];

/** Invoices that recur in the demo data and screenshots. */
export interface Invoice {
  number: string;
  vendor: string;
  amountEur: number;
  needsApproval: boolean; // > €5,000 routes for human approval
}

export const INVOICES: Invoice[] = [
  { number: 'MP-2026-04417', vendor: 'Moravia Produkty', amountEur: 1284.5, needsApproval: false },
  { number: 'DL-2026-00921', vendor: 'Donau Logistik', amountEur: 7430.0, needsApproval: true },
  { number: 'TT-2026-03110', vendor: 'Tatra Trans', amountEur: 612.9, needsApproval: false },
  { number: 'MP-2026-04503', vendor: 'Moravia Produkty', amountEur: 18950.0, needsApproval: true },
];

/** Environment secrets the invoice process needs (keys only; values are demo). */
export const SECRETS: { key: string; value: string; note: string }[] = [
  { key: 'GOPAY_CLIENT_ID', value: 'mf-prod-8842', note: 'Payment gateway client id' },
  { key: 'GOPAY_CLIENT_SECRET', value: 'demo-secret-rotate-me', note: 'Payment gateway secret' },
  { key: 'LEDGER_DSN', value: 'postgres://ledger.internal/meridian', note: 'Ledger database' },
  { key: 'APPROVAL_THRESHOLD_EUR', value: '5000', note: 'Above this, route for human approval' },
];

/**
 * SIEM forwarding target for the security chapter. The bring-up stands up a
 * REAL, lightweight OpenTelemetry collector (otel/opentelemetry-collector) on
 * the shared bitswan_network with an OTLP receiver + a debug exporter, so when
 * the admin points Bailey's SIEM forwarding at this endpoint the connectivity
 * test SUCCEEDS and the audit events actually flow (no on-screen errors).
 *
 * The daemon container reaches the collector by container name on
 * bitswan_network. Bailey's SIEM config (bailey_siem.go) takes a base endpoint
 * and a protocol:
 *   - otlp-http (default): POSTs to <endpoint>/v1/logs        → port 4318
 *   - otlp-grpc:           LogsService/Export over gRPC        → port 4317
 * The HTTP form is what the SIEM card's URL field expects. Surfaced into
 * e2e/.env by e2e/bringup.sh as E2E_OTLP_HTTP_ENDPOINT / E2E_OTLP_GRPC_ENDPOINT
 * (see e2e/fixtures/bitswan.ts ENV.otlpHttpEndpoint / ENV.otlpGrpcEndpoint).
 */
export const SIEM = {
  collectorHost: 'bitswan-e2e-otel',
  /** OTLP/HTTP base URL the daemon POSTs audit logs to (Bailey appends /v1/logs). */
  httpEndpoint: 'http://bitswan-e2e-otel:4318',
  /** OTLP/gRPC target (LogsService/Export), for the otlp-grpc protocol. */
  grpcEndpoint: 'http://bitswan-e2e-otel:4317',
  /** Default protocol for the SIEM card (matches Bailey's siemProtocolHTTP). */
  protocol: 'otlp-http' as const,
};

/** Testable requirements for the Requirements & tests feature. */
export const REQUIREMENTS: { title: string; body: string }[] = [
  { title: 'VAT total matches the purchase order', body: 'Given a vendor invoice, the computed VAT must equal the PO VAT within €0.01.' },
  { title: 'Invoices over €5,000 require approval', body: 'Any invoice with amount > APPROVAL_THRESHOLD_EUR must be held for human approval before posting.' },
  { title: 'Duplicate invoice numbers are rejected', body: 'An invoice number already posted in the last 24 months must not post again.' },
];
