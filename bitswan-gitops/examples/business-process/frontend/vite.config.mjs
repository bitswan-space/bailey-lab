import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The Go shim owns the exposed :8080 and proxies UI requests here; vite runs
// on an internal port. allowedHosts still lists the public domain because the
// shim forwards the original Host.
//
// HMR runs over the Bailey protected ingress: the browser reaches this app on
// the inner host over TLS (443), so pin vite's HMR client to wss://<host>:443/
// rather than letting it guess the internal dev port. The shim and the Bailey
// gate both proxy the HMR websocket through to vite.
const gitopsDomain = process.env.BITSWAN_GITOPS_DOMAIN
// The workspace-internal DNS name of this container (set by the infra
// driver). Allowing it lets in-network clients — above all the coding
// agent's browser tooling — reach the dev server directly by hostname,
// without the public gate.
const internalHostname = process.env.BITSWAN_INTERNAL_HOSTNAME

export default defineConfig({
  plugins: [react()],
  cacheDir: '/tmp/.vite',
  server: {
    host: '127.0.0.1',
    port: Number(process.env.VITE_PORT || 5173),
    allowedHosts: [
      ...(gitopsDomain ? ['.' + gitopsDomain] : []),
      ...(internalHostname ? [internalHostname] : []),
    ],
    hmr: {
      protocol: 'wss',
      clientPort: Number(process.env.VITE_HMR_CLIENT_PORT ?? 443),
    },
  },
})
