import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Boxes,
  Folder,
  GitPullRequest,
  Loader2,
  MessageSquare,
  RotateCcw,
} from 'lucide-react';
import { FilesTab } from '@/components/files/FilesTab';
import { DiffTab } from '@/components/diff/DiffTab';
import { ContainersPane } from '@/components/agents/ContainersPane';
import { Button } from '@/components/ui/button';
import { useSessions } from '@/components/agents/SessionProvider';
import { AgentSidebar } from '@/components/agents/AgentSidebar';
import { useLatestAgentSession } from '@/hooks/useLatestAgentSession';
import { cn } from '@/lib/utils';
import { useUrlEnum, useUrlFlag } from '@/lib/urlState';

interface AgentFilesTabProps {
  copy: string;
  bp: string;
  branch: string;
  /** True only when the Coding Agent tab is the active tab (the pane stays
   *  mounted-but-hidden otherwise). Gates auto-reattach so we don't spin up
   *  sessions for BPs the user is only browsing on other tabs. */
  tabVisible?: boolean;
}

type Sub = 'chat' | 'files' | 'containers';
const SUBS: Sub[] = ['chat', 'files', 'containers'];

/**
 * A session that dies sooner than this never really got going — the agent
 * failed to launch (bad resume, container wedged, claude not authenticated).
 * One that outlives it was a working agent that ended for its own reasons
 * (the user quit it, the server's idle timeout fired, the ws dropped), and is
 * restarted immediately with a clean slate of attempts.
 */
const HEALTHY_SESSION_MS = 20_000;
/**
 * Backoff before each *re*-launch after a failed one. Its length is also the
 * attempt budget: once it's exhausted we stop and show the error rather than
 * hammering the coding-agent container.
 */
const RELAUNCH_BACKOFF_MS = [2_000, 8_000, 20_000];

/**
 * Where autostart stands for the viewed BP. `launching` covers both "a
 * session is up" and "we're about to (re)try one" — the other two are the
 * give-up states the pane renders an error for.
 */
type LaunchState =
  /** Running, starting, or waiting out a backoff before the next attempt. */
  | 'launching'
  /** The agent started and died on launch, every attempt we had. */
  | 'exits-immediately'
  /** The server refused to spawn it — retrying the same request won't help. */
  | 'refused';

/**
 * The Agents screen, per the wireframe (Workspace Dashboard → Agents): one
 * agent per business process — no session list. A header chip shows the
 * agent (status dot + name), then Chat / Files sub-tabs; the right-hand
 * ENVIRONMENT panel lives in WorkspaceView.
 *
 *   - Chat  → the live coding-agent terminal. It renders in SessionProvider's
 *     portal layer over this pane, so it must stay mounted (we hide it, not
 *     unmount it, when Files is active) or the running terminal is torn down.
 *   - Files → the copy file browser with a Diff toggle.
 *
 * (Plan, Notes, and the Playwright Browser pane from the wireframe are
 * intentionally not built.)
 */
export function AgentFilesTab({ copy, bp, branch: _branch, tabVisible = true }: AgentFilesTabProps) {
  const {
    sessionFor,
    setCurrentScope,
    onExit,
  } = useSessions();
  const { session: latest, loading: pastLoading } = useLatestAgentSession(copy, bp);

  // Sub-tab and the Diff toggle live in the URL so the Agents view is
  // deep-linkable (?sub=files&diff=1).
  const [sub, setSub] = useUrlEnum('sub', SUBS, 'chat');
  const [showDiff, setShowDiff] = useUrlFlag('diff');
  // Turn Diff off when the user changes sub-tab or copy — but NOT on the
  // initial mount, so a pasted ?diff=1 link is honoured.
  const diffResetReady = useRef(false);
  useEffect(() => {
    if (!diffResetReady.current) {
      diffResetReady.current = true;
      return;
    }
    setShowDiff(false);
  }, [sub, copy, setShowDiff]);

  // Bind this BP as the active scope and hand the provider the Chat pane so
  // it can portal the terminal over it. Cleanup unbinds so terminals stay
  // alive (just hidden) when the user navigates away.
  const paneRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    setCurrentScope({ copy, bp });
    return () => setCurrentScope(null);
  }, [copy, bp, setCurrentScope]);

  // The BP's live agent — one session per (user, copy, BP), tracked by the
  // provider.
  const agent = sessionFor({ copy, bp });

  // ---------------------------------------------------------------------
  // Autostart. There is no manual "Start agent" step (bailey-lab #246): an
  // agent that isn't running is a bug, so the tab launches one itself and
  // only ever shows the user a spinner or — if launching keeps failing — an
  // error with a Retry.
  //
  // `launchGen` is the request signal: bumping it asks the effect below for
  // another launch. Together with the (copy, bp) key it forms the token the
  // effect dedupes on, so a launch happens once per request and once per
  // scope, never in a render loop.
  // ---------------------------------------------------------------------
  const [launchGen, setLaunchGen] = useState(0);
  const [launchState, setLaunchState] = useState<LaunchState>('launching');
  const launchFailed = launchState !== 'launching';
  const failedAttempts = useRef(0);
  // eslint-disable-next-line no-restricted-syntax -- null = no relaunch pending
  const relaunchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelRelaunch = useCallback(() => {
    if (relaunchTimer.current) {
      clearTimeout(relaunchTimer.current);
      relaunchTimer.current = null;
    }
  }, []);

  // Don't relaunch into a browser tab nobody is looking at: a backgrounded
  // dashboard would otherwise re-attach every time the server's idle timeout
  // reaps the session. Coming back to the tab re-runs the effect below.
  const [docVisible, setDocVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const onVisibility = () => setDocVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Reset per-scope launch state when the user moves to another BP, so a
  // wedged agent in one BP doesn't leave the next one stuck on its error.
  useEffect(() => {
    failedAttempts.current = 0;
    setLaunchState('launching');
    return cancelRelaunch;
  }, [copy, bp, cancelRelaunch]);

  // The agent runs server-side inside `dtach` keyed by the Claude session
  // UUID, so it survives a browser close / hard refresh — but the client's
  // live-session list is in-memory and starts empty. When nothing is
  // attached, resume the most recent conversation: `dtach -A` re-attaches to
  // the still-running agent, or `claude --resume` restores the conversation
  // if it has exited (and the server falls back to a fresh conversation on
  // the same UUID when the transcript is gone — see buildAutoCmd). With no
  // prior session at all, start a fresh one.

  // Restart loop guard. Every session end in this scope lands here; how it's
  // handled depends on why it ended.
  //
  //   - The server refused to spawn anything (1008 bad request / forbidden
  //     resume / not authenticated, 1011 coding-agent host unreachable):
  //     retrying can't fix that, so surface it straight away.
  //   - The session had been up and running: restart it — the agent is meant
  //     to be running the whole time this tab is open.
  //   - It died on launch: count it against the attempt budget and try again
  //     after a growing backoff; when the budget runs out, stop and show the
  //     error instead of hammering the container.
  useEffect(
    () =>
      onExit((s) => {
        if (s.copy !== copy || s.bp !== bp) return;
        if (s.exitCode === 1008 || s.exitCode === 1011) {
          cancelRelaunch();
          setLaunchState('refused');
          return;
        }
        if (Date.now() - s.startedAt >= HEALTHY_SESSION_MS) {
          failedAttempts.current = 0;
          setLaunchGen((g) => g + 1);
          return;
        }
        const attempt = failedAttempts.current;
        failedAttempts.current = attempt + 1;
        const backoff = RELAUNCH_BACKOFF_MS[attempt];
        if (backoff === undefined) {
          setLaunchState('exits-immediately');
          return;
        }
        cancelRelaunch();
        relaunchTimer.current = setTimeout(() => {
          relaunchTimer.current = null;
          setLaunchGen((g) => g + 1);
        }, backoff);
      }),
    [onExit, copy, bp, cancelRelaunch],
  );

  // Manual escape hatch for the exhausted-attempts state: hand the attempt
  // budget back to the autostart effect.
  const retry = useCallback(() => {
    cancelRelaunch();
    failedAttempts.current = 0;
    setLaunchState('launching');
    setLaunchGen((g) => g + 1);
  }, [cancelRelaunch]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header: agent status dot + sub-tabs. No session name — one
          conversation per (user, copy, BP), so there is nothing to tell
          apart; the dot alone carries running / failed / starting. */}
      <div className="flex h-10 shrink-0 items-center gap-4 border-b border-border bg-background px-5">
        <SubTab
          active={sub === 'chat'}
          onClick={() => setSub('chat')}
          icon={<MessageSquare className="size-3.5" aria-hidden />}
          label="Chat"
        />
        <SubTab
          active={sub === 'files'}
          onClick={() => setSub('files')}
          icon={<Folder className="size-3.5" aria-hidden />}
          label="Files"
        />
        <SubTab
          active={sub === 'containers'}
          onClick={() => setSub('containers')}
          icon={<Boxes className="size-3.5" aria-hidden />}
          label="Containers"
        />
        {sub === 'files' && (
          <Button
            variant={showDiff ? 'default' : 'outline'}
            size="sm"
            className="ml-auto h-6 px-2 text-xs"
            onClick={() => setShowDiff(!showDiff)}
          >
            <GitPullRequest className="size-3" aria-hidden />
            Diff
          </Button>
        )}
      </div>

      {/* Chat pane — always mounted (hidden when on Files) so the live
          terminal portal target survives the toggle. */}
      <main
        ref={paneRef}
        className={cn(
          'relative min-h-0 flex-1 overflow-hidden bg-zinc-50',
          sub !== 'chat' && 'hidden',
        )}
      >
        <AgentSidebar copy={copy} bp={bp} />
      </main>

      {/* Files pane — mounted alongside so toggling back to Chat doesn't
          remount (and re-fetch) the tree. */}
      <div className={cn('min-h-0 flex-1 overflow-hidden', sub !== 'files' && 'hidden')}>
        {/* Scope the diff to this BP — the whole tab is per-BP, and with
            per-BP repos "the copy's diff" is an aggregate that would mix in
            unrelated business processes. */}
        {showDiff ? (
          <DiffTab copy={copy} pathPrefix={bp} />
        ) : (
          <FilesTab copy={copy} bp={bp} />
        )}
      </div>

      {/* Containers pane — mounted only when active; its LogsPane opens an
          SSE stream we don't want running in the background. */}
      {sub === 'containers' && (
        <ContainersPane bp={bp} copy={copy} active={sub === 'containers'} />
      )}
    </div>
  );
}

function SubTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-full items-center gap-1.5 border-b-2 text-[13px] transition-colors',
        active
          ? 'border-foreground font-semibold text-foreground'
          : 'border-transparent font-medium text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  );
}
