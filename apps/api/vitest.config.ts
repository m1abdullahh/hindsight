import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    pool: 'forks',
    // Integration tests share one database (a Neon test branch). Running
    // files in parallel makes them race on truncateAll() and DB writes.
    // Serialize file execution; tests inside a file already run sequentially.
    fileParallelism: false,
    setupFiles: ['./test/setup.ts'],
    testTimeout: 30_000,
  },
});
