import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// Self-hosted fonts (vendored): the app runs behind the Bailey protected
// ingress whose strict CSP forbids external origins, and Bailey must not leak
// to a third-party CDN — so Roboto / Roboto Mono are bundled locally instead
// of loaded from fonts.googleapis.com. (Roboto has no 600 weight; 500/700
// cover the design.)
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';
import '@fontsource/roboto-mono/400.css';
import '@fontsource/roboto-mono/500.css';
import './styles.css';

/**
 * Whether this document is the dashboard loaded inside the dashboard.
 *
 * The OpenCode panel is an iframe on this same origin, and OpenCode's home
 * route is `/` — which here is this app. A frame that navigates there must
 * not boot a second dashboard inside the first. Same-origin is the test, not
 * "am I framed at all": AOC embeds the dashboard from another origin on
 * purpose, and reading a cross-origin parent's location throws, which reads
 * as "not nested in myself".
 */
function nestedInSelf(): boolean {
  if (window.parent === window) return false;
  try {
    return window.parent.location.origin === window.location.origin;
  } catch {
    return false;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

if (nestedInSelf()) {
  // The parent's OpenCode panel listens for this and points the frame back at
  // the conversation it was showing.
  window.parent.postMessage({ type: 'bitswan-nested-dashboard' }, window.location.origin);
} else {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  // Tell the embedding parent (e.g. AOC) that the dashboard SPA bundle has booted.
  // Used by the parent to distinguish "iframe rendered our app" from "iframe rendered
  // a browser-native connection-refused page" or other failure modes.
  if (window.parent !== window) {
    try {
      window.parent.postMessage('dashboard-ready', '*');
    } catch {
      // ignore — parent may be cross-origin with restrictive policies
    }
  }
}
