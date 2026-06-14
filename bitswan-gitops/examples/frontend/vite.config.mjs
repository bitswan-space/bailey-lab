import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The Go shim owns the exposed :8080 and proxies UI requests here. vite runs
// on an internal port; allowedHosts still lists the public domain because the
// shim forwards the original Host. HMR is told to use wss on the public 443
// (through Bailey) so hot reload survives the proxy chain.
const gitopsDomain = process.env.BITSWAN_GITOPS_DOMAIN

export default defineConfig({
  plugins: [react()],
  cacheDir: '/tmp/.vite',
  server: {
    host: '127.0.0.1',
    port: Number(process.env.VITE_PORT || 5173),
    allowedHosts: gitopsDomain ? ['.' + gitopsDomain] : [],
    hmr: { clientPort: 443, protocol: 'wss' },
  },
})
