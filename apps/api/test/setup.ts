// Sets default env vars before any test module loads `config/env.ts`.
// Vitest runs setupFiles before importing test files, so process.env is
// populated by the time Zod parses it.
//
// Integration tests need TEST_DATABASE_URL pointed at a dedicated Neon branch
// (so truncateAll() can't wipe your dev branch). REDIS_URL should point at the
// same Upstash database used in dev — tests don't share keys with the API at
// runtime because each test boots a fresh app.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Vitest does not auto-load .env. Parse apps/api/.env into process.env so
// DATABASE_URL / REDIS_URL / TEST_DATABASE_URL exist before config/env.ts runs.
try {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, '..', '.env');
  const text = readFileSync(envPath, 'utf-8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
} catch {
  // .env optional; CI may inject TEST_DATABASE_URL via real env vars.
}

process.env['NODE_ENV'] = 'test';
if (process.env['TEST_DATABASE_URL']) {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'];
}
process.env['PUBLIC_API_URL'] ??= 'http://localhost:3001';
process.env['WEB_ORIGIN'] ??= 'http://localhost:5173';
// Force the mail stub provider in tests so we never call Resend.
process.env['MAIL_PROVIDER_API_KEY'] = 'test-stub';

// Install the R2 stub so screenshot tests don't hit Cloudflare.
const { installR2Stub } = await import('./helpers/r2-stub.js');
installR2Stub();
