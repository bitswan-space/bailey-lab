import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Boxes,
  Folder,
  GitPullRequest,
  Loader2,
  LogIn,
  MessageSquare,
  RotateCcw,
} from 'lucide-react';
import { FilesTab } from '@/components/files/FilesTab';
import { DiffTab } from '@/components/diff/DiffTab';
import { ContainersPane } from '@/components/agents/ContainersPane';
import { Button } from '@/components/ui/button';
import { useSessions } from '@/components/agents/SessionProvider';
import {
  decideAfterAgentExit,
  RELAUNCH_BACKOFF_MS,
  type AgentLaunchFailure,
} from '@/lib/agentSessionExit';
import { gateSessionState } from '@/lib/auth-token';
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
 * Where autostart stands for the viewed BP. `launching` covers both "a
 * session is up" and "we're about to (re)try one"; the rest are the give-up
 * states the pane renders an error for. `decideAfterAgentExit` produces all of
 * them except `signed-out`, which no close code can tell you — that one comes
 * from asking the gate (see the exit handler below).
 */
type LaunchState = 'launching' | AgentLaunchFailure | 'signed-out';
type Failure = Exclude<LaunchState, 'launching'>;

/**
 * The message each give-up state puts on screen, and what the button under it
 * should do. They have to be told apart, because the action that helps is
 * different for each: "refused" is an answer from the server, "cannot-connect"
 * means nothing answered and trying again may well work, and "signed-out"
 * means retrying CANNOT work — the socket has no session to present, and only
 * a top-level navigation can get one back.
 */
const FAILURE: Record<Failure, { message: string; action: 'retry' | 'sign-in' }> = {
  refused: {
    message: 'The coding agent for this business process could not be reached.',
    action: 'retry',
  },
  'cannot-connect': {
    message: 'The connection to the coding agent could not be opened.',
    action: 'retry',
  },
  'exits-immediately': {
    message: `The coding agent for this business process exited immediately on ${
      RELAUNCH_BACKOFF_MS.length + 1
    } attempts.`,
    action: 'retry',
  },
  'signed-out': {
    message: 'Your sign-in session has expired, so the agent could not reconnect.',
    action: 'sign-in',
  },
};

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
    startSession,
    resumeSession,
    setCurrentScope,
    setPaneEl,
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
  useEffect(() => {
    setPaneEl(paneRef.current);
    return () => setPaneEl(null);
  }, [setPaneEl]);

  // The BP's live agent — one session per (user, copy, BP), tracked by the
  // provider.
  const agent = sessionFor({ copy, bp });
  // Read by the async gate probe below, which resolves after the exit that
  // started it — by which time a retry may already have succeeded.
  const agentRef = useRef(agent);
  agentRef.current = agent;

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
  const failure = launchState === 'launching' ? undefined : launchState;
  const launchFailed = failure !== undefined;
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
  // eslint-disable-next-line no-restricted-syntax -- null = nothing launched yet
  const launchedToken = useRef<string | null>(null);
  useEffect(() => {
    if (!tabVisible || !docVisible || pastLoading) return;
    if (agent) return; // already attached — nothing to do
    if (launchFailed) return; // out of attempts; waiting on the user's Retry
    const token = `${copy}/${bp}#${launchGen}`;
    if (launchedToken.current === token) return;
    launchedToken.current = token;
    if (latest?.claudeSessionId) {
      resumeSession(copy, bp, latest.claudeSessionId);
    } else {
      startSession(copy, bp);
    }
  }, [
    tabVisible,
    docVisible,
    pastLoading,
    agent,
    launchFailed,
    launchGen,
    latest,
    copy,
    bp,
    resumeSession,
    startSession,
  ]);

  // Restart loop guard. EVERY session end in this scope lands here —
  // including a socket that never opened, which used to go unreported and
  // left the tab holding a dead terminal with no way back (bailey-lab #437).
  // `decideAfterAgentExit` owns the routing (and its tests pin it); this
  // effect carries the decision out, and asks one question the close itself
  // cannot answer.
  //
  // That question is for the socket that never opened. It has two very
  // different causes wearing the same 1006: something momentary (the agent
  // container restarting, the proxy blipping), which retrying fixes, or the
  // gate's session having lapsed, which retrying CANNOT fix — measured, on a
  // lapsed session every attempt in the budget was declined and only a reload
  // brought the agent back. `/oauth2/auth` answers it same-origin, so we ask
  // instead of spending 30 seconds of backoff on a dead end and then offering
  // a Retry that can't work either.
  useEffect(() => {
    let cancelled = false;
    const off = onExit((s) => {
      if (s.copy !== copy || s.bp !== bp) return;
      if (!s.opened) {
        void gateSessionState().then((state) => {
          // Only act on a definite "signed out", and only while this scope
          // still has nothing running — a retry may have won the race.
          if (cancelled || state !== 'signed-out' || agentRef.current) return;
          cancelRelaunch();
          setLaunchState('signed-out');
        });
      }
      const decision = decideAfterAgentExit({
        opened: s.opened,
        closeCode: s.exitCode,
        ageMs: Date.now() - s.startedAt,
        failedAttempts: failedAttempts.current,
      });
      if (decision.relaunch === 'no') {
        cancelRelaunch();
        setLaunchState(decision.failure);
        return;
      }
      if (decision.relaunch === 'immediately') {
        failedAttempts.current = 0;
        setLaunchGen((g) => g + 1);
        return;
      }
      failedAttempts.current += 1;
      cancelRelaunch();
      relaunchTimer.current = setTimeout(() => {
        relaunchTimer.current = null;
        setLaunchGen((g) => g + 1);
      }, decision.delayMs);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [onExit, copy, bp, cancelRelaunch]);

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
        <div className="flex items-center border-r border-border pr-4">
          <span
            title={agent ? 'Agent running' : launchFailed ? 'Agent unavailable' : 'Starting agent…'}
            className={cn(
              'size-1.5 rounded-full',
              agent
                ? 'bg-emerald-600'
                : launchFailed
                  ? 'bg-destructive'
                  : 'bg-muted-foreground/40',
            )}
          />
        </div>
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
        {/* Transitional state only. The agent is started automatically, so
            the user sees a spinner while that is in flight — and an error
            with a Retry if it keeps failing, which is a bug worth showing
            rather than an empty pane. */}
        {!agent && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            {failure ? (
              <>
                <AlertTriangle className="size-5 text-amber-600" aria-hidden />
                <span className="max-w-md text-center text-destructive">
                  {FAILURE[failure].message}
                </span>
                {FAILURE[failure].action === 'sign-in' ? (
                  // A reload, not a retry: it is a top-level navigation, so it
                  // can complete the sign-in redirect chain that a WebSocket
                  // upgrade and a same-origin fetch both cannot. Left to the
                  // user rather than done automatically — reloading under
                  // someone would throw away an unsaved edit elsewhere in the
                  // dashboard.
                  <Button onClick={() => window.location.reload()} size="sm" variant="outline">
                    <LogIn className="size-3.5" aria-hidden /> Sign in again
                  </Button>
                ) : (
                  <Button onClick={retry} size="sm" variant="outline">
                    <RotateCcw className="size-3.5" aria-hidden /> Retry
                  </Button>
                )}
              </>
            ) : (
              <span className="flex items-center gap-2">
                <Loader2 className="size-3.5 animate-spin" aria-hidden /> Starting agent…
              </span>
            )}
          </div>
        )}
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
