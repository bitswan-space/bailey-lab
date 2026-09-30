import React from 'react';

const { C: SC, Icon: SIcon, Btn: SBtn, Pill: SPill } = window.WD_SHELL;
const {
  Card: SCard, PageHeader: SPageHeader, TextInput: STextInput, EmptyState: SEmpty,
  Toggle: SToggle,
} = window.SC_UI;
const { Api: SApi } = window.SC_API;
const { useState: useS, useEffect: useSE, useRef: useSR, useMemo: useSM } = React;

// Coding agents — what this server hands the coding agents in every workspace.
// One card today: the default model provider for OpenCode. The daemon side is
// internal/daemon/opencode_provider.go; how the setting reaches a workspace's
// OpenCode servers is in docs/opencode-integration.md.
//
// The provider list is OpenCode's own catalogue (models.dev), read live by the
// daemon; the fields for a provider are the environment variables the
// catalogue says it reads — what OpenCode's /connect asks for.

const CUSTOM = '__custom__';
const CUSTOM_KEY = 'BITSWAN_OPENCODE_API_KEY';

function Row({ label, hint, children }) {
  return (
    <div style={{ display: 'flex', gap: 16, padding: '13px 0', borderBottom: `1px solid ${SC.surface2}` }}>
      <div style={{ width: 190, flex: '0 0 auto' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: SC.fg, wordBreak: 'break-word' }}>{label}</div>
        {hint && <div style={{ fontSize: 11.5, color: SC.muted, lineHeight: '16px', marginTop: 3 }}>{hint}</div>}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

function Note({ tone, children }) {
  const warn = tone === 'warn';
  return (
    <div style={{ display: 'flex', gap: 10, padding: 12, marginTop: 14, borderRadius: 10,
      background: warn ? '#fffbeb' : SC.surface, border: `1px solid ${warn ? SC.amber + '55' : SC.border}` }}>
      <SIcon name="shield-alert" size={15} color={warn ? SC.amber : SC.red} style={{ marginTop: 1, flex: '0 0 auto' }} />
      <span style={{ fontSize: 12, color: SC.fg, lineHeight: '17px' }}>{children}</span>
    </div>
  );
}

// A native select, styled like the console's, for the short lists.
function NativeSelect({ value, onChange, children, style }) {
  return (
    <div style={{ position: 'relative', maxWidth: 320, ...style }}>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{
        height: 36, width: '100%', padding: '0 32px 0 12px', border: `1px solid ${SC.border}`,
        borderRadius: 8, background: '#fff', fontFamily: 'inherit', fontSize: 13.5, color: SC.fg,
        outline: 'none', cursor: 'pointer', appearance: 'none', WebkitAppearance: 'none',
      }}>{children}</select>
      <SIcon name="chevron-down" size={14} color={SC.mutedFg}
        style={{ position: 'absolute', right: 11, top: 11, pointerEvents: 'none' }} />
    </div>
  );
}

// Inline SVGs, React-owned: the popover mounts and unmounts, and Lucide's
// <i>→<svg> swap on a node React is about to remove crashes (see the shell's
// worktree dropdown, which avoids it the same way).
const IconChevron = ({ size = 14, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><path d="m6 9 6 6 6-6" /></svg>
);
const IconSearch = ({ size = 13, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
);
const IconCheck = ({ size = 13, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5"
    strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><path d="M20 6 9 17l-5-5" /></svg>
);

// A button that opens a popover with a search box over a long list. Entries
// are {id, name, hint, group}; typing filters by name, id or hint, groups
// show while the box is empty, Enter takes the highlighted row, Escape and a
// click outside close it.
function SearchPicker({ value, entries, onChange, placeholder, searchPlaceholder, emptyText, disabled, mono }) {
  const [open, setOpen] = useS(false);
  const [query, setQuery] = useS('');
  const [active, setActive] = useS(0);
  const rootRef = useSR(null);
  const inputRef = useSR(null);
  const listRef = useSR(null);

  const q = query.trim().toLowerCase();
  const shown = q
    ? entries.filter((e) => e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q) || (e.hint || '').toLowerCase().includes(q))
    : entries;
  const selected = entries.find((e) => e.id === value) || null;

  useSE(() => {
    if (!open) return;
    setQuery(''); setActive(0);
    const t = setTimeout(() => inputRef.current && inputRef.current.focus(), 0);
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  useSE(() => { setActive(0); }, [q]);
  useSE(() => {
    const el = listRef.current && listRef.current.querySelector(`[data-index="${active}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const pick = (entry) => { onChange(entry.id); setOpen(false); };
  const onInputKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, shown.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && shown[active]) { e.preventDefault(); pick(shown[active]); }
  };
  const monoStyle = { fontSize: 11.5, color: SC.mutedFg, fontFamily: 'Geist Mono, monospace' };

  let lastGroup = null;
  return (
    <div ref={rootRef} style={{ position: 'relative', maxWidth: 360 }}>
      <button type="button" disabled={disabled} onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', height: 36, padding: '0 10px 0 12px',
        border: `1px solid ${open ? SC.primary : SC.border}`, borderRadius: 8, background: '#fff',
        boxShadow: open ? `0 0 0 3px ${SC.primarySoft}` : 'none', fontFamily: 'inherit', fontSize: 13.5,
        color: selected ? SC.fg : SC.muted, cursor: disabled ? 'not-allowed' : 'pointer', textAlign: 'left',
        opacity: disabled ? 0.6 : 1,
      }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          fontFamily: mono && selected ? 'Geist Mono, monospace' : 'inherit' }}>
          {selected ? selected.name : (value || placeholder)}
        </span>
        {selected && selected.code && !mono && <span style={monoStyle}>{selected.code}</span>}
        <IconChevron color={SC.mutedFg} />
      </button>

      {open && (
        <div role="listbox" style={{
          position: 'absolute', zIndex: 30, top: 40, left: 0, width: '100%', minWidth: 300,
          background: '#fff', border: `1px solid ${SC.border}`, borderRadius: 10,
          boxShadow: '0 10px 30px rgba(0,0,0,0.12)', overflow: 'hidden',
        }}>
          <div style={{ padding: 8, borderBottom: `1px solid ${SC.surface2}` }}>
            <div style={{ position: 'relative' }}>
              <span style={{ position: 'absolute', left: 9, top: 8 }}><IconSearch color={SC.mutedFg} /></span>
              <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onInputKey}
                placeholder={searchPlaceholder} style={{
                  width: '100%', height: 30, paddingLeft: 28, paddingRight: 10, border: `1px solid ${SC.border}`,
                  borderRadius: 6, background: '#fff', fontFamily: 'inherit', fontSize: 12.5, color: SC.fg, outline: 'none',
                }} />
            </div>
          </div>
          <div ref={listRef} style={{ maxHeight: 300, overflowY: 'auto', padding: 6 }}>
            {shown.length === 0 && (
              <div style={{ padding: '14px 10px', fontSize: 12.5, color: SC.muted }}>{emptyText}</div>
            )}
            {shown.map((e, i) => {
              const header = !q && e.group && e.group !== lastGroup ? e.group : null;
              lastGroup = e.group;
              const isSel = e.id === value;
              const isAct = i === active;
              return (
                <React.Fragment key={e.id}>
                  {header && (
                    <div style={{ fontSize: 10, fontWeight: 600, color: SC.mutedFg, textTransform: 'uppercase',
                      letterSpacing: 0.5, padding: '8px 10px 4px' }}>{header}</div>
                  )}
                  <div role="option" aria-selected={isSel} data-index={i}
                    onMouseEnter={() => setActive(i)} onClick={() => pick(e)} style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 6,
                      background: isAct ? SC.surface2 : 'transparent', cursor: 'pointer',
                    }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: SC.fg, fontWeight: isSel ? 600 : 400,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      fontFamily: mono ? 'Geist Mono, monospace' : 'inherit' }}>{mono ? e.id : e.name}</span>
                    <span style={monoStyle}>{mono ? (e.name !== e.id ? e.name : '') : (e.hint || e.id)}</span>
                    <span style={{ width: 13, display: 'inline-flex' }}>{isSel && <IconCheck color={SC.primary} />}</span>
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// The provider entries: the admin's own endpoint and servers first, the
// familiar few, then the rest of the catalogue alphabetically.
function providerEntries(providers) {
  const rest = providers.filter((p) => !p.popular && !p.self_hosted);
  return [
    { id: CUSTOM, name: 'Custom endpoint', hint: 'an endpoint of your own', group: 'Your own' },
    ...providers.filter((p) => p.self_hosted).map((p) => ({ ...p, hint: 'a server of your own', group: 'Your own' })),
    ...providers.filter((p) => p.popular).map((p) => ({ ...p, code: p.id, group: 'Popular' })),
    ...rest.map((p) => ({ ...p, code: p.id, group: `All providers (${rest.length})` })),
  ];
}

// The models a custom endpoint serves, by the id it expects — OpenCode has no
// catalogue for an endpoint of your own.
function ModelsEditor({ models, onChange }) {
  const set = (i, patch) => onChange(models.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const add = () => onChange([...models, { id: '', name: '' }]);
  const remove = (i) => onChange(models.filter((_, j) => j !== i));
  return (
    <div>
      {models.length === 0 && (
        <div style={{ fontSize: 12.5, color: SC.muted, marginBottom: 8 }}>No models listed yet.</div>
      )}
      {models.map((m, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
          <STextInput value={m.id || ''} onChange={(v) => set(i, { id: v })} mono
            placeholder="model id, e.g. qwen3-coder" style={{ flex: 1 }} />
          <STextInput value={m.name || ''} onChange={(v) => set(i, { name: v })}
            placeholder="display name (optional)" style={{ flex: 1 }} />
          <button onClick={() => remove(i)} title="Remove model"
            style={{ border: 0, background: 'transparent', cursor: 'pointer', color: SC.muted, padding: 4 }}>
            <SIcon name="x" size={15} />
          </button>
        </div>
      ))}
      <SBtn size="sm" leftIcon="plus" onClick={add}>Add model</SBtn>
    </div>
  );
}

// A model picker fed from the daemon's catalogue, per provider. Falls back to
// a plain input while the list is loading or if it cannot be fetched.
function ModelPicker({ providerId, value, onChange }) {
  const [state, setState] = useS({ id: '', models: null, error: '' });
  useSE(() => {
    let cancelled = false;
    setState({ id: providerId, models: null, error: '' });
    SApi.openCodeProviderModels(providerId)
      .then((r) => { if (!cancelled) setState({ id: providerId, models: r.models || [], error: '' }); })
      .catch((e) => { if (!cancelled) setState({ id: providerId, models: [], error: e.message || 'Could not load the models.' }); });
    return () => { cancelled = true; };
  }, [providerId]);
  const models = state.models || [];
  if (state.error || (state.models && models.length === 0)) {
    return (
      <div>
        <STextInput value={value} onChange={onChange} mono placeholder="model id" style={{ maxWidth: 360 }} />
        <div style={{ fontSize: 11.5, color: SC.muted, marginTop: 6 }}>{state.error || 'The catalogue lists no models for this provider; type the id.'}</div>
      </div>
    );
  }
  return (
    <SearchPicker mono value={value} onChange={onChange}
      entries={models.map((m) => ({ id: m.id, name: m.name || m.id }))}
      placeholder={state.models ? 'Choose a model' : 'Loading models…'} disabled={!state.models}
      searchPlaceholder={`Search ${models.length} models…`} emptyText="No model matches." />
  );
}

// One field per value the provider needs, under the plain labels the daemon
// derives from OpenCode's catalogue — never a variable name. When every value
// is a secret they are alternative names for one key and a single "API key"
// field suffices; otherwise the settings the provider needs next to its key
// (a resource name, a region) each get a field.
function CredentialFields({ vars, values, secrets, onChange, providerName }) {
  const allSecret = vars.length > 0 && vars.every((v) => v.secret);
  const shown = allSecret ? [vars[0]] : vars;
  const stored = (name) => (secrets && secrets[name]) || { set: false };
  return (
    <>
      {shown.map((v) => {
        const label = allSecret ? 'API key' : (v.label || 'Value');
        const s = stored(v.name);
        let hint;
        if (v.file) {
          hint = s.set ? 'A key file is stored. Leave blank to keep it.' : 'The JSON key file the provider issued for a service account.';
        } else if (v.secret) {
          hint = s.set ? `One ending in …${s.hint || ''} is stored. Leave blank to keep it.` : (v.optional ? 'Optional. Leave empty if the server needs none.' : 'Required.');
        } else {
          hint = 'Required.';
        }
        return (
          <Row key={v.name} label={label} hint={hint}>
            {v.file ? (
              <textarea value={values[v.name] || ''} onChange={(e) => onChange(v.name, e.target.value)}
                placeholder={s.set ? '(stored — paste a new key file to replace it)' : '{ "type": "service_account", … }'}
                rows={4} spellCheck={false} style={{
                  width: '100%', padding: '8px 12px', border: `1px solid ${SC.border}`, borderRadius: 8, background: '#fff',
                  fontFamily: 'Geist Mono, monospace', fontSize: 12, color: SC.fg, outline: 'none', resize: 'vertical',
                }} />
            ) : (
              <STextInput value={values[v.name] || ''} onChange={(val) => onChange(v.name, val)} mono
                type={v.secret ? 'password' : 'text'} autoComplete={v.secret ? 'new-password' : 'off'}
                placeholder={v.secret ? (s.set ? '••••••••  (unchanged)' : (v.optional ? 'none' : `Paste the ${providerName} ${label.toLowerCase()}`)) : label.toLowerCase()}
                style={{ maxWidth: v.secret ? undefined : 360 }} />
            )}
          </Row>
        );
      })}
    </>
  );
}

function OpenCodeProviderCard({ toast }) {
  const [cfg, setCfg] = useS(null);
  const [loadErr, setLoadErr] = useS('');
  const [entered, setEntered] = useS({});
  // The URL override sits behind a switch so the field is not there to
  // confuse anyone who does not route through a proxy; it opens on its own
  // when an override is stored.
  const [overrideOn, setOverrideOn] = useS(false);
  const [busy, setBusy] = useS('');
  const [err, setErr] = useS('');

  const load = async () => {
    setLoadErr(''); setErr('');
    try {
      const r = await SApi.openCodeProvider();
      // A fresh configuration starts with OpenCode as the default agent: the
      // point of giving the server a key is that nobody has to be asked.
      if (!r.updated_at) r.default_agent = true;
      // Stored plain settings and secret hints belong to the saved provider;
      // switching to another one starts its fields empty.
      r.saved_provider = r.provider;
      setCfg(r); setEntered({}); setOverrideOn(!!(r.base_url && !r.custom));
    } catch (e) {
      setLoadErr(e.message || 'Could not load the OpenCode provider settings.');
    }
  };
  useSE(() => { load(); }, []);

  if (loadErr) return <SEmpty icon="shield-alert" title="Couldn't load the settings" text={loadErr} />;
  if (!cfg) return <div style={{ padding: 20, fontSize: 13, color: SC.muted }}>Loading…</div>;

  const providers = cfg.providers || [];
  const packages = cfg.packages || [];
  const custom = cfg.custom || null;
  const provider = custom ? null : (providers.find((p) => p.id === cfg.provider) || null);
  // The provider's variables: from the catalogue, or — with the catalogue
  // unreachable — as they were saved.
  const vars = custom ? [{ name: CUSTOM_KEY, label: 'API key', secret: true, optional: true }] : (provider ? provider.env : (cfg.provider ? cfg.vars || [] : []));
  const selfHosted = !custom && !!(provider ? provider.self_hosted : cfg.self_hosted);
  const patch = (p) => setCfg({ ...cfg, ...p });
  const patchCustom = (p) => patch({ custom: { ...custom, ...p } });
  const chosen = !!custom || !!cfg.provider;
  const sameAsSaved = cfg.provider === cfg.saved_provider;

  const chooseProvider = (v) => {
    setEntered({});
    if (v === CUSTOM) {
      patch({ custom: custom || { name: '', package: 'openai-compatible', canonical: '', models: [] }, provider: '', model: '' });
    } else {
      patch({ custom: null, provider: v, model: v === cfg.provider ? cfg.model : '', base_url: v === cfg.provider ? cfg.base_url : '' });
      if (v !== cfg.provider) setOverrideOn(false);
    }
  };
  // What the fields show: plain settings come back from the server, secrets
  // only as typed here.
  const fieldValues = { ...(sameAsSaved ? cfg.values || {} : {}), ...entered };
  const setField = (name, value) => setEntered((e) => ({ ...e, [name]: value }));

  const listedModels = custom && !custom.canonical ? (custom.models || []).filter((m) => (m.id || '').trim()) : [];

  const submit = async (body, doing, done) => {
    setBusy(doing); setErr('');
    try {
      const r = await SApi.setOpenCodeProvider(body);
      r.saved_provider = r.provider;
      setCfg(r); setEntered({});
      toast(done, 'success');
    } catch (e) {
      setErr(e.message || 'Could not save the settings.');
    } finally { setBusy(''); }
  };
  const save = (enabled) => {
    const values = {};
    for (const v of vars) if (fieldValues[v.name] !== undefined) values[v.name] = fieldValues[v.name];
    return submit({
      enabled,
      provider: (cfg.provider || '').trim(),
      model: (cfg.model || '').trim(),
      values,
      restrict: !!cfg.restrict,
      default_agent: !!cfg.default_agent,
      base_url: (cfg.base_url || '').trim(),
      custom: custom ? {
        name: custom.name || '',
        package: custom.package || '',
        canonical: custom.canonical || '',
        models: (custom.models || []).map((m) => ({ id: m.id || '', name: m.name || '' })),
      } : null,
    }, enabled ? 'save' : 'disable', enabled ? 'Default provider saved' : 'Default provider turned off');
  };
  const remove = () => {
    const ok = window.confirm(
      'Forget the stored credentials and the provider choice?\n\n' +
      'OpenCode servers started from now on will have no default provider. ' +
      'Providers people connected themselves are untouched.');
    if (!ok) return;
    submit({ clear: true }, 'remove', 'Default provider removed');
  };

  const anySecretStored = Object.values(cfg.secrets || {}).some((s) => s.set);
  const status = cfg.enabled ? 'Enabled' : anySecretStored ? 'Turned off' : 'Not configured';
  const providerName = custom ? 'endpoint' : (provider ? provider.name : 'provider');

  return (
    <SCard>
      <div style={{ fontSize: 15, fontWeight: 600, color: SC.fg }}>Default model provider for OpenCode</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, marginBottom: 4 }}>
        <SPill tone={cfg.enabled ? 'primary' : 'neutral'} size="xs">{status}</SPill>
        {cfg.updated_at && (
          <span style={{ fontSize: 11.5, color: SC.muted }}>
            last changed by {cfg.updated_by} on {new Date(cfg.updated_at).toLocaleString()}
          </span>
        )}
      </div>

      <div style={{ padding: 13, background: SC.surface, border: `1px solid ${SC.border}`, borderRadius: 10, margin: '10px 0 6px' }}>
        <div style={{ fontSize: 12.5, color: SC.fg, lineHeight: '18px' }}>
          OpenCode in every workspace on this server starts with this provider and model, so nobody has
          to bring a key of their own. The list is OpenCode's own catalogue — what its “connect provider”
          offers, without the sign-in flows a person completes themselves. Claude Code is not affected.
        </div>
      </div>

      {cfg.catalog_error && (
        <Note>
          OpenCode's provider catalogue could not be loaded ({cfg.catalog_error}). The saved provider
          still shows; choosing another needs the catalogue.
        </Note>
      )}

      <Row label="Provider" hint="Everything OpenCode's catalogue lists, or an endpoint of your own.">
        <SearchPicker value={custom ? CUSTOM : (cfg.provider || '')} entries={providerEntries(providers)} onChange={chooseProvider}
          placeholder={cfg.provider || 'Choose a provider'} disabled={providers.length === 0 && !cfg.provider}
          searchPlaceholder={`Search ${providers.length} providers…`}
          emptyText="No provider matches. Not in OpenCode's catalogue? Choose “Custom endpoint”." />
      </Row>

      {chosen && custom && (
        <>
          <Row label="Provider id" hint="Lowercase letters, digits, - and _. It prefixes model references, e.g. acme/qwen3-coder.">
            <STextInput value={cfg.provider || ''} onChange={(v) => patch({ provider: v })} mono
              placeholder="acme" style={{ maxWidth: 320 }} />
          </Row>
          <Row label="Display name" hint="What people see in OpenCode's model picker.">
            <STextInput value={custom.name || ''} onChange={(v) => patchCustom({ name: v })}
              placeholder={cfg.provider || 'Acme AI'} style={{ maxWidth: 320 }} />
          </Row>
          <Row label="API style" hint="Which API the endpoint speaks. Most gateways and self-hosted servers are OpenAI-compatible.">
            <NativeSelect value={custom.package || ''} onChange={(v) => patchCustom({ package: v })}>
              {packages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </NativeSelect>
          </Row>
          <Row label="Endpoint URL" hint="Where requests go. Include /v1 for OpenAI-compatible servers.">
            <STextInput value={cfg.base_url || ''} onChange={(v) => patch({ base_url: v })} mono
              placeholder="https://llm.acme.example/v1" />
          </Row>
          <Row label="Models" hint="Either list the models the endpoint serves, or inherit a catalogue provider's models — for a gateway that fronts one.">
            <NativeSelect value={custom.canonical || ''} onChange={(v) => patchCustom({ canonical: v })} style={{ marginBottom: 10 }}>
              <option value="">List them here</option>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </NativeSelect>
            {!custom.canonical && (
              <ModelsEditor models={custom.models || []} onChange={(models) => patchCustom({ models })} />
            )}
          </Row>
          <Row label="Default model" hint={custom.canonical ? 'A model id of the inherited provider.' : 'One of the listed models. OpenCode uses it unless a person picks another.'}>
            {listedModels.length > 0 ? (
              <NativeSelect value={cfg.model || ''} onChange={(v) => patch({ model: v })}>
                <option value="">Choose a model…</option>
                {listedModels.map((m) => <option key={m.id} value={m.id.trim()}>{m.name ? `${m.name} (${m.id.trim()})` : m.id.trim()}</option>)}
              </NativeSelect>
            ) : (
              <STextInput value={cfg.model || ''} onChange={(v) => patch({ model: v })} mono
                placeholder={custom.canonical ? 'e.g. claude-sonnet-4-5' : 'list a model first'} style={{ maxWidth: 320 }} />
            )}
          </Row>
        </>
      )}

      {chosen && !custom && selfHosted && (
        <>
          <Row label="Server URL" hint="Where the server answers, with /v1. OpenCode reads the model list from it.">
            <STextInput value={cfg.base_url || ''} onChange={(v) => patch({ base_url: v })} mono
              placeholder={provider && provider.id === 'ollama' ? 'http://ollama.internal:11434/v1' : 'http://gpu-host:8000/v1'} />
          </Row>
          <Row label="Model" hint="As the server names it. OpenCode uses it unless a person picks another.">
            <STextInput value={cfg.model || ''} onChange={(v) => patch({ model: v })} mono
              placeholder={provider && provider.id === 'ollama' ? 'qwen3:8b' : 'model id'} style={{ maxWidth: 360 }} />
          </Row>
        </>
      )}

      {chosen && !custom && !selfHosted && (
        <>
          <Row label="Model" hint="OpenCode uses it unless a person picks another.">
            {provider
              ? <ModelPicker providerId={provider.id} value={cfg.model || ''} onChange={(v) => patch({ model: v })} />
              : <STextInput value={cfg.model || ''} onChange={(v) => patch({ model: v })} mono placeholder="model id" style={{ maxWidth: 360 }} />}
          </Row>
          <Row label="URL override" hint="Only if requests should go through a proxy or gateway of your own instead of the provider's own endpoint.">
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <SToggle label="Send requests to a URL of your own" on={overrideOn}
                onChange={(on) => { setOverrideOn(on); if (!on) patch({ base_url: '' }); }} />
              <div style={{ fontSize: 12.5, color: SC.fg, lineHeight: '18px' }}>
                {overrideOn
                  ? 'On — requests go to the URL below. The provider\u2019s models and API stay the same.'
                  : 'Off — requests go to the provider\u2019s own endpoint.'}
              </div>
            </div>
            {overrideOn && (
              <div style={{ marginTop: 10 }}>
                <STextInput value={cfg.base_url || ''} onChange={(v) => patch({ base_url: v })} mono
                  placeholder="https://llm-proxy.example.com/anthropic" autoFocus />
              </div>
            )}
          </Row>
        </>
      )}

      {chosen && (<>
      <CredentialFields vars={vars} values={fieldValues} secrets={sameAsSaved ? cfg.secrets : {}} onChange={setField} providerName={providerName} />
      <Row label="Other providers" hint="Whether OpenCode offers anything but this provider.">
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <SToggle label="Restrict OpenCode to this provider" on={!!cfg.restrict} onChange={(on) => patch({ restrict: on })} />
          <div style={{ fontSize: 12.5, color: SC.fg, lineHeight: '18px' }}>
            {cfg.restrict
              ? 'Restricted — OpenCode offers this provider only. Its built-in hosted provider and any provider a person connected themselves are hidden.'
              : 'Open — this provider is the default; OpenCode’s built-in hosted provider and any provider a person connects themselves stay available.'}
          </div>
        </div>
      </Row>
      <Row label="Default coding agent" hint="Whether workspaces open OpenCode for everyone, or ask each person to choose.">
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <SToggle label="Make OpenCode the default coding agent" on={!!cfg.default_agent} onChange={(on) => patch({ default_agent: on })} />
          <div style={{ fontSize: 12.5, color: SC.fg, lineHeight: '18px' }}>
            {cfg.default_agent
              ? 'On — the Coding Agent tab opens OpenCode for anyone who has not chosen an agent, without asking. People can still pick Claude Code in their workspace settings, and a choice already made stays.'
              : 'Off — the Coding Agent tab asks each person to choose between Claude Code and OpenCode on first open.'}
          </div>
        </div>
      </Row>

      <Note tone="warn">
        The credentials are written into every workspace's coding-agent home, where every coding-agent run
        can read them — treat them as shared with everyone who can use a coding agent on this server. An
        endpoint URL is where every prompt and the credentials are sent, so it deserves the same care. It
        all applies to OpenCode servers started from now on: a person's running server picks it up when it
        next starts, and idle servers stop after 30 minutes.
      </Note>

      {err && <Note>{err}</Note>}

      <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <SBtn variant="primary" leftIcon="check" disabled={!!busy} onClick={() => save(true)}>
          {busy === 'save' ? 'Saving…' : cfg.enabled ? 'Save changes' : 'Enable default provider'}
        </SBtn>
        {cfg.enabled && (
          <SBtn disabled={!!busy} onClick={() => save(false)}
            title="Keeps the credentials. OpenCode servers started from now on get no default provider.">
            {busy === 'disable' ? 'Turning off…' : 'Turn off'}
          </SBtn>
        )}
        {anySecretStored && (
          <SBtn variant="danger" disabled={!!busy} onClick={remove} title="Forgets the stored credentials and the provider choice.">
            {busy === 'remove' ? 'Removing…' : 'Remove'}
          </SBtn>
        )}
      </div>
      </>)}
    </SCard>
  );
}

function AgentsView({ ctx }) {
  const { toast } = ctx;
  return (
    <div>
      <SPageHeader title="Coding agents" subtitle="What this server hands the coding agents in every workspace." />
      <OpenCodeProviderCard toast={toast} />
    </div>
  );
}

window.SC_AGENTS = { AgentsView };
