import type { Membership } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { can, type Action } from './capabilities.js';

const member = (role: 'owner' | 'admin' | 'member', userId = 'u-actor'): Membership => ({
  id: 'm',
  orgId: 'o',
  userId,
  role,
  status: 'active',
  createdAt: new Date(),
});

interface MatrixCase {
  role: 'owner' | 'admin' | 'member';
  action: Action;
  expected: boolean;
}

const cases: MatrixCase[] = [
  // org:manage — owner only
  { role: 'owner', action: { type: 'org:manage' }, expected: true },
  { role: 'admin', action: { type: 'org:manage' }, expected: false },
  { role: 'member', action: { type: 'org:manage' }, expected: false },

  // org:delete — owner only
  { role: 'owner', action: { type: 'org:delete' }, expected: true },
  { role: 'admin', action: { type: 'org:delete' }, expected: false },
  { role: 'member', action: { type: 'org:delete' }, expected: false },

  // members:invite — owner + admin
  { role: 'owner', action: { type: 'members:invite' }, expected: true },
  { role: 'admin', action: { type: 'members:invite' }, expected: true },
  { role: 'member', action: { type: 'members:invite' }, expected: false },

  // members:remove — owner + admin
  { role: 'owner', action: { type: 'members:remove' }, expected: true },
  { role: 'admin', action: { type: 'members:remove' }, expected: true },
  { role: 'member', action: { type: 'members:remove' }, expected: false },

  // members:change_role — owner + admin
  { role: 'owner', action: { type: 'members:change_role' }, expected: true },
  { role: 'admin', action: { type: 'members:change_role' }, expected: true },
  { role: 'member', action: { type: 'members:change_role' }, expected: false },

  // projects:create — owner + admin
  { role: 'owner', action: { type: 'projects:create' }, expected: true },
  { role: 'admin', action: { type: 'projects:create' }, expected: true },
  { role: 'member', action: { type: 'projects:create' }, expected: false },

  // projects:edit — owner + admin
  { role: 'owner', action: { type: 'projects:edit' }, expected: true },
  { role: 'admin', action: { type: 'projects:edit' }, expected: true },
  { role: 'member', action: { type: 'projects:edit' }, expected: false },

  // projects:assign_members — owner + admin
  { role: 'owner', action: { type: 'projects:assign_members' }, expected: true },
  { role: 'admin', action: { type: 'projects:assign_members' }, expected: true },
  { role: 'member', action: { type: 'projects:assign_members' }, expected: false },

  // time_entries:read_all — owner + admin
  { role: 'owner', action: { type: 'time_entries:read_all' }, expected: true },
  { role: 'admin', action: { type: 'time_entries:read_all' }, expected: true },
  { role: 'member', action: { type: 'time_entries:read_all' }, expected: false },

  // audit:read — owner + admin
  { role: 'owner', action: { type: 'audit:read' }, expected: true },
  { role: 'admin', action: { type: 'audit:read' }, expected: true },
  { role: 'member', action: { type: 'audit:read' }, expected: false },

  // devices:register — anyone active
  { role: 'owner', action: { type: 'devices:register' }, expected: true },
  { role: 'admin', action: { type: 'devices:register' }, expected: true },
  { role: 'member', action: { type: 'devices:register' }, expected: true },

  // projects:read — owner + admin always; member only when assigned
  { role: 'owner', action: { type: 'projects:read', assignedToCaller: false }, expected: true },
  { role: 'admin', action: { type: 'projects:read', assignedToCaller: false }, expected: true },
  { role: 'member', action: { type: 'projects:read', assignedToCaller: false }, expected: false },
  { role: 'member', action: { type: 'projects:read', assignedToCaller: true }, expected: true },

  // screenshots:read — owner/admin always; member only own
  { role: 'owner', action: { type: 'screenshots:read', ownerUserId: 'u-other' }, expected: true },
  { role: 'admin', action: { type: 'screenshots:read', ownerUserId: 'u-other' }, expected: true },
  { role: 'member', action: { type: 'screenshots:read', ownerUserId: 'u-other' }, expected: false },
  { role: 'member', action: { type: 'screenshots:read', ownerUserId: 'u-actor' }, expected: true },

  // screenshots:delete — owner/admin always; member only own.
  { role: 'owner', action: { type: 'screenshots:delete', ownerUserId: 'u-other' }, expected: true },
  { role: 'admin', action: { type: 'screenshots:delete', ownerUserId: 'u-other' }, expected: true },
  {
    role: 'member',
    action: { type: 'screenshots:delete', ownerUserId: 'u-other' },
    expected: false,
  },
  {
    role: 'member',
    action: { type: 'screenshots:delete', ownerUserId: 'u-actor' },
    expected: true,
  },
];

describe('capability matrix', () => {
  for (const c of cases) {
    const label = `${c.role} ${c.action.type}${
      'assignedToCaller' in c.action ? ` assigned=${c.action.assignedToCaller}` : ''
    }${'ownerUserId' in c.action ? ` owner=${c.action.ownerUserId}` : ''}${
      'withinGrace' in c.action ? ` grace=${c.action.withinGrace}` : ''
    } → ${c.expected}`;
    it(label, () => {
      expect(can(member(c.role), c.action)).toBe(c.expected);
    });
  }

  it('suspended membership cannot do anything', () => {
    const suspended: Membership = { ...member('owner'), status: 'suspended' };
    expect(can(suspended, { type: 'org:manage' })).toBe(false);
    expect(can(suspended, { type: 'devices:register' })).toBe(false);
  });
});
