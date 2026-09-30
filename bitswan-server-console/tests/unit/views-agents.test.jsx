import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { SC_AGENTS, installFetch } from './harness.js';
import { makeData, Host, spies } from './ctx.js';

const { AgentsView } = SC_AGENTS;

const KEY = { name: 'BITSWAN_OPENCODE_API_KEY', label: 'API key', secret: true, optional: true };
const PROVIDERS = [
  { id: 'ollama', name: 'Ollama', env: [KEY], self_hosted: true, model_count: 0 },
  { id: 'anthropic', name: 'Anthropic', env: [{ name: 'ANTHROPIC_API_KEY', label: 'API key', secret: true }], popular: true, model_count: 2 },
  { id: 'azure', name: 'Azure', env: [
    { name: 'AZURE_RESOURCE_NAME', label: 'Resource name', secret: false },
    { name: 'AZURE_API_KEY', label: 'API key', secret: true },
  ], model_count: 1 },
  { id: 'google', name: 'Google', env: [
    { name: 'GOOGLE_API_KEY', label: 'API key', secret: true },
    { name: 'GEMINI_API_KEY', label: 'Gemini API key', secret: true },
  ], popular: true, model_count: 1 },
];
const PACKAGES = [{ id: 'openai-compatible', name: 'OpenAI-compatible (chat completions)' }];
const MODELS = {
  anthropic: [{ id: 'claude-opus-4-1', name: 'Claude Opus 4.1' }, { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }],
  azure: [{ id: 'gpt-5', name: 'GPT-5' }],
  google: [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }],
};

const FRESH = { enabled: false, provider: '', model: '', vars: [], values: {}, secrets: {}, restrict: false, default_agent: false, providers: PROVIDERS, packages: PACKAGES };
const AZURE_SAVED = {
  ...FRESH, enabled: true, provider: 'azure', model: 'gpt-5',
  vars: PROVIDERS[2].env, values: { AZURE_RESOURCE_NAME: 'acme-eu' }, secrets: { AZURE_API_KEY: { set: true, hint: 'cdef' } },
  restrict: true, default_agent: true, updated_at: '2026-09-30T08:00:00Z', updated_by: 'ada@example.com',
};

function mount(cfg = FRESH, extra = {}) {
  const routes = {
    '/bailey/api/admin/opencode-provider': (url, init) => {
      if (init && init.method === 'POST') {
        const body = JSON.parse(init.body);
        if (body.clear) return { json: FRESH };
        const secrets = {};
        for (const [k, v] of Object.entries(body.values || {})) if (v) secrets[k] = { set: true, hint: v.slice(-4) };
        return { json: { ...cfg, ...body, secrets: { ...(cfg.secrets || {}), ...secrets }, updated_at: '2026-09-30T09:00:00Z', updated_by: 'boss@example.com', providers: PROVIDERS, packages: PACKAGES } };
      }
      return { json: cfg };
    },
    ...Object.fromEntries(Object.entries(MODELS).map(([id, models]) => [`/bailey/api/admin/opencode-provider/models?provider=${id}`, { json: { provider: id, models } }])),
    ...(extra.routes || {}),
  };
  const fetchMock = installFetch(routes);
  const s = spies();
  render(<Host View={AgentsView} data={makeData()} extra={{ toast: s.toast }} />);
  return { fetchMock, spies: s };
}

const postBody = (fetchMock) => {
  const post = fetchMock.mock.calls.find(([, init]) => init && init.method === 'POST');
  return post ? JSON.parse(post[1].body) : null;
};

async function pickProvider(text) {
  fireEvent.click(await screen.findByRole('button', { name: /Choose a provider|Custom endpoint|Anthropic|Azure|Ollama/ }));
  fireEvent.change(screen.getByPlaceholderText(/Search \d+ providers/), { target: { value: text } });
  fireEvent.click(screen.getByRole('option', { name: new RegExp('^' + text, 'i') }));
}

describe('AgentsView — the default provider for OpenCode', () => {
  it('shows only the provider picker until something is picked', async () => {
    mount();
    expect(await screen.findByRole('button', { name: /Choose a provider/ })).toBeTruthy();
    expect(screen.queryByText('API key')).toBeNull();
    expect(screen.queryByRole('button', { name: /Enable default provider/ })).toBeNull();
    expect(screen.getByText('Not configured')).toBeTruthy();
  });

  it('searches the catalogue in a popover and lists the admin’s own options first', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Choose a provider/ }));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options[0]).toMatch(/Custom endpoint/);
    expect(options[1]).toMatch(/Ollama/);
    fireEvent.change(screen.getByPlaceholderText(/Search 4 providers/), { target: { value: 'azu' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: /Azure/ })).toBeTruthy();
    fireEvent.keyDown(screen.getByPlaceholderText(/Search 4 providers/), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('asks for a provider’s values by plain label, never by variable name', async () => {
    mount();
    await pickProvider('Azure');
    expect(screen.getByText('Resource name')).toBeTruthy();
    expect(screen.getByText('API key')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/AZURE_|_API_KEY|_RESOURCE_NAME/);
    // Google's several names are one key.
    await pickProvider('Google');
    expect(screen.getAllByText('API key')).toHaveLength(1);
    expect(screen.queryByText('Gemini API key')).toBeNull();
  });

  it('picks the model from the provider’s catalogue and sends everything with the save', async () => {
    const { fetchMock } = mount();
    await pickProvider('Azure');
    fireEvent.change(screen.getByPlaceholderText('resource name'), { target: { value: 'acme-eu' } });
    fireEvent.change(screen.getByPlaceholderText(/Paste the Azure api key/i), { target: { value: 'az-0123456789abcdef' } });
    fireEvent.click(await screen.findByRole('button', { name: /Choose a model/ }));
    fireEvent.click(await screen.findByRole('option', { name: /gpt-5/ }));
    fireEvent.click(screen.getByRole('button', { name: /Enable default provider/ }));
    await waitFor(() => expect(postBody(fetchMock)).toMatchObject({
      enabled: true, provider: 'azure', model: 'gpt-5', default_agent: true, restrict: false,
      values: { AZURE_RESOURCE_NAME: 'acme-eu', AZURE_API_KEY: 'az-0123456789abcdef' },
    }));
    expect(await screen.findByText(/last changed by boss@example.com/)).toBeTruthy();
  });

  it('shows a stored setting and says a secret is held, without ever rendering it', async () => {
    const { fetchMock } = mount(AZURE_SAVED);
    expect(await screen.findByDisplayValue('acme-eu')).toBeTruthy();
    expect(screen.getByText(/One ending in …cdef is stored\. Leave blank to keep it\./)).toBeTruthy();
    expect(screen.getByText('Enabled')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Turn off/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Remove/ })).toBeTruthy();
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('cdef');
    // Saving with the key left blank keeps it: nothing is sent for it.
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(() => expect(postBody(fetchMock).values).toEqual({ AZURE_RESOURCE_NAME: 'acme-eu' }));
  });

  it('keeps the URL override behind a switch', async () => {
    mount();
    await pickProvider('Anthropic');
    expect(screen.queryByPlaceholderText(/llm-proxy/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send requests to a URL of your own' }));
    expect(screen.getByPlaceholderText(/llm-proxy/)).toBeTruthy();
  });

  it('takes a server of your own with a URL, an optional key and a typed model', async () => {
    const { fetchMock } = mount();
    await pickProvider('Ollama');
    expect(screen.getByText('Server URL')).toBeTruthy();
    expect(screen.getByText(/Optional\. Leave empty if the server needs none\./)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/ollama\.internal/), { target: { value: 'http://ollama.internal:11434/v1' } });
    fireEvent.change(screen.getByPlaceholderText('qwen3:8b'), { target: { value: 'qwen3:8b' } });
    fireEvent.click(screen.getByRole('button', { name: /Enable default provider/ }));
    await waitFor(() => expect(postBody(fetchMock)).toMatchObject({ provider: 'ollama', model: 'qwen3:8b', base_url: 'http://ollama.internal:11434/v1', values: {} }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/models?'))).toBe(false);
  });

  it('describes a custom endpoint with its own models, the key optional', async () => {
    const { fetchMock } = mount();
    await pickProvider('Custom endpoint');
    fireEvent.change(screen.getByPlaceholderText('acme'), { target: { value: 'lab' } });
    fireEvent.change(screen.getByPlaceholderText('https://llm.acme.example/v1'), { target: { value: 'http://lab.internal:8000/v1' } });
    fireEvent.click(screen.getByRole('button', { name: /Add model/ }));
    fireEvent.change(screen.getByPlaceholderText(/model id, e\.g\./), { target: { value: 'llama' } });
    fireEvent.change(screen.getByDisplayValue('Choose a model…'), { target: { value: 'llama' } });
    fireEvent.click(screen.getByRole('button', { name: /Enable default provider/ }));
    await waitFor(() => expect(postBody(fetchMock)).toMatchObject({
      provider: 'lab', model: 'llama', base_url: 'http://lab.internal:8000/v1',
      custom: { package: 'openai-compatible', models: [{ id: 'llama', name: '' }] },
    }));
  });

  it('says so when the catalogue cannot be loaded, and still shows the saved provider', async () => {
    mount({ ...AZURE_SAVED, providers: [PROVIDERS[0]], catalog_error: 'models.dev unreachable' });
    expect(await screen.findByText(/catalogue could not be loaded/)).toBeTruthy();
    expect(screen.getByDisplayValue('acme-eu')).toBeTruthy();
    expect(screen.getByText('Resource name')).toBeTruthy();
  });

  it('forgets everything on Remove after a confirmation', async () => {
    const { fetchMock } = mount(AZURE_SAVED);
    await screen.findByDisplayValue('acme-eu');
    window.confirm = () => true;
    fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
    await waitFor(() => expect(postBody(fetchMock)).toEqual({ clear: true }));
    expect(await screen.findByText('Not configured')).toBeTruthy();
  });
});
