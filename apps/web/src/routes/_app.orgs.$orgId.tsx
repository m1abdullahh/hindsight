import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { useEffect } from 'react';

import { sessionStore } from '@/lib/session-store';

export const Route = createFileRoute('/_app/orgs/$orgId')({
  beforeLoad: ({ params }) => {
    const state = sessionStore.getState();
    const membership = state.memberships.find((m) => m.orgId === params.orgId);
    // If memberships haven't been hydrated yet (e.g. fresh page load), let the
    // page render — useBoot in _app fetches them and the route will re-evaluate.
    if (state.memberships.length > 0 && !membership) {
      throw redirect({ to: '/' });
    }
  },
  component: OrgScopeLayout,
});

function OrgScopeLayout() {
  const params = Route.useParams();

  useEffect(() => {
    const state = sessionStore.getState();
    if (state.currentOrgId !== params.orgId && state.organizations[params.orgId]) {
      state.switchOrg(params.orgId);
    }
  }, [params.orgId]);

  return <Outlet />;
}
