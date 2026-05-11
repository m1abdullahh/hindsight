import type { Request, Response } from 'express';

import { AppError } from '../../lib/errors.js';

import { computePresence } from './service.js';

const requireCaller = (req: Request) => {
  const c = req.caller;
  if (!c) throw new AppError('unauthorized', 401, 'auth required');
  return c;
};

export const presenceHandler = async (req: Request, res: Response): Promise<void> => {
  const caller = requireCaller(req);
  const orgId = req.params['orgId'];
  if (!orgId) throw new AppError('invalid_input', 400, 'missing orgId in path');
  if (!caller.membership) throw new AppError('forbidden', 403, 'org membership required');

  const result = await computePresence(orgId);
  res.status(200).json(result);
};
