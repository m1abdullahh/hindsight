import type { Request, Response } from 'express';

import { AppError } from '../../lib/errors.js';

import * as service from './service.js';
import type { AddMemberDirectInput, UpdateMemberInput, UpdateOrgInput } from './schemas.js';

const requireMembership = (req: Request) => {
  const m = req.caller?.membership;
  if (!m) throw new AppError('forbidden', 403, 'org membership required');
  return m;
};

const requireOrgIdParam = (req: Request): string => {
  const orgId = req.params['orgId'];
  if (!orgId) throw new AppError('invalid_input', 400, 'missing orgId in path');
  return orgId;
};

const requireUserIdParam = (req: Request): string => {
  const userId = req.params['userId'];
  if (!userId) throw new AppError('invalid_input', 400, 'missing userId in path');
  return userId;
};

export const getOrgHandler = async (req: Request, res: Response): Promise<void> => {
  const orgId = requireOrgIdParam(req);
  requireMembership(req);
  const org = await service.getOrg(orgId);
  res.status(200).json(org);
};

export const updateOrgHandler = async (req: Request, res: Response): Promise<void> => {
  const orgId = requireOrgIdParam(req);
  const m = requireMembership(req);
  const result = await service.updateOrg(m, orgId, req.body as UpdateOrgInput);
  res.status(200).json(result);
};

export const listMembersHandler = async (req: Request, res: Response): Promise<void> => {
  const orgId = requireOrgIdParam(req);
  requireMembership(req);
  const rows = await service.listMembers(orgId);
  res.status(200).json({ members: rows });
};

export const updateMemberHandler = async (req: Request, res: Response): Promise<void> => {
  const orgId = requireOrgIdParam(req);
  const userId = requireUserIdParam(req);
  const m = requireMembership(req);
  const result = await service.updateMember(m, orgId, userId, req.body as UpdateMemberInput);
  res.status(200).json(result);
};

export const removeMemberHandler = async (req: Request, res: Response): Promise<void> => {
  const orgId = requireOrgIdParam(req);
  const userId = requireUserIdParam(req);
  const m = requireMembership(req);
  await service.removeMember(m, orgId, userId);
  res.status(204).end();
};

export const addMemberDirectHandler = async (req: Request, res: Response): Promise<void> => {
  const orgId = requireOrgIdParam(req);
  const m = requireMembership(req);
  const result = await service.addMemberDirect(m, orgId, req.body as AddMemberDirectInput);
  res.status(201).json(result);
};
