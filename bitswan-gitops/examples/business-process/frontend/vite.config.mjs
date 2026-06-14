import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The Go shim owns the exposed :8080 and proxies UI requests here; vite runs
// on an internal port. allowedHosts still lists the public domain because the
// shim forwards the original Host.
//
// HMR is disabled: its websocket can't reliably traverse the Bailey ingress
// chain (browser → oauth2-proxy → gate → shim → vite), which left the vite
// client in a "connection lost, polling for restart" reload loop. With HMR
// off the app loads cleanly over HTTP; edit + manual refresh to see changes.
// (Re-enabling live HMR needs the ingress chain to proxy the HMR websocket.)
const gitopsDomain = process.env.BITSWAN_GITOPS_DOMAIN

export default defineConfig({
  plugins: [react()],
  cacheDir: '/tmp/.vite',
  server: {
    host: '127.0.0.1',
    port: Number(process.env.VITE_PORT || 5173),
    allowedHosts: gitopsDomain ? ['.' + gitopsDomain] : [],
    hmr: false,
  },
})
