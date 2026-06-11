import type { Request, Response } from 'express';

import { can } from '../../auth/capabilities.js';
import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';

import * as service from './service.js';
import type {
  CreateManualTimeEntryInput,
  CreateTimeEntryInput,
  ListTimeEntriesQuery,
  UpdateTimeEntryInput,
} from './schemas.js';

const requireCaller = (req: Request) => {
  const c = req.caller;
  if (!c) throw new AppError('unauthorized', 401, 'auth required');
  return c;
};

export const createTimeEntryHandler = async (req: Request, res: Response): Promise<void> => {
  const caller = requireCaller(req);
  if (caller.token.kind !== 'device' || !caller.device) {
    throw new AppError('forbidden', 403, 'requires a device token');
  }
  const dto = await service.startTimeEntry(
    { userId: caller.user.id, deviceId: caller.device.id },
    req.body as CreateTimeEntryInput,
  );
  res.status(201).json(dto);
};

// POST /orgs/:orgId/members/:userId/time-entries — admin/owner manually adds
// time on a member's behalf. orgScope has already resolved the caller's
// membership for :orgId; we gate on the create_manual capability here.
export const createManualTimeEntryHandler = async (req: Request, res: Response): Promise<void> => {
  const caller = requireCaller(req);
  const orgId = req.params['orgId'];
  const userId = req.params['userId'];
  if (!orgId) throw new AppError('invalid_input', 400, 'missing orgId in path');
  if (!userId) throw new AppError('invalid_input', 400, 'missing userId in path');

  const m = caller.membership;
  if (!m || !can(m, { type: 'time_entries:create_manual' })) {
    throw new AppError('forbidden', 403, 'only an admin can add time for a member');
  }

  const dto = await service.createManualTimeEntry(
    { userId: caller.user.id, orgId },
    userId,
    req.body as CreateManualTimeEntryInput,
  );
  res.status(201).json(dto);
};

const isAdminOf =
  (callerUserId: string) =>
  async (orgId: string): Promise<boolean> => {
    const m = await prisma.membership.findUnique({
      where: { orgId_userId: { orgId, userId: callerUserId } },
    });
    return !!m && m.status === 'active' && (m.role === 'owner' || m.role === 'admin');
  };

export const updateTimeEntryHandler = async (req: Request, res: Response): Promise<void> => {
  const caller = requireCaller(req);
  const id = req.params['id'];
  if (!id) throw new AppError('invalid_input', 400, 'missing time entry id');

  // Eagerly resolve the admin-status helper into a sync closure to keep the service
  // signature simple (the caller passes a sync predicate by org). We do this by
  // pre-loading the entry's project orgId.
  const entry = await prisma.timeEntry.findUnique({
    where: { id },
    include: { project: { select: { orgId: true } } },
  });
  if (!entry) throw new AppError('not_found', 404, 'time entry not found');

  let isAdmin = false;
  if (entry.userId !== caller.user.id) {
    isAdmin = await isAdminOf(caller.user.id)(entry.project.orgId);
  }

  const dto = await service.updateTimeEntry(
    {
      userId: caller.user.id,
      isAdminOf: () => isAdmin,
    },
    id,
    req.body as UpdateTimeEntryInput,
  );
  res.status(200).json(dto);
};

export const listTimeEntriesHandler = async (req: Request, res: Response): Promise<void> => {
  const caller = requireCaller(req);
  const orgId = req.params['orgId'];
  if (!orgId) throw new AppError('invalid_input', 400, 'missing orgId in path');
  const m = caller.membership;
  if (!m) throw new AppError('forbidden', 403, 'org membership required');

  const query = req.query as unknown as ListTimeEntriesQuery;
  const page = await service.listTimeEntries(orgId, m, query);
  res.status(200).json(page);
};
