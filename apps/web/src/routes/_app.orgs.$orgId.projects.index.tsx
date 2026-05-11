import type { ProjectDto } from '@hindsight/shared/dto';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Archive, FolderPlus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/components/ui/use-toast';
import { apiGet, apiPost } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { projectAccent, projectAccentSoft } from '@/lib/project-accent';
import { queryKeys } from '@/lib/queries';
import { useCan } from '@/lib/use-can';

const searchSchema = z.object({
  archived: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
});

interface ProjectsResponse {
  projects: ProjectDto[];
}

export const Route = createFileRoute('/_app/orgs/$orgId/projects/')({
  validateSearch: searchSchema,
  component: ProjectsListPage,
});

function ProjectsListPage() {
  const params = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const includeArchived = search.archived ?? false;
  const canCreate = useCan('projects:create');

  const query = useQuery({
    queryKey: queryKeys.projects(params.orgId, includeArchived),
    queryFn: () =>
      apiGet<ProjectsResponse>(`/orgs/${params.orgId}/projects`, {
        ...(includeArchived ? { includeArchived: true } : {}),
      }),
  });

  const projectCount = query.data?.projects.length ?? 0;

  return (
    <div className="px-7 py-6">
      <header className="mb-5 flex items-end justify-between">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-[13px] text-ink3">
            {includeArchived
              ? 'Archived projects in this organization.'
              : 'Active projects in this organization.'}
          </p>
        </div>
        {canCreate && <NewProjectDialog orgId={params.orgId} />}
      </header>

      {/* Active/Archived pill toggle (mock style) */}
      <div className="mb-4 inline-flex rounded-md bg-muted p-0.5 text-[12.5px]">
        <PillToggle active={!includeArchived} onClick={() => navigate({ search: {} })}>
          Active
          {!includeArchived && projectCount > 0 && (
            <span className="ml-1.5 font-mono text-[11px] text-ink4">{projectCount}</span>
          )}
        </PillToggle>
        <PillToggle
          active={includeArchived}
          onClick={() => navigate({ search: { archived: true } })}
        >
          Archived
        </PillToggle>
      </div>

      {query.isLoading ? (
        <div className="rounded-lg border border-border bg-card p-4">
          <Skeleton className="h-40 w-full" />
        </div>
      ) : query.data?.projects.length ? (
        <div className="rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2.5">
              <h2 className="text-[13px] font-medium">
                {includeArchived ? 'Archived projects' : 'Active projects'}
              </h2>
              <span className="font-mono text-[11px] text-ink4">
                {projectCount} project{projectCount === 1 ? '' : 's'}
              </span>
            </div>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Interval</TableHead>
                <TableHead>Blur</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.projects.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <Link
                      to="/orgs/$orgId/projects/$projectId"
                      params={{ orgId: params.orgId, projectId: p.id }}
                      className="flex items-center gap-2.5 hover:underline"
                    >
                      <span
                        className="grid h-[22px] w-[22px] place-items-center rounded"
                        style={{ background: projectAccentSoft(p.id) }}
                      >
                        <span
                          className="h-[9px] w-[9px] rounded-sm"
                          style={{ background: projectAccent(p.id) }}
                        />
                      </span>
                      <span>
                        <span className="block text-[13px] font-medium">{p.name}</span>
                        <span className="block text-[11px] text-ink4">{p.description ?? '—'}</span>
                      </span>
                      {p.archivedAt && (
                        <Pill tone="neutral" className="ml-1">
                          <Archive className="h-3 w-3" />
                          archived
                        </Pill>
                      )}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-[12px] text-ink3">
                    {p.screenshotIntervalMinutes} min
                  </TableCell>
                  <TableCell>
                    {p.blurScreenshots ? <Pill tone="accent">On</Pill> : <Pill>Off</Pill>}
                  </TableCell>
                  <TableCell className="text-[12px] text-ink3">
                    {formatRelative(p.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState canCreate={canCreate} archived={includeArchived} />
      )}
    </div>
  );
}

function PillToggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'rounded px-3.5 py-1 transition-colors ' +
        (active
          ? 'bg-card font-medium text-foreground shadow-sm'
          : 'text-ink3 hover:text-foreground')
      }
    >
      {children}
    </button>
  );
}

function EmptyState({ canCreate, archived }: { canCreate: boolean; archived: boolean }) {
  if (archived) {
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
    },
  });

  const mutation = useMutation({
    mutationFn: (input: CreateInput) =>
      apiPost<ProjectDto>(`/orgs/${orgId}/projects`, {
        name: input.name,
        description: input.description || undefined,
        screenshotIntervalMinutes: input.screenshotIntervalMinutes,
        blurScreenshots: input.blurScreenshots,
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
        <Button>New project</Button>
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
          <div className="space-y-2">
            <Label htmlFor="project-interval">Screenshot interval (minutes)</Label>
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
