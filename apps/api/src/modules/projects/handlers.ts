import type { Request, Response } from 'express';

import { AppError } from '../../lib/errors.js';

import * as service from './service.js';
import type {
  CreateAssignmentInput,
  CreateProjectInput,
  ListProjectsQuery,
  UpdateAssignmentInput,
  UpdateProjectInput,
} from './schemas.js';

const requireMembership = (req: Request) => {
  const m = req.caller?.membership;
  if (!m) throw new AppError('forbidden', 403, 'org membership required');
  return m;
};

const requireProject = (req: Request) => {
  const p = req.caller?.project;
  if (!p) throw new AppError('not_found', 404, 'project not found');
  return p;
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

const parseListQuery = (req: Request): ListProjectsQuery => {
  const v = req.query['includeArchived'];
  if (v === undefined) return {};
  return { includeArchived: v === 'true' };
};

// ── Org-scoped routes ──────────────────────────────────────────────────────

export const listProjectsHandler = async (req: Request, res: Response): Promise<void> => {
  const orgId = requireOrgIdParam(req);
  const m = requireMembership(req);
  const projects = await service.listProjects(orgId, m, parseListQuery(req));
  res.status(200).json({ projects });
};

export const createProjectHandler = async (req: Request, res: Response): Promise<void> => {
  const orgId = requireOrgIdParam(req);
  const m = requireMembership(req);
  const project = await service.createProject(orgId, m, req.body as CreateProjectInput);
  res.status(201).json(project);
};

// ── Project-scoped routes ──────────────────────────────────────────────────

export const getProjectHandler = async (req: Request, res: Response): Promise<void> => {
  const project = requireProject(req);
  const m = requireMembership(req);
  const dto = await service.getProject(project, m);
  res.status(200).json(dto);
};

export const updateProjectHandler = async (req: Request, res: Response): Promise<void> => {
  const project = requireProject(req);
  const m = requireMembership(req);
  const dto = await service.updateProject(project, m, req.body as UpdateProjectInput);
  res.status(200).json(dto);
};

export const archiveProjectHandler = async (req: Request, res: Response): Promise<void> => {
  const project = requireProject(req);
  const m = requireMembership(req);
  const dto = await service.setArchived(project, m, true);
  res.status(200).json(dto);
};

export const unarchiveProjectHandler = async (req: Request, res: Response): Promise<void> => {
  const project = requireProject(req);
  const m = requireMembership(req);
  const dto = await service.setArchived(project, m, false);
  res.status(200).json(dto);
};

// ── Assignment routes ─────────────────────────────────────────────────────

export const listAssignmentsHandler = async (req: Request, res: Response): Promise<void> => {
  const project = requireProject(req);
  // Members can read assignments of projects they're on.
  // projectScope only verified org membership; we need an extra check for members.
  const m = requireMembership(req);
  if (m.role === 'member') {
    const own = await service.listAssignments(project, false);
    const isOnProject = own.some((row) => row.user.id === m.userId);
    if (!isOnProject) {
      throw new AppError('forbidden', 403, 'not assigned to this project');
    }
  }
  const includeRemoved = req.query['includeRemoved'] === 'true';
  const assignments = await service.listAssignments(project, includeRemoved);
  res.status(200).json({ assignments });
};

export const addAssignmentHandler = async (req: Request, res: Response): Promise<void> => {
  const project = requireProject(req);
  const m = requireMembership(req);
  const dto = await service.addAssignment(project, m, req.body as CreateAssignmentInput);
  res.status(201).json(dto);
};

export const updateAssignmentHandler = async (req: Request, res: Response): Promise<void> => {
  const project = requireProject(req);
  const userId = requireUserIdParam(req);
  const m = requireMembership(req);
  const dto = await service.updateAssignment(project, m, userId, req.body as UpdateAssignmentInput);
  res.status(200).json(dto);
};

export const removeAssignmentHandler = async (req: Request, res: Response): Promise<void> => {
  const project = requireProject(req);
  const userId = requireUserIdParam(req);
  const m = requireMembership(req);
  await service.removeAssignment(project, m, userId);
  res.status(204).end();
};
