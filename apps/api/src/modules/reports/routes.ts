import { Router } from 'express';

import { asyncHandler } from '../../middleware/async-handler.js';
import { requireAuth } from '../../middleware/bearer-auth.js';
import { orgScope } from '../../middleware/org-scope.js';
import { validate } from '../../middleware/validate.js';

import { timeTotalsHandler } from './handlers.js';
import { timeTotalsQuery } from './schemas.js';

export const reportsRouter: Router = Router();

reportsRouter.get(
  '/orgs/:orgId/reports/time-totals',
  requireAuth(),
  orgScope(),
  validate(timeTotalsQuery, 'query'),
  asyncHandler(timeTotalsHandler),
);
