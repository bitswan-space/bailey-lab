import crypto from 'node:crypto';

/**
 * Per-panel tab state for OpenCode's web UI.
 *
 * OpenCode keeps its open-tab strip in "window-scoped" storage. The desktop
 * app gives every window its own id, so every window has its own tabs; the
 * web build uses the fixed id `browser`, so every frame on one origin shares
 * one tab list under the localStorage prefix `opencode.window.browser.dat:`.
 * The dashboard mounts one OpenCode panel per business process, all on its
 * own origin, and each panel therefore showed the tabs the others had opened.
 *
 * The fix makes each panel its own "window": the dashboard serves OpenCode's
 * HTML itself for page routes and injects this shim ahead of OpenCode's
 * scripts. The shim reads the panel's scope from `window.name` (the iframe's
 * `name`, set by the panel) and shadows `window.localStorage` with a wrapper
 * that rewrites only the window-scoped keys to a per-scope prefix. Global
 * state — theme, settings, the server list, the last-used project — keeps its
 * keys and stays shared, exactly as it is shared between desktop windows.
 *
 * Coupled to 2.0.16's storage naming; `docs/opencode-integration.md` says
 * what to re-check on a bump.
 */

/** The `name` an OpenCode panel iframe carries: this prefix plus its scope. */
export const PANEL_NAME_PREFIX = 'bitswan-opencode:';

/** The localStorage prefix OpenCode's web build uses for window-scoped state. */
export const WINDOW_STORAGE_PREFIX = 'opencode.window.browser.dat:';

/** The panel's scope from an iframe name, or undefined when it is not a panel. */
export function panelScopeFromName(name: string): string | undefined {
  if (!name.startsWith(PANEL_NAME_PREFIX)) return undefined;
  const scope = name.slice(PANEL_NAME_PREFIX.length);
  return scope || undefined;
}

/** Where a window-scoped key of `scope` lands in the shared localStorage. */
export function scopedStorageKey(key: string, scope: string): string {
  if (!key.startsWith(WINDOW_STORAGE_PREFIX)) return key;
  return `opencode.window.${scope}.dat:${key.slice(WINDOW_STORAGE_PREFIX.length)}`;
}

/**
 * The shim, as inline JavaScript. Kept to ES5 and free of `</script>` so it
 * can be inlined verbatim; the logic mirrors `scopedStorageKey`.
 */
export const STORAGE_SHIM_SOURCE = `(function () {
  var NAME_PREFIX = ${JSON.stringify(PANEL_NAME_PREFIX)};
  var WINDOW_PREFIX = ${JSON.stringify(WINDOW_STORAGE_PREFIX)};
  var name = '';
  try { name = String(window.name || ''); } catch (e) { return; }
  if (name.indexOf(NAME_PREFIX) !== 0) return;
  var scope = name.slice(NAME_PREFIX.length);
  if (!scope) return;
  var mapped = 'opencode.window.' + scope + '.dat:';
  var real;
  try { real = window.localStorage; } catch (e) { return; }
  if (!real) return;
  function map(key) {
    key = String(key);
    return key.indexOf(WINDOW_PREFIX) === 0 ? mapped + key.slice(WINDOW_PREFIX.length) : key;
  }
  function unmap(key) {
    return key.indexOf(mapped) === 0 ? WINDOW_PREFIX + key.slice(mapped.length) : key;
  }
  var proxy = {
    getItem: function (key) { return real.getItem(map(key)); },
    setItem: function (key, value) { real.setItem(map(key), value); },
    removeItem: function (key) { real.removeItem(map(key)); },
    clear: function () { real.clear(); },
    key: function (index) { var k = real.key(index); return k === null ? null : unmap(k); }
  };
  Object.defineProperty(proxy, 'length', { get: function () { return real.length; } });
  try {
    Object.defineProperty(window, 'localStorage', {
      configurable: true, enumerable: true, get: function () { return proxy; }
    });
  } catch (e) { /* the shared storage stays in place */ }
})();`;

/** base64 SHA-256 of the shim, for a CSP `script-src` allowance. */
export function storageShimHash(): string {
  return crypto.createHash('sha256').update(STORAGE_SHIM_SOURCE, 'utf8').digest('base64');
}

const SHIM_TAG = `<script id="bitswan-opencode-storage-shim">${STORAGE_SHIM_SOURCE}</script>`;

/**
 * OpenCode's HTML with the shim as the first thing in `<head>`, so it runs
 * before OpenCode's own inline theme script and its module bundle. HTML with
 * no `<head>` gets it prepended.
 */
export function injectStorageShim(html: string): string {
  if (html.includes('id="bitswan-opencode-storage-shim"')) return html;
  const at = html.search(/<head[^>]*>/i);
  if (at === -1) return SHIM_TAG + html;
  const end = html.indexOf('>', at) + 1;
  return html.slice(0, end) + SHIM_TAG + html.slice(end);
}

/**
 * OpenCode's own CSP allows its inline theme script by hash; the injected
 * shim needs the same allowance, or it is blocked wherever that header is
 * honoured as-is (the Bailey gate replaces it on inner hosts, a plain
 * deployment does not). Adds the hash to `script-src`; a policy without one
 * is returned unchanged.
 */
export function cspAllowingShim(csp: string): string {
  const allowance = `'sha256-${storageShimHash()}'`;
  if (csp.includes(allowance)) return csp;
  return csp.replace(/(^|;)(\s*script-src\b[^;]*)/i, (whole, sep: string, directive: string) =>
    `${sep}${directive} ${allowance}`,
  );
}
