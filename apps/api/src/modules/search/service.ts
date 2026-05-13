import type { Membership } from '@prisma/client';

import { prisma } from '../../lib/prisma.js';
import {
  toMembershipDto,
  toProjectDto,
  toUserDto,
  type MembershipDto,
  type ProjectDto,
  type UserDto,
} from '../../lib/dto.js';

import type { SearchQuery } from './schemas.js';

export interface MemberSearchHit {
  user: UserDto;
  membership: MembershipDto;
}

export interface SearchResult {
  members: MemberSearchHit[];
  projects: ProjectDto[];
}

export const search = async (
  orgId: string,
  caller: Membership,
  query: SearchQuery,
): Promise<SearchResult> => {
  const q = query.q;
  const take = query.limit;

  const [memberRows, projectRows] = await Promise.all([
    prisma.membership.findMany({
      where: {
        orgId,
        status: 'active',
        OR: [
          { user: { name: { contains: q, mode: 'insensitive' } } },
          { user: { email: { contains: q, mode: 'insensitive' } } },
        ],
      },
      include: { user: true },
      orderBy: { user: { name: 'asc' } },
      take,
    }),
    prisma.project.findMany({
      where: {
        orgId,
        archivedAt: null,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ],
        // Members can only surface projects they're assigned to — mirrors
        // listProjects in modules/projects/service.ts.
        ...(caller.role === 'member'
          ? { assignments: { some: { userId: caller.userId, removedAt: null } } }
          : {}),
      },
      orderBy: { name: 'asc' },
      take,
    }),
  ]);

  return {
    members: memberRows.map((m) => ({
      user: toUserDto(m.user),
      membership: toMembershipDto(m),
    })),
    projects: projectRows.map(toProjectDto),
  };
};
