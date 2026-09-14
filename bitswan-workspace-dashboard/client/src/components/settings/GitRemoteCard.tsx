import { useCallback, useEffect, useRef, useState } from 'react';
import { GitBranch, KeyRound, Loader2, Upload } from 'lucide-react';
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
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';

type CardState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: GitRemote };

const ACTIVE_POLL_MS = 3000;
const IDLE_POLL_MS = 30000;
const FIXED_BRANCH_ORDER = ['dev', 'staging', 'production', 'gitops'];

const RESULT_META: Record<
  GitRemoteBranch['result'],
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; className?: string }
> = {
  pushed: { label: 'Pushed', variant: 'default' },
  up_to_date: { label: 'Up to date', variant: 'secondary' },
  deleted: { label: 'Deleted', variant: 'secondary' },
  pending: { label: 'Pending', variant: 'outline' },
  diverged: {
    label: 'Diverged',
    variant: 'outline',
    className: 'border-amber-500/60 text-amber-700 dark:text-amber-400',
  },
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
  const [confirmClear, setConfirmClear] = useState(false);
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
          Bailey mirrors this whole workspace into one repository with one folder per business
          process. Branches <code>dev</code>, <code>staging</code> and <code>production</code> hold
          each process&apos;s code as deployed to that stage, <code>gitops</code> holds the
          deployment manifests, and <code>copies/&lt;name&gt;</code> holds each person&apos;s copy
          as last published. Pushes run after every deploy or promote, and again every few minutes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
        <section className="space-y-3">
          <SectionHeader
            eyebrow="Deploy key"
            title="This workspace's SSH public key"
            helper="Add it as a read-write deploy key on GitHub, GitLab or Forgejo. Each workspace has its own key."
            right={
              <CopyButton
                text={data.public_key}
                label="Copy public key"
                successToast="Public key copied"
              />
            }
          />
          <pre className="select-all whitespace-pre-wrap break-all rounded-md border border-border bg-muted/40 p-3 font-mono text-[12px] leading-relaxed">
            {data.public_key}
          </pre>
          {data.fingerprint && (
            <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
              <KeyRound className="size-3" aria-hidden />
              {data.fingerprint}
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
                    disabled={pushing || inProgress}
                    onClick={() => void pushNow()}
                  >
                    {inProgress || pushing ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : (
                      <Upload className="size-3.5" aria-hidden />
                    )}
                    {inProgress ? 'Pushing…' : 'Push now'}
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
              <RelativeTime value={data.updated_at} />.
            </p>
          )}
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
              {branches.length === 0 && !inProgress && !status.error ? (
                <EmptyState message="Nothing pushed yet — the first push runs after you save, or press Push now." />
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {branches.map(([name, row]) => {
                    const meta = RESULT_META[row.result] ?? RESULT_META.pending;
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
                        {row.result === 'diverged' && (
                          <p className="text-[12px] text-muted-foreground">
                            {`The remote's ${name} has commits Bailey didn't push. Bailey never force-pushes — reset or delete that branch on the remote, then Push now.`}
                          </p>
                        )}
                        {row.detail && row.result !== 'diverged' && (
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
