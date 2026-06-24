// harness.js — load every console module in dependency order so the
// window.SC_* globals they publish at import time are all registered, then
// re-export the registered components for the test files.
//
// Import order mirrors main.jsx: api → ui → data → views → scenes → app. Each
// module reads the globals published by earlier ones at import time, so the
// order matters.
import '../../src/console/api.js';
import '../../src/console/console-ui.jsx';
import '../../src/console/console-data.jsx';
import '../../src/console/views-workspaces.jsx';
import '../../src/console/views-people.jsx';
import '../../src/console/views-devices.jsx';
import '../../src/console/auth-scenes.jsx';
import '../../src/console/console-app.jsx';

export const SC_API = window.SC_API;
export const SC_UI = window.SC_UI;
export const SC_DATA = window.SC_DATA;
export const SC_WORKSPACES = window.SC_WORKSPACES;
export const SC_PEOPLE = window.SC_PEOPLE;
export const SC_DEVICES = window.SC_DEVICES;
export const SC_SCENES = window.SC_SCENES;
export const SC_APP = window.SC_APP;

// installFetch(routes) replaces global.fetch with a router. `routes` maps a
// path (or a {method,path} key matched loosely) to either a response spec or a
// function (url, init) => spec. A spec is { status?, json?, text?, ndjson?[] }.
// Returns the vitest mock so tests can assert on calls.
import { vi } from 'vitest';

function makeResponse(spec) {
  const status = spec.status ?? 200;
  const ok = status >= 200 && status < 300;
  let bodyText;
  if (spec.ndjson) {
    bodyText = spec.ndjson.map((o) => JSON.stringify(o)).join('\n') + '\n';
  } else if (spec.text != null) {
    bodyText = spec.text;
  } else if (spec.json !== undefined) {
    bodyText = JSON.stringify(spec.json);
  } else {
    bodyText = '';
  }
  const res = {
    ok, status, statusText: spec.statusText || (ok ? 'OK' : 'Error'),
    text: () => Promise.resolve(bodyText),
    json: () => Promise.resolve(JSON.parse(bodyText)),
  };
  if (spec.noBody) {
    res.body = null;
  } else if (spec.ndjson || spec.streamText != null) {
    // Build a single-chunk ReadableStream-like reader for postNDJSON.
    const chunk = new TextEncoder().encode(spec.ndjson ? bodyText : spec.streamText);
    let read = false;
    res.body = {
      getReader: () => ({
        read: () => Promise.resolve(read ? { done: true } : ((read = true), { value: chunk, done: false })),
      }),
    };
  } else {
    res.body = null;
  }
  return res;
}

export function installFetch(routes) {
  const fn = vi.fn((url, init) => {
    const method = (init && init.method) || 'GET';
    // exact path match, then path-only match, then method+path.
    let spec = routes[url] || routes[`${method} ${url}`];
    if (!spec) {
      // try matching by pathname (strip query) and decoded path.
      for (const key of Object.keys(routes)) {
        const k = key.replace(/^\w+ /, '');
        if (url === k || decodeURIComponent(url) === k) { spec = routes[key]; break; }
      }
    }
    if (typeof spec === 'function') spec = spec(url, init);
    if (!spec) spec = { status: 404, json: { error: `no route for ${method} ${url}` } };
    return Promise.resolve(makeResponse(spec));
  });
  global.fetch = fn;
  window.fetch = fn;
  return fn;
}
