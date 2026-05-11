# Projects & Assignments — HTTP Module

One new module: `modules/projects/`. Same four-file convention from [plans/01-backend-structure/modules.md](../01-backend-structure/modules.md): `routes.ts` / `schemas.ts` / `handlers.ts` / `service.ts`.

## Routes

Mounted under `/api/v1`. Two URL families per [docs/05-api-surface.md:59-76](../../docs/05-api-surface.md#L59-L76):

```
GET    /orgs/:orgId/projects                     requireAuth() + orgScope()
POST   /orgs/:orgId/projects                     requireAuth() + orgScope()    body: createProjectInput

GET    /projects/:projectId                      requireAuth() + projectScope()
PATCH  /projects/:projectId                      requireAuth() + projectScope()  body: updateProjectInput
POST   /projects/:projectId/archive              requireAuth() + projectScope()
DELETE /projects/:projectId/archive              requireAuth() + projectScope()

GET    /projects/:projectId/assignments          requireAuth() + projectScope()
POST   /projects/:projectId/assignments          requireAuth() + projectScope()  body: createAssignmentInput
PATCH  /projects/:projectId/assignments/:userId  requireAuth() + projectScope()  body: updateAssignmentInput
DELETE /projects/:projectId/assignments/:userId  requireAuth() + projectScope()
```

`PATCH /projects/:projectId/assignments/:userId` is **added beyond** the doc — the `hourlyRateCents` field needs an update path. Same shape as the org members PATCH.

## Schemas (`projects/schemas.ts`)

```ts
import { z } from 'zod';

const Name = z.string().trim().min(1).max(100);
const Description = z.string().trim().max(2000).nullable().optional();
const Interval = z.number().int().min(1).max(60);
const Cents = z.number().int().min(0).max(1_000_000_00);

export const createProjectInput = z.object({
  name: Name,
  description: Description,
  screenshotIntervalMinutes: Interval.default(10),
  blurScreenshots: z.boolean().default(false),
});

export const updateProjectInput = z
  .object({
    name: Name.optional(),
    description: Description,
    screenshotIntervalMinutes: Interval.optional(),
    blurScreenshots: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'must include at least one field',
  });

export const listProjectsQuery = z.object({
  includeArchived: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
});

export const createAssignmentInput = z.object({
  userId: z.string().min(1),
  hourlyRateCents: Cents.optional(),
});

export const updateAssignmentInput = z
  .object({
    hourlyRateCents: Cents.nullable().optional(),
  })
  .refine((v) => v.hourlyRateCents !== undefined, {
    message: 'must include at least one field',
  });
```

The output schemas (DTOs) live in [`apps/api/src/lib/dto.ts`](../../apps/api/src/lib/dto.ts) — see "DTO additions" below.

## `projectScope` middleware

New file: [`apps/api/src/middleware/project-scope.ts`](../../apps/api/src/middleware/project-scope.ts).

```ts
import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';

export const projectScope =
  () =>
  async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const projectId = req.params['projectId'];
      if (!projectId) {
        throw new AppError('invalid_input', 400, 'missing projectId in path');
      }
      if (!req.caller) {
        throw new AppError('unauthorized', 401, 'auth required before projectScope');
      }

      const project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project) {
        throw new AppError('not_found', 404, 'project not found');
      }

      const membership = await prisma.membership.findUnique({
        where: { orgId_userId: { orgId: project.orgId, userId: req.caller.user.id } },
      });
      if (!membership || membership.status !== 'active') {
        throw new AppError('forbidden', 403, "not a member of this project's org");
      }

      req.caller.project = project;
      req.caller.membership = membership;
      next();
    } catch (err) {
      next(err);
    }
  };
```

Tighten [`apps/api/src/types/express-augment.ts`](../../apps/api/src/types/express-augment.ts) to add `project?: Project` to `req.caller`.

`projectScope` does **not** check whether a member is assigned to the project — that's the capability layer's job. It only verifies the caller belongs to the project's org. Without that gate, a member of org A could read a project in org B by guessing the id.

## Service (`projects/service.ts`)

### `listProjects(orgId, callerMembership, opts)`

For owner/admin → return every non-archived project (or all, if `includeArchived`).
For member → return only projects with an active assignment for `caller.userId`.

Use a single SQL query in each case; do not load and post-filter:

```ts
if (caller.role === 'member') {
  return prisma.project.findMany({
    where: {
      orgId,
      ...(opts.includeArchived ? {} : { archivedAt: null }),
      assignments: {
        some: { userId: caller.userId, removedAt: null },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
}
return prisma.project.findMany({
  where: { orgId, ...(opts.includeArchived ? {} : { archivedAt: null }) },
  orderBy: { createdAt: 'desc' },
});
```

### `createProject(orgId, caller, input)`

- `can(caller, { type: 'projects:create' })` → 403 otherwise.
- One transaction:
  1. Insert `Project` row with `createdBy = caller.userId`.
  2. Auto-assign the creator? **No** — keep `assignments` empty by default. Admins can always read their own projects (capability allows it); members would need an explicit assignment, but a member can't create a project anyway.
  3. Audit `project.created`.
- Return `toProjectDto(project)`.

### `getProject(project, caller)`

`projectScope` already loaded the project. Capability check:

- Owner/admin → always allowed.
- Member → need an active assignment. Compute by querying `project_assignments` for `(projectId, userId, removedAt: null)`.
- 403 with the same generic message as non-member; we don't leak whether the project exists vs whether the caller is excluded.

Return `toProjectDto(project)`.

### `updateProject(project, caller, patch)`

- `can(caller, { type: 'projects:create' })` (same admin-or-owner gate).
- One transaction:
  1. Update fields from patch.
  2. If `name`/`description`/`screenshotIntervalMinutes`/`blurScreenshots` actually changed, audit `project.updated` (new audit action — add to the union now). If nothing changed (patch was a no-op), still write the audit row to keep "they tried to update X at this time" visible.
- Return `toProjectDto(updated)`.

### `setArchived(project, caller, archived)`

- `can(caller, { type: 'projects:create' })`.
- Idempotent: if already in the requested state, no-op write but still audit.
- One transaction:
  1. Update `archivedAt = archived ? now() : null`.
  2. Audit `project.archived` (when archiving) or `project.unarchived` (new — add to the union when un-archiving).
- Return `toProjectDto(updated)`.

### `listAssignments(projectId, includeRemoved)`

Return all assignments (default: only `removedAt = null`), with embedded user data via `include: { user: true }`. Caller is already in the project's org (gated by `projectScope`); listing assignments is a read action available to every active member. **Members can see who else is on a project they're on**, per Plan 04 README decision.

### `addAssignment(project, caller, input)`

- `can(caller, { type: 'projects:assign_members' })` (new action; same role gate as `members:invite`).
- Verify the target user has an active membership in the project's org. 422 otherwise.
- Upsert the assignment row (per [schema.md](./schema.md) — `(projectId, userId)` is unique). If a row exists with `removedAt != null`, flip `removedAt` back to `null` and update `assignedAt`. If a row exists with `removedAt = null`, return 409 (already assigned).
- One transaction:
  1. Upsert.
  2. Audit `project.assignment_added`.

### `updateAssignment(project, caller, targetUserId, patch)`

- `can(caller, { type: 'projects:assign_members' })`.
- Update `hourlyRateCents`. Cannot touch `removedAt` here (use the DELETE endpoint).
- Audit `project.assignment_updated` (new — add to the union).

### `removeAssignment(project, caller, targetUserId)`

- `can(caller, { type: 'projects:assign_members' })`.
- Set `removedAt = now()` if currently active. If already removed, 409.
- Audit `project.assignment_removed`.

## Handlers (`projects/handlers.ts`)

Thin glue. Each handler:

1. Pulls `req.caller` (and `req.caller.membership`, `req.caller.project` where applicable).
2. Pulls validated body via the existing `validate()` middleware factory.
3. Calls into the service.
4. Sets status (`201` for creates, `200` for reads/updates, `204` for archive/un-archive/remove with no body).

Capability checks live in the **service**, not the handler — keeps "permissions" co-located with the data writes.

## Wiring

[`apps/api/src/modules/index.ts`](../../apps/api/src/modules/index.ts):

```ts
import { authRouter } from './auth/routes.js';
import { invitationsRouter } from './invitations/routes.js';
import { orgsRouter } from './orgs/routes.js';
import { projectsRouter } from './projects/routes.js'; // NEW

export const v1Routers: Router[] = [authRouter, orgsRouter, invitationsRouter, projectsRouter];
```

One added line — confirms the "one folder + one line" promise from Plan 01 still holds.

## DTO additions

In [`apps/api/src/lib/dto.ts`](../../apps/api/src/lib/dto.ts):

```ts
export interface ProjectDto {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  screenshotIntervalMinutes: number;
  blurScreenshots: boolean;
  archivedAt: string | null;
  createdBy: string;
  createdAt: string;
}
export const toProjectDto = (p: Project): ProjectDto => ({
  id: p.id,
  orgId: p.orgId,
  name: p.name,
  description: p.description,
  screenshotIntervalMinutes: p.screenshotIntervalMinutes,
  blurScreenshots: p.blurScreenshots,
  archivedAt: p.archivedAt?.toISOString() ?? null,
  createdBy: p.createdBy,
  createdAt: p.createdAt.toISOString(),
});

export interface ProjectAssignmentDto {
  id: string;
  projectId: string;
  userId: string;
  hourlyRateCents: number | null;
  assignedAt: string;
  removedAt: string | null;
}
export const toProjectAssignmentDto = (a: ProjectAssignment): ProjectAssignmentDto => ({
  id: a.id,
  projectId: a.projectId,
  userId: a.userId,
  hourlyRateCents: a.hourlyRateCents,
  assignedAt: a.assignedAt.toISOString(),
  removedAt: a.removedAt?.toISOString() ?? null,
});
```

The list-assignments endpoint returns `{ assignments: [{ assignment: ProjectAssignmentDto, user: UserDto }] }` — same envelope shape as the orgs members endpoint.

## Audit additions

Add to [`apps/api/src/auth/audit.ts`](../../apps/api/src/auth/audit.ts) `AuditAction` union:

- `project.created` — already in the union from Plan 02
- `project.updated` — **NEW**
- `project.archived` — already in the union from Plan 02
- `project.unarchived` — **NEW**
- `project.deleted` — already in the union (still unused; reserved)
- `project.assignment_added` — already in the union
- `project.assignment_updated` — **NEW**
- `project.assignment_removed` — already in the union

Three new union members. Their `metadata` JSON should include enough to reconstruct the change without joining other rows: e.g. `project.updated` carries `{ fields: ['name', 'screenshotIntervalMinutes'] }`.
