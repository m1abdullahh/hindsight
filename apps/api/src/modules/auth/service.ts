import type { Prisma } from '@prisma/client';

import { writeAudit } from '../../auth/audit.js';
import { isPasswordPwned } from '../../auth/hibp.js';
import { checkLogin, recordFailure, recordSuccess } from '../../auth/login-throttle.js';
import { hashPassword, verifyPassword } from '../../auth/password.js';
import {
  findTokenByPlaintext,
  mintToken,
  revokeAllForUser,
  revokeToken,
} from '../../auth/tokens.js';
import { AppError } from '../../lib/errors.js';
import { ulid } from '../../lib/id.js';
import { logger } from '../../lib/logger.js';
import { sendMail } from '../../lib/mail.js';
import { prisma } from '../../lib/prisma.js';
import { sha256 } from '../../lib/sha256.js';
import {
  toMembershipDto,
  toOrgDto,
  toUserDto,
  type MembershipDto,
  type OrganizationDto,
  type UserDto,
} from '../../lib/dto.js';

import {
  emailVerifyRender,
  emailVerifySubject,
  passwordResetRender,
  passwordResetSubject,
} from './templates.js';
import type {
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  ResendVerificationInput,
  ResetPasswordInput,
  SignOutEverywhereInput,
  SignupInput,
  UpdateProfileInput,
  VerifyEmailInput,
} from './schemas.js';

interface CallerContext {
  ipAddress?: string;
  userAgent?: string;
}

export interface AuthSuccess {
  user: UserDto;
  organization?: OrganizationDto;
  memberships?: MembershipDto[];
  token: string;
  expiresAt: string | null;
}

const slugify = (input: string): string =>
  input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'org';

export async function signup(input: SignupInput, ctx: CallerContext = {}): Promise<AuthSuccess> {
  if (await isPasswordPwned(input.password)) {
    throw new AppError(
      'invalid_input',
      422,
      'this password appears in a known data breach — choose another',
    );
  }

  const passwordHash = await hashPassword(input.password);

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { email: input.email } });
    if (existing) {
      throw new AppError('conflict', 409, 'email already registered');
    }

    const user = await tx.user.create({
      data: {
        id: ulid(),
        email: input.email,
        passwordHash,
        name: input.name,
      },
    });

    const orgId = ulid();
    const slug = `${slugify(input.organizationName)}-${orgId.slice(-6).toLowerCase()}`;
    const organization = await tx.organization.create({
      data: { id: orgId, name: input.organizationName, slug },
    });

    await tx.membership.create({
      data: {
        id: ulid(),
        orgId: organization.id,
        userId: user.id,
        role: 'owner',
      },
    });

    await writeAudit(tx, {
      orgId: organization.id,
      actorId: user.id,
      action: 'org.created',
      targetType: 'organization',
      targetId: organization.id,
    });
    await writeAudit(tx, {
      orgId: organization.id,
      actorId: user.id,
      action: 'auth.signup',
      targetType: 'user',
      targetId: user.id,
    });

    return { user, organization };
  });

  const minted = await mintToken({
    userId: result.user.id,
    kind: 'web',
    ...(ctx.ipAddress ? { ipAddress: ctx.ipAddress } : {}),
    ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
  });

  return {
    user: toUserDto(result.user),
    organization: toOrgDto(result.organization),
    token: minted.plaintext,
    expiresAt: minted.expiresAt?.toISOString() ?? null,
  };
}

// Constant pre-baked argon2id hash so login on a non-existent user still
// performs a verification, keeping response time uniform.
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$ZHVtbXlzYWx0c2FsdHNhbHQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export async function login(input: LoginInput, ctx: CallerContext = {}): Promise<AuthSuccess> {
  const status = await checkLogin(input.email);
  if (status.locked) {
    throw new AppError('too_many_attempts', 429, 'too many failed login attempts', {
      retryAfter: status.retryAfter,
    });
  }

  const user = await prisma.user.findUnique({ where: { email: input.email } });

  const ok = user?.passwordHash
    ? await verifyPassword(user.passwordHash, input.password)
    : (await verifyPassword(DUMMY_HASH, input.password), false);

  if (!ok || !user) {
    await recordFailure(input.email);
    throw new AppError('unauthorized', 401, 'invalid credentials');
  }

  await recordSuccess(input.email);

  const memberships = await prisma.membership.findMany({
    where: { userId: user.id, status: 'active' },
    orderBy: { createdAt: 'asc' },
  });

  const minted = await mintToken({
    userId: user.id,
    kind: 'web',
    ...(ctx.ipAddress ? { ipAddress: ctx.ipAddress } : {}),
    ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
  });

  const primary = memberships[0];
  if (primary) {
    await prisma.$transaction((tx) =>
      writeAudit(tx, {
        orgId: primary.orgId,
        actorId: user.id,
        action: 'auth.login',
        targetType: 'user',
        targetId: user.id,
        metadata: { tokenId: minted.token.id } satisfies Prisma.JsonObject,
      }),
    );
  }

  return {
    user: toUserDto(user),
    memberships: memberships.map(toMembershipDto),
    token: minted.plaintext,
    expiresAt: minted.expiresAt?.toISOString() ?? null,
  };
}

export async function logout(tokenId: string, userId: string): Promise<void> {
  await revokeToken(tokenId);

  const membership = await prisma.membership.findFirst({
    where: { userId, status: 'active' },
    orderBy: { createdAt: 'asc' },
  });
  if (!membership) return;

  await prisma.$transaction((tx) =>
    writeAudit(tx, {
      orgId: membership.orgId,
      actorId: userId,
      action: 'auth.logout',
      targetType: 'user',
      targetId: userId,
      metadata: { tokenId } satisfies Prisma.JsonObject,
    }),
  );
}

export interface MeResult {
  user: UserDto;
  memberships: MembershipDto[];
}

export async function me(userId: string): Promise<MeResult> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError('unauthorized', 401, 'user not found');
  const memberships = await prisma.membership.findMany({
    where: { userId, status: 'active' },
    orderBy: { createdAt: 'asc' },
  });
  return { user: toUserDto(user), memberships: memberships.map(toMembershipDto) };
}

// ── Email verification ──────────────────────────────────────────────────────

const writeAuthAuditForUser = async (
  userId: string,
  action: Parameters<typeof writeAudit>[1]['action'],
  metadata?: Prisma.JsonObject,
): Promise<void> => {
  const membership = await prisma.membership.findFirst({
    where: { userId, status: 'active' },
    orderBy: { createdAt: 'asc' },
  });
  if (!membership) return;
  await prisma.$transaction((tx) =>
    writeAudit(tx, {
      orgId: membership.orgId,
      actorId: userId,
      action,
      targetType: 'user',
      targetId: userId,
      ...(metadata ? { metadata } : {}),
    }),
  );
};

export async function verifyEmail(input: VerifyEmailInput): Promise<{ verifiedAt: string }> {
  const token = await findTokenByPlaintext(input.token);
  if (
    !token ||
    token.kind !== 'email_verify' ||
    token.revokedAt ||
    (token.expiresAt && token.expiresAt < new Date())
  ) {
    throw new AppError('unauthorized', 401, 'invalid or expired token');
  }

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: token.userId } });
    if (!user) throw new AppError('unauthorized', 401, 'user not found');
    const verifiedAt = user.emailVerifiedAt ?? new Date();
    if (!user.emailVerifiedAt) {
      await tx.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: verifiedAt },
      });
    }
    await tx.token.update({
      where: { id: token.id },
      data: { revokedAt: new Date() },
    });
    return { user, verifiedAt };
  });

  await writeAuthAuditForUser(result.user.id, 'auth.email_verified');

  return { verifiedAt: result.verifiedAt.toISOString() };
}

export async function resendVerification(input: ResendVerificationInput): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  // Anti-enumeration: silent success if no match or already verified.
  if (!user || user.deletedAt || user.emailVerifiedAt) return;

  const minted = await mintToken({ userId: user.id, kind: 'email_verify' });
  const data = {
    name: user.name,
    token: minted.plaintext,
    expiresAt: minted.expiresAt!,
  };
  try {
    const tmpl = emailVerifyRender(data);
    await sendMail({
      to: user.email,
      subject: emailVerifySubject(data),
      html: tmpl.html,
      text: tmpl.text,
      tags: { kind: 'email_verify' },
    });
  } catch (err) {
    logger.warn({ err, userId: user.id }, 'resend verification mail failed');
  }
}

// ── Password reset ──────────────────────────────────────────────────────────

export async function forgotPassword(input: ForgotPasswordInput): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user || user.deletedAt) return; // silent success

  const minted = await mintToken({ userId: user.id, kind: 'password_reset' });

  await writeAuthAuditForUser(user.id, 'auth.password_reset_requested', {
    tokenId: minted.token.id,
  } satisfies Prisma.JsonObject);

  const data = {
    name: user.name,
    token: minted.plaintext,
    expiresAt: minted.expiresAt!,
  };
  try {
    const tmpl = passwordResetRender(data);
    await sendMail({
      to: user.email,
      subject: passwordResetSubject(data),
      html: tmpl.html,
      text: tmpl.text,
      tags: { kind: 'password_reset' },
    });
  } catch (err) {
    logger.warn({ err, userId: user.id }, 'password reset mail failed');
  }
}

export async function resetPassword(
  input: ResetPasswordInput,
  ctx: CallerContext = {},
): Promise<AuthSuccess> {
  const token = await findTokenByPlaintext(input.token);
  if (
    !token ||
    token.kind !== 'password_reset' ||
    token.revokedAt ||
    (token.expiresAt && token.expiresAt < new Date())
  ) {
    throw new AppError('unauthorized', 401, 'invalid or expired token');
  }

  if (await isPasswordPwned(input.password)) {
    throw new AppError(
      'invalid_input',
      422,
      'this password appears in a known data breach — choose another',
    );
  }

  const passwordHash = await hashPassword(input.password);

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: token.userId } });
    if (!user) throw new AppError('unauthorized', 401, 'user not found');

    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });

    // Single-use: revoke this reset token.
    await tx.token.update({
      where: { id: token.id },
      data: { revokedAt: new Date() },
    });

    // Sign-out-everywhere — reset is unauthenticated, so no token to keep.
    await tx.token.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return user;
  });

  await writeAuthAuditForUser(result.id, 'auth.password_changed');
  await writeAuthAuditForUser(result.id, 'auth.signed_out_everywhere');

  // Reset throttle so they can log in immediately after.
  await recordSuccess(result.email);

  const minted = await mintToken({
    userId: result.id,
    kind: 'web',
    ...(ctx.ipAddress ? { ipAddress: ctx.ipAddress } : {}),
    ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
  });

  return {
    user: toUserDto(result),
    token: minted.plaintext,
    expiresAt: minted.expiresAt?.toISOString() ?? null,
  };
}

// ── Password change (authenticated) ────────────────────────────────────────

export async function changePassword(
  userId: string,
  currentTokenId: string,
  input: ChangePasswordInput,
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError('unauthorized', 401, 'user not found');

  const ok = user.passwordHash
    ? await verifyPassword(user.passwordHash, input.currentPassword)
    : false;
  if (!ok) throw new AppError('unauthorized', 401, 'invalid credentials');

  if (await isPasswordPwned(input.newPassword)) {
    throw new AppError(
      'invalid_input',
      422,
      'this password appears in a known data breach — choose another',
    );
  }

  const newHash = await hashPassword(input.newPassword);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { passwordHash: newHash } });
    await tx.token.updateMany({
      where: { userId, revokedAt: null, id: { not: currentTokenId } },
      data: { revokedAt: new Date() },
    });
  });

  await writeAuthAuditForUser(userId, 'auth.password_changed');
  await writeAuthAuditForUser(userId, 'auth.signed_out_everywhere');
}

// ── Sign-out-everywhere ────────────────────────────────────────────────────

export async function signOutEverywhere(
  userId: string,
  currentTokenId: string,
  input: SignOutEverywhereInput,
): Promise<void> {
  await revokeAllForUser(userId, {
    ...(input.keepCurrent ? { excludeId: currentTokenId } : {}),
  });
  await writeAuthAuditForUser(userId, 'auth.signed_out_everywhere');
}

// ── Profile update ─────────────────────────────────────────────────────────

export async function updateProfile(userId: string, input: UpdateProfileInput): Promise<MeResult> {
  const fields: string[] = [];
  if (input.name !== undefined) fields.push('name');

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
    },
  });

  await writeAuthAuditForUser(userId, 'auth.profile_updated', {
    fields,
  } satisfies Prisma.JsonObject);

  const memberships = await prisma.membership.findMany({
    where: { userId, status: 'active' },
    orderBy: { createdAt: 'asc' },
  });
  return { user: toUserDto(user), memberships: memberships.map(toMembershipDto) };
}

// Re-exported so test helpers can compute hashes if needed.
export { sha256 };
