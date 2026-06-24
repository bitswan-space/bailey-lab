import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const VITE_HOST = process.env.VITE_HOST ?? 'localhost';
const VITE_PORT = Number(process.env.VITE_PORT ?? 5174);
const RAW_BACKEND = process.env.VITE_BACKEND_URL ?? 'http://localhost:8080';
const BACKEND_HTTP = RAW_BACKEND.replace(/^wss?:/, (m) => (m === 'wss:' ? 'https:' : 'http:'));
const VITE_ALLOWED_HOSTS = (process.env.VITE_ALLOWED_HOSTS ?? '.bswn.io')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

// The Server Console is a server-level admin surface served at bailey.<domain>.
// Its dev server is reached through the Bailey protected ingress (TLS on 443),
// so pin HMR to the public wss endpoint like the workspace dashboard does.
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    host: VITE_HOST,
    port: VITE_PORT,
    strictPort: true,
    allowedHosts: VITE_ALLOWED_HOSTS,
    hmr: {
      protocol: 'wss',
      clientPort: Number(process.env.VITE_HMR_CLIENT_PORT ?? 443),
    },
    proxy: {
      // The Bailey server-admin API (workspaces, people/roles, device
      // approvals, MFA) will be served by the automation-server daemon.
      '/api': { target: BACKEND_HTTP, changeOrigin: true },
    },
  },
});
