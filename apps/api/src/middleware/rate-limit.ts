import { rateLimit as expressRateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';

import { redis } from '../lib/redis.js';

// Generous global safety net. Per-endpoint limits (auth: 10/min/IP,
// presign: 30/min/device, etc — see docs/05-api-surface.md) attach
// to specific routes inside their modules.
export const rateLimit: RateLimitRequestHandler = expressRateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: new RedisStore({
    sendCommand: (command: string, ...args: string[]) =>
      redis.call(command, ...args) as Promise<RedisReply>,
    prefix: 'rl:global:',
  }),
});
