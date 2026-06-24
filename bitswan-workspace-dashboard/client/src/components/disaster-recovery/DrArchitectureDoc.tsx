import { useEffect, useState } from 'react';
import {
  ArrowLeftRight,
  Boxes,
  FileClock,
  LifeBuoy,
  Rocket,
  ShieldCheck,
} from 'lucide-react';
import { api, type BackupState } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * "How this works" — an in-product explainer for the blue-green production
 * architecture, shown as a tab on the DR page. Opens with a LIVE state diagram
 * (which slot is Production / DR / idle right now), then explains the model
 * what/why before how.
 */
export function DrArchitectureDoc({ bp }: { bp: string }) {
  return (
    <div className="flex flex-col gap-5 text-[13px] leading-relaxed text-foreground">
      <Section
        icon={<Boxes className="size-4 text-primary" aria-hidden />}
        title="Right now"
      >
        <LiveState bp={bp} />
      </Section>

      <Section
        icon={<ShieldCheck className="size-4 text-primary" aria-hidden />}
        title="What this is for"
      >
        <p>
          Two things you’ll eventually need to do in production are dangerous if you do them the
          obvious way:
        </p>
        <ul className="ml-1 flex flex-col gap-2">
          <Bullet icon={<Rocket className="size-3.5 text-emerald-600" aria-hidden />}>
            <strong>Ship a new version</strong> — restarting the app in place means downtime, and a
            bad release takes live users down with it.
          </Bullet>
          <Bullet icon={<LifeBuoy className="size-3.5 text-amber-600" aria-hidden />}>
            <strong>Recover lost or corrupted data</strong> — restoring a backup straight onto the
            live database overwrites it. If the backup is wrong, you’ve made the outage worse, with
            no way back.
          </Bullet>
        </ul>
        <p>
          This setup lets you do both <Term>with no downtime</Term> and{' '}
          <Term>without ever overwriting what’s live</Term>. If a change is wrong, you undo it
          instantly.
        </p>
      </Section>

      <Section
        icon={<ArrowLeftRight className="size-4 text-primary" aria-hidden />}
        title="The idea: don’t change what’s live — switch to a copy"
      >
        <p>
          The live environment is never edited in place. Instead there’s always a spare copy beside
          it. You prepare your change on the spare — off to the side, where it can’t affect anyone —
          and when it’s ready you <Term>switch which copy serves traffic</Term>. The switch is
          instant, and the old copy stays exactly as it was, so undoing is just switching back.
        </p>
        <p>Concretely, that means a production business process is made of:</p>
        <ul className="ml-1 flex flex-col gap-1.5">
          <Bullet icon={<Boxes className="size-3.5 text-sky-600" aria-hidden />}>
            <Term>Two databases</Term> — at any moment one holds the live data and the other is a
            spare. Backups are recovered onto the spare, never the live one.
          </Bullet>
          <Bullet icon={<Boxes className="size-3.5 text-emerald-600" aria-hidden />}>
            <Term>Three app slots</Term> — interchangeable copies of the app’s containers
            (<Slot>a</Slot> <Slot>b</Slot> <Slot>c</Slot>). One serves live traffic, one stands by
            for recovery, and one is kept free as room to stage the next release.
          </Bullet>
        </ul>
        <p>
          Two markers track the current arrangement: <Code>live_db</Code> (which database is live)
          and <Code>live_slot</Code> (which app slot traffic reaches). Switching either is the only
          operation that ever changes what’s live.
        </p>
        <SteadyStateDiagram />
      </Section>

      <Section
        icon={<Rocket className="size-4 text-primary" aria-hidden />}
        title="Shipping a new version"
      >
        <p>
          <Term>What:</Term> roll out new code while users keep using the app, with an instant
          rollback if it misbehaves. <Term>Why it’s safe:</Term> the new version runs on the free
          slot first — real users never touch it until you’ve switched — and it talks to the{' '}
          <strong>same live database</strong>, so a release never risks your data.
        </p>
        <p>
          <Term>How:</Term> bring the new version up on the free slot, check it’s healthy, then point
          the ingress at it. The old slot is left running for a moment as your instant rollback, then
          retired to become the new free slot.
        </p>
        <PromoteDiagram />
      </Section>

      <Section
        icon={<LifeBuoy className="size-4 text-primary" aria-hidden />}
        title="Recovering from a disaster"
      >
        <p>
          <Term>What:</Term> bring back good data after a corruption, a bad migration, or an
          accidental deletion.
        </p>
        <p>
          <Term>Why it’s safe — and the whole point of this stage:</Term> you never fail over blind.
          The standby isn’t just a spare database; it’s a <strong>complete, running copy of the
          app</strong> with its own address. You restore the backup onto it, then{' '}
          <strong>open it and actually use it</strong> — log in, click through, confirm the data is
          all there and correct — <em>while live Production carries on untouched</em>. Only once
          you’ve seen with your own eyes that recovery worked do you switch traffic over.
        </p>
        <p>
          <Term>How:</Term>
        </p>
        <ol className="ml-1 flex list-none flex-col gap-1.5">
          <Step n={1}>Restore the backup onto the spare database. Live Production keeps running.</Step>
          <Step n={2}>
            <strong>Open the standby app at its own URL and verify it by hand</strong> — it’s the
            real, working application running on the recovered data, so you can check everything is
            in place before anyone relies on it.
          </Step>
          <Step n={3}>
            Only once it checks out, switch live traffic to the standby. The old live environment
            becomes the new spare — so if you spot a problem, you switch straight back.
          </Step>
        </ol>
        <SwapDiagram />
        <p className="text-muted-foreground">
          Restoring directly onto the live database is refused by the server. Restores into{' '}
          <Code>dev</Code> and <Code>staging</Code> are fine — those aren’t live Production.
        </p>
      </Section>

      <Section
        icon={<ShieldCheck className="size-4 text-primary" aria-hidden />}
        title="Practising recovery"
      >
        <p>
          A backup you’ve never restored is a guess, not a safety net. So on a regular schedule —{' '}
          <strong>quarterly by default</strong> — someone runs the recovery for real: restore the
          latest backup onto the spare, open the standby app, and confirm the data is all there,
          then record that it worked. This page shows when a process is overdue for that check.
          Practising only restores and verifies; it never switches live traffic.
        </p>
      </Section>

      <Section
        icon={<FileClock className="size-4 text-primary" aria-hidden />}
        title="Everything is audit logged"
      >
        <p>
          Every backup, restore, retention change, version switch and recovery swap is recorded in
          git — who did it, when, and what changed. It shows up in this page’s audit log and in the
          deployment history, and because it’s in git it’s a permanent, reviewable record.
        </p>
      </Section>
    </div>
  );
}

const ROLE_TAG = {
  live: { label: 'Production', cls: 'bg-emerald-600' },
  dr: { label: 'Disaster Recovery', cls: 'bg-amber-500' },
  idle: { label: 'Idle', cls: 'bg-zinc-400' },
} as const;

/** Live, real-time view of which app slot each role points at right now —
 *  driven by the actual backups state, so a swap/promote moves the tags. */
function LiveState({ bp }: { bp: string }) {
  // eslint-disable-next-line no-restricted-syntax -- null = loading
  const [state, setState] = useState<BackupState | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .backups(bp)
      .then((s) => alive && setState(s))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [bp]);

  if (failed)
    return <p className="text-[12px] text-muted-foreground">Couldn’t load the current slot state.</p>;
  if (!state)
    return <p className="text-[12px] text-muted-foreground">Loading current state…</p>;

  const roleOf = (slot: string): keyof typeof ROLE_TAG =>
    state.live_slot === slot ? 'live' : state.dr_slot === slot ? 'dr' : 'idle';

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] text-muted-foreground">
        Which app slot each role points at right now — the tags move as you swap or promote.
      </p>
      <DiagramBox>
        {(['a', 'b', 'c'] as const).map((slot) => {
          const role = roleOf(slot);
          const tag = ROLE_TAG[role];
          const db = state.slots?.[slot]?.db ?? null;
          return (
            <div key={slot} className="flex items-center gap-2">
              <span className="font-semibold">slot {slot.toUpperCase()}</span>
              <span className={role === 'idle' ? 'text-muted-foreground' : 'text-primary'}>
                ───▶
              </span>
              <span className={role === 'idle' ? 'text-muted-foreground' : ''}>
                {db ? `database ${db}` : 'no containers'}
              </span>
              <span
                className={cn(
                  'rounded-full px-1.5 text-[9px] font-bold uppercase text-white',
                  tag.cls,
                )}
              >
                {tag.label}
              </span>
            </div>
          );
        })}
        <div className="pt-1 text-[11px] text-muted-foreground">
          Production serves database {state.live_db}; Disaster Recovery holds database{' '}
          {state.standby_db} (where restores land). A swap repoints these — no data moves.
        </div>
      </DiagramBox>
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
        <span className="text-muted-foreground">live traffic ──▶</span>
        <Pill tone="live">slot a → database 1</Pill>
        <Tag tone="live">live</Tag>
      </div>
      <div className="flex items-center gap-2 pl-[6.4rem]">
        <Pill tone="dr">slot b → database 2</Pill>
        <Tag tone="dr">standby</Tag>
      </div>
      <div className="flex items-center gap-2 pl-[6.4rem]">
        <Pill tone="idle">slot c · free (room for the next release)</Pill>
      </div>
    </DiagramBox>
  );
}

function PromoteDiagram() {
  return (
    <DiagramBox>
      <div className="text-muted-foreground">1 · new version comes up on the free slot, same database</div>
      <div className="flex items-center gap-2 pl-4">
        <Pill tone="live">slot a → db 1</Pill>
        <Tag tone="live">live</Tag>
        <Pill tone="idle">slot c (new version) → db 1</Pill>
      </div>
      <div className="pt-1 text-muted-foreground">2 · switch traffic ──▶ slot c, retire slot a</div>
      <div className="flex items-center gap-2 pl-4">
        <Pill tone="live">slot c → db 1</Pill>
        <Tag tone="live">live</Tag>
        <Pill tone="idle">slot a · now free</Pill>
      </div>
      <div className="pt-1 text-[11px] text-emerald-700">same database throughout — new code, same data</div>
    </DiagramBox>
  );
}

function SwapDiagram() {
  return (
    <DiagramBox>
      <div className="text-muted-foreground">restore landed on database 2 (the spare); verified by hand</div>
      <div className="flex items-center gap-2 pl-4">
        <Pill tone="live">slot a → db 1</Pill>
        <Tag tone="live">live</Tag>
        <Pill tone="dr">slot b → db 2</Pill>
        <Tag tone="dr">standby</Tag>
      </div>
      <div className="pt-1 text-muted-foreground">switch traffic ──▶ slot b (now serving the recovered data)</div>
      <div className="flex items-center gap-2 pl-4">
        <Pill tone="dr">slot a → db 1</Pill>
        <Tag tone="dr">spare</Tag>
        <Pill tone="live">slot b → db 2</Pill>
        <Tag tone="live">live</Tag>
      </div>
      <div className="pt-1 text-[11px] text-emerald-700">no downtime — the old live environment becomes the spare</div>
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
