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
