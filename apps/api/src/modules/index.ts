import type { Router } from 'express';

import { authRouter } from './auth/routes.js';
import { devicesRouter } from './devices/routes.js';
import { invitationsRouter } from './invitations/routes.js';
import { orgsRouter } from './orgs/routes.js';
import { presenceRouter } from './presence/routes.js';
import { projectsRouter } from './projects/routes.js';
import { reportsRouter } from './reports/routes.js';
import { screenshotsRouter } from './screenshots/routes.js';
import { searchRouter } from './search/routes.js';
import { timeEntriesRouter } from './time-entries/routes.js';

// Feature module routers under /api/v1.
// A new feature = drop a folder under modules/ and add one line here.
export const v1Routers: Router[] = [
  authRouter,
  orgsRouter,
  invitationsRouter,
  projectsRouter,
  devicesRouter,
  timeEntriesRouter,
  screenshotsRouter,
  reportsRouter,
  presenceRouter,
  searchRouter,
];
