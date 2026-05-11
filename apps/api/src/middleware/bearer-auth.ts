import type { TokenKind } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';

import { verifyAndSlide } from '../auth/tokens.js';
import { AppError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';

export type { TokenKind };

export interface RequireAuthOptions {
  kinds?: TokenKind[];
}

export const requireAuth =
  (opts: RequireAuthOptions = {}) =>
  async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const header = req.get('authorization');
      if (!header?.startsWith('Bearer ')) {
        throw new AppError('unauthorized', 401, 'missing token');
      }

      const presented = header.slice(7);
      const { token } = await verifyAndSlide(presented);

      if (opts.kinds && !opts.kinds.includes(token.kind)) {
        throw new AppError('forbidden', 403, 'wrong token kind');
      }

      const user = await prisma.user.findUnique({ where: { id: token.userId } });
      if (!user || user.deletedAt) {
        throw new AppError('unauthorized', 401, 'user no longer exists');
      }

      let device = null;
      if (token.kind === 'device') {
        if (!token.deviceId) {
          throw new AppError('unauthorized', 401, 'device token missing device link');
        }
        device = await prisma.device.findUnique({ where: { id: token.deviceId } });
        if (!device || device.revokedAt) {
          throw new AppError('unauthorized', 401, 'device revoked');
        }
      }

      req.caller = {
        user,
        token,
        ...(device ? { device } : {}),
      };
      next();
    } catch (err) {
      next(err);
    }
  };

export const requireDevice = (): ReturnType<typeof requireAuth> =>
  requireAuth({ kinds: ['device'] });
