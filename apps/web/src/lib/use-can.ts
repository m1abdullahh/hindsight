import type { MembershipDto } from '@hindsight/shared/dto';

import { useCurrentMembership } from './session-store';

export type Action =
  | 'org:manage'
  | 'members:invite'
  | 'members:manage'
  | 'invitations:revoke'
  | 'devices:revoke_others'
  | 'projects:create'
  | 'projects:update'
  | 'projects:archive'
  | 'projects:assign_members';

export function can(membership: MembershipDto | null, action: Action): boolean {
  if (!membership || membership.status !== 'active') return false;
  const role = membership.role;
  switch (action) {
    case 'org:manage':
      return role === 'owner';
    case 'members:invite':
    case 'members:manage':
    case 'invitations:revoke':
    case 'devices:revoke_others':
    case 'projects:create':
    case 'projects:update':
    case 'projects:archive':
    case 'projects:assign_members':
      return role === 'owner' || role === 'admin';
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return false;
    }
  }
}

export function useCan(action: Action): boolean {
  const m = useCurrentMembership();
  return can(m, action);
}
