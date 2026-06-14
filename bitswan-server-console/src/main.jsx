import React from 'react';
import { createRoot } from 'react-dom/client';
import { createIcons, icons } from 'lucide';

// Vendored fonts (no external CDN — Bailey's inner CSP forbids third-party
// origins, and Bailey must not leak to one). Inter for UI, Geist Mono for code.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';

import './styles/tokens.css';

// The console renders Lucide icons the UMD way the design was authored for:
// <i data-lucide="name"> placeholders that window.lucide.createIcons() swaps
// for inline SVGs. Provide that global from the bundled lucide package.
window.lucide = { createIcons: () => createIcons({ icons }) };

// Load the console modules in dependency order — each assigns its
// window.WD_SHELL / window.SC_* namespace as a side effect (mirrors the
// design's ordered <script> tags). console-app sets window.SC_APP.
import './shell.jsx';
import './console/api.js';
import './console/console-data.jsx';
import './console/console-ui.jsx';
import './console/views-workspaces.jsx';
import './console/views-people.jsx';
import './console/views-devices.jsx';
import './console/auth-scenes.jsx';
import './console/console-app.jsx';

createRoot(document.getElementById('root')).render(React.createElement(window.SC_APP));
