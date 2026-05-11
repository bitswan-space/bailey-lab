import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  // Files we never want to lint.
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.vite/**',
      'workspace-demo/**',
      'client/dist/**',
      'server/dist/**',
    ],
  },

  // Baseline JS recommended rules.
  js.configs.recommended,

  // Baseline TS recommended rules (typescript-eslint applies these to .ts/.tsx).
  ...tseslint.configs.recommended,

  // Config files at repo root run in Node (ESM).
  {
    files: ['*.{js,cjs,mjs}', 'eslint.config.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // Server: Node runtime, TypeScript ESM.
  {
    files: ['server/**/*.{ts,tsx}'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2022,
      globals: { ...globals.node },
    },
    rules: {
      // The server file uses `import.meta` and Node 20 APIs liberally — those
      // are fine and shouldn't be flagged.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Client: browser runtime + React + JSX.
  {
    files: ['client/**/*.{ts,tsx}'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2022,
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // Modern JSX transform — no need to import React just to use JSX.
      'react/react-in-jsx-scope': 'off',
      // TypeScript handles prop validation.
      'react/prop-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Config files in the client (Vite / Tailwind / PostCSS) run in Node.
  {
    files: ['client/{vite,tailwind,postcss}.config.{js,ts}'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
);
