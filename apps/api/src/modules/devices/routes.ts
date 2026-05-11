import { Router } from 'express';

import { asyncHandler } from '../../middleware/async-handler.js';
import { requireAuth, requireDevice } from '../../middleware/bearer-auth.js';
import { idempotency } from '../../middleware/idempotency.js';
import { validate } from '../../middleware/validate.js';

import {
  heartbeatHandler,
  listDevicesHandler,
  registerDeviceHandler,
  revokeDeviceHandler,
} from './handlers.js';
import { heartbeatInput, registerDeviceInput } from './schemas.js';

export const devicesRouter: Router = Router();

devicesRouter.post(
  '/devices/register',
  requireAuth({ kinds: ['web'] }),
  idempotency(),
  validate(registerDeviceInput, 'body'),
  asyncHandler(registerDeviceHandler),
);

devicesRouter.get('/devices', requireAuth(), asyncHandler(listDevicesHandler));

devicesRouter.delete('/devices/:deviceId', requireAuth(), asyncHandler(revokeDeviceHandler));

// Heartbeats are intrinsically idempotent (latest write wins) and fire every
// ~15s while the app is running. Requiring an Idempotency-Key here just
// pollutes Redis and forces clients to mint a UUID per call for no benefit.
devicesRouter.post(
  '/devices/heartbeat',
  requireDevice(),
  validate(heartbeatInput, 'body'),
  asyncHandler(heartbeatHandler),
);
