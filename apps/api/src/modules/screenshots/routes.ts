import { Router } from 'express';

import { asyncHandler } from '../../middleware/async-handler.js';
import { requireAuth, requireDevice } from '../../middleware/bearer-auth.js';
import { idempotency } from '../../middleware/idempotency.js';
import { orgScope } from '../../middleware/org-scope.js';
import { validate } from '../../middleware/validate.js';

import {
  confirmHandler,
  deleteScreenshotHandler,
  getScreenshotHandler,
  listScreenshotsHandler,
  presignHandler,
} from './handlers.js';
import { confirmInput, listScreenshotsQuery, presignInput } from './schemas.js';

export const screenshotsRouter: Router = Router();

screenshotsRouter.post(
  '/screenshots/presign',
  requireDevice(),
  idempotency(),
  validate(presignInput, 'body'),
  asyncHandler(presignHandler),
);

screenshotsRouter.post(
  '/screenshots/:id/confirm',
  requireDevice(),
  idempotency(),
  validate(confirmInput, 'body'),
  asyncHandler(confirmHandler),
);

screenshotsRouter.get(
  '/orgs/:orgId/screenshots',
  requireAuth(),
  orgScope(),
  validate(listScreenshotsQuery, 'query'),
  asyncHandler(listScreenshotsHandler),
);

screenshotsRouter.get('/screenshots/:id', requireAuth(), asyncHandler(getScreenshotHandler));

screenshotsRouter.delete('/screenshots/:id', requireAuth(), asyncHandler(deleteScreenshotHandler));
