import type { ProjectDto } from '@hindsight/shared/dto';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, createFileRoute, useRouterState } from '@tanstack/react-router';
import { Archive, ArchiveRestore, Settings2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { Pill } from '@/components/ui/pill';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/use-toast';
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { formatHours } from '@/lib/format';
import { projectAccent } from '@/lib/project-accent';
import { queryKeys } from '@/lib/queries';
import { useCan } from '@/lib/use-can';

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

export const Route = createFileRoute('/_app/orgs/$orgId/projects/$projectId')({
  component: ProjectDetailLayout,
});

function startOfWeekIso(): string {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  const offset = day === 0 ? 6 : day - 1;
  monday.setDate(now.getDate() - offset);
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString();
}

function ProjectDetailLayout() {
  const params = Route.useParams();
  const canUpdate = useCan('projects:update');
  const canArchive = useCan('projects:archive');
  const path = useRouterState({ select: (s) => s.location.pathname });

  const query = useQuery({
    queryKey: queryKeys.project(params.projectId),
    queryFn: () => apiGet<ProjectDto>(`/projects/${params.projectId}`),
    retry: (failureCount, error) => {
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        return false;
      }
      return failureCount < 2;
    },
  });

  const weekFrom = startOfWeekIso();
  const weekQuery = useQuery({
    enabled: Boolean(query.data),
    queryKey: queryKeys.timeTotals(params.orgId, {
      projectId: params.projectId,
      from: weekFrom,
    }),
    queryFn: () =>
      apiGet<TimeTotalsResponse>(`/orgs/${params.orgId}/reports/time-totals`, {
        projectId: params.projectId,
        from: weekFrom,
      }),
  });

  if (query.isLoading) {
    return <Skeleton className="h-40 w-full max-w-3xl" />;
  }

  if (query.error instanceof ApiError && query.error.status === 403) {
    return (
      <div className="mx-auto max-w-2xl rounded-md border border-dashed py-12 text-center">
        <h2 className="text-lg font-medium">Access denied</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          You don&apos;t have access to this project. Ask an admin to add you.
        </p>
        <Button asChild variant="outline" className="mt-4">
          <Link to="/orgs/$orgId/projects" params={{ orgId: params.orgId }}>
            Back to projects
          </Link>
        </Button>
      </div>
    );
  }

  if (query.error || !query.data) {
    return (
      <div className="mx-auto max-w-2xl rounded-md border border-dashed py-12 text-center">
        <h2 className="text-lg font-medium">Project not found</h2>
        <Button asChild variant="outline" className="mt-4">
          <Link to="/orgs/$orgId/projects" params={{ orgId: params.orgId }}>
            Back to projects
          </Link>
        </Button>
      </div>
    );
  }

  const project = query.data;
  const overviewPath = `/orgs/${params.orgId}/projects/${params.projectId}`;
  const membersPath = `${overviewPath}/members`;
  const screenshotsPath = `${overviewPath}/screenshots`;
  const weekSeconds = (weekQuery.data?.rows ?? []).reduce((s, r) => s + r.totalActiveSeconds, 0);

  return (
    <div className="px-7 py-6">
      <BreadcrumbSuffix>
        <span className="text-ink4">{' / '}</span>
        <span className="text-foreground">{project.name}</span>
      </BreadcrumbSuffix>

      <HeaderActionsPortal>
        {canUpdate && <EditProjectDialog project={project} />}
        {canArchive && <ArchiveToggleButton project={project} />}
      </HeaderActionsPortal>

      <header className="mb-5 flex flex-wrap items-end justify-between gap-6">
        <div>
          <div className="mb-1.5 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.05em] text-ink4">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{ background: projectAccent(project.id) }}
            />
            Project
          </div>
          <h1 className="text-[26px] font-semibold tracking-tight">{project.name}</h1>
          {project.description && (
            <p className="mt-1 text-[13px] text-ink3">{project.description}</p>
          )}
        </div>
        <div className="flex items-center gap-5">
          {project.archivedAt ? (
            <Pill tone="neutral">
              <Archive className="h-3 w-3" />
              Archived
            </Pill>
          ) : (
            <Pill tone="good">● Active</Pill>
          )}
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-[0.05em] text-ink4">This week</div>
            <div className="mt-0.5 font-mono text-[22px] font-medium tracking-tight tabular-nums">
              {formatHours(weekSeconds)}
            </div>
          </div>
        </div>
      </header>

      <div className="mb-5 flex gap-0 border-b border-border">
        <Link
          to="/orgs/$orgId/projects/$projectId"
          params={params}
          className={tabClasses(path === overviewPath || path === `${overviewPath}/`)}
        >
          Overview
        </Link>
        <Link
          to="/orgs/$orgId/projects/$projectId/members"
          params={params}
          className={tabClasses(path.startsWith(membersPath))}
        >
          Members
        </Link>
        <Link
          to="/orgs/$orgId/projects/$projectId/screenshots"
          params={params}
          className={tabClasses(path.startsWith(screenshotsPath))}
        >
          Screenshots
        </Link>
      </div>

      <Outlet />
    </div>
  );
}

const tabClasses = (active: boolean) =>
  'px-3.5 py-2 text-[13px] border-b-2 -mb-px transition-colors ' +
  (active
    ? 'border-foreground font-medium text-foreground'
    : 'border-transparent text-ink3 hover:text-foreground');

function HeaderActionsPortal({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(document.getElementById('page-header-actions'));
  }, []);
  if (!target) return null;
  return createPortal(children, target);
}

function BreadcrumbSuffix({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(document.getElementById('page-breadcrumb-suffix'));
  }, []);
  if (!target) return null;
  return createPortal(children, target);
}

interface EditInput {
  name?: string;
  description?: string;
  screenshotIntervalMinutes?: number;
  blurScreenshots?: boolean;
  idleTimeoutMinutes?: number;
}

function EditProjectDialog({ project }: { project: ProjectDto }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const form = useForm<EditInput>({
    defaultValues: {
      name: project.name,
      description: project.description ?? '',
      screenshotIntervalMinutes: project.screenshotIntervalMinutes,
      blurScreenshots: project.blurScreenshots,
      idleTimeoutMinutes: project.idleTimeoutMinutes,
    },
  });

  const mutation = useMutation({
    mutationFn: (input: EditInput) => apiPatch<ProjectDto>(`/projects/${project.id}`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.project(project.id) });
      queryClient.invalidateQueries({ queryKey: ['orgs', project.orgId, 'projects'] });
      toast({ title: 'Project updated' });
      setOpen(false);
    },
    onError: (err) => {
      toast({
        title: 'Could not update project',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    const patch: Record<string, unknown> = {};
    if (values.name && values.name !== project.name) patch['name'] = values.name;
    const newDesc = values.description ?? '';
    const oldDesc = project.description ?? '';
    if (newDesc !== oldDesc) patch['description'] = newDesc || null;
    if (
      values.screenshotIntervalMinutes !== undefined &&
      values.screenshotIntervalMinutes !== project.screenshotIntervalMinutes
    ) {
      patch['screenshotIntervalMinutes'] = values.screenshotIntervalMinutes;
    }
    if (
      values.blurScreenshots !== undefined &&
      values.blurScreenshots !== project.blurScreenshots
    ) {
      patch['blurScreenshots'] = values.blurScreenshots;
    }
    if (
      values.idleTimeoutMinutes !== undefined &&
      values.idleTimeoutMinutes !== project.idleTimeoutMinutes
    ) {
      patch['idleTimeoutMinutes'] = values.idleTimeoutMinutes;
    }
    if (Object.keys(patch).length === 0) {
      setOpen(false);
      return;
    }
    mutation.mutate(patch as EditInput);
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="h-9 gap-1.5">
          <Settings2 className="h-3.5 w-3.5" />
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit project</DialogTitle>
          <DialogDescription>Changes save immediately.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="edit-name">Name</Label>
            <Input id="edit-name" {...form.register('name')} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-description">Description</Label>
            <Input id="edit-description" {...form.register('description')} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="edit-interval">Screenshot interval (min)</Label>
              <Input
                id="edit-interval"
                type="number"
                min={1}
                max={60}
                {...form.register('screenshotIntervalMinutes', { valueAsNumber: true })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-idle-timeout">Idle timeout (min)</Label>
              <Input
                id="edit-idle-timeout"
                type="number"
                min={1}
                max={60}
                {...form.register('idleTimeoutMinutes', { valueAsNumber: true })}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              id="edit-blur"
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              {...form.register('blurScreenshots')}
            />
            <Label htmlFor="edit-blur" className="cursor-pointer">
              Blur screenshots before storing
            </Label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? <Spinner /> : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ArchiveToggleButton({ project }: { project: ProjectDto }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isArchived = !!project.archivedAt;

  const mutation = useMutation({
    mutationFn: () =>
      isArchived
        ? apiDelete(`/projects/${project.id}/archive`)
        : apiPost(`/projects/${project.id}/archive`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.project(project.id) });
      queryClient.invalidateQueries({ queryKey: ['orgs', project.orgId, 'projects'] });
      toast({ title: isArchived ? 'Project unarchived' : 'Project archived' });
      setOpen(false);
    },
    onError: (err) => {
      toast({
        title: 'Could not change archive state',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          className="h-9 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          {isArchived ? <ArchiveRestore className="mr-1.5 h-3.5 w-3.5" /> : null}
          {isArchived ? 'Unarchive' : 'Archive'}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isArchived ? 'Unarchive this project?' : 'Archive this project?'}
          </DialogTitle>
          <DialogDescription>
            {isArchived
              ? 'It will be visible again in the active projects list.'
              : 'Archived projects are hidden from the default list. Their existing time entries and screenshots are preserved.'}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner /> : isArchived ? 'Unarchive' : 'Archive'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
