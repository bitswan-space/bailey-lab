import {
  ArrowLeftRight,
  Boxes,
  Database,
  FileClock,
  LifeBuoy,
  Lock,
  Rocket,
  ShieldCheck,
} from 'lucide-react';

/**
 * "How this works" — an in-product explainer for the blue-green Production /
 * Disaster-Recovery architecture, shown as a tab on the DR page so operators
 * understand the model before they restore or swap. Static content; no data.
 */
export function DrArchitectureDoc() {
  return (
    <div className="flex flex-col gap-5 text-[13px] leading-relaxed text-foreground">
      <Section
        icon={<Boxes className="size-4 text-primary" aria-hidden />}
        title="Two production slots — A and B"
      >
        <p>
          Every production business process runs as <Term>two self-contained slots</Term>,{' '}
          <Slot>A</Slot> and <Slot>B</Slot>. Each slot is a full copy of the app — its own
          frontend and backend containers — wired to <Term>its own database</Term> (a separate
          logical Postgres DB, MinIO bucket and CouchDB namespace). The slots never share data.
        </p>
        <p>
          At any moment exactly one slot is <LiveTag /> — it is what real users hit — and the other
          is <DrTag />. Which one is live is decided by a single pointer (<Code>live_slot</Code>)
          recorded in <Code>bitswan.yaml</Code>.
        </p>
        <Diagram />
      </Section>

      <Section
        icon={<ArrowLeftRight className="size-4 text-primary" aria-hidden />}
        title="One primitive: repoint the ingress"
      >
        <p>
          There is only ever <Term>one operation</Term>: switch which containers the production
          ingress points at. No data is moved and nothing is redeployed to change which DB is live —
          the app keeps running. Two things use this same primitive:
        </p>
        <ul className="ml-1 flex flex-col gap-2">
          <Bullet icon={<Rocket className="size-3.5 text-emerald-600" aria-hidden />}>
            <strong>Zero-downtime promote (deploy).</strong> A new app version is brought up, the
            ingress is repointed to it, and the old version retired — with <strong>no change</strong>{' '}
            to the database. The new code talks to the current live DB. A deploy never swaps DBs.
          </Bullet>
          <Bullet icon={<LifeBuoy className="size-3.5 text-amber-600" aria-hidden />}>
            <strong>DR go-live swap.</strong> The ingress is repointed to the <em>other</em> slot.
            That slot&apos;s database becomes live; the old live slot becomes DR. Zero downtime, no
            data moved — Production and DR simply trade places.
          </Bullet>
        </ul>
      </Section>

      <Section
        icon={<Lock className="size-4 text-primary" aria-hidden />}
        title="You never restore onto live Production"
      >
        <p>
          Restoring a backup overwrites a database, so it is <Term>never</Term> allowed to target
          live Production (the server refuses it). Recovery always flows the safe way:
        </p>
        <ol className="ml-1 flex list-none flex-col gap-1.5">
          <Step n={1}>Restore a backup into the <DrTag /> slot (the standby DB). Live Production is untouched.</Step>
          <Step n={2}>Open the DR app and verify the data by hand — is everything there and correct?</Step>
          <Step n={3}>
            Only then <strong>swap</strong> — the verified DR slot becomes Production via the ingress
            cutover above.
          </Step>
        </ol>
        <p className="text-muted-foreground">
          Restores into <Code>dev</Code> and <Code>staging</Code> are still allowed (those aren&apos;t
          live Production).
        </p>
      </Section>

      <Section
        icon={<ShieldCheck className="size-4 text-primary" aria-hidden />}
        title="Quarterly recovery tests (CISO policy)"
      >
        <p>
          Backups are only trustworthy if you&apos;ve proven they restore. On a cadence (quarterly by
          default) someone restores Production&apos;s latest backup into DR, verifies it by hand, and
          records the test. The page warns when a BP is <strong>overdue</strong>. Routine testing
          restores &amp; verifies — it does <strong>not</strong> swap.
        </p>
      </Section>

      <Section
        icon={<FileClock className="size-4 text-primary" aria-hidden />}
        title="Everything is audited"
      >
        <p>
          Every backup created, every restore, every retention-policy change, and every swap is
          written to <Code>bitswan.yaml</Code> and committed to git — who, when, and what. It shows
          up in this page&apos;s audit log and in the deployment history, and (being git) is the
          permanent, reviewable record. <Database className="inline size-3.5 align-text-bottom" aria-hidden />
        </p>
      </Section>
    </div>
  );
}

function Diagram() {
  return (
    <div className="mt-1 flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-4 font-mono text-[11.5px] leading-relaxed text-foreground">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">production ingress</span>
        <span className="text-primary">───▶</span>
        <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-semibold text-emerald-800">
          slot A · app → db-a
        </span>
        <span className="rounded-full bg-emerald-600 px-1.5 text-[9px] font-bold uppercase text-white">
          live · production
        </span>
      </div>
      <div className="flex items-center gap-2 pl-[7.4rem] text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5">slot B · app → db-b</span>
        <span className="rounded-full bg-amber-500 px-1.5 text-[9px] font-bold uppercase text-white">
          standby · dr
        </span>
      </div>
      <div className="pt-1 text-[11px] text-muted-foreground">
        swap = move the ingress arrow to slot B → B becomes live Production, A becomes DR.
      </div>
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-[14px] font-bold text-foreground">
        {icon}
        {title}
      </h3>
      <div className="flex flex-col gap-2 pl-6">{children}</div>
    </section>
  );
}

function Bullet({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span>{children}</span>
    </li>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-bold text-primary">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

const Term = ({ children }: { children: React.ReactNode }) => (
  <strong className="font-semibold text-foreground">{children}</strong>
);
const Code = ({ children }: { children: React.ReactNode }) => (
  <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">{children}</code>
);
const Slot = ({ children }: { children: React.ReactNode }) => (
  <span className="font-mono font-semibold">{children}</span>
);
const LiveTag = () => (
  <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700">
    live (Production)
  </span>
);
const DrTag = () => (
  <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700">
    standby (DR)
  </span>
);
