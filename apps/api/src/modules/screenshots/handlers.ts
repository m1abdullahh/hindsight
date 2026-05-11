import type { Request, Response } from 'express';

import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';

import * as service from './service.js';
import type { ConfirmInput, ListScreenshotsQuery, PresignInput } from './schemas.js';

const requireCaller = (req: Request) => {
  const c = req.caller;
  if (!c) throw new AppError('unauthorized', 401, 'auth required');
  return c;
};

const requireDeviceCaller = (req: Request) => {
  const caller = requireCaller(req);
  if (caller.token.kind !== 'device' || !caller.device) {
    throw new AppError('forbidden', 403, 'requires a device token');
  }
  return { caller, deviceId: caller.device.id };
};

export const presignHandler = async (req: Request, res: Response): Promise<void> => {
  const { caller, deviceId } = requireDeviceCaller(req);
  const result = await service.presignScreenshot(
    { userId: caller.user.id, deviceId },
    req.body as PresignInput,
  );
  res.status(201).json(result);
};

export const confirmHandler = async (req: Request, res: Response): Promise<void> => {
  const { caller, deviceId } = requireDeviceCaller(req);
  const id = req.params['id'];
  if (!id) throw new AppError('invalid_input', 400, 'missing screenshot id');
  const dto = await service.confirmScreenshot(
    { userId: caller.user.id, deviceId },
    id,
    req.body as ConfirmInput,
  );
  res.status(200).json(dto);
};

export const listScreenshotsHandler = async (req: Request, res: Response): Promise<void> => {
  const caller = requireCaller(req);
  const orgId = req.params['orgId'];
  if (!orgId) throw new AppError('invalid_input', 400, 'missing orgId');
  const m = caller.membership;
  if (!m) throw new AppError('forbidden', 403, 'org membership required');
  const page = await service.listScreenshots(
    orgId,
    m,
    req.query as unknown as ListScreenshotsQuery,
  );
  res.status(200).json(page);
};

export const getScreenshotHandler = async (req: Request, res: Response): Promise<void> => {
  const caller = requireCaller(req);
  const id = req.params['id'];
  if (!id) throw new AppError('invalid_input', 400, 'missing screenshot id');

  // Resolve membership in the screenshot's org. We don't have orgScope here
  // because /screenshots/:id has no orgId in path.
  const row = await prisma.screenshot.findUnique({
    where: { id },
    include: { timeEntry: { include: { project: { select: { orgId: true } } } } },
  });
  if (!row || row.deletedAt) throw new AppError('not_found', 404, 'screenshot not found');

  const membership = await prisma.membership.findUnique({
    where: {
      orgId_userId: { orgId: row.timeEntry.project.orgId, userId: caller.user.id },
    },
  });
  if (!membership || membership.status !== 'active') {
    throw new AppError('forbidden', 403, "not a member of this screenshot's org");
  }

  const detail = await service.getScreenshot(membership, id);
  res.status(200).json(detail);
};

export const deleteScreenshotHandler = async (req: Request, res: Response): Promise<void> => {
  const caller = requireCaller(req);
  const id = req.params['id'];
  if (!id) throw new AppError('invalid_input', 400, 'missing screenshot id');

  const row = await prisma.screenshot.findUnique({
    where: { id },
    include: { timeEntry: { include: { project: { select: { orgId: true } } } } },
  });
  if (!row || row.deletedAt) throw new AppError('not_found', 404, 'screenshot not found');

  const membership = await prisma.membership.findUnique({
    where: {
      orgId_userId: { orgId: row.timeEntry.project.orgId, userId: caller.user.id },
    },
  });
  if (!membership || membership.status !== 'active') {
    throw new AppError('forbidden', 403, "not a member of this screenshot's org");
  }

  await service.deleteScreenshot(membership, id);
  res.status(204).end();
};
