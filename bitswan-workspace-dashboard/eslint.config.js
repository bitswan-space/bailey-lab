import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsdoc from 'eslint-plugin-jsdoc';
import globals from 'globals';

// Code-quality "hint" rules — emitted as warnings so they show up during
// development without breaking the lint script. The intent is to surface
// patterns that tend to silently degrade type safety, hide dead code, or skip
// documentation. Every rule is suppressible with `eslint-disable-next-line`
// when the pattern is genuinely the right answer at that location.
const qualityWarnings = {
  'no-restricted-syntax': [
    'warn',
    {
      // `as X` casts erase type-checker guarantees. Allowed: `as const`.
      selector: "TSAsExpression:not([typeAnnotation.type='TSTypeReference'][typeAnnotation.typeName.name='const'])",
      message:
        'Avoid `as` type assertions — prefer a runtime check or type guard. Disable per-line at intentional JSON / DOM-event boundaries.',
    },
    {
      // `unknown` in a *type position*. Acceptable in narrow boundary cases
      // (heterogeneous SSE event payloads); suppress per-line there.
      selector: 'TSUnknownKeyword',
      message:
        'Avoid `unknown` — model the actual shape, or narrow at the boundary. Suppress per-line for genuine heterogeneous payloads.',
    },
    {
      // `foo!.bar` non-null assertions: same risk as `as`, no runtime check.
      selector: 'TSNonNullExpression',
      message:
        'Avoid the `!` non-null assertion — prefer an explicit check, optional chaining, or default.',
    },
    {
      // `null` in a type position: prefer optional (`?:`) or a discriminated
      // union over explicit `| null`. We mirror gitops snake_case wire types
      // that legitimately use `null`; suppress per-line there.
      selector: 'TSNullKeyword',
      message:
        'Avoid `null` in type positions — prefer optional members (`?:`) or an explicit discriminated state. Suppress per-line on wire-mirroring types.',
    },
    {
      // `undefined` in a type position: same rationale as `null`.
      selector: 'TSUndefinedKeyword',
      message:
        'Avoid `undefined` in type positions — prefer optional members (`?:`) or a default. Suppress per-line where it is intentional.',
    },
  ],

  // Dead-code hints.
  '@typescript-eslint/no-unused-vars': [
    'warn',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
  ],
  '@typescript-eslint/no-unused-expressions': 'warn',
  '@typescript-eslint/no-empty-function': 'warn',
  'no-unused-private-class-members': 'warn',
  'no-useless-return': 'warn',
  'no-useless-rename': 'warn',
  'no-lonely-if': 'warn',

  '@typescript-eslint/no-explicit-any': 'warn',
};

// JSDoc hints — only "is there a JSDoc?" on *exported* declarations. We
// deliberately skip the rest of `jsdoc/recommended` (which would also require
// every `@param` / `@returns` tag) because that produces high-noise warnings
// against well-named, self-documenting code.
const jsdocWarnings = {
  'jsdoc/require-jsdoc': [
    'warn',
    {
      publicOnly: true,
      require: {
        FunctionDeclaration: true,
        MethodDefinition: true,
        ClassDeclaration: true,
        ArrowFunctionExpression: false,
        FunctionExpression: false,
      },
      checkConstructors: false,
      checkGetters: false,
      checkSetters: false,
    },
  ],
};

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

  // Register the JSDoc plugin without enabling its noisy recommended set;
  // see `jsdocWarnings` above for the single rule we opt into.
  { plugins: { jsdoc } },

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
      ...qualityWarnings,
      ...jsdocWarnings,
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
      ...qualityWarnings,
      ...jsdocWarnings,
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

  // React components (.tsx) — well-named JSX functions; require-jsdoc would
  // add busywork without much signal. The other code-quality warnings still
  // apply.
  {
    files: ['**/*.tsx'],
    rules: { 'jsdoc/require-jsdoc': 'off' },
  },

  // shadcn/ui files are vendored verbatim — exempt from style/doc warnings.
  {
    files: ['client/src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': 'off',
      'jsdoc/require-jsdoc': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
);
