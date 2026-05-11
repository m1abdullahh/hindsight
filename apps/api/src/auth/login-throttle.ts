import { redis } from '../lib/redis.js';

const WINDOW_S = 15 * 60;
const LIMIT = 5;
const LOCK_S = 15 * 60;

const failKey = (email: string): string => `login:fail:${email}`;
const lockKey = (email: string): string => `login:lock:${email}`;

export interface ThrottleStatus {
  locked: boolean;
  retryAfter?: number;
}

export const checkLogin = async (email: string): Promise<ThrottleStatus> => {
  const ttl = await redis.ttl(lockKey(email));
  if (ttl > 0) return { locked: true, retryAfter: ttl };
  return { locked: false };
};

export const recordFailure = async (email: string): Promise<void> => {
  const k = failKey(email);
  const count = await redis.incr(k);
  if (count === 1) await redis.expire(k, WINDOW_S);
  if (count >= LIMIT) {
    await redis.set(lockKey(email), '1', 'EX', LOCK_S);
    await redis.del(k);
  }
};

export const recordSuccess = async (email: string): Promise<void> => {
  await Promise.all([redis.del(failKey(email)), redis.del(lockKey(email))]);
};

/** Test helper — clear all login-throttle keys for the suite. */
export const flushLoginThrottleKeys = async (): Promise<void> => {
  const patterns = ['login:fail:*', 'login:lock:*'];
  for (const pattern of patterns) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  }
};
