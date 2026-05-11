import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';

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
        where: { orgId_userId: { orgId, userId: req.caller.user.id } },
        include: { organization: { select: { deletedAt: true } } },
      });

      if (!membership || membership.status !== 'active' || membership.organization.deletedAt) {
        throw new AppError('forbidden', 403, 'not a member of this org');
      }

      // Strip the joined organization slice so the typed `Membership`
      // shape on req.caller stays consistent with the schema row.
      const { organization: _organization, ...flat } = membership;
      req.caller.membership = flat;
      next();
    } catch (err) {
      next(err);
    }
  };
