import type { Membership } from '@prisma/client';

import { prisma } from '../../lib/prisma.js';

import type { TimeTotalsQuery } from './schemas.js';

export interface TimeTotalRow {
  userId: string;
  userName: string;
  userEmail: string;
  projectId: string;
  projectName: string;
  totalActiveSeconds: number;
  hourlyRateCents: number | null;
  earnedCents: number | null;
}

export interface TimeTotalsResult {
  rows: TimeTotalRow[];
  range: { from: string | null; to: string | null };
}

const computeEarnedCents = (seconds: number, rateCents: number | null): number | null => {
  if (rateCents === null) return null;
  return Math.round((seconds / 3600) * rateCents);
};

export const computeTimeTotals = async (
  orgId: string,
  caller: Membership,
  query: TimeTotalsQuery,
): Promise<TimeTotalsResult> => {
  // Members can only see their own totals — silently force userId regardless
  // of what was requested. Owners/admins can pass any userId or omit for all.
  const userId = caller.role === 'member' ? caller.userId : query.userId;

  const groups = await prisma.timeEntry.groupBy({
    by: ['userId', 'projectId'],
    where: {
      project: { orgId },
      ...(userId ? { userId } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.from || query.to
        ? {
            startedAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    },
    _sum: { totalActiveSeconds: true },
  });

  if (groups.length === 0) {
    return {
      rows: [],
      range: {
        from: query.from?.toISOString() ?? null,
        to: query.to?.toISOString() ?? null,
      },
    };
  }

  const userIds = Array.from(new Set(groups.map((g) => g.userId)));
  const projectIds = Array.from(new Set(groups.map((g) => g.projectId)));

  const [users, projects, assignments] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true },
    }),
    prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: { id: true, name: true },
    }),
    prisma.projectAssignment.findMany({
      where: {
        projectId: { in: projectIds },
        userId: { in: userIds },
      },
      select: { projectId: true, userId: true, hourlyRateCents: true },
    }),
  ]);

  const userById = new Map(users.map((u) => [u.id, u]));
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const rateByPair = new Map(
    assignments.map((a) => [`${a.projectId}::${a.userId}`, a.hourlyRateCents]),
  );

  const rows: TimeTotalRow[] = groups.map((g) => {
    const u = userById.get(g.userId);
    const p = projectById.get(g.projectId);
    const seconds = g._sum.totalActiveSeconds ?? 0;
    const rate = rateByPair.get(`${g.projectId}::${g.userId}`) ?? null;
    return {
      userId: g.userId,
      userName: u?.name ?? '(unknown user)',
      userEmail: u?.email ?? '',
      projectId: g.projectId,
      projectName: p?.name ?? '(unknown project)',
      totalActiveSeconds: seconds,
      hourlyRateCents: rate,
      earnedCents: computeEarnedCents(seconds, rate),
    };
  });

  // Stable order: by project name, then user name.
  rows.sort((a, b) => {
    const pn = a.projectName.localeCompare(b.projectName);
    return pn !== 0 ? pn : a.userName.localeCompare(b.userName);
  });

  return {
    rows,
    range: {
      from: query.from?.toISOString() ?? null,
      to: query.to?.toISOString() ?? null,
    },
  };
};
