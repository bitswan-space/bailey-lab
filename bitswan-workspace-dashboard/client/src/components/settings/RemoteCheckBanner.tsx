import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowDownToLine, Loader2, PauseCircle, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, errorMessage, type GitRemotePull } from '@/lib/api';
import { toast } from '@/lib/notify';

interface RemoteCheckBannerProps {
  bp: string;
  role: 'admin' | 'auditor' | 'member';
}

type CheckState =
  | { kind: 'checking' }
  | { kind: 'done'; pull: GitRemotePull }
  | { kind: 'failed'; message: string };

export function RemoteCheckBanner({ bp, role }: RemoteCheckBannerProps) {
  const [state, setState] = useState<CheckState>({ kind: 'checking' });
  const [acting, setActing] = useState(false);
  const aliveRef = useRef(true);

  const check = async () => {
    setState({ kind: 'checking' });
    try {
      const pull = await api.gitRemote.pull();
      if (!aliveRef.current) return;
      setState({ kind: 'done', pull });
      if (pull.inbound.includes(bp)) {
        toast.info(`New changes arrived from the git remote for ${bp} — sync your copy before deploying.`);
      }
    } catch (err) {
      if (!aliveRef.current) return;
      setState({ kind: 'failed', message: errorMessage(err) });
    }
  };

  useEffect(() => {
    aliveRef.current = true;
    void check();
    return () => {
      aliveRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-check when the process in view changes
  }, [bp]);

  const repair = async () => {
    setActing(true);
    try {
      await api.gitRemote.forcePush();
      toast.success('The remote was repaired from this workspace');
      await check();
    } catch (err) {
      toast.error(`Couldn't repair the remote: ${errorMessage(err)}`);
    } finally {
      if (aliveRef.current) setActing(false);
    }
  };

  const pause = async () => {
    setActing(true);
    try {
      await api.gitRemote.pause();
      toast.success('The git remote is paused');
      await check();
    } catch (err) {
      toast.error(`Couldn't pause the remote: ${errorMessage(err)}`);
    } finally {
      if (aliveRef.current) setActing(false);
    }
  };

  if (state.kind === 'checking') {
    return (
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-7 py-2 text-[12px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        Checking the git remote for changes to main…
      </div>
    );
  }

  if (state.kind === 'failed') {
    return (
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-amber-500/10 px-7 py-2 text-[12px] text-amber-800 dark:text-amber-300">
        <AlertTriangle className="size-3.5" aria-hidden />
        {`Couldn't check the git remote: ${state.message}. Deploying still works; main may be missing changes pushed to the remote.`}
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[12px]" onClick={() => void check()}>
          Retry
        </Button>
      </div>
    );
  }

  const { pull } = state;
  if (!pull.configured) return null;

  if (pull.paused) {
    return (
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-7 py-2 text-[12px] text-muted-foreground">
        <PauseCircle className="size-3.5" aria-hidden />
        The git remote is paused — nothing is pulled from it or pushed to it until an admin resumes it.
      </div>
    );
  }

  if (pull.result === 'diverged' || pull.result === 'conflict') {
    const main = pull.branches.main;
    const what =
      pull.result === 'conflict'
        ? `Changes on the remote's main for ${pull.conflicts.join(', ')} conflict with work in this workspace.`
        : "The remote's main was rewritten and is no longer a fast-forward of what this workspace pushed.";
    return (
      <div className="flex flex-col gap-2 border-b border-border bg-destructive/5 px-7 py-3 text-[12px] text-foreground">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-destructive">Git remote out of step</div>
            <p className="mt-0.5 text-muted-foreground">
              {what} Bailey never force-pushes on its own, so main is not being mirrored right now.
              {main?.detail ? ` ${main.detail}.` : ''}
            </p>
            {role === 'admin' ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="destructive" disabled={acting} onClick={() => void repair()}>
                  {acting ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Upload className="size-3.5" aria-hidden />}
                  Force push to repair
                </Button>
                <Button size="sm" variant="outline" disabled={acting} onClick={() => void pause()}>
                  <PauseCircle className="size-3.5" aria-hidden />
                  Pause the remote
                </Button>
              </div>
            ) : (
              <p className="mt-1 text-muted-foreground">
                Ask a workspace admin to force push to repair or to pause the remote (Advanced → Settings).
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (pull.inbound.length > 0) {
    const mine = pull.inbound.includes(bp);
    return (
      <div className="flex items-center gap-2 border-b border-border bg-primary/5 px-7 py-2 text-[12px] text-foreground">
        <ArrowDownToLine className="size-3.5 text-primary" aria-hidden />
        {mine
          ? 'New changes from the git remote were pulled into main. Sync your copy before deploying.'
          : `New changes from the git remote were pulled into main for ${pull.inbound.join(', ')}.`}
      </div>
    );
  }

  if (pull.result === 'error' && pull.error) {
    return (
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-amber-500/10 px-7 py-2 text-[12px] text-amber-800 dark:text-amber-300">
        <AlertTriangle className="size-3.5" aria-hidden />
        {`The git remote could not be reached: ${pull.error}`}
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[12px]" onClick={() => void check()}>
          Retry
        </Button>
      </div>
    );
  }

  return null;
}
