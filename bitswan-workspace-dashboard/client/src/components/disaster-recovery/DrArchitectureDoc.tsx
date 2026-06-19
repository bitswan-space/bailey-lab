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
 * "How this works" — an in-product explainer for the blue-green production
 * architecture (3 app slots over 2 databases), shown as a tab on the DR page so
 * operators understand zero-downtime promotion and DR recovery before they act.
 * Static content; no data.
 */
export function DrArchitectureDoc() {
  return (
    <div className="flex flex-col gap-5 text-[13px] leading-relaxed text-foreground">
      <Section
        icon={<Boxes className="size-4 text-primary" aria-hidden />}
        title="Two databases, three app slots"
      >
        <p>
          Each production business process has <Term>two persistent databases</Term> — <Db n={1} />{' '}
          and <Db n={2} /> — and up to <Term>three app slots</Term> (<Slot>a</Slot> <Slot>b</Slot>{' '}
          <Slot>c</Slot>), where an app slot is a full set of app containers (frontend + backend).
          Two pointers say what is what:
        </p>
        <ul className="ml-1 flex flex-col gap-1.5">
          <Bullet icon={<Database className="size-3.5 text-emerald-600" aria-hidden />}>
            <Code>live_db</Code> — which database is <strong>Production</strong>. The other is the{' '}
            <strong>DR standby</strong> (where restores land).
          </Bullet>
          <Bullet icon={<Rocket className="size-3.5 text-emerald-600" aria-hidden />}>
            <Code>live_slot</Code> — which app slot the production ingress serves.
          </Bullet>
        </ul>
        <p>
          Steady state runs <Term>two slots</Term>: the live one (on <Code>live_db</Code>) and the DR
          one (on the standby db). The third slot sits <Term>idle</Term> — it is the buffer that makes
          zero-downtime promotion possible.
        </p>
        <SteadyStateDiagram />
      </Section>

      <Section
        icon={<ArrowLeftRight className="size-4 text-primary" aria-hidden />}
        title="One primitive: repoint the ingress"
      >
        <p>
          There is only ever <Term>one operation</Term>: switch which app slot the production ingress
          points at. No data is moved and nothing is rebuilt to change it — the app keeps serving. Two
          flows use this same primitive.
        </p>
      </Section>

      <Section
        icon={<Rocket className="size-4 text-primary" aria-hidden />}
        title="Zero-downtime promotion (new code)"
      >
        <p>
          To ship a new version with no downtime: bring it up on the <Term>idle slot</Term>, wired to
          the <strong>current live database</strong> — a promote <strong>never moves data</strong>.
          Health-check it, repoint the ingress to it, then retire the old slot (it becomes the new
          idle buffer).
        </p>
        <PromoteDiagram />
      </Section>

      <Section
        icon={<LifeBuoy className="size-4 text-primary" aria-hidden />}
        title="Disaster recovery (data)"
      >
        <p>You never restore onto live Production. Recovery flows the safe way:</p>
        <ol className="ml-1 flex list-none flex-col gap-1.5">
          <Step n={1}>
            Restore a backup into the <DrTag /> — the <Term>standby database</Term>. Live Production is
            untouched.
          </Step>
          <Step n={2}>Open the DR slot’s app and verify the data by hand.</Step>
          <Step n={3}>
            <strong>Swap</strong>: flip <Code>live_db</Code> to the standby and repoint the ingress to
            the DR slot. Production and DR trade places — zero downtime, no data moved.
          </Step>
        </ol>
        <SwapDiagram />
        <p className="text-muted-foreground">
          Restores into <Code>dev</Code> and <Code>staging</Code> stay allowed (those aren’t live
          Production). Restoring directly onto the live database is refused by the server.
        </p>
      </Section>

      <Section
        icon={<ShieldCheck className="size-4 text-primary" aria-hidden />}
        title="Quarterly recovery tests (CISO policy)"
      >
        <p>
          Backups are only trustworthy if you’ve proven they restore. On a cadence (quarterly by
          default) someone restores Production’s latest backup into DR, verifies it, and records the
          test. This page warns when a BP is <strong>overdue</strong>. Testing restores &amp; verifies
          — it does <strong>not</strong> swap.
        </p>
      </Section>

      <Section
        icon={<FileClock className="size-4 text-primary" aria-hidden />}
        title="Everything is audited"
      >
        <p>
          Every backup, restore, retention change, swap and promote is written to{' '}
          <Code>bitswan.yaml</Code> and committed to git — who, when, what — and shows up in this
          page’s audit log and the deployment history.{' '}
          <Database className="inline size-3.5 align-text-bottom" aria-hidden />
        </p>
      </Section>
    </div>
  );
}

function DiagramBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-1 overflow-x-auto rounded-lg border border-border bg-muted/30 p-4 font-mono text-[11.5px] leading-relaxed">
      <div className="flex min-w-fit flex-col gap-1.5">{children}</div>
    </div>
  );
}

function Pill({ tone, children }: { tone: 'live' | 'dr' | 'idle'; children: React.ReactNode }) {
  const cls = {
    live: 'bg-emerald-100 text-emerald-800',
    dr: 'bg-amber-100 text-amber-800',
    idle: 'bg-muted text-muted-foreground',
  }[tone];
  return <span className={`rounded px-1.5 py-0.5 font-semibold ${cls}`}>{children}</span>;
}

function Tag({ tone, children }: { tone: 'live' | 'dr'; children: React.ReactNode }) {
  const cls = tone === 'live' ? 'bg-emerald-600' : 'bg-amber-500';
  return (
    <span className={`rounded-full px-1.5 text-[9px] font-bold uppercase text-white ${cls}`}>
      {children}
    </span>
  );
}

function SteadyStateDiagram() {
  return (
    <DiagramBox>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">production ingress ──▶</span>
        <Pill tone="live">slot a → db1</Pill>
        <Tag tone="live">live · production</Tag>
      </div>
      <div className="flex items-center gap-2 pl-[8.6rem]">
        <Pill tone="dr">slot b → db2</Pill>
        <Tag tone="dr">standby · dr</Tag>
      </div>
      <div className="flex items-center gap-2 pl-[8.6rem]">
        <Pill tone="idle">slot c · idle (promote buffer)</Pill>
      </div>
    </DiagramBox>
  );
}

function PromoteDiagram() {
  return (
    <DiagramBox>
      <div className="text-muted-foreground">1 · bring new code up on the idle slot, same db1</div>
      <div className="flex items-center gap-2 pl-4">
        <Pill tone="live">slot a → db1</Pill>
        <Tag tone="live">live</Tag>
        <Pill tone="idle">slot c (new) → db1</Pill>
      </div>
      <div className="pt-1 text-muted-foreground">2 · repoint ingress ──▶ slot c, retire slot a</div>
      <div className="flex items-center gap-2 pl-4">
        <Pill tone="live">slot c → db1</Pill>
        <Tag tone="live">live</Tag>
        <Pill tone="idle">slot a · idle</Pill>
      </div>
      <div className="pt-1 text-[11px] text-emerald-700">db never moves — new code, same data</div>
    </DiagramBox>
  );
}

function SwapDiagram() {
  return (
    <DiagramBox>
      <div className="text-muted-foreground">before — restore landed in db2 (standby), verified</div>
      <div className="flex items-center gap-2 pl-4">
        <Pill tone="live">slot a → db1</Pill>
        <Tag tone="live">live</Tag>
        <Pill tone="dr">slot b → db2</Pill>
        <Tag tone="dr">dr</Tag>
      </div>
      <div className="pt-1 text-muted-foreground">swap — flip live_db→db2, repoint ingress──▶slot b</div>
      <div className="flex items-center gap-2 pl-4">
        <Pill tone="dr">slot a → db1</Pill>
        <Tag tone="dr">dr</Tag>
        <Pill tone="live">slot b → db2</Pill>
        <Tag tone="live">live</Tag>
      </div>
      <div className="pt-1 text-[11px] text-emerald-700">zero downtime — Production and DR trade places</div>
    </DiagramBox>
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
  <span className="rounded bg-muted px-1 font-mono font-semibold">{children}</span>
);
const Db = ({ n }: { n: number }) => (
  <span className="rounded bg-sky-100 px-1.5 py-0.5 font-mono text-[12px] font-semibold text-sky-700">
    db{n}
  </span>
);
const DrTag = () => (
  <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700">
    standby (DR)
  </span>
);
