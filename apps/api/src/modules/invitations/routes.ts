import { Router } from 'express';

import { asyncHandler } from '../../middleware/async-handler.js';
import { requireAuth } from '../../middleware/bearer-auth.js';
import { orgScope } from '../../middleware/org-scope.js';
import { validate } from '../../middleware/validate.js';

import {
  acceptInviteHandler,
  createInviteHandler,
  listInvitesHandler,
  revokeInviteHandler,
} from './handlers.js';
import { acceptInviteInput, createInviteInput } from './schemas.js';

export const invitationsRouter: Router = Router();

invitationsRouter.post(
  '/orgs/:orgId/invitations',
  requireAuth(),
  orgScope(),
  validate(createInviteInput, 'body'),
  asyncHandler(createInviteHandler),
);

invitationsRouter.get(
  '/orgs/:orgId/invitations',
  requireAuth(),
  orgScope(),
  asyncHandler(listInvitesHandler),
);

invitationsRouter.delete(
  '/orgs/:orgId/invitations/:invitationId',
  requireAuth(),
  orgScope(),
  asyncHandler(revokeInviteHandler),
);

invitationsRouter.post(
  '/auth/invitations/accept',
  validate(acceptInviteInput, 'body'),
  asyncHandler(acceptInviteHandler),
);
