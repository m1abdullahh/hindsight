import { Router } from 'express';

import { asyncHandler } from '../../middleware/async-handler.js';
import { requireAuth } from '../../middleware/bearer-auth.js';
import { orgScope } from '../../middleware/org-scope.js';
import { validate } from '../../middleware/validate.js';

import { timeTotalsByDayHandler, timeTotalsHandler } from './handlers.js';
import { timeTotalsByDayQuery, timeTotalsQuery } from './schemas.js';

export const reportsRouter: Router = Router();

reportsRouter.get(
  '/orgs/:orgId/reports/time-totals',
  requireAuth(),
  orgScope(),
  validate(timeTotalsQuery, 'query'),
  asyncHandler(timeTotalsHandler),
);

reportsRouter.get(
  '/orgs/:orgId/reports/time-totals-by-day',
  requireAuth(),
  orgScope(),
  validate(timeTotalsByDayQuery, 'query'),
  asyncHandler(timeTotalsByDayHandler),
);
