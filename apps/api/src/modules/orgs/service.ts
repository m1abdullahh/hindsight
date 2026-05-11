import { Prisma, type Membership } from '@prisma/client';

import { writeAudit } from '../../auth/audit.js';
import { can } from '../../auth/capabilities.js';
import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import {
  toMembershipDto,
  toOrgDto,
  toUserDto,
  type MembershipDto,
  type OrganizationDto,
  type UserDto,
} from '../../lib/dto.js';

import type { UpdateMemberInput, UpdateOrgInput } from './schemas.js';

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
