import type { Membership } from '@prisma/client';

import { AppError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';

// Single source of truth for "is this user an active member of this org, and
// is that org still alive?" Used by orgScope (which guards /orgs/:orgId/*
// routes) and by handlers that resolve the org from the resource itself
// (notably /screenshots/:id GET + DELETE, which have no orgId in path).
//
// The deletedAt check matters: when an org is soft-deleted via cascade, the
// membership rows linger until the cleanup job runs. Without this gate, a
// member could keep operating on the dead org's resources for that window.
export const resolveActiveMembership = async (
  orgId: string,
  userId: string,
): Promise<Membership> => {
  const m = await prisma.membership.findUnique({
    where: { orgId_userId: { orgId, userId } },
    include: { organization: { select: { deletedAt: true } } },
  });
  if (!m || m.status !== 'active' || m.organization.deletedAt) {
    throw new AppError('forbidden', 403, 'not an active member of this org');
  }
  // Strip the joined organization slice so callers get the bare Membership
  // row shape the rest of the codebase expects.
  const { organization: _organization, ...flat } = m;
  return flat;
};
