import { useCallback, useEffect, useRef, useState } from 'react';
import { GitBranch, KeyRound, Loader2, PauseCircle, PlayCircle, Upload } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { CopyButton } from '@/components/shared/CopyButton';
import { EmptyState } from '@/components/shared/EmptyState';
import { RelativeTime } from '@/components/shared/RelativeTime';
import { SectionHeader } from '@/components/shared/SectionHeader';
import { api, errorMessage, type GitRemote, type GitRemoteBranch } from '@/lib/api';
import { RemoteSetupGuide } from '@/components/settings/RemoteSetupGuide';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';

type CardState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: GitRemote };

const ACTIVE_POLL_MS = 3000;
const IDLE_POLL_MS = 30000;
const FIXED_BRANCH_ORDER = ['main', 'gitops'];
const RESULT_FALLBACK = 'error';

const RESULT_META: Record<
  GitRemoteBranch['result'],
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; className?: string }
> = {
  pushed: { label: 'Pushed', variant: 'default' },
  up_to_date: { label: 'Up to date', variant: 'secondary' },
  diverged: {
    label: 'Diverged',
    variant: 'outline',
    className: 'border-amber-500/60 text-amber-700 dark:text-amber-400',
  },
  conflict: {
    label: 'Conflict',
    variant: 'outline',
    className: 'border-amber-500/60 text-amber-700 dark:text-amber-400',
  },
  deleted: { label: 'Removed', variant: 'secondary' },
  rejected: { label: 'Rejected', variant: 'destructive' },
  error: { label: 'Error', variant: 'destructive' },
};

function branchOrder(a: string, b: string): number {
  const ia = FIXED_BRANCH_ORDER.indexOf(a);
  const ib = FIXED_BRANCH_ORDER.indexOf(b);
  if (ia !== -1 || ib !== -1) {
    return (ia === -1 ? FIXED_BRANCH_ORDER.length : ia) - (ib === -1 ? FIXED_BRANCH_ORDER.length : ib);
  }
  return a.localeCompare(b);
}

function shortSha(sha?: GitRemoteBranch['local']): string {
  return sha ? sha.slice(0, 8) : '—';
}

export function GitRemoteCard() {
  const [state, setState] = useState<CardState>({ kind: 'loading' });
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [inlineError, setInlineError] = useState('');
  const aliveRef = useRef(true);

  const apply = useCallback((data: GitRemote) => {
    if (!aliveRef.current) return;
    setState({ kind: 'ready', data });
  }, []);

  const reload = useCallback(async () => {
    try {
      const data = await api.gitRemote.get();
      apply(data);
    } catch (err) {
      if (!aliveRef.current) return;
      setState((prev) =>
        prev.kind === 'ready' ? prev : { kind: 'error', message: errorMessage(err) },
      );
    }
  }, [apply]);

  useEffect(() => {
    aliveRef.current = true;
    void reload();
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => {
      aliveRef.current = false;
      window.removeEventListener('focus', onFocus);
    };
  }, [reload]);

  const ready = state.kind === 'ready' ? state.data : undefined;
  const inProgress = !!ready?.status.in_progress;
  const hasUrl = !!ready?.url;

  useEffect(() => {
    if (!ready || (!hasUrl && !inProgress)) return;
    const id = window.setInterval(
      () => void reload(),
      inProgress ? ACTIVE_POLL_MS : IDLE_POLL_MS,
    );
    return () => window.clearInterval(id);
  }, [ready, hasUrl, inProgress, reload]);

  useEffect(() => {
    if (ready && !dirty) setDraft(ready.url ?? '');
  }, [ready, dirty]);

  const save = async () => {
    const url = draft.trim();
    if (!url || !ready) return;
    setSaving(true);
    setInlineError('');
    try {
      const data = await api.gitRemote.set(url);
      apply(data);
      setDirty(false);
      toast.success('Git remote saved — first push queued');
    } catch (err) {
      const message = errorMessage(err);
      setInlineError(message);
      toast.error(`Couldn't save the remote: ${message}`);
    } finally {
      if (aliveRef.current) setSaving(false);
    }
  };

  const clear = async () => {
    setClearing(true);
    try {
      const data = await api.gitRemote.clear();
      apply(data);
      setDirty(false);
      setDraft('');
      toast.success('Git remote cleared — Bailey stops pushing');
    } catch (err) {
      toast.error(`Couldn't clear the remote: ${errorMessage(err)}`);
    } finally {
      if (aliveRef.current) setClearing(false);
      setConfirmClear(false);
    }
  };

  const pushNow = async () => {
    setPushing(true);
    try {
      const data = await api.gitRemote.push();
      apply(data);
      toast.success(data.coalesced ? 'A push is already queued' : 'Push queued');
    } catch (err) {
      toast.error(`Couldn't queue the push: ${errorMessage(err)}`);
    } finally {
      if (aliveRef.current) setPushing(false);
    }
  };

  const togglePause = async () => {
    if (!ready) return;
    setToggling(true);
    try {
      const data = ready.paused ? await api.gitRemote.resume() : await api.gitRemote.pause();
      apply(data);
      toast.success(data.paused ? 'Git remote paused' : 'Git remote resumed — push queued');
    } catch (err) {
      toast.error(`Couldn't change the remote: ${errorMessage(err)}`);
    } finally {
      if (aliveRef.current) setToggling(false);
    }
  };

  const repair = async () => {
    setRepairing(true);
    try {
      const data = await api.gitRemote.forcePush();
      apply(data);
      toast.success("The remote's main and gitops now match this workspace");
    } catch (err) {
      toast.error(`Couldn't repair the remote: ${errorMessage(err)}`);
    } finally {
      if (aliveRef.current) setRepairing(false);
    }
  };

  const rotateKey = async () => {
    setRotating(true);
    try {
      const data = await api.gitRemote.rotateKey();
      apply(data);
      toast.success('New deploy key generated — add it to your git host and remove the old one');
    } catch (err) {
      toast.error(`Couldn't generate a new key: ${errorMessage(err)}`);
    } finally {
      if (aliveRef.current) setRotating(false);
      setConfirmRotate(false);
    }
  };

  if (state.kind === 'loading') {
    return (
      <EmptyState
        message={
          <span className="inline-flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Reading the git remote…
          </span>
        }
      />
    );
  }

  if (state.kind === 'error') {
    const adminsOnly = /admin/i.test(state.message);
    return (
      <EmptyState
        message={
          <div className="flex flex-col items-center gap-3">
            <span>
              {adminsOnly
                ? 'Workspace settings are admins only.'
                : `Couldn't read the git remote: ${state.message}`}
            </span>
            {!adminsOnly && (
              <Button size="sm" variant="outline" onClick={() => {
                setState({ kind: 'loading' });
                void reload();
              }}>
                Retry
              </Button>
            )}
          </div>
        }
      />
    );
  }

  const data = state.data;
  const status = data.status;
  const branches = Object.entries(status.branches ?? {}).sort(([a], [b]) => branchOrder(a, b));
  const saveDisabled = saving || !draft.trim() || draft.trim() === (data.url ?? '');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GitBranch className="size-4 text-primary" aria-hidden />
          Git remote
        </CardTitle>
        <CardDescription className="max-w-2xl leading-relaxed">
          Bailey mirrors this workspace into one repository. <code>main</code> holds one folder per
          business process with its code exactly as it stands on the process&apos;s own main;{' '}
          <code>gitops</code> holds each process&apos;s deployment manifest, where the dev, staging
          and production stages are recorded; <code>copies/&lt;name&gt;</code> mirrors each
          person&apos;s copy. Both are read-only mirrors overwritten on every push (copies are removed
          with the copy). Pushes run after every deploy or promote and every few minutes. Commits added on top of the remote&apos;s <code>main</code> are pulled back into the
          workspace before anyone deploys, and copies behind them must sync first. Bailey never
          force-pushes on its own: a rewritten remote <code>main</code> is reported here instead.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
        <section className="space-y-3">
          <SectionHeader
            eyebrow="Deploy key"
            title="This workspace's SSH public key"
            helper="Add it as a read-write deploy key on GitHub, GitLab or Forgejo. Each workspace has its own key."
            right={
              <div className="flex shrink-0 flex-wrap gap-2">
                <CopyButton
                  text={data.public_key}
                  label="Copy public key"
                  successToast="Public key copied"
                />
                <Button size="sm" variant="outline" disabled={rotating} onClick={() => setConfirmRotate(true)}>
                  <KeyRound className="size-3.5" aria-hidden />
                  Retire key and generate a new one
                </Button>
              </div>
            }
          />
          <pre className="select-all whitespace-pre-wrap break-all rounded-md border border-border bg-muted/40 p-3 font-mono text-[12px] leading-relaxed">
            {data.public_key}
          </pre>
          {data.fingerprint && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <KeyRound className="size-3" aria-hidden />
                {data.fingerprint}
              </span>
              {status.key_rotated_at && (
                <span className="font-sans">
                  {`Rotated by ${status.key_rotated_by ?? 'an admin'} `}
                  <RelativeTime value={status.key_rotated_at} />
                </span>
              )}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <SectionHeader
            eyebrow="Remote"
            title="Where the workspace is pushed"
            helper="SSH remotes only (git@host:org/repo.git or ssh://…). HTTPS is not accepted — the workspace authenticates with the deploy key above."
          />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <div className="min-w-0 flex-1">
              <Input
                aria-label="Git remote URL"
                className="font-mono"
                placeholder="git@github.com:acme/bailey-mirror.git"
                value={draft}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setDirty(true);
                  setInlineError('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !saveDisabled) void save();
                }}
              />
              {inlineError && (
                <p className="mt-1.5 text-[12px] text-destructive">{inlineError}</p>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button size="sm" disabled={saveDisabled} onClick={() => void save()}>
                {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                Save
              </Button>
              {data.url && (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={pushing || inProgress || data.paused}
                    onClick={() => void pushNow()}
                  >
                    {inProgress || pushing ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : (
                      <Upload className="size-3.5" aria-hidden />
                    )}
                    {inProgress ? 'Pushing…' : 'Push now'}
                  </Button>
                  <Button size="sm" variant="outline" disabled={toggling} onClick={() => void togglePause()}>
                    {data.paused ? (
                      <PlayCircle className="size-3.5" aria-hidden />
                    ) : (
                      <PauseCircle className="size-3.5" aria-hidden />
                    )}
                    {data.paused ? 'Resume' : 'Pause'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={clearing}
                    onClick={() => setConfirmClear(true)}
                  >
                    Clear
                  </Button>
                </>
              )}
            </div>
          </div>
          {data.url && data.updated_by && (
            <p className="text-[12px] text-muted-foreground">
              {`Set by ${data.updated_by} `}
              <RelativeTime value={data.updated_at} />
              {data.paused ? ' · paused: nothing is pushed or pulled until you resume.' : '.'}
            </p>
          )}
          <RemoteSetupGuide provider={data.provider ?? undefined} />
        </section>

        <section className="space-y-3">
          <SectionHeader eyebrow="Push status" title="What reached the remote" />
          {!data.url ? (
            <EmptyState message="No remote configured yet. Paste an SSH URL above and Save — Bailey pushes right after." />
          ) : (
            <>
              <dl className="grid grid-cols-1 gap-x-8 gap-y-1 text-[13px] sm:grid-cols-2">
                <div className="flex justify-between gap-4 sm:justify-start">
                  <dt className="text-muted-foreground">Last successful push</dt>
                  <dd className="text-foreground">
                    <RelativeTime value={status.last_success_at} fallback="never" />
                  </dd>
                </div>
                <div className="flex justify-between gap-4 sm:justify-start">
                  <dt className="text-muted-foreground">Last attempt</dt>
                  <dd className="text-foreground">
                    {inProgress ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Loader2 className="size-3 animate-spin" aria-hidden />
                        pushing now
                      </span>
                    ) : (
                      <RelativeTime value={status.last_attempt_at} fallback="never" />
                    )}
                  </dd>
                </div>
              </dl>
              {status.error && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
                  {`Last push failed: ${status.error}`}
                </div>
              )}
              {(status.result === 'diverged' || status.result === 'conflict') && (
                <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[12px]">
                  <div className="font-semibold text-amber-800 dark:text-amber-300">
                    {status.result === 'conflict'
                      ? `Remote changes to ${(status.conflicts ?? []).join(', ')} conflict with work in this workspace`
                      : "The remote's main is no longer a fast-forward of what this workspace pushed"}
                  </div>
                  <p className="text-muted-foreground">
                    Bailey never force-pushes main on its own, so main is not being mirrored. Force
                    push to replace the remote&apos;s main with this workspace&apos;s, or pause the
                    remote until it is sorted out by hand.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="destructive" disabled={repairing} onClick={() => void repair()}>
                      {repairing ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Upload className="size-3.5" aria-hidden />}
                      Force push to repair
                    </Button>
                    {!data.paused && (
                      <Button size="sm" variant="outline" disabled={toggling} onClick={() => void togglePause()}>
                        <PauseCircle className="size-3.5" aria-hidden />
                        Pause the remote
                      </Button>
                    )}
                  </div>
                </div>
              )}
              {status.inbound && status.inbound.length > 0 && (
                <p className="text-[12px] text-muted-foreground">
                  {`Last run pulled remote changes into main for ${status.inbound.join(', ')}.`}
                </p>
              )}
              {branches.length === 0 && !inProgress && !status.error ? (
                <EmptyState message="Nothing pushed yet — the first push runs after you save, or press Push now." />
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {branches.map(([name, row]) => {
                    const meta = RESULT_META[row.result] ?? RESULT_META[RESULT_FALLBACK];
                    return (
                      <li key={name} className="flex flex-col gap-1 px-3 py-2 text-[13px]">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-foreground">{name}</span>
                          <Badge variant={meta.variant} className={cn('text-[10px]', meta.className)}>
                            {meta.label}
                          </Badge>
                          <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                            {`${shortSha(row.local)} → ${shortSha(row.remote)}`}
                          </span>
                        </div>
                        {row.detail && (
                          <p className="text-[12px] text-muted-foreground">{row.detail}</p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {status.warnings && status.warnings.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-muted-foreground">
                  {status.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      </CardContent>

      <AlertDialog open={confirmRotate} onOpenChange={setConfirmRotate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retire this deploy key?</AlertDialogTitle>
            <AlertDialogDescription>
              Bailey generates a new SSH key for this workspace and stops using the current one. Pushes
              and pulls will fail until you add the new public key to your git host as a read-write
              deploy key; remove the old key there once you have. The retired key is kept on the server
              but never used again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rotating}>Keep the current key</AlertDialogCancel>
            <AlertDialogAction disabled={rotating} onClick={() => void rotateKey()}>
              Retire and generate a new key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop mirroring to this remote?</AlertDialogTitle>
            <AlertDialogDescription>
              {`Bailey stops pushing to ${data.url ?? 'the remote'}. Nothing is deleted on the remote, and nothing in this workspace changes.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearing}>Keep mirroring</AlertDialogCancel>
            <AlertDialogAction disabled={clearing} onClick={() => void clear()}>
              Clear remote
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
