import type { Membership } from '@prisma/client';

// Closed action set. Resource-scoped actions take the resource as part of the
// discriminator so call sites are statically checked. Resource shapes for
// projects/screenshots are sketched here and exercised once those plans land.
export type Action =
  | { type: 'org:manage' }
  | { type: 'org:delete' }
  | { type: 'members:invite' }
  | { type: 'members:remove' }
  | { type: 'members:change_role' }
  | { type: 'projects:create' }
  | { type: 'projects:edit' }
  | { type: 'projects:assign_members' }
  | { type: 'projects:read'; assignedToCaller: boolean }
  | { type: 'time_entries:read_all' }
  | { type: 'screenshots:read'; ownerUserId: string }
  | { type: 'screenshots:delete'; ownerUserId: string; withinGrace: boolean }
  | { type: 'audit:read' }
  | { type: 'devices:register' };

export const can = (m: Membership, action: Action): boolean => {
  if (m.status !== 'active') return false;

  switch (action.type) {
    case 'org:manage':
    case 'org:delete':
      return m.role === 'owner';

    case 'members:invite':
    case 'members:change_role':
    case 'members:remove':
    case 'projects:create':
    case 'projects:edit':
    case 'projects:assign_members':
    case 'time_entries:read_all':
    case 'audit:read':
      return m.role === 'owner' || m.role === 'admin';

    case 'projects:read':
      if (m.role === 'owner' || m.role === 'admin') return true;
      if (m.role === 'member') return action.assignedToCaller;
      return false;

    case 'screenshots:read':
      if (m.role === 'owner' || m.role === 'admin') return true;
      return m.userId === action.ownerUserId;

    case 'screenshots:delete':
      // Admins/owners can delete any capture; members can delete only their
      // own, and only within the per-capture grace window. The privacy
      // contract in 09-privacy-and-ethics.md depends on this — once the
      // window has passed, even the member who took the screenshot cannot
      // remove it through the API.
      if (m.role === 'owner' || m.role === 'admin') return true;
      if (m.userId !== action.ownerUserId) return false;
      return action.withinGrace;

    case 'devices:register':
      return true;
  }
};
