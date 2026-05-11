/// <reference types="vitest" />
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const apiBaseUrl = process.env['VITE_API_BASE_URL'] ?? 'http://localhost:3001';
// Web app URL used by the "Open web admin →" link in the Team tab footer.
// Defaults to the local Vite dev server; production builds should set
// VITE_WEB_BASE_URL to the deployed web app's origin.
const webBaseUrl = process.env['VITE_WEB_BASE_URL'] ?? 'http://localhost:5173';
const appVersion = process.env['npm_package_version'] ?? '0.1.0';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@hindsight/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
      '@hindsight/shared/dto': fileURLToPath(
        new URL('../../packages/shared/src/dto.ts', import.meta.url),
      ),
    },
  },
  define: {
    __API_BASE_URL__: JSON.stringify(apiBaseUrl),
    __WEB_BASE_URL__: JSON.stringify(webBaseUrl),
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
