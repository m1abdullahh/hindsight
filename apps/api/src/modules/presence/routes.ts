import { Router } from 'express';

import { asyncHandler } from '../../middleware/async-handler.js';
import { requireAuth } from '../../middleware/bearer-auth.js';
import { orgScope } from '../../middleware/org-scope.js';

import { presenceHandler } from './handlers.js';

export const presenceRouter: Router = Router();

presenceRouter.get(
  '/orgs/:orgId/presence',
  requireAuth(),
  orgScope(),
  asyncHandler(presenceHandler),
);
