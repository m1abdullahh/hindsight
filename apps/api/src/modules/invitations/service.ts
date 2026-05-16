import { randomBytes } from 'node:crypto';

import { Prisma, type Membership } from '@prisma/client';

import { writeAudit } from '../../auth/audit.js';
import { can } from '../../auth/capabilities.js';
import { isPasswordPwned } from '../../auth/hibp.js';
import { hashPassword } from '../../auth/password.js';
import { mintToken } from '../../auth/tokens.js';
import { AppError } from '../../lib/errors.js';
import { ulid } from '../../lib/id.js';
import { logger } from '../../lib/logger.js';
import { sendMail } from '../../lib/mail.js';
import { prisma } from '../../lib/prisma.js';
import { sha256 } from '../../lib/sha256.js';
import {
  toInvitationDto,
  toMembershipDto,
  toOrgDto,
  toUserDto,
  type InvitationDto,
  type MembershipDto,
  type OrganizationDto,
  type UserDto,
} from '../../lib/dto.js';

import * as inviteTemplate from './templates.js';
import type { AcceptInviteInput, CreateInviteInput } from './schemas.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CallerContext {
  ipAddress?: string;
  userAgent?: string;
}

export interface CreateInviteResult {
  invitation: InvitationDto;
  mailed: boolean;
  mailError?: string;
}

const generateInvitePlaintext = (): string => randomBytes(32).toString('base64url');

export const createInvite = async (
  actor: Membership,
  orgId: string,
  input: CreateInviteInput,
  inviterName: string,
): Promise<CreateInviteResult> => {
  if (!can(actor, { type: 'members:invite' })) {
    throw new AppError('forbidden', 403, 'requires owner or admin');
  }
  if (input.role === 'admin' && actor.role !== 'owner') {
    throw new AppError('forbidden', 403, 'only owners can invite admins');
  }

  const plaintext = generateInvitePlaintext();
  const tokenHash = sha256(plaintext);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  const result = await prisma.$transaction(async (tx) => {
    // Unverified users cannot invite others (08-auth-and-permissions.md
    // §"Email verification"). Without this check, an attacker who signs up
    // under a typo'd address they don't control can still seed memberships
    // into the org they created.
    const actorUser = await tx.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: { emailVerifiedAt: true },
    });
    if (!actorUser.emailVerifiedAt) {
      throw new AppError('forbidden', 403, 'verify your email before inviting others');
    }

    // Reject if already an active member.
    const existingUser = await tx.user.findUnique({ where: { email: input.email } });
    if (existingUser) {
      const membership = await tx.membership.findUnique({
        where: { orgId_userId: { orgId, userId: existingUser.id } },
      });
      if (membership) {
        throw new AppError('conflict', 409, 'user is already a member');
      }
    }

    // Reject if there's an outstanding (un-accepted) invitation.
    const outstanding = await tx.invitation.findFirst({
      where: {
        orgId,
        email: input.email,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (outstanding) {
      throw new AppError('conflict', 409, 'pending invitation already exists');
    }

    const org = await tx.organization.findUnique({ where: { id: orgId } });
    if (!org || org.deletedAt) {
      throw new AppError('not_found', 404, 'organization not found');
    }

    const invitation = await tx.invitation.create({
      data: {
        id: ulid(),
        orgId,
        email: input.email,
        role: input.role,
        tokenHash,
        invitedById: actor.userId,
        expiresAt,
      },
    });

    await writeAudit(tx, {
      orgId,
      actorId: actor.userId,
      action: 'member.invited',
      targetType: 'invitation',
      targetId: invitation.id,
      metadata: { email: input.email, role: input.role } satisfies Prisma.JsonObject,
    });

    return { invitation, organizationName: org.name };
  });

  let mailed = true;
  let mailError: string | undefined;
  try {
    const { subject, render } = inviteTemplate;
    const tmpl = render({
      inviterName,
      organizationName: result.organizationName,
      role: input.role,
      token: plaintext,
      expiresAt,
    });
    await sendMail({
      to: input.email,
      subject: subject({
        inviterName,
        organizationName: result.organizationName,
        role: input.role,
        token: plaintext,
        expiresAt,
      }),
      html: tmpl.html,
      text: tmpl.text,
      tags: { kind: 'invitation' },
    });
  } catch (err) {
    mailed = false;
    mailError = (err as Error).message;
    logger.warn(
      { err, invitationId: result.invitation.id },
      'invitation created but mail send failed',
    );
  }

  return {
    invitation: toInvitationDto(result.invitation),
    mailed,
    ...(mailError ? { mailError } : {}),
  };
};

export const listInvites = async (orgId: string): Promise<InvitationDto[]> => {
  const rows = await prisma.invitation.findMany({
    where: {
      orgId,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toInvitationDto);
};

export const revokeInvite = async (
  actor: Membership,
  orgId: string,
  invitationId: string,
): Promise<void> => {
  if (!can(actor, { type: 'members:invite' })) {
    throw new AppError('forbidden', 403, 'requires owner or admin');
  }

  await prisma.$transaction(async (tx) => {
    const inv = await tx.invitation.findUnique({ where: { id: invitationId } });
    if (!inv || inv.orgId !== orgId) {
      throw new AppError('not_found', 404, 'invitation not found');
    }
    if (inv.acceptedAt || inv.revokedAt) {
      throw new AppError('conflict', 409, 'invitation no longer pending');
    }

    await tx.invitation.update({
      where: { id: invitationId },
      data: { revokedAt: new Date() },
    });

    await writeAudit(tx, {
      orgId,
      actorId: actor.userId,
      action: 'member.invitation_revoked',
      targetType: 'invitation',
      targetId: invitationId,
    });
  });
};

export interface AcceptInviteResult {
  user: UserDto;
  organization: OrganizationDto;
  memberships: MembershipDto[];
  token: string;
  expiresAt: string | null;
}

export const acceptInvite = async (
  input: AcceptInviteInput,
  ctx: CallerContext & { authenticatedUserEmail?: string } = {},
): Promise<AcceptInviteResult> => {
  const tokenHash = sha256(input.token);

  // Pre-resolve and HIBP-check outside the transaction (avoid long network call inside).
  const inv = await prisma.invitation.findUnique({ where: { tokenHash } });
  if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt < new Date()) {
    throw new AppError('not_found', 404, 'invitation not valid');
  }

  // If the caller arrived with a live session for a *different* email than
  // the invitation, refuse — the documented contract (08-auth-and-permissions
  // §"Invitation acceptance") is to ask them to log out first, not silently
  // attach the membership to whichever account happens to be signed in.
  if (
    ctx.authenticatedUserEmail &&
    ctx.authenticatedUserEmail.toLowerCase() !== inv.email.toLowerCase()
  ) {
    throw new AppError(
      'conflict',
      409,
      `this invitation was sent to ${inv.email} — sign out first to accept it`,
    );
  }

  const existingUser = await prisma.user.findUnique({ where: { email: inv.email } });
  const isNewUser = !existingUser;

  if (isNewUser) {
    const missing: ('password' | 'name')[] = [];
    if (!input.password) missing.push('password');
    if (!input.name) missing.push('name');
    if (missing.length > 0) {
      throw new AppError('invalid_input', 400, 'password and name are required for new users', {
        requires: missing,
        existingUser: false,
      });
    }
    if (await isPasswordPwned(input.password!)) {
      throw new AppError(
        'invalid_input',
        422,
        'this password appears in a known data breach — choose another',
      );
    }
  } else if (input.password) {
    throw new AppError(
      'invalid_input',
      400,
      'this email already has an account — accept without setting a password',
      { requires: [], existingUser: true },
    );
  }

  const passwordHash = isNewUser && input.password ? await hashPassword(input.password) : null;

  const result = await prisma.$transaction(
    async (tx) => {
      // Re-read inside the transaction with row check, defending against double-accept races.
      const live = await tx.invitation.findUnique({ where: { id: inv.id } });
      if (!live || live.acceptedAt || live.revokedAt || live.expiresAt < new Date()) {
        throw new AppError('not_found', 404, 'invitation not valid');
      }

      let user;
      if (isNewUser) {
        // Do NOT auto-set emailVerifiedAt here. Clicking the invite link is
        // only weak evidence of mailbox control (forwarders, shared inboxes,
        // an admin who controls the address). The user goes through the
        // normal /auth/email/verify flow before gaining verify-gated
        // capabilities (e.g. inviting others — see createInvite).
        user = await tx.user.create({
          data: {
            id: ulid(),
            email: live.email,
            passwordHash,
            name: input.name!,
          },
        });
      } else {
        user = existingUser!;
      }

      // Idempotency: if a membership already exists, treat it as the join.
      const existingMembership = await tx.membership.findUnique({
        where: { orgId_userId: { orgId: live.orgId, userId: user.id } },
      });

      if (!existingMembership) {
        await tx.membership.create({
          data: {
            id: ulid(),
            orgId: live.orgId,
            userId: user.id,
            role: live.role,
            status: 'active',
          },
        });
      }

      await tx.invitation.update({
        where: { id: live.id },
        data: { acceptedAt: new Date(), acceptedBy: user.id },
      });

      if (isNewUser) {
        await writeAudit(tx, {
          orgId: live.orgId,
          actorId: user.id,
          action: 'auth.signup',
          targetType: 'user',
          targetId: user.id,
        });
      }

      await writeAudit(tx, {
        orgId: live.orgId,
        actorId: user.id,
        action: 'member.joined',
        targetType: 'membership',
        targetId: user.id,
        metadata: { invitationId: live.id, role: live.role } satisfies Prisma.JsonObject,
      });

      const organization = await tx.organization.findUniqueOrThrow({ where: { id: live.orgId } });
      const memberships = await tx.membership.findMany({
        where: { userId: user.id, status: 'active' },
        orderBy: { createdAt: 'asc' },
      });

      return { user, organization, memberships };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  const minted = await mintToken({
    userId: result.user.id,
    kind: 'web',
    ...(ctx.ipAddress ? { ipAddress: ctx.ipAddress } : {}),
    ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
  });

  return {
    user: toUserDto(result.user),
    organization: toOrgDto(result.organization),
    memberships: result.memberships.map(toMembershipDto),
    token: minted.plaintext,
    expiresAt: minted.expiresAt?.toISOString() ?? null,
  };
};
