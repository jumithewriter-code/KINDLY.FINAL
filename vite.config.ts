import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: {
    // The demo is inlined into one HTML file, so it must be a single chunk with
    // no code splitting and no separate source map.
    sourcemap: process.env.VITE_KINDLY_DEMO !== 'true',
    target: 'es2022',
    rollupOptions: process.env.VITE_KINDLY_DEMO === 'true'
      ? { output: { inlineDynamicImports: true, manualChunks: undefined } }
      : {},
  },
});
