import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { useEffect } from 'react';

import { AppShell } from '@/components/app-shell';
import { Spinner } from '@/components/ui/spinner';
import { useBoot } from '@/lib/use-boot';
import { sessionStore } from '@/lib/session-store';

export const Route = createFileRoute('/_app')({
  beforeLoad: ({ location }) => {
    const { token } = sessionStore.getState();
    if (!token) {
      throw redirect({
        to: '/login',
        search: { next: location.pathname + location.search },
      });
    }
  },
  component: AppLayout,
});

function AppLayout() {
  const boot = useBoot();
  const navigate = Route.useNavigate();

  useEffect(() => {
    if (boot.isError) {
      void navigate({ to: '/login' });
    }
  }, [boot.isError, navigate]);

  if (boot.isLoading || (!boot.data && !boot.isError)) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner className="h-6 w-6 text-muted-foreground" />
      </div>
    );
  }

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
