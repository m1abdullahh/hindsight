import type { Prisma } from '@prisma/client';
import { type Membership } from '@prisma/client';

import { writeAudit } from '../../auth/audit.js';
import { AppError } from '../../lib/errors.js';
import { ulid } from '../../lib/id.js';
import { prisma } from '../../lib/prisma.js';
import { toTimeEntryDto, type TimeEntryDto } from '../../lib/dto.js';

import type {
  CreateManualTimeEntryInput,
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

interface AdminCaller {
  userId: string;
  orgId: string;
}

/**
 * Admin/owner manually records time on a member's behalf (e.g. the member
 * forgot to track). The entry has no device, counts as active/billable time
 * (its `totalActiveSeconds` rolls up into reports exactly like tracked time),
 * and is always audited so a retroactive add is traceable.
 *
 * The caller is assumed to already be an owner/admin of `caller.orgId` (the
 * handler enforces this via `can(..., time_entries:create_manual)`).
 */
export const createManualTimeEntry = async (
  caller: AdminCaller,
  targetUserId: string,
  input: CreateManualTimeEntryInput,
): Promise<TimeEntryDto> => {
  const project = await prisma.project.findUnique({ where: { id: input.projectId } });
  if (!project || project.archivedAt) {
    throw new AppError('not_found', 404, 'project not found or archived');
  }
  // Project must belong to the caller's org so an admin can't write time into
  // another org by guessing a project id.
  if (project.orgId !== caller.orgId) {
    throw new AppError('forbidden', 403, 'project is not in this org');
  }

  // The member must be an active member of this org.
  const membership = await prisma.membership.findUnique({
    where: { orgId_userId: { orgId: caller.orgId, userId: targetUserId } },
  });
  if (!membership || membership.status !== 'active') {
    throw new AppError('not_found', 404, 'member not found in this org');
  }

  // Anchor the calendar day to noon UTC so it stays on the intended day in
  // every timezone, then derive the close from the duration.
  const startedAt = new Date(`${input.date}T12:00:00.000Z`);
  const endedAt = new Date(startedAt.getTime() + input.durationSeconds * 1000);

  const created = await prisma.$transaction(async (tx) => {
    const entry = await tx.timeEntry.create({
      data: {
        id: ulid(),
        userId: targetUserId,
        projectId: project.id,
        deviceId: null,
        startedAt,
        endedAt,
        totalActiveSeconds: input.durationSeconds,
        totalIdleSeconds: 0,
        ...(input.notes ? { notes: input.notes } : {}),
      },
    });

    await writeAudit(tx, {
      orgId: caller.orgId,
      actorId: caller.userId,
      action: 'time_entry.created_by_admin',
      targetType: 'time_entry',
      targetId: entry.id,
      metadata: {
        targetUserId,
        projectId: project.id,
        date: input.date,
        durationSeconds: input.durationSeconds,
      } satisfies Prisma.JsonObject,
    });

    return entry;
  });

  return toTimeEntryDto(created);
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

  const isCrossUserAdminEdit =
    entry.userId !== caller.userId && caller.isAdminOf(entry.project.orgId);

  if (entry.userId !== caller.userId && !isCrossUserAdminEdit) {
    throw new AppError('forbidden', 403, 'cannot modify this time entry');
  }

  if (entry.endedAt && patch.endedAt !== undefined) {
    throw new AppError('conflict', 409, 'time entry is already closed');
  }

  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.timeEntry.update({
      where: { id: entry.id },
      data: {
        ...(patch.endedAt !== undefined ? { endedAt: patch.endedAt } : {}),
        ...(patch.totalActiveSeconds !== undefined
          ? { totalActiveSeconds: patch.totalActiveSeconds }
          : {}),
        ...(patch.totalIdleSeconds !== undefined
          ? { totalIdleSeconds: patch.totalIdleSeconds }
          : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      },
    });

    // When an admin edits a time entry belonging to a different user, record
    // before/after of each changed field. Time totals roll up into reports
    // and (eventually) payroll — without this trail there's no way to detect
    // an admin retroactively bumping someone's hours, or zeroing them out.
    if (isCrossUserAdminEdit) {
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (patch.endedAt !== undefined && patch.endedAt?.getTime() !== entry.endedAt?.getTime()) {
        changes.endedAt = {
          from: entry.endedAt?.toISOString() ?? null,
          to: patch.endedAt?.toISOString() ?? null,
        };
      }
      if (
        patch.totalActiveSeconds !== undefined &&
        patch.totalActiveSeconds !== entry.totalActiveSeconds
      ) {
        changes.totalActiveSeconds = {
          from: entry.totalActiveSeconds,
          to: patch.totalActiveSeconds,
        };
      }
      if (
        patch.totalIdleSeconds !== undefined &&
        patch.totalIdleSeconds !== entry.totalIdleSeconds
      ) {
        changes.totalIdleSeconds = { from: entry.totalIdleSeconds, to: patch.totalIdleSeconds };
      }
      if (patch.notes !== undefined && patch.notes !== entry.notes) {
        // Don't store the full notes text in the audit row — it can grow
        // unbounded and may itself contain PII. Just record that it changed.
        changes.notes = { from: '<changed>', to: '<changed>' };
      }

      if (Object.keys(changes).length > 0) {
        await writeAudit(tx, {
          orgId: entry.project.orgId,
          actorId: caller.userId,
          action: 'time_entry.updated_by_admin',
          targetType: 'time_entry',
          targetId: entry.id,
          metadata: {
            targetUserId: entry.userId,
            changes,
          } as Prisma.JsonObject,
        });
      }
    }

    return next;
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
