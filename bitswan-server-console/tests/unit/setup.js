// tests/unit/setup.js — global setup for the console Vitest suite.
//
// The console modules read shared primitives off window globals at import time
// (window.WD_SHELL from the workspace shell, window.SC_UI / SC_API / etc. that
// the console's own modules publish). jsdom gives us `window`; we provide a
// faithful WD_SHELL shell stub here — the real palette plus working
// Icon/Btn/Pill React components — so the console views render real DOM under
// jsdom and their statements actually execute under coverage (rather than
// short-circuiting on a null primitive).
import '@testing-library/react';
import React from 'react';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Tear down the DOM between tests so repeated renders don't collide.
afterEach(() => cleanup());

// Mirror of the real design-system palette (src/shell.jsx). Components read many
// of these keys; supplying the real values keeps inline-style branches honest.
const C = {
  bg: '#ffffff', fg: '#09090b', muted: '#71717a', mutedFg: '#a1a1aa',
  border: '#e4e4e7', borderHi: '#d4d4d8', surface: '#fafafa', surface2: '#f4f4f5',
  primary: '#093df5', primaryHi: '#0735d0', primarySoft: '#eef2ff',
  green: '#16a34a', greenSoft: '#dcfce7', red: '#dc2626', redSoft: '#fee2e2',
  amber: '#f59e0b', amberSoft: '#fef3c7', blueSoft: '#dbeafe',
};

function Icon({ name, size = 14, color, style }) {
  return React.createElement('i', {
    'data-lucide': name, 'data-icon': name,
    style: { width: size, height: size, color, display: 'inline-block', ...style },
  });
}

function useLucide() {
  React.useEffect(() => { if (window.lucide) window.lucide.createIcons(); });
}

function Pill({ tone = 'neutral', children, size = 'sm' }) {
  return React.createElement('span', { 'data-pill': tone, 'data-size': size }, children);
}

function Btn({ children, leftIcon, rightIcon, onClick, style, disabled, title, variant }) {
  return React.createElement(
    'button',
    { type: 'button', onClick, disabled, title, 'data-variant': variant, style },
    leftIcon ? React.createElement(Icon, { name: leftIcon, key: 'l' }) : null,
    children,
    rightIcon ? React.createElement(Icon, { name: rightIcon, key: 'r' }) : null,
  );
}

window.WD_SHELL = { C, Icon, Btn, Pill, useLucide };

// lucide.createIcons is invoked by useLucide + a setInterval in the app; make it
// a no-op so those calls don't throw under jsdom.
window.lucide = { createIcons: () => {} };

// navigator.clipboard for CopyChip.
if (!navigator.clipboard) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: () => Promise.resolve() },
    configurable: true,
  });
}
