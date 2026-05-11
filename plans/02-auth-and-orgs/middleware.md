# Auth & Orgs — Middleware

This plan replaces the two stubs from [Plan 01](../01-backend-structure/) with real implementations and tightens [`express.d.ts`](../../apps/api/src/types/express.d.ts).

## `req.caller` typing

Replace `unknown` with real Prisma types:

```ts
import 'express';
import type { Logger } from 'pino';
import type { User, Token, Device, Membership } from '@prisma/client';

declare module 'express-serve-static-core' {
  interface Request {
    id: string;
    log: Logger;
    caller?: {
      user: User;
      token: Token;
      device?: Device;
      membership?: Membership;
    };
  }
}

export {};
```

After this change, every handler that runs after `requireAuth()` can read `req.caller.user` with full Prisma typing for free. After `orgScope()` runs, `req.caller.membership` is also typed.

## `bearer-auth.ts` (real)

```ts
import type { NextFunction, Request, Response } from 'express';
import type { TokenKind } from '@prisma/client';

import { verifyAndSlide } from '../auth/tokens.js';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';

export interface RequireAuthOptions {
  kinds?: TokenKind[];
}

export const requireAuth =
  (opts: RequireAuthOptions = {}) =>
  async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const header = req.get('authorization');
      if (!header?.startsWith('Bearer ')) {
        throw new AppError('unauthorized', 401, 'missing token');
      }

      const presented = header.slice(7);
      const { token } = await verifyAndSlide(presented);

      if (opts.kinds && !opts.kinds.includes(token.kind)) {
        throw new AppError('forbidden', 403, 'wrong token kind');
      }

      const user = await prisma.user.findUnique({ where: { id: token.userId } });
      if (!user || user.deletedAt) {
        throw new AppError('unauthorized', 401, 'user no longer exists');
      }

      const device =
        token.kind === 'device' && token.deviceId
          ? await prisma.device.findUnique({ where: { id: token.deviceId } })
          : null;

      req.caller = {
        user,
        token,
        ...(device ? { device } : {}),
      };
      next();
    } catch (err) {
      next(err);
    }
  };

export const requireDevice = () => requireAuth({ kinds: ['device'] });
```

Notes:

- `verifyAndSlide` does the sha256 lookup, expiry/revocation checks, and the debounced expiry slide. Middleware just wires it to Express.
- We check `user.deletedAt` because tokens outlive a soft-delete by design (cascades only on hard delete).
- `device` is fetched in a separate query rather than via `include` so the hot path on web tokens (the common case) is one round-trip, not one with an unused join.

## `org-scope.ts` (real)

```ts
import type { NextFunction, Request, Response } from 'express';

import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';

export const orgScope =
  () =>
  async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const orgId = req.params['orgId'];
      if (!orgId) {
        throw new AppError('invalid_input', 400, 'missing orgId in path');
      }
      if (!req.caller) {
        throw new AppError('unauthorized', 401, 'auth required before orgScope');
      }

      const membership = await prisma.membership.findUnique({
        where: {
          orgId_userId: { orgId, userId: req.caller.user.id },
        },
      });

      if (!membership || membership.status !== 'active') {
        throw new AppError('forbidden', 403, 'not a member of this org');
      }

      req.caller.membership = membership;
      next();
    } catch (err) {
      next(err);
    }
  };
```

Notes:

- The compound unique key `(orgId, userId)` is what makes this a single index lookup.
- Suspended members get a 403, same as non-members. Distinguishing them in the response would leak existence; we don't.
- `orgScope` is **always** mounted _after_ `requireAuth` on the same route. There's no defensive auto-auth — if you forget `requireAuth`, you get the 401 thrown above instead of a silent surprise.

## Wiring in routes

Per [plans/01-backend-structure/modules.md](../01-backend-structure/modules.md), each feature router attaches the middleware explicitly per route. Examples:

```ts
// public — no auth
authRouter.post('/auth/login', validate(loginInput, 'body'), asyncHandler(loginHandler));

// requires a session-equivalent web/device token
authRouter.get('/auth/me', requireAuth(), asyncHandler(meHandler));

// org-scoped — requires both
orgsRouter.get('/orgs/:orgId', requireAuth(), orgScope(), asyncHandler(getOrgHandler));
```

## Module barrel update

`apps/api/src/middleware/index.ts` already re-exports `requireAuth`, `requireDevice`, and `orgScope` (Plan 01 set up the barrel). No changes needed except verifying type imports still resolve after the `express.d.ts` tightening.
