import type { Request, Response } from 'express';

import { AppError } from '../../lib/errors.js';

import * as service from './service.js';
import type { HeartbeatInput, RegisterDeviceInput } from './schemas.js';

const requireCaller = (req: Request) => {
  const c = req.caller;
  if (!c) throw new AppError('unauthorized', 401, 'auth required');
  return c;
};

const callerCtx = (req: Request) => {
  const ua = req.get('user-agent');
  return {
    ...(typeof req.ip === 'string' ? { ipAddress: req.ip } : {}),
    ...(ua ? { userAgent: ua } : {}),
  };
};

export const registerDeviceHandler = async (req: Request, res: Response): Promise<void> => {
  const caller = requireCaller(req);
  if (caller.token.kind !== 'web') {
    throw new AppError('forbidden', 403, 'register requires a web token');
  }
  const result = await service.registerDevice(
    caller.user,
    req.body as RegisterDeviceInput,
    callerCtx(req),
  );
  res.status(201).json(result);
};

export const listDevicesHandler = async (req: Request, res: Response): Promise<void> => {
  const caller = requireCaller(req);
  const devices = await service.listDevices(caller.user.id);
  res.status(200).json({ devices });
};

export const revokeDeviceHandler = async (req: Request, res: Response): Promise<void> => {
  const caller = requireCaller(req);
  const deviceId = req.params['deviceId'];
  if (!deviceId) throw new AppError('invalid_input', 400, 'missing deviceId in path');
  await service.revokeDevice(caller.user, deviceId);
  res.status(204).end();
};

export const heartbeatHandler = async (req: Request, res: Response): Promise<void> => {
  const caller = requireCaller(req);
  if (!caller.device) {
    throw new AppError('forbidden', 403, 'heartbeat requires a device token');
  }
  const dto = await service.heartbeat(caller.device, req.body as HeartbeatInput);
  res.status(200).json(dto);
};
