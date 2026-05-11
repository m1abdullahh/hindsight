import { createHash } from 'node:crypto';

import { config } from '../config/env.js';
import { logger } from '../lib/logger.js';

const HIBP_TIMEOUT_MS = 1500;
const HIBP_URL = 'https://api.pwnedpasswords.com/range/';

/**
 * k-anonymity check: send first 5 hex chars of SHA-1(password) to HIBP, look
 * for the suffix in the response. Returns true if the password appears in a
 * known breach. Fails open on network/provider errors.
 *
 * In NODE_ENV=test we short-circuit to a deterministic local check. Hitting
 * HIBP from CI would (a) be flaky on the network, (b) be slow, and (c) make
 * test fixtures depend on whether common passwords have been re-breached. The
 * local check still rejects the obvious HIBP-famous strings so the tests that
 * verify our 422 path keep working.
 */
export const isPasswordPwned = async (plaintext: string): Promise<boolean> => {
  if (config.NODE_ENV === 'test') {
    return TEST_PWNED_LIST.has(plaintext);
  }
  const sha1 = createHash('sha1').update(plaintext).digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HIBP_TIMEOUT_MS);

  try {
    const res = await fetch(`${HIBP_URL}${prefix}`, {
      headers: { 'Add-Padding': 'true' },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'hibp request returned non-2xx; failing open');
      return false;
    }
    const text = await res.text();
    for (const line of text.split('\n')) {
      const [hashSuffix] = line.split(':');
      if (hashSuffix?.trim() === suffix) return true;
    }
    return false;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'hibp request failed; failing open');
    return false;
  } finally {
    clearTimeout(timer);
  }
};

// Used only when NODE_ENV=test. Includes obviously-pwned strings tests use to
// exercise the 422 path. Keep the test fixture password
// ("correct horse battery staple") out of this list — many existing tests rely
// on it being acceptable.
const TEST_PWNED_LIST = new Set<string>([
  'password',
  'password1',
  'password123',
  'password1234',
  '123456789012',
  'qwerty123456',
  'letmein12345',
  'iloveyou1234',
  'welcome12345',
]);
