import type { MembershipDto, ProjectDto, UserDto } from '@hindsight/shared/dto';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Command } from 'cmdk';
import {
  BarChart3,
  Camera,
  Clock,
  FolderKanban,
  LayoutDashboard,
  Settings,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { apiGet } from '@/lib/api';
import { queryKeys } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

interface MemberHit {
  user: UserDto;
  membership: MembershipDto;
}
interface SearchResponse {
  members: MemberHit[];
  projects: ProjectDto[];
}

interface PageEntry {
  key: string;
  label: string;
  keywords: string[];
  icon: ReactNode;
  to: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: Record<string, any>;
}

const buildPages = (orgId: string | null): PageEntry[] => {
  const pages: PageEntry[] = [
    {
      key: 'profile',
      label: 'Profile settings',
      keywords: ['settings', 'account', 'profile'],
      icon: <Settings className="h-3.5 w-3.5" />,
      to: '/settings/profile',
    },
    {
      key: 'devices',
      label: 'Device settings',
      keywords: ['settings', 'devices', 'tracker'],
      icon: <Settings className="h-3.5 w-3.5" />,
      to: '/settings/devices',
    },
  ];
  if (orgId) {
    pages.unshift(
      {
        key: 'overview',
        label: 'Overview',
        keywords: ['dashboard', 'home'],
        icon: <LayoutDashboard className="h-3.5 w-3.5" />,
        to: '/orgs/$orgId',
        params: { orgId },
      },
      {
        key: 'screenshots',
        label: 'Screenshots',
        keywords: ['screenshots', 'captures'],
        icon: <Camera className="h-3.5 w-3.5" />,
        to: '/orgs/$orgId/screenshots',
        params: { orgId },
      },
      {
        key: 'timesheet',
        label: 'Timesheet',
        keywords: ['timesheet', 'hours', 'time'],
        icon: <Clock className="h-3.5 w-3.5" />,
        to: '/orgs/$orgId/timesheet',
        params: { orgId },
      },
      {
        key: 'projects',
        label: 'Projects',
        keywords: ['projects', 'workspaces'],
        icon: <FolderKanban className="h-3.5 w-3.5" />,
        to: '/orgs/$orgId/projects',
        params: { orgId },
      },
      {
        key: 'members',
        label: 'Members',
        keywords: ['members', 'team', 'people', 'users'],
        icon: <Users className="h-3.5 w-3.5" />,
        to: '/orgs/$orgId/members',
        params: { orgId },
      },
      {
        key: 'reports',
        label: 'Reports',
        keywords: ['reports', 'analytics', 'time totals'],
        icon: <BarChart3 className="h-3.5 w-3.5" />,
        to: '/orgs/$orgId/reports',
        params: { orgId },
      },
    );
  }
  return pages;
};

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string | null;
}

export function CommandPalette({ open, onOpenChange, orgId }: CommandPaletteProps) {
  const [input, setInput] = useState('');
  const debounced = useDebounced(input.trim(), 150);
  const navigate = useNavigate();

  // Reset the input every time the palette closes so the next open starts fresh.
  useEffect(() => {
    if (!open) setInput('');
  }, [open]);

  const enabled = open && !!orgId && debounced.length > 0;
  const { data, isFetching } = useQuery({
    queryKey: orgId ? queryKeys.search(orgId, debounced) : ['search', 'idle'],
    queryFn: () =>
      apiGet<SearchResponse>(`/orgs/${orgId!}/search`, { q: debounced, limit: 8 }),
    enabled,
    staleTime: 30_000,
  });

  // Show skeletons while we wait for the first response for this query;
  // keep stale results visible during refetches so the list doesn't flash.
  const showSkeleton = enabled && isFetching && !data;

  const pages = useMemo(() => buildPages(orgId), [orgId]);
  const lowered = debounced.toLowerCase();
  const matchingPages = useMemo(() => {
    if (lowered.length === 0) return pages;
    return pages.filter((p) => {
      if (p.label.toLowerCase().includes(lowered)) return true;
      return p.keywords.some((k) => k.includes(lowered));
    });
  }, [pages, lowered]);

  const members = data?.members ?? [];
  const projects = data?.projects ?? [];

  const go = (run: () => void) => {
    run();
    onOpenChange(false);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh] animate-in fade-in-0 duration-150"
      onMouseDown={(e) => {
        // Close on overlay click (but not when clicking inside the panel).
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Search"
    >
      <Command
        // cmdk filters items by label by default; we already filter pages
        // ourselves and members/projects are server-filtered, so opt out.
        shouldFilter={false}
        loop
        className="w-full max-w-[560px] overflow-hidden rounded-lg border border-border bg-card shadow-2xl animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-200"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onOpenChange(false);
          }
        }}
      >
        <div className="flex items-center gap-2 border-b border-border px-3.5">
          <Command.Input
            value={input}
            onValueChange={setInput}
            placeholder="Search members, projects, pages…"
            autoFocus
            className="h-11 flex-1 bg-transparent text-[14px] text-foreground placeholder:text-ink4 outline-none"
          />
          {isFetching && enabled && (
            <span className="text-[10.5px] uppercase tracking-[0.06em] text-ink4">Searching…</span>
          )}
        </div>

        <Command.List className="max-h-[60vh] overflow-y-auto px-1.5 py-1.5">
          {!showSkeleton && (
            <Command.Empty className="px-3 py-6 text-center text-[12.5px] text-ink3">
              {debounced.length === 0 ? 'Start typing to search.' : 'No results.'}
            </Command.Empty>
          )}

          {showSkeleton && <ResultSkeletons />}

          {matchingPages.length > 0 && (
            <Command.Group
              heading="Pages"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.06em] [&_[cmdk-group-heading]]:text-ink4"
            >
              {matchingPages.map((p) => (
                <Item
                  key={`page:${p.key}`}
                  value={`page:${p.key}`}
                  icon={p.icon}
                  onSelect={() =>
                    go(() => {
                      // TanStack Router params are strict — cast for the simple shape.
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      void navigate({ to: p.to, params: p.params as any });
                    })
                  }
                >
                  <span className="flex-1 truncate">{p.label}</span>
                  <span className="text-[10.5px] text-ink4">Go to</span>
                </Item>
              ))}
            </Command.Group>
          )}

          {members.length > 0 && orgId && (
            <Command.Group
              heading="Members"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.06em] [&_[cmdk-group-heading]]:text-ink4"
            >
              {members.map((m) => (
                <Item
                  key={`member:${m.user.id}`}
                  value={`member:${m.user.id}`}
                  icon={<Users className="h-3.5 w-3.5" />}
                  onSelect={() =>
                    go(() => {
                      void navigate({
                        to: '/orgs/$orgId/members',
                        params: { orgId },
                        search: { member: m.user.id },
                      });
                    })
                  }
                >
                  <span className="flex-1 truncate">{m.user.name}</span>
                  <span className="truncate text-[11px] text-ink4">{m.user.email}</span>
                </Item>
              ))}
            </Command.Group>
          )}

          {projects.length > 0 && orgId && (
            <Command.Group
              heading="Projects"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.06em] [&_[cmdk-group-heading]]:text-ink4"
            >
              {projects.map((p) => (
                <Item
                  key={`project:${p.id}`}
                  value={`project:${p.id}`}
                  icon={<FolderKanban className="h-3.5 w-3.5" />}
                  onSelect={() =>
                    go(() => {
                      void navigate({
                        to: '/orgs/$orgId/projects/$projectId',
                        params: { orgId, projectId: p.id },
                      });
                    })
                  }
                >
                  <span className="flex-1 truncate">{p.name}</span>
                  {p.description && (
                    <span className="truncate text-[11px] text-ink4">{p.description}</span>
                  )}
                </Item>
              ))}
            </Command.Group>
          )}

          {(members.length > 0 || projects.length > 0) && orgId && (
            <Command.Group
              heading="Reports"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.06em] [&_[cmdk-group-heading]]:text-ink4"
            >
              {members.map((m) => (
                <Item
                  key={`report-member:${m.user.id}`}
                  value={`report-member:${m.user.id}`}
                  icon={<BarChart3 className="h-3.5 w-3.5" />}
                  onSelect={() =>
                    go(() => {
                      void navigate({
                        to: '/orgs/$orgId/reports',
                        params: { orgId },
                        search: { userId: m.user.id },
                      });
                    })
                  }
                >
                  <span className="flex-1 truncate">Report for {m.user.name}</span>
                  <span className="text-[10.5px] text-ink4">Open</span>
                </Item>
              ))}
              {projects.map((p) => (
                <Item
                  key={`report-project:${p.id}`}
                  value={`report-project:${p.id}`}
                  icon={<BarChart3 className="h-3.5 w-3.5" />}
                  onSelect={() =>
                    go(() => {
                      void navigate({
                        to: '/orgs/$orgId/reports',
                        params: { orgId },
                        search: { projectId: p.id },
                      });
                    })
                  }
                >
                  <span className="flex-1 truncate">Report for {p.name}</span>
                  <span className="text-[10.5px] text-ink4">Open</span>
                </Item>
              ))}
            </Command.Group>
          )}
        </Command.List>

        <div className="flex items-center justify-between border-t border-border px-3 py-1.5 text-[10.5px] text-ink4">
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
            <span className="mx-2 opacity-50">·</span>
            <Kbd>↵</Kbd> select
            <span className="mx-2 opacity-50">·</span>
            <Kbd>esc</Kbd> close
          </span>
        </div>
      </Command>
    </div>
  );
}

interface ItemProps {
  value: string;
  icon: ReactNode;
  onSelect: () => void;
  children: ReactNode;
}

function Item({ value, icon, onSelect, children }: ItemProps) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-[13px] text-ink2',
        'data-[selected=true]:bg-muted data-[selected=true]:text-foreground',
      )}
    >
      <span className="text-ink3">{icon}</span>
      {children}
    </Command.Item>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="mx-0.5 inline-block min-w-[14px] rounded border border-border bg-background px-1 text-center font-mono text-[10px] text-ink3">
      {children}
    </kbd>
  );
}

function ResultSkeletons() {
  return (
    <div className="px-1" aria-hidden>
      <div className="px-2 pb-1 pt-2 text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink4">
        Searching
      </div>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-2 px-2 py-2">
          <Skeleton className="h-3.5 w-3.5 rounded" />
          <Skeleton className="h-3.5 flex-1" style={{ maxWidth: `${72 - i * 12}%` }} />
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}
