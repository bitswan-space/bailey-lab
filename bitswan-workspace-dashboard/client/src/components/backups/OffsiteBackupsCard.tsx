import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Cloud,
  CloudUpload,
  Download,
  Loader2,
  Play,
  ShieldAlert,
} from 'lucide-react';
import { toast } from '@/lib/notify';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { api } from '@/lib/api';
import type { OffsiteBackupConfig } from '@/types';
import { RelativeTime } from '@/components/shared/RelativeTime';

/** "workspace ok, postgres failed" style summary of a run's per-service results. */
function runSummary(config: OffsiteBackupConfig): string {
  const results = config.last_run?.results;
  if (!results) return '';
  const parts: string[] = [];
  for (const [name, value] of Object.entries(results)) {
    if (name === 'timestamp' || value === undefined || typeof value === 'string') continue;
    parts.push(`${name} ${value.success === false ? 'failed' : 'ok'}`);
  }
  return parts.join(', ');
}

/**
 * Workspace-wide off-site (restic) backups card, shown at the top of the
 * Backups tab. Covers the whole server: nightly full backups plus the
 * off-site mirrors of every process's manual snapshots. Hidden entirely
 * when the workspace has no AOC connection — everything then stays
 * local-only, as before.
 */
export function OffsiteBackupsCard() {
  // eslint-disable-next-line no-restricted-syntax -- null = not loaded yet
  const [config, setConfig] = useState<OffsiteBackupConfig | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = status unknown
  const [keyMirrored, setKeyMirrored] = useState<boolean | null>(null);
  const [running, setRunning] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [confirmKeyDelete, setConfirmKeyDelete] = useState(false);
  // eslint-disable-next-line no-restricted-syntax -- null = not loaded yet
  const [draft, setDraft] = useState<{ daily: number; monthly: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout>>();

  const load = useCallback(async () => {
    try {
      const c = await api.offsiteBackups.config();
      setConfig(c);
      setDraft({
        daily: c.retention?.daily ?? 30,
        monthly: c.retention?.monthly ?? 12,
      });
      setRunning(!!c.running);
      if (c.configured) {
        api.offsiteBackups
          .keyStatus()
          .then((s) => setKeyMirrored(s.on_s3))
          .catch(() => setKeyMirrored(null));
      }
      return c;
    } catch {
      setConfig(null);
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
    return () => clearTimeout(pollTimer.current);
  }, [load]);

  // While a run is in flight, poll config until `running` clears.
  const pollUntilDone = useCallback(() => {
    clearTimeout(pollTimer.current);
    pollTimer.current = setTimeout(async () => {
      const c = await load();
      if (c?.running) {
        pollUntilDone();
      } else if (c) {
        setRunning(false);
        if (c.last_run) {
          (c.last_run.ok ? toast.success : toast.error)(
            c.last_run.ok
              ? 'Off-site backup completed'
              : `Off-site backup finished with errors: ${runSummary(c)}`,
          );
        }
      }
    }, 5000);
  }, [load]);

  const runNow = useCallback(async () => {
    setRunning(true);
    try {
      await api.offsiteBackups.run();
      toast.success('Off-site backup started');
      pollUntilDone();
    } catch (err) {
      setRunning(false);
      toast.error(`Failed to start backup: ${String(err)}`);
    }
  }, [pollUntilDone]);

  const downloadKey = useCallback(async () => {
    setKeyBusy(true);
    try {
      const { key } = await api.offsiteBackups.key();
      const blob = new Blob([key], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'restic-encryption-key.txt';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(`Failed to download key: ${String(err)}`);
    } finally {
      setKeyBusy(false);
    }
  }, []);

  const mirrorKey = useCallback(async () => {
    setKeyBusy(true);
    try {
      await api.offsiteBackups.mirrorKey();
      setKeyMirrored(true);
      toast.success('Encryption key mirrored off-site');
    } catch (err) {
      toast.error(`Failed to mirror key: ${String(err)}`);
    } finally {
      setKeyBusy(false);
    }
  }, []);

  const deleteKeyMirror = useCallback(async () => {
    setConfirmKeyDelete(false);
    setKeyBusy(true);
    try {
      await api.offsiteBackups.deleteKeyMirror();
      setKeyMirrored(false);
      toast.success('Off-site key copy deleted — keep your local download safe');
    } catch (err) {
      toast.error(`Failed to delete off-site key copy: ${String(err)}`);
    } finally {
      setKeyBusy(false);
    }
  }, []);

  const saveRetention = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await api.offsiteBackups.saveConfig({
        enabled: true,
        retention_daily: draft.daily,
        retention_monthly: draft.monthly,
      });
      toast.success('Off-site retention saved');
      await load();
    } catch (err) {
      toast.error(`Failed to save retention: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }, [draft, load]);

  // No AOC connection (or gitops unreachable): off-site backups don't apply.
  if (!config || !config.aoc_connected) return null;

  if (!config.configured || config.enabled === false) {
    return (
      <div className="rounded-[10px] border border-dashed border-border bg-background p-3 text-[12px] text-muted-foreground">
        <Cloud className="mr-1.5 inline size-3.5 align-[-2px]" aria-hidden />
        Off-site backups are {config.configured ? 'disabled' : 'not set up yet'} for
        this workspace — snapshots stay on this server only.
      </div>
    );
  }

  const last = config.last_run;

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-background p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="inline-flex items-center gap-1.5 text-[13px] font-bold text-foreground">
          <Cloud className="size-4 text-muted-foreground" aria-hidden />
          Off-site backups
        </span>
        <span className="text-[12px] text-muted-foreground">
          Workspace-wide: a nightly full backup, plus every manual snapshot is
          mirrored off-site as it is taken.
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={running} onClick={() => void runNow()}>
            {running ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Play className="size-3.5" aria-hidden />
            )}
            {running ? 'Backing up…' : 'Run backup now'}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-muted-foreground">
        <span>
          Last run:{' '}
          {last ? (
            <>
              <span className={last.ok ? 'text-emerald-700' : 'text-amber-700'}>
                {last.ok ? 'ok' : 'errors'}
              </span>{' '}
              · <RelativeTime value={last.finished_at} />
              {runSummary(config) ? ` · ${runSummary(config)}` : ''}
            </>
          ) : (
            'never'
          )}
        </span>
        <span aria-hidden>·</span>
        <span className="inline-flex items-center gap-2">
          Encryption key:
          {keyMirrored === null ? (
            <span>unknown</span>
          ) : keyMirrored ? (
            <Badge
              variant="outline"
              className="gap-1 border-emerald-200 bg-emerald-50 text-emerald-700"
            >
              <Cloud className="size-3" aria-hidden />
              mirrored off-site
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="gap-1 border-amber-200 bg-amber-50 text-amber-700"
              title="If this server is lost, backups are unrecoverable without your downloaded key"
            >
              <ShieldAlert className="size-3" aria-hidden />
              local only
            </Badge>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[12px]"
            disabled={keyBusy}
            title="Download the key to store in a password manager"
            onClick={() => void downloadKey()}
          >
            <Download className="size-3" aria-hidden />
            Download
          </Button>
          {keyMirrored === false && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[12px]"
              disabled={keyBusy}
              onClick={() => void mirrorKey()}
            >
              <CloudUpload className="size-3" aria-hidden />
              Re-mirror
            </Button>
          )}
          {keyMirrored === true && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[12px] text-muted-foreground"
              disabled={keyBusy}
              title="Remove the off-site key copy so a compromised store can't decrypt backups"
              onClick={() => setConfirmKeyDelete(true)}
            >
              Delete off-site copy
            </Button>
          )}
        </span>
      </div>

      {draft && (
        <div className="flex flex-wrap items-end gap-3 border-t border-border pt-2.5">
          {(['daily', 'monthly'] as const).map((k) => (
            <label key={k} className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {k}
              </span>
              <input
                type="number"
                min={0}
                value={draft[k]}
                onChange={(e) =>
                  setDraft((d) => d && { ...d, [k]: Math.max(0, Number(e.target.value) || 0) })
                }
                className="h-8 w-20 rounded-md border border-border bg-background px-2 text-[13px] outline-none focus:border-primary"
              />
            </label>
          ))}
          <Button
            size="sm"
            disabled={
              saving ||
              (draft.daily === (config.retention?.daily ?? 30) &&
                draft.monthly === (config.retention?.monthly ?? 12))
            }
            onClick={() => void saveRetention()}
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            Save retention
          </Button>
          <span className="text-[11px] text-muted-foreground">
            How many nightly full backups to keep off-site. Per-process snapshot
            copies follow each process&apos;s own policy (Production → Backups).
          </span>
        </div>
      )}

      <AlertDialog open={confirmKeyDelete} onOpenChange={(o) => !o && setConfirmKeyDelete(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the off-site key copy?</AlertDialogTitle>
            <AlertDialogDescription>
              The encryption key will then exist only on this server (and in any
              downloads you keep). If the server is lost and you have no
              downloaded copy, <strong>all off-site backups become permanently
              unrecoverable</strong>. Download the key first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmKeyDelete(false)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => void deleteKeyMirror()}>
              Delete off-site copy
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
