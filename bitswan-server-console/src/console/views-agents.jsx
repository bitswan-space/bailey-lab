import React from 'react';

const { C: SC, Icon: SIcon, Btn: SBtn, Pill: SPill } = window.WD_SHELL;
const {
  Card: SCard, PageHeader: SPageHeader, TextInput: STextInput, EmptyState: SEmpty,
  Toggle: SToggle, Select: SSelect,
} = window.SC_UI;
const { Api: SApi } = window.SC_API;
const { useState: useS, useEffect: useSE } = React;

// Coding agents — what this server hands the coding agents in every workspace.
// One card today: the default model provider for OpenCode. The daemon side is
// internal/daemon/opencode_provider.go; how the setting reaches a workspace's
// OpenCode servers is in docs/opencode-integration.md.

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
      setCfg(r); setKey('');
    } catch (e) {
      setLoadErr(e.message || 'Could not load the OpenCode provider settings.');
    }
  };
  useSE(() => { load(); }, []);

  if (loadErr) return <SEmpty icon="shield-alert" title="Couldn't load the settings" text={loadErr} />;
  if (!cfg) return <div style={{ padding: 20, fontSize: 13, color: SC.muted }}>Loading…</div>;

  const providers = cfg.providers || [];
  const provider = providers.find((p) => p.id === cfg.provider) || null;
  const patch = (p) => setCfg({ ...cfg, ...p });

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
    provider: cfg.provider || '',
    model: (cfg.model || '').trim(),
    api_key: key,
    restrict: !!cfg.restrict,
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

      <Row label="Provider">
        <SSelect value={cfg.provider || ''} onChange={(v) => patch({ provider: v })}
          options={[{ value: '', label: 'Choose a provider…' }, ...providers.map((p) => ({ value: p.id, label: p.name }))]}
          style={{ maxWidth: 320 }} />
      </Row>
      <Row label="Model" hint="The provider's own model id. OpenCode uses it unless a person picks another.">
        <STextInput value={cfg.model || ''} onChange={(v) => patch({ model: v })} mono
          placeholder={provider ? provider.model_hint : 'choose a provider first'} style={{ maxWidth: 320 }} />
      </Row>
      <Row label="API key" hint={cfg.key_set ? `A key ending in …${cfg.key_hint || ''} is stored. Leave blank to keep it.` : 'Required.'}>
        <STextInput value={key} onChange={setKey} type="password" autoComplete="new-password" mono
          placeholder={cfg.key_set ? '••••••••  (unchanged)' : `Paste the ${provider ? provider.name : 'provider'} API key`} />
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

      <Note tone="warn">
        The key is written into every workspace's coding-agent home, where every coding-agent run can read
        it — treat it as shared with everyone who can use a coding agent on this server. It applies to
        OpenCode servers started from now on: a person's running server picks it up when it next starts,
        and idle servers stop after 30 minutes.
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
