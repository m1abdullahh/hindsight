import type { Request, Response } from 'express';

import { AppError } from '../../lib/errors.js';

import * as service from './service.js';
import type { AcceptInviteInput, CreateInviteInput } from './schemas.js';

const requireMembership = (req: Request) => {
  const m = req.caller?.membership;
  if (!m) throw new AppError('forbidden', 403, 'org membership required');
  return m;
};

const requireCaller = (req: Request) => {
  const c = req.caller;
  if (!c) throw new AppError('unauthorized', 401, 'auth required');
  return c;
};

const requireOrgIdParam = (req: Request): string => {
  const orgId = req.params['orgId'];
  if (!orgId) throw new AppError('invalid_input', 400, 'missing orgId in path');
  return orgId;
};

const requireInvitationIdParam = (req: Request): string => {
  const id = req.params['invitationId'];
  if (!id) throw new AppError('invalid_input', 400, 'missing invitationId in path');
  return id;
};

const callerCtx = (req: Request) => {
  const ua = req.get('user-agent');
  return {
    ...(typeof req.ip === 'string' ? { ipAddress: req.ip } : {}),
    ...(ua ? { userAgent: ua } : {}),
  };
};

export const createInviteHandler = async (req: Request, res: Response): Promise<void> => {
  const orgId = requireOrgIdParam(req);
  const m = requireMembership(req);
  const caller = requireCaller(req);
  const result = await service.createInvite(
    m,
    orgId,
    req.body as CreateInviteInput,
    caller.user.name,
  );
  res.status(201).json(result);
};

export const listInvitesHandler = async (req: Request, res: Response): Promise<void> => {
  const orgId = requireOrgIdParam(req);
  const m = requireMembership(req);
  if (m.role === 'member') {
    throw new AppError('forbidden', 403, 'requires owner or admin');
  }
  const invitations = await service.listInvites(orgId);
  res.status(200).json({ invitations });
};

export const revokeInviteHandler = async (req: Request, res: Response): Promise<void> => {
  const orgId = requireOrgIdParam(req);
  const invitationId = requireInvitationIdParam(req);
  const m = requireMembership(req);
  await service.revokeInvite(m, orgId, invitationId);
  res.status(204).end();
};

export const acceptInviteHandler = async (req: Request, res: Response): Promise<void> => {
  const result = await service.acceptInvite(req.body as AcceptInviteInput, callerCtx(req));
  res.status(201).json(result);
};
