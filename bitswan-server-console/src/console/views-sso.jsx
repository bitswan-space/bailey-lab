import React from 'react';

const { C: SC, Icon: SIcon, Btn: SBtn, Pill: SPill } = window.WD_SHELL;
const {
  Card: SCard, PageHeader: SPageHeader, Field: SField, TextInput: STextInput,
  EmptyState: SEmpty,
} = window.SC_UI;
const { Api: SApi } = window.SC_API;
const { useState: useS, useEffect: useSE } = React;

const SSO_ROLES = ['admin', 'auditor', 'member', 'user'];

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

function MappingEditor({ mappings, onChange }) {
  const set = (i, patch) => onChange(mappings.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const add = () => onChange([...mappings, { group: '', role: 'member' }]);
  const remove = (i) => onChange(mappings.filter((_, j) => j !== i));

  return (
    <div>
      {mappings.length === 0 && (
        <div style={{ fontSize: 12.5, color: SC.muted, marginBottom: 8 }}>
          No mappings — everyone who signs in through this provider is a member until an admin changes their role here in Bailey.
        </div>
      )}
      {mappings.map((m, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
          <STextInput value={m.group} onChange={(v) => set(i, { group: v })}
            placeholder="group value from the provider" style={{ flex: 1 }} />
          <select value={m.role} onChange={(e) => set(i, { role: e.target.value })}
            style={{ height: 34, borderRadius: 8, border: `1px solid ${SC.border}`, padding: '0 8px', fontFamily: 'inherit', fontSize: 13 }}>
            {SSO_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <button onClick={() => remove(i)} title="Remove mapping"
            style={{ border: 0, background: 'transparent', cursor: 'pointer', color: SC.muted, padding: 4 }}>
            <SIcon name="x" size={15} />
          </button>
        </div>
      ))}
      <SBtn size="sm" leftIcon="plus" onClick={add}>Add mapping</SBtn>
    </div>
  );
}

function SSOView({ ctx }) {
  const { toast } = ctx;
  const [cfg, setCfg] = useS(null);
  const [loadErr, setLoadErr] = useS('');
  const [secret, setSecret] = useS('');
  const [busy, setBusy] = useS('');
  const [err, setErr] = useS('');

  const load = async () => {
    setLoadErr(''); setErr('');
    try {
      const r = await SApi.ssoGet();
      setCfg(r); setSecret('');
    } catch (e) {
      setLoadErr(e.message || 'Could not load the single sign-on settings.');
    }
  };
  useSE(() => { load(); }, []);

  const patch = (p) => setCfg({ ...cfg, ...p });

  const save = async (enabled) => {
    setBusy(enabled === false ? 'disable' : 'save'); setErr('');
    try {
      const r = await SApi.ssoSet({
        enabled,
        display_name: cfg.display_name || '',
        issuer_url: cfg.issuer_url || '',
        client_id: cfg.client_id || '',
        client_secret: secret,
        groups_claim: cfg.groups_claim || '',
        role_mappings: cfg.role_mappings || [],
      });
      setCfg(r); setSecret('');
      toast(enabled ? 'Single sign-on enabled' : 'Single sign-on disabled', 'success');
    } catch (e) {
      setErr(e.message || 'Could not save the settings.');
    } finally { setBusy(''); }
  };

  const test = async () => {
    setBusy('test'); setErr('');
    try {
      await SApi.ssoTest(cfg.issuer_url || '');
      toast('Discovery document looks good', 'success');
    } catch (e) {
      setErr(e.message || 'Could not reach the provider.');
    } finally { setBusy(''); }
  };

  if (loadErr) {
    return (
      <div>
        <SPageHeader title="Single sign-on" sub="Let people sign in with your own identity provider." />
        <SEmpty icon="shield-alert" title="Couldn't load the settings" text={loadErr} />
      </div>
    );
  }
  if (!cfg) return <div style={{ padding: 20, fontSize: 13, color: SC.muted }}>Loading…</div>;

  return (
    <div>
      <SPageHeader title="Single sign-on"
        sub="Add your own OpenID Connect provider so your people sign in with their company account. Bitswan accounts keep working alongside it." />

      <SCard>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <SPill tone={cfg.enabled ? 'primary' : 'neutral'} size="xs">{cfg.enabled ? 'Enabled' : 'Not configured'}</SPill>
          {cfg.updated_at && (
            <span style={{ fontSize: 11.5, color: SC.muted }}>
              last changed by {cfg.updated_by} on {new Date(cfg.updated_at).toLocaleString()}
            </span>
          )}
        </div>

        <div style={{ padding: 13, background: SC.surface, border: `1px solid ${SC.border}`, borderRadius: 10, margin: '10px 0 6px' }}>
          <div style={{ fontSize: 12.5, color: SC.fg, lineHeight: '18px' }}>
            Signing in still only proves who someone is. Every new device is approved the same way it is today,
            and people arrive as members until an admin gives them a role — or until a mapping below does.
            Because your provider already knows your staff, you will not need the email invitations.
          </div>
        </div>

        <Row label="Display name" hint="What the sign-in button says.">
          <STextInput value={cfg.display_name || ''} onChange={(v) => patch({ display_name: v })} placeholder="Acme single sign-on" />
        </Row>
        <Row label="Issuer URL" hint="The provider's OIDC issuer. Bailey reads its discovery document.">
          <div style={{ display: 'flex', gap: 8 }}>
            <STextInput value={cfg.issuer_url || ''} onChange={(v) => patch({ issuer_url: v })}
              placeholder="https://login.acme.example" style={{ flex: 1 }} />
            <SBtn size="sm" onClick={test} disabled={!cfg.issuer_url || busy === 'test'}>
              {busy === 'test' ? 'Checking…' : 'Test'}
            </SBtn>
          </div>
        </Row>
        <Row label="Client ID">
          <STextInput value={cfg.client_id || ''} onChange={(v) => patch({ client_id: v })} placeholder="bailey" />
        </Row>
        <Row label="Client secret" hint={cfg.secret_set ? 'A secret is stored. Leave blank to keep it.' : 'Required.'}>
          <STextInput value={secret} onChange={setSecret} type="password"
            placeholder={cfg.secret_set ? '••••••••  (unchanged)' : 'Paste the client secret'} />
        </Row>
        <Row label="Redirect URI" hint="Register this with your provider.">
          <code style={{ fontSize: 12.5, fontFamily: 'Geist Mono, monospace', color: SC.fg, wordBreak: 'break-all' }}>
            {cfg.callback_url || 'Available once this server has a domain.'}
          </code>
        </Row>
        <Row label="Groups claim" hint="Only if your provider does not use “groups”.">
          <STextInput value={cfg.groups_claim || ''} onChange={(v) => patch({ groups_claim: v })} placeholder="groups" />
        </Row>
        <Row label="Role mapping" hint="Optional. Strongest match wins.">
          <MappingEditor mappings={cfg.role_mappings || []} onChange={(m) => patch({ role_mappings: m })} />
        </Row>

        {err && (
          <div style={{ display: 'flex', gap: 10, padding: 13, background: SC.surface, borderRadius: 10, border: `1px solid ${SC.border}`, marginTop: 14 }}>
            <SIcon name="shield-alert" size={15} color={SC.red} style={{ marginTop: 1, flex: '0 0 auto' }} />
            <span style={{ fontSize: 12.5, color: SC.fg, lineHeight: '17px' }}>{err}</span>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
          <SBtn variant="primary" leftIcon="check" disabled={busy === 'save'} onClick={() => save(true)}>
            {busy === 'save' ? 'Saving…' : cfg.enabled ? 'Save changes' : 'Enable single sign-on'}
          </SBtn>
          {cfg.enabled && (
            <SBtn disabled={busy === 'disable'} onClick={() => save(false)}>
              {busy === 'disable' ? 'Disabling…' : 'Disable'}
            </SBtn>
          )}
          <span style={{ fontSize: 11.5, color: SC.muted }}>
            Saving changes where this server checks identities, so everyone — including you — signs in again.
          </span>
        </div>
      </SCard>
    </div>
  );
}

window.SC_SSO = { SSOView };
