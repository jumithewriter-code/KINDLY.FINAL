import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * Unit, integration and accessibility tests run against the in-process backend,
 * never a live Supabase project, so CI stays deterministic and offline.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', '_conflicting-next-scaffold/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/test/**', 'src/**/*.test.{ts,tsx}', 'src/lib/database.types.ts'],
    },
  },
});
