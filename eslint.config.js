// Flat ESLint config. We run two project-specific configs:
// - Browser/React rules for src/** (hooks exhaustive-deps is the big one).
// - Node rules for server/** and root build files.
// Prettier is appended last to disable stylistic rules that would fight it.

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettier from 'eslint-config-prettier'

export default [
  { ignores: ['dist', 'node_modules', 'coverage', 'fixtures'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // React / browser
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        fetch: 'readonly',
        EventSource: 'readonly',
        FormData: 'readonly',
        File: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        KeyboardEvent: 'readonly',
        MessageEvent: 'readonly',
        Event: 'readonly',
        Node: 'readonly',
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // react-refresh/only-export-components is noisy for small apps; keep
      // the default warn level but allow constants in the same file.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // The types.ts / defensive SDK shapes use many `any`-adjacent escapes;
      // prefer `unknown` but don't block on every occurrence.
      '@typescript-eslint/no-explicit-any': 'warn',
      // We frequently catch errors as `unknown` and cast once at the bar.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // Node (server + tests + build scripts)
  {
    files: ['server/**/*.ts', 'vitest.config.ts', 'vite.config.ts', 'build.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setImmediate: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  prettier,
]
