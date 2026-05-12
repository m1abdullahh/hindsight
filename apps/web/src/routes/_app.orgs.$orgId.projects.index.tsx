import type { ProjectDto } from '@hindsight/shared/dto';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { FolderPlus, MoreHorizontal, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { AvatarLive } from '@/components/ui/avatar-live';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Pill } from '@/components/ui/pill';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/use-toast';
import { apiDelete, apiGet, apiPost } from '@/lib/api';
import { formatDate, formatHours } from '@/lib/format';
import { projectAccent, projectAccentSoft } from '@/lib/project-accent';
import { queryKeys } from '@/lib/queries';
import { useCan } from '@/lib/use-can';

type Tab = 'active' | 'archived' | 'all';

const searchSchema = z.object({
  // Legacy `archived=true` URLs map to the new 'archived' tab.
  archived: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
  view: z.enum(['active', 'archived', 'all']).optional(),
});

interface ProjectsResponse {
  projects: ProjectDto[];
}

interface TimeTotalRow {
  userId: string;
  userName: string;
  userEmail: string;
  projectId: string;
  projectName: string;
  totalActiveSeconds: number;
  hourlyRateCents: number | null;
  earnedCents: number | null;
}
interface TimeTotalsResponse {
  rows: TimeTotalRow[];
}

export const Route = createFileRoute('/_app/orgs/$orgId/projects/')({
  validateSearch: searchSchema,
  component: ProjectsListPage,
});

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function startOfWeekIso(): string {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  const offset = day === 0 ? 6 : day - 1;
  monday.setDate(now.getDate() - offset);
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString();
}

function ProjectsListPage() {
  const params = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const tab: Tab = search.view ?? (search.archived ? 'archived' : 'active');
  const canCreate = useCan('projects:create');

  // The list endpoint returns only active projects unless `includeArchived` is
  // set, in which case it returns both. Fetch with the flag whenever the user
  // might see archived rows, and filter client-side per tab.
  const includeArchived = tab !== 'active';
  const query = useQuery({
    queryKey: queryKeys.projects(params.orgId, includeArchived),
    queryFn: () =>
      apiGet<ProjectsResponse>(`/orgs/${params.orgId}/projects`, {
        ...(includeArchived ? { includeArchived: true } : {}),
      }),
  });

  const todayFrom = startOfTodayIso();
  const todayTotalsQuery = useQuery({
    queryKey: queryKeys.timeTotals(params.orgId, { from: todayFrom }),
    queryFn: () =>
      apiGet<TimeTotalsResponse>(`/orgs/${params.orgId}/reports/time-totals`, {
        from: todayFrom,
      }),
    refetchInterval: 30_000,
  });

  const weekFrom = startOfWeekIso();
  const weekTotalsQuery = useQuery({
    queryKey: queryKeys.timeTotals(params.orgId, { from: weekFrom }),
    queryFn: () =>
      apiGet<TimeTotalsResponse>(`/orgs/${params.orgId}/reports/time-totals`, {
        from: weekFrom,
      }),
  });

  const allProjects = query.data?.projects ?? [];

  const counts = useMemo(() => {
    let active = 0;
    let archived = 0;
    for (const p of allProjects) {
      if (p.archivedAt) archived++;
      else active++;
    }
    return { active, archived, all: allProjects.length };
  }, [allProjects]);

  const visibleProjects = useMemo(() => {
    if (tab === 'active') return allProjects.filter((p) => !p.archivedAt);
    if (tab === 'archived') return allProjects.filter((p) => p.archivedAt);
    return allProjects;
  }, [allProjects, tab]);

  // Derive per-project today + this-week + members from time-totals.
  const todayByProject = useMemo(
    () => secondsByProject(todayTotalsQuery.data?.rows ?? []),
    [todayTotalsQuery.data],
  );
  const weekByProject = useMemo(
    () => secondsByProject(weekTotalsQuery.data?.rows ?? []),
    [weekTotalsQuery.data],
  );
  const membersByProject = useMemo(
    () => membersFromRows(weekTotalsQuery.data?.rows ?? []),
    [weekTotalsQuery.data],
  );

  const setTab = (next: Tab) => {
    navigate({ search: next === 'active' ? {} : { view: next } });
  };

  return (
    <div className="px-7 py-6">
      {canCreate && (
        <HeaderActionsPortal>
          <NewProjectDialog orgId={params.orgId} />
        </HeaderActionsPortal>
      )}

      <header className="mb-5">
        <h1 className="text-[26px] font-semibold tracking-tight">Projects</h1>
        <p className="mt-1 text-[13px] text-ink3">
          {tab === 'archived'
            ? 'Archived projects in this organization.'
            : tab === 'all'
              ? 'All projects in this organization.'
              : 'Active projects in this organization.'}
        </p>
      </header>

      <div className="mb-4 flex items-center border-b border-border">
        <TabButton active={tab === 'active'} onClick={() => setTab('active')} count={counts.active}>
          Active
        </TabButton>
        <TabButton
          active={tab === 'archived'}
          onClick={() => setTab('archived')}
          count={tab === 'archived' || counts.archived > 0 ? counts.archived : undefined}
        >
          Archived
        </TabButton>
        <TabButton active={tab === 'all'} onClick={() => setTab('all')}>
          All
        </TabButton>
      </div>

      {query.isLoading ? (
        <div className="rounded-lg border border-border bg-card p-4">
          <Skeleton className="h-40 w-full" />
        </div>
      ) : visibleProjects.length ? (
        <section className="rounded-lg border border-border bg-card">
          <div className="grid grid-cols-12 items-center gap-3 border-b border-border px-4 py-2.5 text-[10.5px] uppercase tracking-wide text-ink4">
            <div className="col-span-4">Name</div>
            <div className="col-span-1">Members</div>
            <div className="col-span-1">Today</div>
            <div className="col-span-1">This week</div>
            <div className="col-span-1">Interval</div>
            <div className="col-span-1">Blur</div>
            <div className="col-span-2">Created</div>
            <div className="col-span-1" />
          </div>
          <ul className="divide-y divide-border">
            {visibleProjects.map((p) => {
              const todaySec = todayByProject.get(p.id) ?? 0;
              const weekSec = weekByProject.get(p.id) ?? 0;
              const members = membersByProject.get(p.id) ?? [];
              return (
                <li
                  key={p.id}
                  className="grid grid-cols-12 items-center gap-3 px-4 py-3 text-[13px]"
                >
                  <div className="col-span-4">
                    <Link
                      to="/orgs/$orgId/projects/$projectId"
                      params={{ orgId: params.orgId, projectId: p.id }}
                      className="group flex items-center gap-3"
                    >
                      <span
                        className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-md"
                        style={{ background: projectAccentSoft(p.id) }}
                      >
                        <span
                          className="h-2.5 w-2.5 rounded-sm"
                          style={{ background: projectAccent(p.id) }}
                        />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium group-hover:underline">
                          {p.name}
                        </span>
                        {p.description && (
                          <span className="block truncate text-[11px] text-ink4">
                            {p.description}
                          </span>
                        )}
                      </span>
                    </Link>
                  </div>
                  <div className="col-span-1">
                    <AvatarStack people={members} />
                  </div>
                  <div className="col-span-1 font-mono tabular-nums text-ink2">
                    {todaySec > 0 ? formatHours(todaySec) : '—'}
                  </div>
                  <div className="col-span-1 font-mono tabular-nums text-ink2">
                    {weekSec > 0 ? formatHours(weekSec) : '—'}
                  </div>
                  <div className="col-span-1 font-mono text-[12px] text-ink3">
                    {p.screenshotIntervalMinutes} min
                  </div>
                  <div className="col-span-1">
                    {p.blurScreenshots ? <Pill tone="accent">On</Pill> : <Pill>Off</Pill>}
                  </div>
                  <div className="col-span-2 text-[12.5px] text-ink3">
                    {formatDate(p.createdAt)}
                  </div>
                  <div className="col-span-1 flex justify-end">
                    <ProjectRowActions project={p} orgId={params.orgId} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <EmptyState canCreate={canCreate} tab={tab} />
      )}
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────

function secondsByProject(rows: TimeTotalRow[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(r.projectId, (map.get(r.projectId) ?? 0) + r.totalActiveSeconds);
  }
  return map;
}

function membersFromRows(rows: TimeTotalRow[]): Map<string, { id: string; name: string }[]> {
  const map = new Map<string, { id: string; name: string }[]>();
  for (const r of rows) {
    const arr = map.get(r.projectId) ?? [];
    if (!arr.some((m) => m.id === r.userId)) {
      arr.push({ id: r.userId, name: r.userName });
      map.set(r.projectId, arr);
    }
  }
  return map;
}

// ── small visual primitives ─────────────────────────────────────────────

function TabButton({
  active,
  onClick,
  children,
  count,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  count?: number | undefined;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'relative px-3 pb-2.5 pt-1 text-[12.5px] transition-colors ' +
        (active ? 'font-medium text-foreground' : 'text-ink3 hover:text-foreground')
      }
    >
      {children}
      {count !== undefined && (
        <span className="ml-1.5 font-mono text-[11px] text-ink4">{count}</span>
      )}
      {active && (
        <span className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-foreground" />
      )}
    </button>
  );
}

function AvatarStack({
  people,
  max = 3,
}: {
  people: { id: string; name: string }[];
  max?: number;
}) {
  if (people.length === 0) {
    return <span className="text-[11px] text-ink4">—</span>;
  }
  const visible = people.slice(0, max);
  const extra = people.length - visible.length;
  return (
    <div className="flex items-center">
      {visible.map((p, i) => (
        <div
          key={p.id}
          className="rounded-full ring-2 ring-card"
          style={{ marginLeft: i === 0 ? 0 : -8 }}
        >
          <AvatarLive userId={p.id} name={p.name} size={22} />
        </div>
      ))}
      {extra > 0 && (
        <div
          className="grid h-[22px] w-[22px] place-items-center rounded-full bg-muted text-[10px] font-medium text-ink3 ring-2 ring-card"
          style={{ marginLeft: -8 }}
        >
          +{extra}
        </div>
      )}
    </div>
  );
}

function HeaderActionsPortal({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(document.getElementById('page-header-actions'));
  }, []);
  if (!target) return null;
  return createPortal(children, target);
}

function ProjectRowActions({ project, orgId }: { project: ProjectDto; orgId: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const archived = Boolean(project.archivedAt);

  const archiveMutation = useMutation({
    mutationFn: () =>
      archived
        ? apiDelete(`/projects/${project.id}/archive`)
        : apiPost(`/projects/${project.id}/archive`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orgs', orgId, 'projects'] });
      toast({ title: archived ? 'Project unarchived' : 'Project archived' });
    },
    onError: (err) => {
      toast({
        title: archived ? 'Could not unarchive' : 'Could not archive',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Actions for ${project.name}`}
          className="h-8 w-8"
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem asChild>
          <Link to="/orgs/$orgId/projects/$projectId" params={{ orgId, projectId: project.id }}>
            Open project
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            archiveMutation.mutate();
          }}
        >
          {archived ? 'Unarchive' : 'Archive'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EmptyState({ canCreate, tab }: { canCreate: boolean; tab: Tab }) {
  if (tab === 'archived') {
    return (
      <div className="rounded-lg border border-dashed border-border-strong bg-card px-6 py-14 text-center">
        <p className="text-[13px] text-ink3">No archived projects.</p>
      </div>
    );
  }
  if (!canCreate) {
    return (
      <div className="rounded-lg border border-dashed border-border-strong bg-card px-6 py-14 text-center">
        <p className="text-[14px] font-medium">
          You haven&apos;t been assigned to any projects yet
        </p>
        <p className="mt-1 text-[12.5px] text-ink3">
          Ask your org owner or admin to add you to a project.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-dashed border-border-strong bg-card px-6 py-14 text-center">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-muted text-ink3">
        <FolderPlus className="h-6 w-6" />
      </div>
      <p className="mt-3 text-[14px] font-medium">No projects yet</p>
      <p className="mt-1 text-[12.5px] text-ink3">Create your first project to get started.</p>
    </div>
  );
}

const createSchema = z.object({
  name: z.string().trim().min(1, 'Required').max(100),
  description: z.string().trim().max(2000).optional(),
  screenshotIntervalMinutes: z.coerce.number().int().min(1).max(60),
  blurScreenshots: z.boolean(),
  idleTimeoutMinutes: z.coerce.number().int().min(1).max(60),
});
type CreateInput = z.infer<typeof createSchema>;

function NewProjectDialog({ orgId }: { orgId: string }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const form = useForm<CreateInput>({
    defaultValues: {
      name: '',
      description: '',
      screenshotIntervalMinutes: 10,
      blurScreenshots: false,
      idleTimeoutMinutes: 5,
    },
  });

  const mutation = useMutation({
    mutationFn: (input: CreateInput) =>
      apiPost<ProjectDto>(`/orgs/${orgId}/projects`, {
        name: input.name,
        description: input.description || undefined,
        screenshotIntervalMinutes: input.screenshotIntervalMinutes,
        blurScreenshots: input.blurScreenshots,
        idleTimeoutMinutes: input.idleTimeoutMinutes,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orgs', orgId, 'projects'] });
      toast({ title: 'Project created' });
      setOpen(false);
      form.reset();
    },
    onError: (err) => {
      toast({
        title: 'Could not create project',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    const parsed = createSchema.safeParse(values);
    if (!parsed.success) {
      for (const [k, v] of Object.entries(parsed.error.flatten().fieldErrors)) {
        if (v?.[0]) form.setError(k as keyof CreateInput, { message: v[0] });
      }
      return;
    }
    mutation.mutate(parsed.data);
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="h-9 gap-1.5 px-3.5">
          <Plus className="h-3.5 w-3.5" />
          New project
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a new project</DialogTitle>
          <DialogDescription>
            Set the screenshot interval and blur policy. You can change these later.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="project-name">Name</Label>
            <Input id="project-name" {...form.register('name')} autoFocus />
            {form.formState.errors.name && (
              <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-description">Description (optional)</Label>
            <Input id="project-description" {...form.register('description')} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="project-interval">Screenshot interval (min)</Label>
              <Input
                id="project-interval"
                type="number"
                min={1}
                max={60}
                {...form.register('screenshotIntervalMinutes', { valueAsNumber: true })}
              />
              {form.formState.errors.screenshotIntervalMinutes && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.screenshotIntervalMinutes.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="project-idle-timeout">Idle timeout (min)</Label>
              <Input
                id="project-idle-timeout"
                type="number"
                min={1}
                max={60}
                {...form.register('idleTimeoutMinutes', { valueAsNumber: true })}
              />
              {form.formState.errors.idleTimeoutMinutes && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.idleTimeoutMinutes.message}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              id="project-blur"
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              {...form.register('blurScreenshots')}
            />
            <Label htmlFor="project-blur" className="cursor-pointer">
              Blur screenshots before storing
            </Label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? <Spinner /> : 'Create project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
