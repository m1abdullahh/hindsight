import type { MembershipDto, OrganizationDto, UserDto } from '@hindsight/shared/dto';
import { beforeEach, describe, expect, it } from 'vitest';

import { sessionStore } from './session-store';

const user: UserDto = {
  id: 'u1',
  email: 'a@b.co',
  name: 'A',
  emailVerifiedAt: null,
  createdAt: '2025-01-01T00:00:00Z',
};
const org: OrganizationDto = {
  id: 'o1',
  name: 'Org',
  slug: 'org',
  createdAt: '2025-01-01T00:00:00Z',
};
const membership: MembershipDto = {
  id: 'm1',
  orgId: 'o1',
  userId: 'u1',
  role: 'owner',
  status: 'active',
  createdAt: '2025-01-01T00:00:00Z',
};

describe('sessionStore', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStore.getState().clearSession();
  });

  it('persists token + currentOrgId to localStorage on setSession', () => {
    sessionStore.getState().setSession({
      token: 'tok',
      user,
      organizations: [org],
      memberships: [membership],
    });
    const stored = JSON.parse(localStorage.getItem('hindsight.session') ?? 'null');
    expect(stored).toEqual({ token: 'tok', currentOrgId: 'o1' });
    expect(sessionStore.getState().user).toEqual(user);
    expect(sessionStore.getState().organizations['o1']).toEqual(org);
  });

  it('keeps the existing currentOrgId when still valid', () => {
    sessionStore.setState({ currentOrgId: 'o1' });
    sessionStore.getState().setSession({
      token: 'tok',
      user,
      organizations: [org, { ...org, id: 'o2', name: 'Other' }],
      memberships: [membership, { ...membership, id: 'm2', orgId: 'o2' }],
    });
    expect(sessionStore.getState().currentOrgId).toBe('o1');
  });

  it('falls back to first membership when currentOrgId is unknown', () => {
    sessionStore.setState({ currentOrgId: 'unknown' });
    sessionStore.getState().setSession({
      token: 'tok',
      user,
      organizations: [org],
      memberships: [membership],
    });
    expect(sessionStore.getState().currentOrgId).toBe('o1');
  });

  it('switchOrg only switches to known orgs', () => {
    sessionStore.getState().setSession({
      token: 'tok',
      user,
      organizations: [org],
      memberships: [membership],
    });
    sessionStore.getState().switchOrg('unknown');
    expect(sessionStore.getState().currentOrgId).toBe('o1');
    sessionStore.getState().switchOrg('o1');
    expect(sessionStore.getState().currentOrgId).toBe('o1');
  });

  it('clearSession wipes state and localStorage', () => {
    sessionStore.getState().setSession({
      token: 'tok',
      user,
      organizations: [org],
      memberships: [membership],
    });
    sessionStore.getState().clearSession();
    expect(sessionStore.getState().token).toBeNull();
    expect(sessionStore.getState().user).toBeNull();
    expect(sessionStore.getState().memberships).toEqual([]);
    expect(localStorage.getItem('hindsight.session')).toBeNull();
  });
});
