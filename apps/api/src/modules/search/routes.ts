import { Router } from 'express';

import { asyncHandler } from '../../middleware/async-handler.js';
import { requireAuth } from '../../middleware/bearer-auth.js';
import { orgScope } from '../../middleware/org-scope.js';
import { validate } from '../../middleware/validate.js';

import { searchHandler } from './handlers.js';
import { searchQuery } from './schemas.js';

export const searchRouter: Router = Router();

searchRouter.get(
  '/orgs/:orgId/search',
  requireAuth(),
  orgScope(),
  validate(searchQuery, 'query'),
  asyncHandler(searchHandler),
);
