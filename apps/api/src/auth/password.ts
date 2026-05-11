import argon2 from 'argon2';

// Defaults targeting ~250ms hash on prod hardware. Run `pnpm --filter @hindsight/api tune:argon2`
// to verify or retune; numbers may be adjusted in scripts/tune-argon2.ts when prod hardware lands.
const PARAMS = {
  type: argon2.argon2id,
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 1,
} as const;

export const hashPassword = (plain: string): Promise<string> => argon2.hash(plain, PARAMS);

export const verifyPassword = async (hash: string, plain: string): Promise<boolean> => {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
};
