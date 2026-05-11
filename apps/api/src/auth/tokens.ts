import { randomBytes } from 'node:crypto';

import type { Token, TokenKind } from '@prisma/client';

import { AppError } from '../lib/errors.js';
import { ulid } from '../lib/id.js';
import { prisma } from '../lib/prisma.js';
import { sha256 } from '../lib/sha256.js';

const WEB_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const SLIDE_DEBOUNCE_MS = 5 * 60 * 1000;

const ttlForKind = (kind: TokenKind): number | null => {
  switch (kind) {
    case 'web':
      return WEB_TTL_MS;
    case 'password_reset':
      return PASSWORD_RESET_TTL_MS;
    case 'email_verify':
      return EMAIL_VERIFY_TTL_MS;
    case 'device':
      return null;
  }
};

const generatePlaintext = (): string => randomBytes(32).toString('base64url');

export interface MintOptions {
  userId: string;
  kind: TokenKind;
  deviceId?: string;
  userAgent?: string;
  ipAddress?: string;
}

export interface MintedToken {
  plaintext: string;
  token: Token;
  expiresAt: Date | null;
}

export async function mintToken(opts: MintOptions): Promise<MintedToken> {
  const plaintext = generatePlaintext();
  const tokenHash = sha256(plaintext);
  const now = new Date();
  const ttl = ttlForKind(opts.kind);
  const expiresAt = ttl !== null ? new Date(now.getTime() + ttl) : null;

  const token = await prisma.token.create({
    data: {
      id: ulid(),
      userId: opts.userId,
      kind: opts.kind,
      tokenHash,
      deviceId: opts.deviceId ?? null,
      expiresAt,
      userAgent: opts.userAgent ?? null,
      ipAddress: opts.ipAddress ?? null,
    },
  });

  return { plaintext, token, expiresAt };
}

export interface VerifiedToken {
  token: Token;
  sliding: boolean;
}

export async function verifyAndSlide(presented: string): Promise<VerifiedToken> {
  const tokenHash = sha256(presented);
  const token = await prisma.token.findUnique({ where: { tokenHash } });

  if (!token) throw new AppError('unauthorized', 401, 'invalid token');
  if (token.revokedAt) throw new AppError('unauthorized', 401, 'token revoked');
  if (token.expiresAt && token.expiresAt < new Date()) {
    throw new AppError('unauthorized', 401, 'token expired');
  }

  const stale = !token.lastUsedAt || token.lastUsedAt.getTime() < Date.now() - SLIDE_DEBOUNCE_MS;
  if (!stale) return { token, sliding: false };

  const updated = await prisma.token.update({
    where: { id: token.id },
    data: {
      lastUsedAt: new Date(),
      ...(token.kind === 'web' ? { expiresAt: new Date(Date.now() + WEB_TTL_MS) } : {}),
    },
  });
  return { token: updated, sliding: true };
}

export const revokeToken = (id: string): Promise<Token> =>
  prisma.token.update({ where: { id }, data: { revokedAt: new Date() } });

export interface RevokeAllForUserOptions {
  kind?: TokenKind;
  excludeId?: string;
}

export const revokeAllForUser = (
  userId: string,
  options: RevokeAllForUserOptions = {},
): Promise<unknown> =>
  prisma.token.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(options.kind ? { kind: options.kind } : {}),
      ...(options.excludeId ? { id: { not: options.excludeId } } : {}),
    },
    data: { revokedAt: new Date() },
  });

/** Look up a token by plaintext for one-shot consumption (verify-email, reset). */
export const findTokenByPlaintext = (presented: string): Promise<Token | null> =>
  prisma.token.findUnique({ where: { tokenHash: sha256(presented) } });
