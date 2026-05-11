import type { Prisma } from '@prisma/client';
import { type Membership, type Project } from '@prisma/client';

import { writeAudit } from '../../auth/audit.js';
import { can } from '../../auth/capabilities.js';
import { AppError } from '../../lib/errors.js';
import { ulid } from '../../lib/id.js';
import { prisma } from '../../lib/prisma.js';
import {
  toProjectAssignmentDto,
  toProjectDto,
  toUserDto,
  type ProjectAssignmentDto,
  type ProjectDto,
  type UserDto,
} from '../../lib/dto.js';

import type {
  CreateAssignmentInput,
  CreateProjectInput,
  ListProjectsQuery,
  UpdateAssignmentInput,
  UpdateProjectInput,
} from './schemas.js';

// ── Project CRUD ────────────────────────────────────────────────────────────

export const listProjects = async (
  orgId: string,
  caller: Membership,
  opts: ListProjectsQuery,
): Promise<ProjectDto[]> => {
  const archivedFilter = opts.includeArchived ? {} : { archivedAt: null };

  const rows =
    caller.role === 'member'
      ? await prisma.project.findMany({
          where: {
            orgId,
            ...archivedFilter,
            assignments: {
              some: { userId: caller.userId, removedAt: null },
            },
          },
          orderBy: { createdAt: 'desc' },
        })
      : await prisma.project.findMany({
          where: { orgId, ...archivedFilter },
          orderBy: { createdAt: 'desc' },
        });

  return rows.map(toProjectDto);
};

export const createProject = async (
  orgId: string,
  caller: Membership,
  input: CreateProjectInput,
): Promise<ProjectDto> => {
  if (!can(caller, { type: 'projects:create' })) {
    throw new AppError('forbidden', 403, 'requires owner or admin');
  }

  const created = await prisma.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        id: ulid(),
        orgId,
        name: input.name,
        description: input.description ?? null,
        screenshotIntervalMinutes: input.screenshotIntervalMinutes,
        blurScreenshots: input.blurScreenshots,
        createdBy: caller.userId,
      },
    });
    await writeAudit(tx, {
      orgId,
      actorId: caller.userId,
      action: 'project.created',
      targetType: 'project',
      targetId: project.id,
      metadata: {
        name: project.name,
        screenshotIntervalMinutes: project.screenshotIntervalMinutes,
        blurScreenshots: project.blurScreenshots,
      } satisfies Prisma.JsonObject,
    });
    return project;
  });

  return toProjectDto(created);
};

export const getProject = async (project: Project, caller: Membership): Promise<ProjectDto> => {
  let assigned = false;
  if (caller.role === 'member') {
    const assignment = await prisma.projectAssignment.findUnique({
      where: { projectId_userId: { projectId: project.id, userId: caller.userId } },
    });
    assigned = !!assignment && assignment.removedAt === null;
  }
  if (!can(caller, { type: 'projects:read', assignedToCaller: assigned })) {
    throw new AppError('forbidden', 403, 'project not accessible');
  }
  return toProjectDto(project);
};

export const updateProject = async (
  project: Project,
  caller: Membership,
  patch: UpdateProjectInput,
): Promise<ProjectDto> => {
  if (!can(caller, { type: 'projects:edit' })) {
    throw new AppError('forbidden', 403, 'requires owner or admin');
  }

  const fields = Object.keys(patch).filter(
    (k) => (patch as Record<string, unknown>)[k] !== undefined,
  );

  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.project.update({
      where: { id: project.id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.screenshotIntervalMinutes !== undefined
          ? { screenshotIntervalMinutes: patch.screenshotIntervalMinutes }
          : {}),
        ...(patch.blurScreenshots !== undefined ? { blurScreenshots: patch.blurScreenshots } : {}),
      },
    });
    await writeAudit(tx, {
      orgId: project.orgId,
      actorId: caller.userId,
      action: 'project.updated',
      targetType: 'project',
      targetId: project.id,
      metadata: { fields } satisfies Prisma.JsonObject,
    });
    return next;
  });

  return toProjectDto(updated);
};

export const setArchived = async (
  project: Project,
  caller: Membership,
  archived: boolean,
): Promise<ProjectDto> => {
  if (!can(caller, { type: 'projects:edit' })) {
    throw new AppError('forbidden', 403, 'requires owner or admin');
  }

  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.project.update({
      where: { id: project.id },
      data: { archivedAt: archived ? new Date() : null },
    });
    await writeAudit(tx, {
      orgId: project.orgId,
      actorId: caller.userId,
      action: archived ? 'project.archived' : 'project.unarchived',
      targetType: 'project',
      targetId: project.id,
    });
    return next;
  });

  return toProjectDto(updated);
};

// ── Assignments ─────────────────────────────────────────────────────────────

export interface AssignmentRow {
  assignment: ProjectAssignmentDto;
  user: UserDto;
}

export const listAssignments = async (
  project: Project,
  includeRemoved: boolean,
): Promise<AssignmentRow[]> => {
  const rows = await prisma.projectAssignment.findMany({
    where: {
      projectId: project.id,
      ...(includeRemoved ? {} : { removedAt: null }),
    },
    include: { user: true },
    orderBy: { assignedAt: 'asc' },
  });
  return rows.map((r) => ({
    assignment: toProjectAssignmentDto(r),
    user: toUserDto(r.user),
  }));
};

export const addAssignment = async (
  project: Project,
  caller: Membership,
  input: CreateAssignmentInput,
): Promise<ProjectAssignmentDto> => {
  if (!can(caller, { type: 'projects:assign_members' })) {
    throw new AppError('forbidden', 403, 'requires owner or admin');
  }

  // The target must be an active member of the same org.
  const targetMembership = await prisma.membership.findUnique({
    where: { orgId_userId: { orgId: project.orgId, userId: input.userId } },
  });
  if (!targetMembership || targetMembership.status !== 'active') {
    throw new AppError('invalid_input', 422, 'user is not an active member of this org');
  }

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.projectAssignment.findUnique({
      where: { projectId_userId: { projectId: project.id, userId: input.userId } },
    });

    if (existing && existing.removedAt === null) {
      throw new AppError('conflict', 409, 'user is already assigned to this project');
    }

    const next = existing
      ? await tx.projectAssignment.update({
          where: { id: existing.id },
          data: {
            removedAt: null,
            assignedAt: new Date(),
            ...(input.hourlyRateCents !== undefined
              ? { hourlyRateCents: input.hourlyRateCents }
              : {}),
          },
        })
      : await tx.projectAssignment.create({
          data: {
            id: ulid(),
            projectId: project.id,
            userId: input.userId,
            hourlyRateCents: input.hourlyRateCents ?? null,
          },
        });

    await writeAudit(tx, {
      orgId: project.orgId,
      actorId: caller.userId,
      action: 'project.assignment_added',
      targetType: 'project_assignment',
      targetId: next.id,
      metadata: {
        projectId: project.id,
        userId: input.userId,
        reactivated: !!existing,
      } satisfies Prisma.JsonObject,
    });

    return next;
  });

  return toProjectAssignmentDto(result);
};

export const updateAssignment = async (
  project: Project,
  caller: Membership,
  targetUserId: string,
  patch: UpdateAssignmentInput,
): Promise<ProjectAssignmentDto> => {
  if (!can(caller, { type: 'projects:assign_members' })) {
    throw new AppError('forbidden', 403, 'requires owner or admin');
  }

  const updated = await prisma.$transaction(async (tx) => {
    const existing = await tx.projectAssignment.findUnique({
      where: { projectId_userId: { projectId: project.id, userId: targetUserId } },
    });
    if (!existing || existing.removedAt !== null) {
      throw new AppError('conflict', 409, 'no active assignment for this user');
    }

    const next = await tx.projectAssignment.update({
      where: { id: existing.id },
      data: {
        ...(patch.hourlyRateCents !== undefined ? { hourlyRateCents: patch.hourlyRateCents } : {}),
      },
    });

    await writeAudit(tx, {
      orgId: project.orgId,
      actorId: caller.userId,
      action: 'project.assignment_updated',
      targetType: 'project_assignment',
      targetId: next.id,
      metadata: {
        from: { hourlyRateCents: existing.hourlyRateCents },
        to: { hourlyRateCents: next.hourlyRateCents },
      } satisfies Prisma.JsonObject,
    });

    return next;
  });

  return toProjectAssignmentDto(updated);
};

export const removeAssignment = async (
  project: Project,
  caller: Membership,
  targetUserId: string,
): Promise<void> => {
  if (!can(caller, { type: 'projects:assign_members' })) {
    throw new AppError('forbidden', 403, 'requires owner or admin');
  }

  await prisma.$transaction(async (tx) => {
    const existing = await tx.projectAssignment.findUnique({
      where: { projectId_userId: { projectId: project.id, userId: targetUserId } },
    });
    if (!existing) {
      throw new AppError('not_found', 404, 'assignment not found');
    }
    if (existing.removedAt !== null) {
      throw new AppError('conflict', 409, 'assignment already removed');
    }

    await tx.projectAssignment.update({
      where: { id: existing.id },
      data: { removedAt: new Date() },
    });

    await writeAudit(tx, {
      orgId: project.orgId,
      actorId: caller.userId,
      action: 'project.assignment_removed',
      targetType: 'project_assignment',
      targetId: existing.id,
      metadata: { projectId: project.id, userId: targetUserId } satisfies Prisma.JsonObject,
    });
  });
};
