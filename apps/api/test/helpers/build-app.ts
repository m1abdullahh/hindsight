import type { Express } from 'express';

import { buildApp } from '../../src/app.js';

export const makeTestApp = (): Express => buildApp();
