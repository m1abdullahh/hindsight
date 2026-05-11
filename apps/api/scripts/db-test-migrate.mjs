// Apply Prisma migrations to the test database.
//
// Reads TEST_DATABASE_URL from the environment (loaded by `node --env-file=.env`)
// and spawns `prisma migrate deploy` with DATABASE_URL set to that value.
// This works cross-platform — unlike `cross-env DATABASE_URL=$TEST_DATABASE_URL`,
// which doesn't perform shell-style variable expansion on Windows.

import { spawnSync } from 'node:child_process';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error('TEST_DATABASE_URL is not set. Add it to apps/api/.env (a Neon test-branch URL).');
  process.exit(1);
}

const result = spawnSync('prisma', ['migrate', 'deploy'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, DATABASE_URL: url },
});

process.exit(result.status ?? 1);
