import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SC_SSO, installFetch } from './harness.js';
import { makeData, Host, spies } from './ctx.js';

const { SSOView } = SC_SSO;

const CONFIGURED = {
  enabled: true,
  sso_only: false,
  display_name: 'Acme single sign-on',
  issuer_url: 'https://id.acme.example',
  client_id: 'bailey',
  secret_set: true,
  groups_claim: '',
  role_mappings: [],
  callback_url: 'https://auth.acme.bswn.io/callback',
  updated_at: '2026-09-01T10:00:00Z',
  updated_by: 'ada@example.com',
};

function mount(cfg = CONFIGURED, extra = {}) {
  const routes = { '/bailey/api/admin/sso': (url, init) => ({ json: init && init.method === 'POST' ? { ...cfg, ...JSON.parse(init.body) } : cfg }) };
  const fetchMock = installFetch({ ...routes, ...(extra.routes || {}) });
  const s = spies();
  render(<Host View={SSOView} data={makeData()} extra={{ toast: s.toast }} />);
  return { fetchMock, spies: s };
}

describe('SSOView', () => {
  it('shows the provider and the redirect URI an admin has to register', async () => {
    mount();
    expect(await screen.findByDisplayValue('Acme single sign-on')).toBeTruthy();
    expect(screen.getByText('https://auth.acme.bswn.io/callback')).toBeTruthy();
    expect(screen.getByText(/last changed by ada@example.com/)).toBeTruthy();
  });

  it('never renders the stored client secret, only that one is held', async () => {
    const { fetchMock } = mount();
    await screen.findByDisplayValue('Acme single sign-on');
    expect(screen.getByText(/A secret is stored\. Leave blank to keep it\./)).toBeTruthy();
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('s3cret');
  });

  it('offers both ways in by default and says so', async () => {
    mount();
    await screen.findByDisplayValue('Acme single sign-on');
    expect(screen.getByText(/people pick between a Bitswan account and your provider/i)).toBeTruthy();
    expect(screen.queryByText(/bitswan bailey sso disable/)).toBeNull();
  });

  it('warns about lockout and names the escape hatch once Bitswan accounts are off', async () => {
    mount({ ...CONFIGURED, sso_only: true });
    await screen.findByDisplayValue('Acme single sign-on');
    expect(screen.getByText(/your provider is the only way in/i)).toBeTruthy();
    expect(screen.getByText(/nobody can sign in — including you/i)).toBeTruthy();
    expect(screen.getByText(/bitswan bailey sso disable/)).toBeTruthy();
  });

  it('closing the Bitswan-account door is one labelled toggle away', async () => {
    const { fetchMock } = mount();
    await screen.findByDisplayValue('Acme single sign-on');
    fireEvent.click(screen.getByRole('button', { name: 'Bitswan account sign-in' }));
    expect(screen.getByText(/your provider is the only way in/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init && init.method === 'POST');
      expect(JSON.parse(post[1].body)).toMatchObject({ sso_only: true });
    });
  });

  it('sends sso_only with the save so the toggle actually reaches the server', async () => {
    const { fetchMock } = mount({ ...CONFIGURED, sso_only: true });
    await screen.findByDisplayValue('Acme single sign-on');
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init && init.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(post[1].body)).toMatchObject({ enabled: true, sso_only: true });
    });
  });

  it('surfaces a save failure instead of pretending it worked', async () => {
    installFetch({
      '/bailey/api/admin/sso': (url, init) => (init && init.method === 'POST'
        ? { status: 502, json: { error: 'could not reach https://id.acme.example' } }
        : { json: CONFIGURED }),
    });
    render(<Host View={SSOView} data={makeData()} />);
    await screen.findByDisplayValue('Acme single sign-on');
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
    expect(await screen.findByText(/could not reach https:\/\/id\.acme\.example/)).toBeTruthy();
  });

  it('reports a provider it cannot load rather than rendering an empty form', async () => {
    installFetch({ '/bailey/api/admin/sso': { status: 500, json: { error: 'stored SSO config is corrupt' } } });
    render(<Host View={SSOView} data={makeData()} />);
    expect(await screen.findByText(/Couldn't load the settings/)).toBeTruthy();
    expect(screen.getByText(/stored SSO config is corrupt/)).toBeTruthy();
  });
});
