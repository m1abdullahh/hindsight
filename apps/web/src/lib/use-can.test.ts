import type { MembershipDto } from '@hindsight/shared/dto';
import { describe, expect, it } from 'vitest';

import { can, type Action } from './use-can';

const make = (
  role: MembershipDto['role'],
  status: MembershipDto['status'] = 'active',
): MembershipDto => ({
  id: 'm1',
  orgId: 'o1',
  userId: 'u1',
  role,
  status,
  createdAt: '2025-01-01T00:00:00Z',
});

const roles: MembershipDto['role'][] = ['owner', 'admin', 'member'];
const actions: Action[] = [
  'org:manage',
  'members:invite',
  'members:manage',
  'invitations:revoke',
  'devices:revoke_others',
  'projects:create',
  'projects:update',
  'projects:archive',
  'projects:assign_members',
];

const expectedTrue: Record<MembershipDto['role'], Action[]> = {
  owner: actions,
  admin: [
    'members:invite',
    'members:manage',
    'invitations:revoke',
    'devices:revoke_others',
    'projects:create',
    'projects:update',
    'projects:archive',
    'projects:assign_members',
  ],
  member: [],
};

describe('can()', () => {
  for (const role of roles) {
    for (const action of actions) {
      const expected = expectedTrue[role].includes(action);
      it(`${role} × ${action} → ${expected}`, () => {
        expect(can(make(role), action)).toBe(expected);
      });
    }
  }

  it('returns false for null membership', () => {
    for (const action of actions) expect(can(null, action)).toBe(false);
  });

  it('returns false for suspended members', () => {
    expect(can(make('owner', 'suspended'), 'org:manage')).toBe(false);
    expect(can(make('admin', 'suspended'), 'members:invite')).toBe(false);
  });
});
