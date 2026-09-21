import { afterEach, expect, it, vi } from 'vitest';
import { getAutomationUrl, getBackendUrl } from './api';

// Tests for this automation's testable requirements.
//
// The binding is the test's NAME: it carries the requirement's id with hyphens
// turned into underscores, so REQ-SH1M is tested by test_REQ_SH1M_… . These run
// inside the frontend's own live-dev container (see [testing.frontend] in
// ../process.toml), which is why the frontend image ships vitest.

afterEach(() => {
  vi.unstubAllEnvs();
});

it('test_REQ_SH1M_backend_calls_go_through_the_shim', () => {
  // The backend is private: it is only reachable same-origin via the shim,
  // which strips /api and forwards. A change here silently breaks every
  // backend call in the browser, so it is worth pinning.
  expect(getBackendUrl()).toBe('/api/internal');
});

it('test_REQ_TMP7_automation_urls_come_from_the_workspace_template', () => {
  vi.stubEnv('VITE_BITSWAN_URL_TEMPLATE', 'https://ws-{name}-live-dev.example.com');
  expect(getAutomationUrl('backend')).toBe('https://ws-backend-live-dev.example.com');
});

it('test_REQ_TMP7_automation_urls_are_null_without_a_template', () => {
  vi.stubEnv('VITE_BITSWAN_URL_TEMPLATE', '');
  expect(getAutomationUrl('backend')).toBeNull();
});
