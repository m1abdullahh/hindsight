import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { config } from '../config/env.js';

const adapter = new PrismaPg({ connectionString: config.DATABASE_URL });

// Defaults bumped to survive Neon serverless cold starts. The compute can
// take 5–15s to wake up; the default 5s transaction timeout plus 2s maxWait
// fires P2028 ("Transaction not found ... was obtained before disconnecting")
// when a transaction's first query is the one that wakes the pool.
// Per-call options on $transaction() still override these.
export const prisma = new PrismaClient({
  adapter,
  log: ['warn', 'error'],
  transactionOptions: {
    maxWait: 10_000,
    timeout: 30_000,
  },
});
