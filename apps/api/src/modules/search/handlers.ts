import type { Request, Response } from 'express';

import { AppError } from '../../lib/errors.js';

import { search } from './service.js';
import type { SearchQuery } from './schemas.js';

const requireMembership = (req: Request) => {
  const m = req.caller?.membership;
  if (!m) throw new AppError('forbidden', 403, 'org membership required');
  return m;
};

const requireOrgIdParam = (req: Request): string => {
  const orgId = req.params['orgId'];
  if (!orgId) throw new AppError('invalid_input', 400, 'missing orgId in path');
  return orgId;
};

export const searchHandler = async (req: Request, res: Response): Promise<void> => {
  const orgId = requireOrgIdParam(req);
  const m = requireMembership(req);
  const result = await search(orgId, m, req.query as unknown as SearchQuery);
  res.status(200).json(result);
};
