import type { NextFunction, Request, Response } from 'express';

import { ulid } from '../lib/id.js';
import { logger } from '../lib/logger.js';

export const requestContext = (req: Request, _res: Response, next: NextFunction): void => {
  req.id = ulid();
  req.log = logger.child({ reqId: req.id });
  next();
};
