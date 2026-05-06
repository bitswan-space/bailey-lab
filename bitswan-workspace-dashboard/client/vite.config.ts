import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VITE_HOST = process.env.VITE_HOST ?? 'localhost';
const VITE_PORT = Number(process.env.VITE_PORT ?? 5173);
const VITE_BACKEND_URL = process.env.VITE_BACKEND_URL ?? 'ws://localhost:8080';

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
      '/ws': {
        target: VITE_BACKEND_URL,
        ws: true,
      },
    },
  },
});
