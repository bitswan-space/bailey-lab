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
import '@xterm/xterm/css/xterm.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

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
