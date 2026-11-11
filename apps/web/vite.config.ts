import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The release version is built into the page, so a running TV can notice that a newer release is live.
const version = readFileSync(join(import.meta.dirname, '../../VERSION'), 'utf8').trim();
// Beheer → Wijzigingen shows the changelog of this build.
const changelog = readFileSync(join(import.meta.dirname, '../../CHANGELOG.md'), 'utf8');

// The dev server mirrors the edge proxy (deploy/nginx): /api goes to the backend, /stream/ws to go2rtc's
// MSE WebSocket only. Override targets with UITKIJK_API_TARGET / UITKIJK_GO2RTC_TARGET.
const apiTarget = process.env.UITKIJK_API_TARGET ?? 'http://127.0.0.1:3000';
const go2rtcTarget = process.env.UITKIJK_GO2RTC_TARGET ?? 'http://127.0.0.1:1984';

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version), __CHANGELOG__: JSON.stringify(changelog) },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: apiTarget },
      '/stream/ws': {
        target: go2rtcTarget,
        ws: true,
        rewrite: (path) => path.replace(/^\/stream\/ws/, '/api/ws'),
      },
    },
  },
  test: {
    name: 'web',
    root: import.meta.dirname,
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
  },
});
