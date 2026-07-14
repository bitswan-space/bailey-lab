import { useCallback, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { toast } from '@/lib/notify';

/**
 * Per-user Claude statusline editor (Agents screen → ENVIRONMENT panel →
 * Agent statusline). The script runs inside the coding-agent container on
 * every statusline render: Claude pipes a JSON payload (cwd, model, cost,
 * context_window, rate_limits, …) to its stdin and shows its stdout — ANSI
 * colors included — under the chat input box. Saving applies immediately,
 * even to sessions that are already open; Reset returns to the container's
 * built-in default.
 *
 * The dialog opens on the *effective* script — the user's custom one, or the
 * shipped default as a working example to edit. Syntax errors (`bash -n`,
 * checked in the container before install) come back inline, not as a toast.
 *
 * `children` is the trigger element (the sidebar row supplies its own look).
 */
export function StatuslineDialog({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [script, setScript] = useState('');
  const [custom, setCustom] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.statusline.get();
      setScript(res.script);
      setCustom(res.custom);
    } catch (e) {
      setScript('');
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) void load();
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await api.statusline.save(script);
      if (res.ok) {
        setCustom(true);
        setOpen(false);
        toast.success('Statusline saved', {
          description: 'Applies on the next render — even in open sessions.',
        });
      } else {
        setError(res.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    setError('');
    try {
      await api.statusline.reset();
      toast.success('Statusline reset to default');
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Agent statusline</DialogTitle>
          <DialogDescription>
            This script renders the status bar under the agent&apos;s input box.
            Claude pipes session JSON (cwd, model, cost, context_window,
            rate_limits, …) to its stdin on every render and shows its stdout;
            ANSI colors work. Saving applies immediately, even to open sessions.
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex h-72 items-center justify-center text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
          </div>
        ) : (
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            spellCheck={false}
            rows={18}
            className="max-h-[50vh] w-full resize-y rounded-md border border-border bg-background p-2.5 font-mono text-xs text-foreground outline-none focus:border-foreground/60"
          />
        )}
        {error && (
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            {error}
          </pre>
        )}
        <DialogFooter>
          {custom && (
            <Button
              variant="outline"
              onClick={reset}
              disabled={saving || loading}
              className="mr-auto"
            >
              Reset to default
            </Button>
          )}
          <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || loading || !script.trim()}>
            {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
