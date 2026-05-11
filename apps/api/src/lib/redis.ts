import { Redis } from 'ioredis';

import { config } from '../config/env.js';

// `lazyConnect: true` defers the TCP connect until the first command,
// so importing this module doesn't dial Redis at startup. The server
// and worker entrypoints both eventually issue commands; tests that
// don't touch Redis-backed routes never connect.
export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});
