import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  BarChart3,
  Building2,
  Camera,
  ChevronDown,
  Clock,
  FolderKanban,
  Image as ImageIcon,
  LayoutDashboard,
  Search,
  Settings,
  Users,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { AvatarLive } from '@/components/ui/avatar-live';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { apiPost } from '@/lib/api';
import { cn } from '@/lib/utils';
import { sessionStore, useCurrentOrgId, useUser, useMemberships } from '@/lib/session-store';

export function AppShell({ children }: { children: ReactNode }) {
  const user = useUser();
  const memberships = useMemberships();
  const currentOrgId = useCurrentOrgId();
  const navigate = useNavigate();
  const routerState = useRouterState();
  const path = routerState.location.pathname;

  const orgs = sessionStore.getState().organizations;
  const currentOrg = currentOrgId ? orgs[currentOrgId] : null;
  const currentMembership = currentOrgId
    ? (memberships.find((m) => m.orgId === currentOrgId) ?? null)
    : null;

  const onLogout = async () => {
    try {
      await apiPost('/auth/logout');
    } catch {
      // Logout failures are non-fatal — clear locally regardless.
    }
    sessionStore.getState().clearSession();
    void navigate({ to: '/login' });
  };

  const onSwitchOrg = (orgId: string) => {
    void navigate({ to: '/orgs/$orgId', params: { orgId } });
  };

  return (
    <div className="flex min-h-dvh bg-background">
      {/* Sidebar — 220px, Option A spec */}
      <aside className="hidden w-[220px] flex-col border-r border-border bg-background px-2.5 py-3.5 md:flex">
        <div className="flex items-center gap-2 px-2 pb-4 text-sm font-semibold tracking-tight">
          <div className="grid h-6 w-6 place-items-center rounded-md bg-foreground text-[12px] font-bold text-background">
            H
          </div>
          Hindsight
        </div>

        {currentOrgId && memberships.length > 0 && (
          <>
            <div className="px-1.5 pb-2 text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink4">
              Workspace
            </div>
            <Select value={currentOrgId} onValueChange={onSwitchOrg}>
              <SelectTrigger className="mb-3 h-9 w-full justify-start gap-2 bg-card text-[13px] font-normal text-foreground">
                <Building2 className="h-3.5 w-3.5 shrink-0 opacity-70" />
                <span className="flex-1 truncate text-left">
                  {currentOrg?.name ?? 'Select org'}
                </span>
              </SelectTrigger>
              <SelectContent>
                {memberships.map((m) => {
                  const org = orgs[m.orgId];
                  return (
                    <SelectItem key={m.orgId} value={m.orgId}>
                      {org?.name ?? m.orgId}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </>
        )}

        <nav className="flex flex-1 flex-col gap-0.5">
          {currentOrgId && (
            <>
              <NavLink
                to="/orgs/$orgId"
                params={{ orgId: currentOrgId }}
                icon={<LayoutDashboard className="h-[15px] w-[15px]" />}
                active={path === `/orgs/${currentOrgId}` || path === `/orgs/${currentOrgId}/`}
              >
                Overview
              </NavLink>
              <NavLink
                to="/orgs/$orgId/screenshots"
                params={{ orgId: currentOrgId }}
                icon={<Camera className="h-[15px] w-[15px]" />}
                active={path.startsWith(`/orgs/${currentOrgId}/screenshots`)}
              >
                Screenshots
              </NavLink>
              <NavLink
                to="/orgs/$orgId/timesheet"
                params={{ orgId: currentOrgId }}
                icon={<Clock className="h-[15px] w-[15px]" />}
                active={path.startsWith(`/orgs/${currentOrgId}/timesheet`)}
              >
                Timesheet
              </NavLink>
              <NavLink
                to="/orgs/$orgId/projects"
                params={{ orgId: currentOrgId }}
                icon={<FolderKanban className="h-[15px] w-[15px]" />}
                active={
                  path.startsWith(`/orgs/${currentOrgId}/projects`) &&
                  !path.includes('/screenshots')
                }
              >
                Projects
              </NavLink>
              <NavLink
                to="/orgs/$orgId/members"
                params={{ orgId: currentOrgId }}
                icon={<Users className="h-[15px] w-[15px]" />}
                active={path.startsWith(`/orgs/${currentOrgId}/members`)}
              >
                Members
              </NavLink>
              <NavLink
                to="/orgs/$orgId/reports"
                params={{ orgId: currentOrgId }}
                icon={<BarChart3 className="h-[15px] w-[15px]" />}
                active={path.startsWith(`/orgs/${currentOrgId}/reports`)}
              >
                Reports
              </NavLink>
            </>
          )}
        </nav>

        {/* Desktop-app CTA card — Option A spec.
            Download URL is set via VITE_DESKTOP_DOWNLOAD_URL at build time;
            absent in local dev (no installer hosted yet) so we hide the link
            rather than render a broken anchor. */}
        {(() => {
          const downloadUrl = import.meta.env['VITE_DESKTOP_DOWNLOAD_URL'] as string | undefined;
          return (
            <div className="mb-2 rounded-md border border-dashed border-border-strong bg-card p-2.5">
              <div className="mb-1 flex items-center gap-1.5 text-[11.5px] text-ink2">
                <ImageIcon className="h-3 w-3" /> Desktop app
              </div>
              <p className="text-[11px] leading-snug text-ink3">
                Time is tracked from the desktop tracker.
                {downloadUrl ? (
                  <>
                    {' '}
                    <a
                      href={downloadUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:underline"
                    >
                      Download →
                    </a>
                  </>
                ) : (
                  <> Ask your admin for the installer.</>
                )}
              </p>
            </div>
          );
        })()}

        {user && (
          <div className="flex items-center gap-2 border-t border-border pt-2.5">
            <AvatarLive userId={user.id} name={user.name} size={26} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-medium leading-tight">{user.name}</div>
              <div className="truncate text-[11px] capitalize text-ink4">
                {currentMembership?.role ?? 'member'}
              </div>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="grid h-7 w-7 place-items-center rounded text-ink3 hover:bg-muted"
                  aria-label="Account menu"
                >
                  <Settings className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <div className="text-sm font-medium">{user.name}</div>
                  <div className="text-xs text-ink3">{user.email}</div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/settings/profile">Profile</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/settings/devices">Devices</Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onLogout}>Sign out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-12 items-center gap-3.5 border-b border-border bg-card px-5">
          <div className="text-[13px] text-ink3">
            {currentOrg ? (
              <span>
                {currentOrg.name}
                {' · '}
                <span className="text-foreground">{titleForPath(path)}</span>
              </span>
            ) : (
              'Hindsight'
            )}
          </div>
          <div className="flex-1" />
          <div className="hidden h-7 w-[200px] items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-[12px] text-ink3 sm:flex">
            <Search className="h-3 w-3" />
            <span>Search…</span>
            <span className="ml-auto font-mono text-[10.5px]">⌘K</span>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

interface NavLinkProps {
  to: string;
  params?: Record<string, string>;
  icon: ReactNode;
  active: boolean;
  children: ReactNode;
}

function NavLink({ to, params, icon, active, children }: NavLinkProps) {
  return (
    <Link
      to={to}
      // TanStack Router types are strict; cast through any for the simple param shape.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params={params as any}
      className={cn(
        'flex items-center gap-2 rounded px-2 py-1.5 text-[13px] transition-colors',
        active ? 'bg-muted font-medium text-foreground' : 'text-ink2 hover:bg-muted/60',
      )}
    >
      {icon}
      <span className="flex-1">{children}</span>
    </Link>
  );
}

function titleForPath(path: string): string {
  if (path.includes('/screenshots')) return 'Screenshots';
  if (path.includes('/timesheet')) return 'Timesheet';
  if (path.includes('/projects/')) return 'Projects';
  if (path.endsWith('/projects')) return 'Projects';
  if (path.includes('/members')) return 'Members';
  if (path.includes('/reports')) return 'Reports';
  if (path.includes('/settings')) return 'Settings';
  return 'Overview';
}

// Re-export for any callsites that imported a chevron icon from this module.
export { ChevronDown };
