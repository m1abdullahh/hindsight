import { redis } from '../lib/redis.js';

const WINDOW_S = 15 * 60;
const LIMIT = 5;
const LOCK_S = 15 * 60;
const UNKNOWN_IP = 'unknown';

// Compound (email, ip) so a teammate failing logins on their own IP cannot
// account-DoS another teammate by exhausting the per-email counter. The
// legitimate user can still log in from their own IP; only the attacking
// IP is locked. See 08-auth-and-permissions.md §"Password rules".
//
// `|` is used as a separator because base64url-encoded emails never produce
// it and IPv4/IPv6 addresses don't either; keeps keys grep-able in Redis.
const scope = (email: string, ip: string | undefined): string =>
  `${email}|${(ip ?? UNKNOWN_IP).toLowerCase()}`;

const failKey = (email: string, ip: string | undefined): string => `login:fail:${scope(email, ip)}`;
const lockKey = (email: string, ip: string | undefined): string => `login:lock:${scope(email, ip)}`;

export interface ThrottleStatus {
  locked: boolean;
  retryAfter?: number;
}

export const checkLogin = async (
  email: string,
  ip: string | undefined,
): Promise<ThrottleStatus> => {
  const ttl = await redis.ttl(lockKey(email, ip));
  if (ttl > 0) return { locked: true, retryAfter: ttl };
  return { locked: false };
};

export const recordFailure = async (email: string, ip: string | undefined): Promise<void> => {
  const k = failKey(email, ip);
  const count = await redis.incr(k);
  if (count === 1) await redis.expire(k, WINDOW_S);
  if (count >= LIMIT) {
    await redis.set(lockKey(email, ip), '1', 'EX', LOCK_S);
    await redis.del(k);
  }
};

// On success we know the caller actually has the password — clear every
// (email, *) counter and lock, not just the one matching this IP. Without
// this, a legitimate user who first fumbled their password on a flaky IP
// and then succeeded from a different one would still see the old IP
// locked even though their password is clearly known.
export const recordSuccess = async (email: string): Promise<void> => {
  const patterns = [`login:fail:${email}|*`, `login:lock:${email}|*`];
  for (const pattern of patterns) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  }
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
