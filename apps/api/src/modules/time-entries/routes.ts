import { Router } from 'express';

import { asyncHandler } from '../../middleware/async-handler.js';
import { requireAuth } from '../../middleware/bearer-auth.js';
import { idempotency } from '../../middleware/idempotency.js';
import { orgScope } from '../../middleware/org-scope.js';
import { validate } from '../../middleware/validate.js';

import {
  createManualTimeEntryHandler,
  createTimeEntryHandler,
  listTimeEntriesHandler,
  updateTimeEntryHandler,
} from './handlers.js';
import {
  createManualTimeEntryInput,
  createTimeEntryInput,
  listTimeEntriesQuery,
  updateTimeEntryInput,
} from './schemas.js';

export const timeEntriesRouter: Router = Router();

timeEntriesRouter.post(
  '/time-entries',
  requireAuth(),
  idempotency(),
  validate(createTimeEntryInput, 'body'),
  asyncHandler(createTimeEntryHandler),
);

timeEntriesRouter.patch(
  '/time-entries/:id',
  requireAuth(),
  idempotency(),
  validate(updateTimeEntryInput, 'body'),
  asyncHandler(updateTimeEntryHandler),
);

timeEntriesRouter.post(
  '/orgs/:orgId/members/:userId/time-entries',
  requireAuth(),
  orgScope(),
  idempotency(),
  validate(createManualTimeEntryInput, 'body'),
  asyncHandler(createManualTimeEntryHandler),
);

timeEntriesRouter.get(
  '/orgs/:orgId/time-entries',
  requireAuth(),
  orgScope(),
  validate(listTimeEntriesQuery, 'query'),
  asyncHandler(listTimeEntriesHandler),
);
