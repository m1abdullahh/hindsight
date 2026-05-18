import { Router } from 'express';

import { asyncHandler } from '../../middleware/async-handler.js';
import { requireAuth } from '../../middleware/bearer-auth.js';
import { orgScope } from '../../middleware/org-scope.js';
import { validate } from '../../middleware/validate.js';

import {
  addMemberDirectHandler,
  getOrgHandler,
  listMembersHandler,
  removeMemberHandler,
  updateMemberHandler,
  updateOrgHandler,
} from './handlers.js';
import { addMemberDirectInput, updateMemberInput, updateOrgInput } from './schemas.js';

export const orgsRouter: Router = Router();

orgsRouter.get('/orgs/:orgId', requireAuth(), orgScope(), asyncHandler(getOrgHandler));

orgsRouter.patch(
  '/orgs/:orgId',
  requireAuth(),
  orgScope(),
  validate(updateOrgInput, 'body'),
  asyncHandler(updateOrgHandler),
);

orgsRouter.get('/orgs/:orgId/members', requireAuth(), orgScope(), asyncHandler(listMembersHandler));

orgsRouter.post(
  '/orgs/:orgId/members/direct',
  requireAuth(),
  orgScope(),
  validate(addMemberDirectInput, 'body'),
  asyncHandler(addMemberDirectHandler),
);

orgsRouter.patch(
  '/orgs/:orgId/members/:userId',
  requireAuth(),
  orgScope(),
  validate(updateMemberInput, 'body'),
  asyncHandler(updateMemberHandler),
);

orgsRouter.delete(
  '/orgs/:orgId/members/:userId',
  requireAuth(),
  orgScope(),
  asyncHandler(removeMemberHandler),
);
