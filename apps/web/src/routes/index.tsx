import { createFileRoute, redirect } from '@tanstack/react-router';

import { sessionStore } from '@/lib/session-store';

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    const state = sessionStore.getState();
    if (!state.token) throw redirect({ to: '/login' });
    if (state.currentOrgId) {
      throw redirect({ to: '/orgs/$orgId', params: { orgId: state.currentOrgId } });
    }
    // Token but no org — let the app shell load /auth/me which will hydrate.
    // If memberships array is empty after that, the user can re-login.
  },
  component: () => null,
});
