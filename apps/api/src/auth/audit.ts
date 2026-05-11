import { Prisma } from '@prisma/client';

import { ulid } from '../lib/id.js';

export type AuditAction =
  | 'org.created'
  | 'org.updated'
  | 'org.deleted'
  | 'member.invited'
  | 'member.invitation_revoked'
  | 'member.joined'
  | 'member.removed'
  | 'member.role_changed'
  | 'member.status_changed'
  | 'project.created'
  | 'project.updated'
  | 'project.archived'
  | 'project.unarchived'
  | 'project.deleted'
  | 'project.assignment_added'
  | 'project.assignment_updated'
  | 'project.assignment_removed'
  | 'device.registered'
  | 'device.revoked'
  | 'screenshot.deleted'
  | 'auth.signup'
  | 'auth.login'
  | 'auth.logout'
  | 'auth.email_verified'
  | 'auth.password_reset_requested'
  | 'auth.password_changed'
  | 'auth.signed_out_everywhere'
  | 'auth.profile_updated';

export interface WriteAuditInput {
  orgId: string;
  actorId: string | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  metadata?: Prisma.JsonObject;
}

export const writeAudit = (
  tx: Prisma.TransactionClient,
  input: WriteAuditInput,
): Promise<unknown> =>
  tx.auditLog.create({
    data: {
      id: ulid(),
      orgId: input.orgId,
      actorId: input.actorId,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: input.metadata ?? Prisma.JsonNull,
    },
  });
