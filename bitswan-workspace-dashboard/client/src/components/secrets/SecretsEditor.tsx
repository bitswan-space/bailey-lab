import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Eye, EyeOff, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, type BpSecrets } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Per-business-process secrets editor (wireframe: Deployments → Secrets, and
 * the Coding Agent tab's "Dev secrets" sidebar section). Secret KEY names are
 * shared across every stage (the union); VALUES are per stage. `dev` and
 * `live-dev` share the `dev` realm. A secret set in one stage shows as
 * "Not set" in the stages still missing it.
 *
 * `compact` stacks each row (name above value) for the narrow Environment
 * sidebar; the default two-column grid is for the full Deployments tab.
 */
export function normalizeSecrets(s: BpSecrets | null | undefined): BpSecrets {
  return {
    keys: Array.isArray(s?.keys) ? s!.keys : [],
    values: s && typeof s.values === 'object' && s.values ? s.values : {},
  };
}

interface Props {
  bp: string;
  /** Deployment stage whose values are edited (dev / staging / production). */
  stage: string;
  /** Human label for the stage, e.g. "Development". */
  stageLabel: string;
  compact?: boolean;
}

export function SecretsEditor({ bp, stage, stageLabel, compact = false }: Props) {
  const [store, setStore] = useState<BpSecrets>({ keys: [], values: {} });
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const storeRef = useRef(store);
  storeRef.current = store;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .bpSecrets(bp)
      .then((s) => alive && setStore(normalizeSecrets(s)))
      .catch(() => alive && setStore({ keys: [], values: {} }))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [bp]);

  const save = useCallback(
    (next: BpSecrets) => {
      setStore(next); // optimistic
      setSaving(true);
      api
        .setBpSecrets(bp, next)
        .then((saved) => setStore(normalizeSecrets(saved)))
        .catch((e) => toast.error(`Couldn't save secrets: ${String(e)}`))
        .finally(() => setSaving(false));
    },
    [bp],
  );

  const realm = stage;
  const stageVals = store.values[realm] || {};

  const setLocalValue = (key: string, v: string) =>
    setStore((s) => ({
      ...s,
      values: { ...s.values, [realm]: { ...(s.values[realm] || {}), [key]: v } },
    }));

  const renameKey = (oldKey: string, raw: string) => {
    const newKey = (raw || '').trim().toUpperCase();
    if (!newKey || newKey === oldKey || store.keys.includes(newKey)) return;
    const next: BpSecrets = {
      keys: store.keys.map((k) => (k === oldKey ? newKey : k)),
      values: {},
    };
    for (const r of Object.keys(store.values)) {
      const nv: Record<string, string> = {};
      for (const [k, v] of Object.entries(store.values[r] ?? {})) {
        nv[k === oldKey ? newKey : k] = v;
      }
      next.values[r] = nv;
    }
    save(next);
  };

  const removeKey = (key: string) => {
    const next: BpSecrets = { keys: store.keys.filter((k) => k !== key), values: {} };
    for (const r of Object.keys(store.values)) {
      const nv = { ...(store.values[r] ?? {}) };
      delete nv[key];
      next.values[r] = nv;
    }
    save(next);
  };

  const addKey = () => {
    let n = 1;
    let name = 'NEW_SECRET';
    while (store.keys.includes(name)) {
      n += 1;
      name = `NEW_SECRET_${n}`;
    }
    save({ keys: [...store.keys, name], values: store.values });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 p-4 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading secrets…
      </div>
    );
  }

  const missingCount = store.keys.filter((k) => !(stageVals[k] || '').trim()).length;

  const valueField = (key: string, val: string, missing: boolean) => (
    <div className="relative">
      <input
        type={reveal[key] ? 'text' : 'password'}
        value={val}
        onChange={(e) => setLocalValue(key, e.target.value)}
        onBlur={() => save(storeRef.current)}
        placeholder={missing ? 'Needs a value' : 'value'}
        className={cn(
          'h-8 w-full rounded-md border px-2.5 pr-16 font-mono text-[12px] outline-none focus:border-primary',
          missing ? 'border-amber-300 bg-amber-50' : 'border-border bg-white',
        )}
      />
      {missing ? (
        <span className="pointer-events-none absolute right-2 top-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
          Not set
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setReveal((r) => ({ ...r, [key]: !r[key] }))}
          title={reveal[key] ? 'Hide' : 'Show'}
          className="absolute right-1.5 top-1 flex h-6 items-center rounded px-1.5 text-muted-foreground hover:text-foreground"
        >
          {reveal[key] ? (
            <EyeOff className="size-3.5" aria-hidden />
          ) : (
            <Eye className="size-3.5" aria-hidden />
          )}
        </button>
      )}
    </div>
  );

  const keyField = (key: string) => (
    <input
      defaultValue={key}
      onBlur={(e) => renameKey(key, e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      className="h-8 min-w-0 rounded-md border border-border bg-background px-2.5 font-mono text-[12px] font-semibold outline-none focus:border-primary"
    />
  );

  const deleteBtn = (key: string) => (
    <button
      type="button"
      onClick={() => removeKey(key)}
      title="Delete secret (removes it from every stage)"
      className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-red-600"
    >
      <Trash2 className="size-3.5" aria-hidden />
    </button>
  );

  return (
    <div className={compact ? '' : 'px-1 py-3'}>
      {!compact && (
        <p className="mb-3 max-w-2xl text-[13px] text-muted-foreground">
          Secret names are shared across every stage; values are set per stage.
          These are injected into all of {bp}&apos;s containers and take effect on
          the next deploy of this stage.
        </p>
      )}

      {missingCount > 0 && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle className="size-3.5 shrink-0 text-amber-600" aria-hidden />
          {missingCount} secret{missingCount === 1 ? '' : 's'}{' '}
          {missingCount === 1 ? 'has' : 'have'} no value in {stageLabel} yet.
        </div>
      )}

      {!compact && (
        <div className="grid grid-cols-[210px_1fr_32px] gap-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span>
            Name <span className="font-normal normal-case tracking-normal">(shared)</span>
          </span>
          <span>Value in {stageLabel}</span>
          <span />
        </div>
      )}

      <div className="flex flex-col gap-2">
        {store.keys.length === 0 && (
          <div className="rounded-lg border border-dashed border-border py-4 text-center text-[12px] text-muted-foreground">
            No secrets yet — click &quot;Add secret&quot; below.
          </div>
        )}
        {store.keys.map((key) => {
          const val = stageVals[key] || '';
          const missing = !val.trim();
          if (compact) {
            // Stacked: name + delete on top, value below — fits the sidebar.
            return (
              <div key={key} className="flex flex-col gap-1">
                <div className="flex items-center gap-1.5">
                  <div className="min-w-0 flex-1">{keyField(key)}</div>
                  {deleteBtn(key)}
                </div>
                {valueField(key, val, missing)}
              </div>
            );
          }
          return (
            <div key={key} className="grid grid-cols-[210px_1fr_32px] items-center gap-2">
              {keyField(key)}
              {valueField(key, val, missing)}
              {deleteBtn(key)}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={addKey}
          title="Adds a secret name to every stage — fill in each stage's value separately"
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-dashed border-border bg-white px-3 text-[12px] font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground"
        >
          <Plus className="size-3.5" aria-hidden />
          Add secret
        </button>
        {saving && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> Saving…
          </span>
        )}
      </div>
    </div>
  );
}
