import React from 'react';

const { C: SC, Icon: SIcon, Btn: SBtn, Pill: SPill } = window.WD_SHELL;
const {
  Card: SCard, PageHeader: SPageHeader, TextInput: STextInput, EmptyState: SEmpty,
  Toggle: SToggle,
} = window.SC_UI;
const { Api: SApi } = window.SC_API;
const { useState: useS, useEffect: useSE } = React;

// Coding agents — what this server hands the coding agents in every workspace.
// One card today: the default model provider for OpenCode. The daemon side is
// internal/daemon/opencode_provider.go; how the setting reaches a workspace's
// OpenCode servers is in docs/opencode-integration.md.

const CUSTOM = '__custom__';

function Row({ label, hint, children }) {
  return (
    <div style={{ display: 'flex', gap: 16, padding: '13px 0', borderBottom: `1px solid ${SC.surface2}` }}>
      <div style={{ width: 190, flex: '0 0 auto' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: SC.fg }}>{label}</div>
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

// A native select, styled like the console's: it keeps type-to-jump, which the
// long provider list needs, and takes option groups, which the shared Select
// does not.
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

// The provider groups: OpenCode's whole single-key catalogue is a couple of
// hundred entries, so the familiar few come first and the rest follow in one
// alphabetical group. `withCustom` adds the admin's own endpoint on top.
function ProviderOptions({ providers, withCustom, none }) {
  const popular = providers.filter((p) => p.popular);
  const rest = providers.filter((p) => !p.popular);
  const opt = (p) => <option key={p.id} value={p.id}>{p.name}</option>;
  return (
    <>
      <option value="">{none}</option>
      {withCustom && <optgroup label="Your own"><option value={CUSTOM}>Custom endpoint…</option></optgroup>}
      {popular.length > 0 && <optgroup label="Popular">{popular.map(opt)}</optgroup>}
      <optgroup label={popular.length > 0 ? `All providers (${rest.length})` : 'Providers'}>{rest.map(opt)}</optgroup>
    </>
  );
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

function OpenCodeProviderCard({ toast }) {
  const [cfg, setCfg] = useS(null);
  const [loadErr, setLoadErr] = useS('');
  const [key, setKey] = useS('');
  const [busy, setBusy] = useS('');
  const [err, setErr] = useS('');

  const load = async () => {
    setLoadErr(''); setErr('');
    try {
      const r = await SApi.openCodeProvider();
      // A fresh configuration starts with OpenCode as the default agent: the
      // point of giving the server a key is that nobody has to be asked.
      if (!r.updated_at) r.default_agent = true;
      setCfg(r); setKey('');
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
  const patch = (p) => setCfg({ ...cfg, ...p });
  const patchCustom = (p) => patch({ custom: { ...custom, ...p } });

  const chooseProvider = (v) => {
    if (v === CUSTOM) {
      patch({ custom: custom || { name: '', package: 'openai-compatible', canonical: '', models: [] }, provider: '', model: '' });
    } else {
      patch({ custom: null, provider: v });
    }
  };

  const listedModels = custom && !custom.canonical ? (custom.models || []).filter((m) => (m.id || '').trim()) : [];

  const submit = async (body, doing, done) => {
    setBusy(doing); setErr('');
    try {
      const r = await SApi.setOpenCodeProvider(body);
      setCfg(r); setKey('');
      toast(done, 'success');
    } catch (e) {
      setErr(e.message || 'Could not save the settings.');
    } finally { setBusy(''); }
  };
  const save = (enabled) => submit({
    enabled,
    provider: (cfg.provider || '').trim(),
    model: (cfg.model || '').trim(),
    api_key: key,
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
  const remove = () => {
    const ok = window.confirm(
      'Forget the stored API key and the provider choice?\n\n' +
      'OpenCode servers started from now on will have no default provider. ' +
      'Providers people connected themselves are untouched.');
    if (!ok) return;
    submit({ clear: true }, 'remove', 'Default provider removed');
  };

  const status = cfg.enabled ? 'Enabled' : cfg.key_set ? 'Turned off' : 'Not configured';
  const keyTarget = custom ? 'the endpoint below' : (provider ? provider.name : 'the provider');

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
          to bring a key of their own. People can still connect other providers in OpenCode's own settings
          unless you restrict that below. Claude Code is not affected — it has a sign-in of its own.
        </div>
      </div>

      <Row label="Provider" hint="Everything OpenCode's catalogue lists that takes one API key, or an endpoint of your own.">
        <NativeSelect value={custom ? CUSTOM : (cfg.provider || '')} onChange={chooseProvider}>
          <ProviderOptions providers={providers} withCustom none="Choose a provider…" />
        </NativeSelect>
      </Row>

      {custom && (
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
              <ProviderOptions providers={providers} none="List them here" />
            </NativeSelect>
            {!custom.canonical && (
              <ModelsEditor models={custom.models || []} onChange={(models) => patchCustom({ models })} />
            )}
          </Row>
          <Row label="Default model" hint={custom.canonical ? "A model id of the inherited provider." : "One of the listed models. OpenCode uses it unless a person picks another."}>
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

      {!custom && (
        <>
          <Row label="Model" hint="The provider's own model id. OpenCode uses it unless a person picks another.">
            <STextInput value={cfg.model || ''} onChange={(v) => patch({ model: v })} mono
              placeholder={provider ? (provider.model_hint || 'model id') : 'choose a provider first'} style={{ maxWidth: 320 }} />
          </Row>
          <Row label="Endpoint URL" hint="Optional. Leave blank for the provider's own endpoint; set it to route through a proxy or gateway — the provider's models and API stay the same.">
            <STextInput value={cfg.base_url || ''} onChange={(v) => patch({ base_url: v })} mono
              placeholder="https://llm-proxy.example.com/anthropic" />
          </Row>
        </>
      )}

      <Row label="API key" hint={cfg.key_set ? `A key ending in …${cfg.key_hint || ''} is stored. Leave blank to keep it.` : 'Required.'}>
        <STextInput value={key} onChange={setKey} type="password" autoComplete="new-password" mono
          placeholder={cfg.key_set ? '••••••••  (unchanged)' : `Paste the API key for ${keyTarget}`} />
      </Row>
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
        The key is written into every workspace's coding-agent home, where every coding-agent run can read
        it — treat it as shared with everyone who can use a coding agent on this server. An endpoint URL is
        where every prompt and the key are sent, so it deserves the same care. It all applies to OpenCode
        servers started from now on: a person's running server picks it up when it next starts, and idle
        servers stop after 30 minutes.
      </Note>

      {err && <Note>{err}</Note>}

      <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <SBtn variant="primary" leftIcon="check" disabled={!!busy} onClick={() => save(true)}>
          {busy === 'save' ? 'Saving…' : cfg.enabled ? 'Save changes' : 'Enable default provider'}
        </SBtn>
        {cfg.enabled && (
          <SBtn disabled={!!busy} onClick={() => save(false)}
            title="Keeps the key. OpenCode servers started from now on get no default provider.">
            {busy === 'disable' ? 'Turning off…' : 'Turn off'}
          </SBtn>
        )}
        {cfg.key_set && (
          <SBtn variant="danger" disabled={!!busy} onClick={remove} title="Forgets the stored key and the provider choice.">
            {busy === 'remove' ? 'Removing…' : 'Remove'}
          </SBtn>
        )}
      </div>
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
