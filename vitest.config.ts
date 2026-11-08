import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'shared',
          root: './packages/shared',
          include: ['test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'server',
          root: './apps/server',
          include: ['test/**/*.test.ts'],
          environment: 'node',
        },
      },
      './apps/web/vite.config.ts',
    ],
  },
});
