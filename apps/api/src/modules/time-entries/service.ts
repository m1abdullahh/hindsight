import type { Membership } from '@prisma/client';

import { AppError } from '../../lib/errors.js';
import { ulid } from '../../lib/id.js';
import { prisma } from '../../lib/prisma.js';
import { toTimeEntryDto, type TimeEntryDto } from '../../lib/dto.js';

import type {
  CreateTimeEntryInput,
  ListTimeEntriesQuery,
  UpdateTimeEntryInput,
} from './schemas.js';

interface DeviceCaller {
  userId: string;
  deviceId: string;
}

export const startTimeEntry = async (
  caller: DeviceCaller,
  input: CreateTimeEntryInput,
): Promise<TimeEntryDto> => {
  // Verify the project exists and the user is a member of its org.
  const project = await prisma.project.findUnique({ where: { id: input.projectId } });
  if (!project || project.archivedAt) {
    throw new AppError('not_found', 404, 'project not found or archived');
  }

  const membership = await prisma.membership.findUnique({
    where: { orgId_userId: { orgId: project.orgId, userId: caller.userId } },
  });
  if (!membership || membership.status !== 'active') {
    throw new AppError('forbidden', 403, "not a member of this project's org");
  }

  // Members must have an active assignment; admins/owners can track any project.
  if (membership.role === 'member') {
    const assignment = await prisma.projectAssignment.findUnique({
      where: { projectId_userId: { projectId: project.id, userId: caller.userId } },
    });
    if (!assignment || assignment.removedAt !== null) {
      throw new AppError('forbidden', 403, 'not assigned to this project');
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    // Auto-stop any open time entry on this device.
    await tx.timeEntry.updateMany({
      where: { deviceId: caller.deviceId, endedAt: null },
      data: { endedAt: new Date() },
    });

    return tx.timeEntry.create({
      data: {
        id: ulid(),
        userId: caller.userId,
        projectId: project.id,
        deviceId: caller.deviceId,
        startedAt: input.startedAt,
      },
    });
  });

  return toTimeEntryDto(result);
};

export const updateTimeEntry = async (
  caller: { userId: string; isAdminOf: (orgId: string) => boolean },
  id: string,
  patch: UpdateTimeEntryInput,
): Promise<TimeEntryDto> => {
  const entry = await prisma.timeEntry.findUnique({
    where: { id },
    include: { project: { select: { orgId: true } } },
  });
  if (!entry) throw new AppError('not_found', 404, 'time entry not found');

  if (entry.userId !== caller.userId && !caller.isAdminOf(entry.project.orgId)) {
    throw new AppError('forbidden', 403, 'cannot modify this time entry');
  }

  if (entry.endedAt && patch.endedAt !== undefined) {
    throw new AppError('conflict', 409, 'time entry is already closed');
  }

  const updated = await prisma.timeEntry.update({
    where: { id: entry.id },
    data: {
      ...(patch.endedAt !== undefined ? { endedAt: patch.endedAt } : {}),
      ...(patch.totalActiveSeconds !== undefined
        ? { totalActiveSeconds: patch.totalActiveSeconds }
        : {}),
      ...(patch.totalIdleSeconds !== undefined ? { totalIdleSeconds: patch.totalIdleSeconds } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    },
  });

  return toTimeEntryDto(updated);
};

export interface TimeEntriesPage {
  entries: TimeEntryDto[];
  nextCursor: string | null;
}

const encodeCursor = (startedAt: Date, id: string): string =>
  Buffer.from(`${startedAt.toISOString()}|${id}`).toString('base64url');

interface DecodedCursor {
  startedAt: Date;
  id: string;
}

const decodeCursor = (s: string): DecodedCursor | null => {
  try {
    const decoded = Buffer.from(s, 'base64url').toString();
    const [iso, id] = decoded.split('|');
    if (!iso || !id) return null;
    return { startedAt: new Date(iso), id };
  } catch {
    return null;
  }
};

export const listTimeEntries = async (
  orgId: string,
  caller: Membership,
  query: ListTimeEntriesQuery,
): Promise<TimeEntriesPage> => {
  const userId = caller.role === 'member' ? caller.userId : query.userId;

  const cursor = query.cursor ? decodeCursor(query.cursor) : null;

  const rows = await prisma.timeEntry.findMany({
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
      ...(cursor
        ? {
            OR: [
              { startedAt: { lt: cursor.startedAt } },
              { startedAt: cursor.startedAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
  });

  const hasMore = rows.length > query.limit;
  const sliced = hasMore ? rows.slice(0, query.limit) : rows;
  const last = sliced[sliced.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.startedAt, last.id) : null;

  return { entries: sliced.map(toTimeEntryDto), nextCursor };
};
