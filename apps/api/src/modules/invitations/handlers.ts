import type { Request, Response } from 'express';

import { verifyAndSlide } from '../../auth/tokens.js';
import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';

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

// Resolve the bearer token if one is present, but don't reject when it's
// missing — accept-invite is the one route that must work both anonymously
// (new user creating an account) and authenticated (existing user with a
// matching email). When a *different* user is signed in, the service throws
// 409 so the UI can prompt them to log out first.
const optionalCallerEmail = async (req: Request): Promise<string | undefined> => {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) return undefined;
  try {
    const { token } = await verifyAndSlide(header.slice(7));
    const user = await prisma.user.findUnique({ where: { id: token.userId } });
    if (!user || user.deletedAt) return undefined;
    return user.email;
  } catch {
    // Invalid/expired tokens just behave as "anonymous" here; we don't
    // surface a 401 to a user trying to accept an invite link.
    return undefined;
  }
};

export const acceptInviteHandler = async (req: Request, res: Response): Promise<void> => {
  const authenticatedUserEmail = await optionalCallerEmail(req);
  const result = await service.acceptInvite(req.body as AcceptInviteInput, {
    ...callerCtx(req),
    ...(authenticatedUserEmail ? { authenticatedUserEmail } : {}),
  });
  res.status(201).json(result);
};
