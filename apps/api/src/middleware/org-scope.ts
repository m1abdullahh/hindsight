import type { NextFunction, Request, Response } from 'express';

import { resolveActiveMembership } from '../auth/membership.js';
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

      req.caller.membership = await resolveActiveMembership(orgId, req.caller.user.id);
      next();
    } catch (err) {
      next(err);
    }
  };
