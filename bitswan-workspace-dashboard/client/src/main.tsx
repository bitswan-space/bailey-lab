import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
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
