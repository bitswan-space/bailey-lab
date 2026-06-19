import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Vitest harness for the Bailey Server Console.
//
// Coverage is scoped to src/console/** — the stage-2/3 console surface — via
// coverage.include. We force `all: true` so files with NO test exercising them
// still count as 0%, giving an honest statement baseline rather than only
// reporting on imported modules.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/unit/setup.js'],
    // Only our unit suite — keep Playwright's tests/views.spec.mjs out of it.
    include: ['tests/unit/**/*.{test,spec}.{js,jsx}'],
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/console/**/*.{js,jsx}'],
      reporter: ['text', 'text-summary', 'json-summary'],
      reportsDirectory: './coverage',
    },
  },
});
