import type { MembershipDto, OrganizationDto, UserDto } from '@hindsight/shared/dto';
import { create } from 'zustand';

const STORAGE_KEY = 'hindsight.session';

interface PersistedSession {
  token: string | null;
  currentOrgId: string | null;
}

export interface SessionState {
  token: string | null;
  user: UserDto | null;
  organizations: Record<string, OrganizationDto>;
  memberships: MembershipDto[];
  currentOrgId: string | null;
  setSession: (s: {
    token: string;
    user: UserDto;
    organizations?: OrganizationDto[];
    memberships: MembershipDto[];
  }) => void;
  setUser: (user: UserDto) => void;
  switchOrg: (orgId: string) => void;
  clearSession: () => void;
}

const readPersisted = (): PersistedSession => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { token: null, currentOrgId: null };
    const parsed = JSON.parse(raw) as Partial<PersistedSession>;
    return {
      token: typeof parsed.token === 'string' ? parsed.token : null,
      currentOrgId: typeof parsed.currentOrgId === 'string' ? parsed.currentOrgId : null,
    };
  } catch {
    return { token: null, currentOrgId: null };
  }
};

const writePersisted = (s: PersistedSession): void => {
  try {
    if (!s.token) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // localStorage failures are non-fatal — session still works in-memory.
  }
};

const persisted = readPersisted();

export const sessionStore = create<SessionState>((set, get) => ({
  token: persisted.token,
  user: null,
  organizations: {},
  memberships: [],
  currentOrgId: persisted.currentOrgId,
  setSession: ({ token, user, organizations, memberships }) => {
    const nextOrgs = organizations
      ? Object.fromEntries(organizations.map((o) => [o.id, o]))
      : get().organizations;
    const previousOrg = get().currentOrgId;
    const orgIsKnown = previousOrg && nextOrgs[previousOrg];
    const nextOrg = orgIsKnown ? previousOrg : (memberships[0]?.orgId ?? null);
    set({ token, user, organizations: nextOrgs, memberships, currentOrgId: nextOrg });
    writePersisted({ token, currentOrgId: nextOrg });
  },
  setUser: (user) => set({ user }),
  switchOrg: (orgId) => {
    if (!get().organizations[orgId]) return;
    set({ currentOrgId: orgId });
    writePersisted({ token: get().token, currentOrgId: orgId });
  },
  clearSession: () => {
    set({
      token: null,
      user: null,
      organizations: {},
      memberships: [],
      currentOrgId: null,
    });
    writePersisted({ token: null, currentOrgId: null });
  },
}));

export const useToken = () => sessionStore((s) => s.token);
export const useUser = () => sessionStore((s) => s.user);
export const useMemberships = () => sessionStore((s) => s.memberships);
export const useCurrentOrgId = () => sessionStore((s) => s.currentOrgId);
export const useCurrentOrg = () =>
  sessionStore((s) => (s.currentOrgId ? (s.organizations[s.currentOrgId] ?? null) : null));
export const useCurrentMembership = () =>
  sessionStore((s) =>
    s.currentOrgId ? (s.memberships.find((m) => m.orgId === s.currentOrgId) ?? null) : null,
  );
