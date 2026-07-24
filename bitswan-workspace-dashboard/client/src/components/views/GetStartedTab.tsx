import {
  ArrowRight,
  Bot,
  CheckSquare,
  FileText,
  GitBranch,
  Plus,
  Rocket,
  Server,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { FlowTab } from '@/types';

interface GetStartedTabProps {
  onTab: (t: FlowTab) => void;
  /** Open the "new business process" flow (the dialog lives in TopNav). */
  onNewBp: () => void;
}

interface Step {
  n: number;
  Icon: LucideIcon;
  title: string;
  body: string;
  /** The top-bar tab this step is performed in, if any — makes the step a
   *  launch point straight into the pipeline. */
  tab?: FlowTab;
  /** Small label shown on the jump affordance (defaults to "Open"). */
  cta?: string;
}

// The develop-a-business-process arc, condensed from the Operator's Handbook
// (e2e/manual/content.mjs, chapters 05–13) and keyed to the tabs in the top
// bar above — so this page doubles as a map of the pipeline the reader is
// looking at.
const STEPS: Step[] = [
  {
    n: 1,
    Icon: GitBranch,
    title: 'Work in your own copy',
    body: 'Opening the workspace drops you into your personal copy — a private branch where you can edit, build and preview freely. Nothing you do touches the shared main until you deliberately Sync & Deploy. Switch or spin up copies from the switcher in the bar above.',
  },
  {
    n: 2,
    Icon: Plus,
    title: 'Create a business process',
    body: 'A business process is the unit you build, ship and operate — Meridian’s accounts-payable lives in one process, invoice-processing. Name it and the workspace scaffolds its automations (a backend and a frontend) so there is something real to describe and deploy.',
    cta: 'New business process',
  },
  {
    n: 3,
    Icon: FileText,
    title: 'Describe it',
    body: 'Before code, intent. Write the spec in rich text, then open the flowchart editor and draw the flow node-by-node — no diagram syntax to learn. The description versions with the process, so the documentation lives next to the code instead of drifting in a wiki.',
    tab: 'description',
    cta: 'Open Description',
  },
  {
    n: 4,
    Icon: Bot,
    title: 'Build it with the Coding Agent',
    body: 'Let the agent build the automation straight from your spec — it runs inside Bailey, in your isolated copy, walled off from production data. Each automation gets a live-dev preview that auto-builds as code changes; click its frontend to click through the real thing. Prefer to edit by hand? The Files sub-tab is a full editor over your copy.',
    tab: 'agent',
    cta: 'Open Coding Agent',
  },
  {
    n: 5,
    Icon: CheckSquare,
    title: 'Pin the rules as tests',
    body: 'Turn the spec’s rules into runnable checks — VAT matches the PO, invoices over €5,000 are held, duplicate numbers never post twice — so “does it still do what we promised?” is a button, not a meeting.',
    tab: 'requirements',
    cta: 'Open Requirements',
  },
  {
    n: 6,
    Icon: Rocket,
    title: 'Sync & Deploy to development',
    body: 'One button does the careful thing: commit your work, rebase onto main, fast-forward and roll out to Development — with the live build log streaming. Around it sit the three things you check first: the Diff, the History, and the CVEs of the exact image this deploy would build.',
    tab: 'sync-deploy',
    cta: 'Open Sync & Deploy',
  },
  {
    n: 7,
    Icon: Server,
    title: 'Promote through staging → production',
    body: 'A change moves forward one stage at a time, each hop a zero-downtime blue-green cutover — the live slot never blinks and what promotes is the reviewed image, verbatim. Anyone can promote dev → staging; production is gated until an auditor freezes staging and signs off. Deployment history, secrets, containers, backups and the firewall all live here too, per stage.',
    tab: 'deployments',
    cta: 'Open Deployments',
  },
];

/**
 * The "Get started" orientation page — an always-available first stop in the
 * top-bar pipeline that explains, end to end, how you develop a business
 * process automation in Bailey. It needs no business process or copy (a
 * brand-new operator can read it before anything exists), so App renders it
 * ahead of WorkspaceView's "no business process" empty state.
 */
export function GetStartedTab({ onTab, onNewBp }: GetStartedTabProps) {
  const act = (step: Step) => {
    if (step.cta === 'New business process') return onNewBp();
    if (step.tab) return onTab(step.tab);
  };

  return (
    <div className="flex-1 overflow-auto bg-background">
      {/* A single A4-width reading column so this reads as a document, not a
          dashboard panel. */}
      <article className="mx-auto max-w-3xl px-8 py-10">
        <header className="border-b border-border pb-8">
          <div className="text-[12px] font-semibold uppercase tracking-[0.16em] text-primary">
            Get started
          </div>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-foreground">
            Develop a business process automation
          </h1>
          <p className="mt-4 max-w-prose text-[15px] leading-relaxed text-muted-foreground">
            Bailey is a complete business-process automation platform — staged
            deployment, supply-chain scanning, disaster-recovery rehearsals and
            device-bound access are already in the chassis. You shouldn’t have to
            build the car, so you can think about where you’re driving. This is
            the whole path, and each step is a tab in the bar above.
          </p>
        </header>

        <ol className="mt-8 flex flex-col">
          {STEPS.map((step) => {
            const actionable = step.cta === 'New business process' || !!step.tab;
            return (
              <li
                key={step.n}
                className="flex gap-4 border-b border-border py-6 last:border-b-0"
              >
                <div className="flex shrink-0 flex-col items-center gap-2">
                  <span className="flex size-8 items-center justify-center rounded-full bg-primary text-[13px] font-bold text-primary-foreground tabular-nums">
                    {step.n}
                  </span>
                  <step.Icon className="size-4 text-muted-foreground" aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-[15px] font-semibold text-foreground">
                    {step.title}
                  </h2>
                  <p className="mt-1.5 text-[14px] leading-relaxed text-muted-foreground">
                    {step.body}
                  </p>
                  {actionable && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-2.5 -ml-2 h-7 text-primary hover:text-primary"
                      onClick={() => act(step)}
                    >
                      {step.cta ?? 'Open'}
                      <ArrowRight className="size-3.5" aria-hidden />
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        {/* One "why it matters" callout, condensed from the handbook — the
            single idea a new operator should leave with. */}
        <aside
          className={cn(
            'mt-8 rounded-lg border border-border border-l-2 border-l-primary bg-primary/5 p-5',
          )}
        >
          <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-primary">
            <ShieldCheck className="size-3.5" aria-hidden />
            Why it works this way
          </div>
          <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
            Every stage runs on its own database, file store and network — they
            can’t even reach each other, so testing never risks real production
            data. Changes reach production only through a reviewed promotion of a
            CVE-scanned image, and every deploy is appended to a protected,
            fast-forward-only history you can’t quietly rewrite. Compliance falls
            out of running the system, rather than being bolted on afterwards.
          </p>
        </aside>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Button onClick={onNewBp}>
            <Plus className="size-4" aria-hidden />
            Create your first business process
          </Button>
          <span className="text-[13px] text-muted-foreground">
            Already have one? Pick it in the switcher above.
          </span>
        </div>
      </article>
    </div>
  );
}
