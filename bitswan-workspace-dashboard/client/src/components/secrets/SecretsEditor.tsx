import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Eye, EyeOff, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, type BpSecrets } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Secrets editor — wireframe `SecretsEditor` (Deployments → Secrets, and the
 * Coding Agent tab's "Dev secrets" section).
 *
 * Secret **names are shared across all stages**; **values are per stage**. So a
 * name added (or set) in any stage shows in every other stage — as a "Not set"
 * row until that stage gets its own value. Add / rename / delete a name applies
 * to every stage. The active `stage` only selects which stage's *value* column
 * you edit (live-dev shares dev).
 *
 * The wireframe auto-commits; we add an **Apply** button (per Tim) that encrypts
 * + versions the whole BP's secrets in bitswan.yaml as one commit, so they roll
 * back together. `compact` stacks each row for the narrow Environment sidebar.
 */

interface Props {
  bp: string;
  /** Deployment stage whose value column is shown (dev / staging / production;
   *  live-dev → dev). */
  stage: string;
  stageLabel: string;
  compact?: boolean;
}

const REALMS = ['dev', 'staging', 'production'] as const;

/** Map a deployment stage to its secret realm — matches the gitops backend. */
function realmFor(stage: string): string {
  if (stage === 'live-dev' || stage === 'dev') return 'dev';
  if (stage === '' || stage === 'production') return 'production';
  if (stage === 'staging') return 'staging';
  return stage;
}

type Data = { keys: string[]; values: Record<string, Record<string, string>> };

/** Build the shared key list (union across stages) + per-realm value maps. */
function toData(all: BpSecrets): Data {
  const keys: string[] = [];
  for (const realm of REALMS) {
    for (const k of Object.keys(all[realm] || {})) if (!keys.includes(k)) keys.push(k);
  }
  const values: Record<string, Record<string, string>> = {};
  for (const realm of REALMS) values[realm] = { ...(all[realm] || {}) };
  return { keys, values };
}

/** Full per-realm payload (every shared key in every realm) for the API. */
function toPayload(data: Data): BpSecrets {
  const out: BpSecrets = {};
  for (const realm of REALMS) {
    out[realm] = {};
    for (const k of data.keys) {
      const name = k.trim().toUpperCase();
      if (name) out[realm][name] = data.values[realm]?.[k] ?? '';
    }
  }
  return out;
}

export function SecretsEditor({ bp, stage, stageLabel, compact = false }: Props) {
  const realm = realmFor(stage);
  const [data, setData] = useState<Data>({ keys: [], values: {} });
  const [baseline, setBaseline] = useState<Data>({ keys: [], values: {} });
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .bpSecrets(bp)
      .then((all) => {
        if (!alive) return;
        const d = toData(all);
        setData(d);
        setBaseline(d);
        setReveal({});
      })
      .catch(() => {
        if (!alive) return;
        const d: Data = { keys: [], values: {} };
        setData(d);
        setBaseline(d);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [bp]);

  const dirty = useMemo(
    () => JSON.stringify(toPayload(data)) !== JSON.stringify(toPayload(baseline)),
    [data, baseline],
  );

  const setValue = (key: string, v: string) =>
    setData((d) => ({
      ...d,
      values: { ...d.values, [realm]: { ...(d.values[realm] || {}), [key]: v } },
    }));

  const renameKey = (oldKey: string, raw: string) =>
    setData((d) => {
      const newKey = (raw || '').trim().toUpperCase();
      if (!newKey || newKey === oldKey || d.keys.includes(newKey)) return d;
      const values: Record<string, Record<string, string>> = {};
      for (const r of REALMS) {
        const src = d.values[r] || {};
        const next: Record<string, string> = {};
        for (const k of Object.keys(src)) next[k === oldKey ? newKey : k] = src[k] ?? '';
        values[r] = next;
      }
      return { keys: d.keys.map((k) => (k === oldKey ? newKey : k)), values };
    });

  const removeKey = (key: string) =>
    setData((d) => {
      const values: Record<string, Record<string, string>> = {};
      for (const r of REALMS) {
        values[r] = { ...(d.values[r] || {}) };
        delete values[r][key];
      }
      return { keys: d.keys.filter((k) => k !== key), values };
    });

  const addKey = () =>
    setData((d) => {
      let n = 1;
      let name = 'NEW_SECRET';
      while (d.keys.includes(name)) name = `NEW_SECRET_${++n}`;
      const values: Record<string, Record<string, string>> = {};
      for (const r of REALMS) values[r] = { ...(d.values[r] || {}), [name]: '' };
      return { keys: [...d.keys, name], values };
    });

  const apply = useCallback(() => {
    setApplying(true);
    const work = api.setBpSecrets(bp, toPayload(data));
    toast.promise(work, {
      loading: 'Applying secrets…',
      success: 'Secrets applied — versioned in bitswan.yaml',
      error: (e: unknown) => `Apply failed: ${String(e)}`,
    });
    work
      .then((all) => {
        const d = toData(all);
        setData(d);
        setBaseline(d);
      })
      .catch(() => {})
      .finally(() => setApplying(false));
  }, [bp, data]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 p-4 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading secrets…
      </div>
    );
  }

  const stageVals = data.values[realm] || {};
  const missingCount = data.keys.filter((k) => !(stageVals[k] || '').trim()).length;

  const valueField = (key: string) => {
    const val = stageVals[key] || '';
    const missing = !val.trim();
    return (
      <div className="relative">
        <input
          type={reveal[key] ? 'text' : 'password'}
          value={val}
          onChange={(e) => setValue(key, e.target.value)}
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
            onClick={() => setReveal((s) => ({ ...s, [key]: !s[key] }))}
            title={reveal[key] ? 'Hide' : 'Show'}
            className="absolute right-1.5 top-1 flex h-6 items-center rounded px-1.5 text-muted-foreground hover:text-foreground"
          >
            {reveal[key] ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
        )}
      </div>
    );
  };

  const keyField = (key: string) => (
    <input
      defaultValue={key}
      key={key}
      onBlur={(e) => renameKey(key, e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      placeholder="SECRET_NAME"
      className="h-8 min-w-0 rounded-md border border-border bg-background px-2.5 font-mono text-[12px] font-semibold uppercase outline-none focus:border-primary"
    />
  );

  const deleteBtn = (key: string) => (
    <button
      type="button"
      onClick={() => removeKey(key)}
      title="Delete secret (removes from every stage)"
      className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-red-600"
    >
      <Trash2 className="size-3.5" aria-hidden />
    </button>
  );

  return (
    <div className={compact ? '' : 'px-1 py-3'}>
      {!compact && (
        <p className="mb-3 max-w-2xl text-[13px] text-muted-foreground">
          Secret <strong className="text-foreground">names are shared</strong> across
          every stage; <strong className="text-foreground">values are per stage</strong>.
          Edits are local until you press{' '}
          <strong className="text-foreground">Apply</strong>, which encrypts and versions
          this BP&apos;s secrets in <code>bitswan.yaml</code> (rollback-able) and applies
          them on the next deploy.
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
            Name <span className="font-medium normal-case tracking-normal">(shared)</span>
          </span>
          <span>Value in {stageLabel}</span>
          <span />
        </div>
      )}

      <div className="flex flex-col gap-2">
        {data.keys.length === 0 && (
          <div className="rounded-lg border border-dashed border-border py-4 text-center text-[12px] text-muted-foreground">
            No secrets yet — click &quot;Add secret&quot; below.
          </div>
        )}
        {data.keys.map((key) =>
          compact ? (
            <div key={key} className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1">{keyField(key)}</div>
                {deleteBtn(key)}
              </div>
              {valueField(key)}
            </div>
          ) : (
            <div key={key} className="grid grid-cols-[210px_1fr_32px] items-center gap-2">
              {keyField(key)}
              {valueField(key)}
              {deleteBtn(key)}
            </div>
          ),
        )}
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
        <button
          type="button"
          onClick={apply}
          disabled={!dirty || applying}
          title={dirty ? 'Apply & version secrets' : 'No changes to apply'}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          {applying ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Check className="size-3.5" aria-hidden />
          )}
          Apply
        </button>
        {dirty && !applying && (
          <span className="text-[11px] text-amber-600">Unsaved changes</span>
        )}
      </div>
    </div>
  );
}
