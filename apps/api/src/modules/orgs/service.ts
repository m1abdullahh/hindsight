import { Prisma, type Membership } from '@prisma/client';

import { writeAudit } from '../../auth/audit.js';
import { can } from '../../auth/capabilities.js';
import { isPasswordPwned } from '../../auth/hibp.js';
import { hashPassword } from '../../auth/password.js';
import { AppError } from '../../lib/errors.js';
import { ulid } from '../../lib/id.js';
import { prisma } from '../../lib/prisma.js';
import {
  toMembershipDto,
  toOrgDto,
  toUserDto,
  type MembershipDto,
  type OrganizationDto,
  type UserDto,
} from '../../lib/dto.js';

import type { AddMemberDirectInput, UpdateMemberInput, UpdateOrgInput } from './schemas.js';

export const getOrg = async (orgId: string): Promise<OrganizationDto> => {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org || org.deletedAt) throw new AppError('not_found', 404, 'organization not found');
  return toOrgDto(org);
};

export const updateOrg = async (
  actor: Membership,
  orgId: string,
  patch: UpdateOrgInput,
): Promise<OrganizationDto> => {
  if (!can(actor, { type: 'org:manage' })) {
    throw new AppError('forbidden', 403, 'requires owner');
  }

  const updated = await prisma.$transaction(async (tx) => {
    const org = await tx.organization.update({
      where: { id: orgId },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
      },
    });
    await writeAudit(tx, {
      orgId,
      actorId: actor.userId,
      action: 'org.updated',
      targetType: 'organization',
      targetId: orgId,
      metadata: { fields: Object.keys(patch) } satisfies Prisma.JsonObject,
    });
    return org;
  });

  return toOrgDto(updated);
};

export interface MemberRow {
  membership: MembershipDto;
  user: UserDto;
}

export const listMembers = async (orgId: string): Promise<MemberRow[]> => {
  const rows = await prisma.membership.findMany({
    where: { orgId },
    include: { user: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({
    membership: toMembershipDto(r),
    user: toUserDto(r.user),
  }));
};

const countActiveOwners = async (
  tx: Prisma.TransactionClient,
  orgId: string,
  excludeUserId?: string,
): Promise<number> =>
  tx.membership.count({
    where: {
      orgId,
      role: 'owner',
      status: 'active',
      ...(excludeUserId ? { userId: { not: excludeUserId } } : {}),
    },
  });

export const updateMember = async (
  actor: Membership,
  orgId: string,
  targetUserId: string,
  patch: UpdateMemberInput,
): Promise<MembershipDto> => {
  if (!can(actor, { type: 'members:change_role' })) {
    throw new AppError('forbidden', 403, 'requires owner or admin');
  }

  const updated = await prisma.$transaction(
    async (tx) => {
      const target = await tx.membership.findUnique({
        where: { orgId_userId: { orgId, userId: targetUserId } },
      });
      if (!target) throw new AppError('not_found', 404, 'membership not found');

      // Admins cannot promote/demote owners (owner-only territory).
      if (actor.role === 'admin' && (target.role === 'owner' || patch.role === 'owner')) {
        throw new AppError('forbidden', 403, 'admins cannot manage owners');
      }

      const willBecomeNonOwner =
        target.role === 'owner' &&
        ((patch.role !== undefined && patch.role !== 'owner') || patch.status === 'suspended');

      if (willBecomeNonOwner) {
        const remaining = await countActiveOwners(tx, orgId, targetUserId);
        if (remaining === 0) {
          throw new AppError('conflict', 409, 'cannot leave org without an owner');
        }
      }

      const next = await tx.membership.update({
        where: { id: target.id },
        data: {
          ...(patch.role !== undefined ? { role: patch.role } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
        },
      });

      if (patch.role !== undefined && patch.role !== target.role) {
        await writeAudit(tx, {
          orgId,
          actorId: actor.userId,
          action: 'member.role_changed',
          targetType: 'membership',
          targetId: target.id,
          metadata: { from: target.role, to: patch.role } satisfies Prisma.JsonObject,
        });
      }
      if (patch.status !== undefined && patch.status !== target.status) {
        await writeAudit(tx, {
          orgId,
          actorId: actor.userId,
          action: 'member.status_changed',
          targetType: 'membership',
          targetId: target.id,
          metadata: { from: target.status, to: patch.status } satisfies Prisma.JsonObject,
        });
      }

      return next;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  return toMembershipDto(updated);
};

// Direct member creation — bypasses the invitation/email loop. Intended for
// deployments without a working outbound mail server: the admin sets the
// password locally and shares the credentials out-of-band. The resulting
// User + Membership rows are intentionally identical in shape to those
// produced by the invite flow so every downstream feature (tracking,
// captures, presence, reports, retention, etc.) works without conditionals.
//
// Email is auto-verified because the admin is asserting ownership on the
// user's behalf — there is no email channel to send a verification link
// through, and leaving it unverified would block the new user from
// inviting teammates later (see verify-gated capabilities in
// invitations/service.ts).
export const addMemberDirect = async (
  actor: Membership,
  orgId: string,
  input: AddMemberDirectInput,
): Promise<{ user: UserDto; membership: MembershipDto }> => {
  if (!can(actor, { type: 'members:invite' })) {
    throw new AppError('forbidden', 403, 'requires owner or admin');
  }
  if (input.role === 'admin' && actor.role !== 'owner') {
    throw new AppError('forbidden', 403, 'only owners can add admins');
  }

  // HIBP runs outside the transaction (~150ms network call). Same gate the
  // invite-accept flow uses, so admin-set passwords can't be weaker than
  // user-set ones.
  if (await isPasswordPwned(input.password)) {
    throw new AppError(
      'invalid_input',
      422,
      'this password appears in a known data breach — choose another',
    );
  }

  const passwordHash = await hashPassword(input.password);

  const result = await prisma.$transaction(
    async (tx) => {
      // Mirror invitations/service.ts: caller must be verified before
      // onboarding others, regardless of which onboarding path they use.
      // Without this gate, an attacker who signed up under a typo'd address
      // could seed memberships using direct-add even when blocked from
      // invites.
      const actorUser = await tx.user.findUniqueOrThrow({
        where: { id: actor.userId },
        select: { emailVerifiedAt: true },
      });
      if (!actorUser.emailVerifiedAt) {
        throw new AppError('forbidden', 403, 'verify your email before adding members');
      }

      const org = await tx.organization.findUnique({ where: { id: orgId } });
      if (!org || org.deletedAt) {
        throw new AppError('not_found', 404, 'organization not found');
      }

      const existingUser = await tx.user.findUnique({ where: { email: input.email } });
      if (existingUser) {
        const membership = await tx.membership.findUnique({
          where: { orgId_userId: { orgId, userId: existingUser.id } },
        });
        if (membership) {
          throw new AppError('conflict', 409, 'user is already a member');
        }
        // Existing account with no membership in this org: the safer path
        // is the invite flow (preserves their existing password and gives
        // them an explicit accept step). Direct-add is for brand-new users.
        throw new AppError(
          'conflict',
          409,
          'an account with this email already exists — use Invite instead',
        );
      }

      // Reject if there's an outstanding invitation for this email — avoid
      // two parallel onboarding paths for the same person.
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
        throw new AppError('conflict', 409, 'pending invitation already exists for this email');
      }

      const user = await tx.user.create({
        data: {
          id: ulid(),
          email: input.email,
          name: input.name,
          passwordHash,
          emailVerifiedAt: new Date(),
        },
      });

      const membership = await tx.membership.create({
        data: {
          id: ulid(),
          orgId,
          userId: user.id,
          role: input.role,
          status: 'active',
        },
      });

      await writeAudit(tx, {
        orgId,
        actorId: actor.userId,
        action: 'member.directly_added',
        targetType: 'membership',
        targetId: membership.id,
        metadata: { email: input.email, role: input.role } satisfies Prisma.JsonObject,
      });

      return { user, membership };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  return {
    user: toUserDto(result.user),
    membership: toMembershipDto(result.membership),
  };
};

export const removeMember = async (
  actor: Membership,
  orgId: string,
  targetUserId: string,
): Promise<void> => {
  if (!can(actor, { type: 'members:remove' })) {
    throw new AppError('forbidden', 403, 'requires owner or admin');
  }

  await prisma.$transaction(
    async (tx) => {
      const target = await tx.membership.findUnique({
        where: { orgId_userId: { orgId, userId: targetUserId } },
      });
      if (!target) throw new AppError('not_found', 404, 'membership not found');

      if (actor.role === 'admin' && target.role === 'owner') {
        throw new AppError('forbidden', 403, 'admins cannot remove owners');
      }

      if (target.role === 'owner') {
        const remaining = await countActiveOwners(tx, orgId, targetUserId);
        if (remaining === 0) {
          throw new AppError('conflict', 409, 'cannot remove the last owner');
        }
      }

      await tx.membership.delete({ where: { id: target.id } });

      await writeAudit(tx, {
        orgId,
        actorId: actor.userId,
        action: 'member.removed',
        targetType: 'user',
        targetId: targetUserId,
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
};
