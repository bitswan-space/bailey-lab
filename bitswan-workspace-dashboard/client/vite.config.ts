import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VITE_HOST = process.env.VITE_HOST ?? 'localhost';
const VITE_PORT = Number(process.env.VITE_PORT ?? 5173);
// Accept ws:// or http:// here; we proxy both HTTP and WS upgrades to the same host.
const RAW_BACKEND = process.env.VITE_BACKEND_URL ?? 'http://localhost:8080';
const BACKEND_HTTP = RAW_BACKEND.replace(/^wss?:/, (m) => (m === 'wss:' ? 'https:' : 'http:'));
// Extra hostnames the dev server may be reached through (comma-separated).
// A leading dot allows the domain and all subdomains, e.g. *.bswn.io sandbox proxies.
const VITE_ALLOWED_HOSTS = (process.env.VITE_ALLOWED_HOSTS ?? '.bswn.io')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react()],
  base: '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: VITE_HOST,
    port: VITE_PORT,
    strictPort: true,
    allowedHosts: VITE_ALLOWED_HOSTS,
    // HMR through the Bailey protected ingress: the browser loads this app on
    // the inner host over TLS (443), so pin vite's HMR client to the public
    // wss endpoint (wss://<inner-host>:443/) rather than letting it guess the
    // dev-server port. The Bailey gate upgrades that websocket and routes it
    // to this dev server.
    hmr: {
      protocol: 'wss',
      clientPort: Number(process.env.VITE_HMR_CLIENT_PORT ?? 443),
    },
    proxy: {
      // WebSocket terminal — Vite handles the http→ws upgrade with ws:true.
      '/ws': {
        target: BACKEND_HTTP,
        ws: true,
      },
      // JSON + SSE endpoints served by Fastify.
      '/api': {
        target: BACKEND_HTTP,
        changeOrigin: true,
      },
      // OAuth popup completion page (Fastify route).
      '/_login_done': {
        target: BACKEND_HTTP,
        changeOrigin: true,
      },
    },
  },
});
