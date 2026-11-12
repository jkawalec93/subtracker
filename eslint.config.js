import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    ignores: ['dist', 'node_modules', 'drizzle', 'backups'],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  {
    // Enforce clean architecture: domain/ has zero dependencies on db/, server/, web/ or I/O libraries.
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'fs', message: 'domain/ must remain pure without filesystem I/O.' },
            { name: 'node:fs', message: 'domain/ must remain pure without filesystem I/O.' },
            { name: 'path', message: 'domain/ must remain pure without Node path I/O.' },
            { name: 'node:path', message: 'domain/ must remain pure without Node path I/O.' },
            { name: 'better-sqlite3', message: 'domain/ must not depend on database drivers.' },
            { name: 'drizzle-orm', message: 'domain/ must not depend on ORM.' },
            { name: 'hono', message: 'domain/ must not depend on HTTP server.' },
            { name: 'react', message: 'domain/ must not depend on UI framework.' },
            { name: 'react-dom', message: 'domain/ must not depend on UI framework.' },
          ],
          patterns: [
            {
              group: ['@db/*', '@server/*', '@web/*', '**/db/**', '**/server/**', '**/web/**'],
              message: 'domain/ cannot import from db/, server/, or web/.',
            },
          ],
        },
      ],
    },
  },
);

