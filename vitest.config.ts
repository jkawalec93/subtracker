import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@domain': path.resolve(import.meta.dirname, './src/domain'),
      '@db': path.resolve(import.meta.dirname, './src/db'),
      '@server': path.resolve(import.meta.dirname, './src/server'),
      '@web': path.resolve(import.meta.dirname, './src/web'),
    },
  },
});

