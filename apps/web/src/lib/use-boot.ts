import type { MembershipDto, OrganizationDto, UserDto } from '@hindsight/shared/dto';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { ApiError, api } from './api';
import { queryKeys } from './queries';
import { sessionStore, useToken } from './session-store';

interface MeResponse {
  user: UserDto;
  memberships: MembershipDto[];
}

// Some membership data needs an org name. The /auth/me endpoint returns the
// memberships but not the org rows; we fetch each org by id (cached).
const fetchOrgs = async (orgIds: string[]): Promise<OrganizationDto[]> => {
  const results = await Promise.all(
    orgIds.map((id) => api<OrganizationDto>(`/orgs/${id}`).catch(() => null)),
  );
  return results.filter((o): o is OrganizationDto => o !== null);
};

export function useBoot() {
  const token = useToken();

  const query = useQuery({
    queryKey: queryKeys.me(),
    enabled: !!token,
    staleTime: 60_000,
    retry: (failureCount, error) => {
      if (error instanceof ApiError && error.status === 401) return false;
      return failureCount < 2;
    },
    queryFn: async () => {
      const me = await api<MeResponse>('/auth/me', { swallow401: true });
      const orgs = await fetchOrgs(me.memberships.map((m) => m.orgId));
      return { ...me, organizations: orgs };
    },
  });

  useEffect(() => {
    if (query.data && token) {
      sessionStore.getState().setSession({
        token,
        user: query.data.user,
        organizations: query.data.organizations,
        memberships: query.data.memberships,
      });
    }
  }, [query.data, token]);

  return query;
}
