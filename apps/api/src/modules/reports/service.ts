import type { Membership } from '@prisma/client';

import { prisma } from '../../lib/prisma.js';

import type { TimeTotalsByDayQuery, TimeTotalsQuery } from './schemas.js';

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

// ── per-day breakdown ─────────────────────────────────────────────────

export interface TimeTotalByDaySegment {
  projectId: string;
  projectName: string;
  totalActiveSeconds: number;
}

export interface TimeTotalByDayRow {
  // Zero-based index of the 24h window since `from`. The client controls
  // `from` (typically local midnight of the first visible day) so this
  // index lines up with the rendered "Mon, Tue, Wed…" columns regardless
  // of the caller's timezone — avoids the UTC-vs-local-day misalignment
  // a `YYYY-MM-DD` key would cause.
  index: number;
  totalActiveSeconds: number;
  segments: TimeTotalByDaySegment[];
}

export interface TimeTotalsByDayResult {
  days: TimeTotalByDayRow[];
  range: { from: string; to: string };
}

const MS_PER_DAY = 86_400_000;

export const computeTimeTotalsByDay = async (
  orgId: string,
  caller: Membership,
  query: TimeTotalsByDayQuery,
): Promise<TimeTotalsByDayResult> => {
  if (!query.from || !query.to) {
    throw new Error('time-totals-by-day requires both from and to');
  }
  const fromMs = query.from.getTime();
  const toMs = query.to.getTime();
  if (toMs <= fromMs) {
    throw new Error('time-totals-by-day requires to > from');
  }
  const dayCount = Math.ceil((toMs - fromMs) / MS_PER_DAY);

  // Members are scoped to their own data regardless of the userId param.
  const userId = caller.role === 'member' ? caller.userId : query.userId;

  const entries = await prisma.timeEntry.findMany({
    where: {
      project: { orgId },
      ...(userId ? { userId } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      startedAt: { gte: query.from, lt: query.to },
    },
    select: { startedAt: true, totalActiveSeconds: true, projectId: true },
  });

  const projectIds = Array.from(new Set(entries.map((e) => e.projectId)));
  const projects = projectIds.length
    ? await prisma.project.findMany({
        where: { id: { in: projectIds } },
        select: { id: true, name: true },
      })
    : [];
  const projectName = new Map(projects.map((p) => [p.id, p.name]));

  // Bucket: index → projectId → seconds.
  const byIdx = new Map<number, Map<string, number>>();
  for (const e of entries) {
    const idx = Math.floor((e.startedAt.getTime() - fromMs) / MS_PER_DAY);
    if (idx < 0 || idx >= dayCount) continue;
    let pmap = byIdx.get(idx);
    if (!pmap) {
      pmap = new Map();
      byIdx.set(idx, pmap);
    }
    pmap.set(e.projectId, (pmap.get(e.projectId) ?? 0) + e.totalActiveSeconds);
  }

  // Emit a row for every day in the range so empty days show as zero rather
  // than vanish from the chart.
  const days: TimeTotalByDayRow[] = [];
  for (let idx = 0; idx < dayCount; idx++) {
    const pmap = byIdx.get(idx);
    const segments: TimeTotalByDaySegment[] = pmap
      ? Array.from(pmap.entries())
          .map(([projectId, seconds]) => ({
            projectId,
            projectName: projectName.get(projectId) ?? '(unknown project)',
            totalActiveSeconds: seconds,
          }))
          .sort((a, b) => b.totalActiveSeconds - a.totalActiveSeconds)
      : [];
    const totalActiveSeconds = segments.reduce((s, seg) => s + seg.totalActiveSeconds, 0);
    days.push({ index: idx, totalActiveSeconds, segments });
  }

  return {
    days,
    range: { from: query.from.toISOString(), to: query.to.toISOString() },
  };
};
