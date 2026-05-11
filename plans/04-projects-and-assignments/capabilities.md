# Projects & Assignments — Capabilities & Middleware

This plan extends the capability matrix in [`apps/api/src/auth/capabilities.ts`](../../apps/api/src/auth/capabilities.ts) and adds one new middleware.

## Capability matrix additions

The existing `Action` union from Plan 02 already lists `projects:create` and `projects:read`. Plan 04 wires them and adds two more:

```ts
export type Action =
  // ... existing actions from Plan 02 ...
  | { type: 'projects:create' }
  | { type: 'projects:read'; assignedToCaller: boolean } // wired by Plan 04
  | { type: 'projects:assign_members' } // NEW
  | { type: 'projects:edit' }; // NEW (alias of create-permission for clarity at call sites)
// ... rest ...
```

### Role gates

| Action                                          | Owner | Admin | Member |
| ----------------------------------------------- | ----- | ----- | ------ |
| `projects:create`                               | ✓     | ✓     |        |
| `projects:edit`                                 | ✓     | ✓     |        |
| `projects:assign_members`                       | ✓     | ✓     |        |
| `projects:read` (with `assignedToCaller=true`)  | ✓     | ✓     | ✓      |
| `projects:read` (with `assignedToCaller=false`) | ✓     | ✓     |        |

`projects:edit` is **the same** as `projects:create` for the role check (both require admin or owner). The two action names exist so call sites can read what they actually do (`update`, `archive`, `un-archive` use `projects:edit`; `create` uses `projects:create`). Internally `can()` falls through to the same branch.

### Updated `can()` body

```ts
export const can = (m: Membership, action: Action): boolean => {
  if (m.status !== 'active') return false;

  switch (action.type) {
    // ... existing cases ...

    case 'projects:create':
    case 'projects:edit':
    case 'projects:assign_members':
      return m.role === 'owner' || m.role === 'admin';

    case 'projects:read':
      if (m.role === 'owner' || m.role === 'admin') return true;
      return action.assignedToCaller;

    // ... existing cases ...
  }
};
```

The compiler-exhaustiveness check (`switch` over a discriminated union) catches missing branches at typecheck time. New actions added to the union without a matching branch fail `pnpm typecheck`.

## Capability matrix tests

The existing test in [`apps/api/src/auth/capabilities.test.ts`](../../apps/api/src/auth/capabilities.test.ts) iterates every `(role, action)` pair. Plan 04 adds rows:

```ts
const cases = [
  // ... existing rows ...

  { role: 'owner', action: { type: 'projects:create' }, expect: true },
  { role: 'admin', action: { type: 'projects:create' }, expect: true },
  { role: 'member', action: { type: 'projects:create' }, expect: false },

  { role: 'owner', action: { type: 'projects:edit' }, expect: true },
  { role: 'admin', action: { type: 'projects:edit' }, expect: true },
  { role: 'member', action: { type: 'projects:edit' }, expect: false },

  { role: 'owner', action: { type: 'projects:assign_members' }, expect: true },
  { role: 'admin', action: { type: 'projects:assign_members' }, expect: true },
  { role: 'member', action: { type: 'projects:assign_members' }, expect: false },

  // projects:read has two variants per role
  { role: 'owner', action: { type: 'projects:read', assignedToCaller: true }, expect: true },
  { role: 'owner', action: { type: 'projects:read', assignedToCaller: false }, expect: true },
  { role: 'admin', action: { type: 'projects:read', assignedToCaller: true }, expect: true },
  { role: 'admin', action: { type: 'projects:read', assignedToCaller: false }, expect: true },
  { role: 'member', action: { type: 'projects:read', assignedToCaller: true }, expect: true },
  { role: 'member', action: { type: 'projects:read', assignedToCaller: false }, expect: false },

  // suspended members never get access regardless of assignment
  // (test the suspended-status branch separately in one row per action)
];
```

Twelve new cases. Plus one or two suspended-member rows to confirm `m.status !== 'active'` short-circuits to `false` for every projects action.

## `projectScope` middleware

Specified in [modules.md](./modules.md#projectscope-middleware). It does **two** things:

1. Loads the project by `:projectId`. 404 if not found.
2. Loads the caller's active membership in the project's org. 403 if absent.

It does **not** check whether the caller is _assigned_ to the project — that's a capability concern (`projects:read` with `assignedToCaller`) handled in the service layer where we have the data needed to compute it.

### Why split the gates this way

- `projectScope` is the cheap pre-check (two indexed lookups). It rejects obviously-wrong cases (project doesn't exist, caller isn't even in the right org).
- The service layer does the assignment check because it already has the project loaded and is about to query the assignment row anyway. Combining these saves one round-trip.
- The split also lets _list endpoints_ skip the assignment check entirely — `GET /orgs/:orgId/projects` filters by assignment in SQL, so individual capability checks are not needed.

### Order on routes

```ts
projectsRouter.get(
  '/projects/:projectId',
  requireAuth(), // Layer 1: bearer token
  projectScope(), // Layer 2: project exists, caller in right org
  asyncHandler(getProjectHandler), // Layer 3: capability via service
);
```

Same shape as `requireAuth() + orgScope()` from Plan 02.

## Express type augmentation update

[`apps/api/src/types/express-augment.ts`](../../apps/api/src/types/express-augment.ts) currently has:

```ts
caller?: {
  user: User;
  token: Token;
  device?: Device;
  membership?: Membership;
};
```

Add `project?: Project`:

```ts
import type { Device, Membership, Project, Token, User } from '@prisma/client';

caller?: {
  user: User;
  token: Token;
  device?: Device;
  membership?: Membership;
  project?: Project;       // NEW
};
```

Handlers under `projectScope()` can now read `req.caller.project` with full Prisma typing for free.

## Capability checks in `projects/service.ts`

Each service function calls `can()` once at the top:

```ts
import { can } from '../../auth/capabilities.js';
import { AppError } from '../../lib/errors.js';

export const updateProject = async (
  project: Project,
  caller: Membership,
  patch: UpdateProjectInput,
): Promise<ProjectDto> => {
  if (!can(caller, { type: 'projects:edit' })) {
    throw new AppError('forbidden', 403, 'requires owner or admin');
  }
  // ... transaction ...
};
```

The `getProject` service is the only one that needs the assignment-aware variant:

```ts
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
```

Owners and admins skip the assignment query entirely (the `caller.role === 'member'` short-circuit). Members pay one lookup, but only on the project-detail route — the list route filters in SQL.
