import { Router } from 'express';

import { asyncHandler } from '../../middleware/async-handler.js';
import { requireAuth } from '../../middleware/bearer-auth.js';
import { orgScope } from '../../middleware/org-scope.js';
import { projectScope } from '../../middleware/project-scope.js';
import { validate } from '../../middleware/validate.js';

import {
  addAssignmentHandler,
  archiveProjectHandler,
  createProjectHandler,
  getProjectHandler,
  listAssignmentsHandler,
  listProjectsHandler,
  removeAssignmentHandler,
  unarchiveProjectHandler,
  updateAssignmentHandler,
  updateProjectHandler,
} from './handlers.js';
import {
  createAssignmentInput,
  createProjectInput,
  updateAssignmentInput,
  updateProjectInput,
} from './schemas.js';

export const projectsRouter: Router = Router();

// Org-scoped routes (create / list)
projectsRouter.get(
  '/orgs/:orgId/projects',
  requireAuth(),
  orgScope(),
  asyncHandler(listProjectsHandler),
);

projectsRouter.post(
  '/orgs/:orgId/projects',
  requireAuth(),
  orgScope(),
  validate(createProjectInput, 'body'),
  asyncHandler(createProjectHandler),
);

// Project-scoped routes (detail / update / archive)
projectsRouter.get(
  '/projects/:projectId',
  requireAuth(),
  projectScope(),
  asyncHandler(getProjectHandler),
);

projectsRouter.patch(
  '/projects/:projectId',
  requireAuth(),
  projectScope(),
  validate(updateProjectInput, 'body'),
  asyncHandler(updateProjectHandler),
);

projectsRouter.post(
  '/projects/:projectId/archive',
  requireAuth(),
  projectScope(),
  asyncHandler(archiveProjectHandler),
);

projectsRouter.delete(
  '/projects/:projectId/archive',
  requireAuth(),
  projectScope(),
  asyncHandler(unarchiveProjectHandler),
);

// Assignments
projectsRouter.get(
  '/projects/:projectId/assignments',
  requireAuth(),
  projectScope(),
  asyncHandler(listAssignmentsHandler),
);

projectsRouter.post(
  '/projects/:projectId/assignments',
  requireAuth(),
  projectScope(),
  validate(createAssignmentInput, 'body'),
  asyncHandler(addAssignmentHandler),
);

projectsRouter.patch(
  '/projects/:projectId/assignments/:userId',
  requireAuth(),
  projectScope(),
  validate(updateAssignmentInput, 'body'),
  asyncHandler(updateAssignmentHandler),
);

projectsRouter.delete(
  '/projects/:projectId/assignments/:userId',
  requireAuth(),
  projectScope(),
  asyncHandler(removeAssignmentHandler),
);
