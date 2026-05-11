import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';

export const projectScope =
  () =>
  async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const projectId = req.params['projectId'];
      if (!projectId) {
        throw new AppError('invalid_input', 400, 'missing projectId in path');
      }
      if (!req.caller) {
        throw new AppError('unauthorized', 401, 'auth required before projectScope');
      }

      const project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project) {
        throw new AppError('not_found', 404, 'project not found');
      }

      const membership = await prisma.membership.findUnique({
        where: {
          orgId_userId: { orgId: project.orgId, userId: req.caller.user.id },
        },
        include: { organization: { select: { deletedAt: true } } },
      });

      if (!membership || membership.status !== 'active' || membership.organization.deletedAt) {
        throw new AppError('forbidden', 403, "not a member of this project's org");
      }

      const { organization: _organization, ...flat } = membership;
      req.caller.project = project;
      req.caller.membership = flat;
      next();
    } catch (err) {
      next(err);
    }
  };
