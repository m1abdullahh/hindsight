import type { MembershipDto, ProjectDto, TimeEntryDto, UserDto } from '@hindsight/shared/dto';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { ArrowLeft, Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Pill } from '@/components/ui/pill';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/components/ui/use-toast';
import { ApiError, apiGet, apiPost } from '@/lib/api';
import { formatDateTime, formatHours, formatRelative } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { queryKeys } from '@/lib/queries';
import { useCurrentMembership } from '@/lib/session-store';

interface MemberRow {
  membership: MembershipDto;
  user: UserDto;
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
interface TimeEntriesResponse {
  entries: TimeEntryDto[];
}
interface ScreenshotListItem {
  screenshot: {
    id: string;
    capturedAt: string;
    activeApp: string | null;
    activeWindowTitle: string | null;
  };
  thumbnailUrl: string | null;
}
interface ScreenshotsResponse {
  items: ScreenshotListItem[];
}

export const Route = createFileRoute('/_app/orgs/$orgId/members/$userId')({
  component: MemberDetailPage,
});

function MemberDetailPage() {
  const params = Route.useParams();
  const callerMembership = useCurrentMembership();
  const isAdmin = callerMembership?.role === 'owner' || callerMembership?.role === 'admin';
  const isSelf = callerMembership?.userId === params.userId;
  const canView = isAdmin || isSelf;

  const membersQuery = useQuery({
    queryKey: queryKeys.members(params.orgId),
    queryFn: () => apiGet<{ members: MemberRow[] }>(`/orgs/${params.orgId}/members`),
    enabled: canView,
  });

  const totalsQuery = useQuery({
    queryKey: queryKeys.timeTotals(params.orgId, { userId: params.userId }),
    enabled: canView,
    queryFn: () =>
      apiGet<TimeTotalsResponse>(`/orgs/${params.orgId}/reports/time-totals`, {
        userId: params.userId,
      }),
  });

  const recentEntriesQuery = useQuery({
    queryKey: ['orgs', params.orgId, 'time-entries', { userId: params.userId, limit: 10 }],
    enabled: canView,
    queryFn: () =>
      apiGet<TimeEntriesResponse>(`/orgs/${params.orgId}/time-entries`, {
        userId: params.userId,
        limit: 10,
      }),
  });

  const recentScreenshotsQuery = useQuery({
    queryKey: queryKeys.screenshots(params.orgId, { userId: params.userId }),
    enabled: canView,
    queryFn: () =>
      apiGet<ScreenshotsResponse>(`/orgs/${params.orgId}/screenshots`, {
        userId: params.userId,
        limit: 12,
      }),
  });

  if (!canView) {
    return (
      <div className="mx-auto max-w-2xl rounded-md border border-dashed py-12 text-center">
        <h2 className="text-lg font-medium">Access denied</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          You can only view your own member detail page.
        </p>
        <Button asChild variant="outline" className="mt-4">
          <Link to="/orgs/$orgId/members" params={{ orgId: params.orgId }}>
            Back to members
          </Link>
        </Button>
      </div>
    );
  }

  const memberRow = membersQuery.data?.members.find((m) => m.user.id === params.userId);

  if (membersQuery.isLoading) {
    return <Skeleton className="h-40 w-full max-w-3xl" />;
  }

  if (membersQuery.error instanceof ApiError && membersQuery.error.status === 403) {
    return (
      <div className="mx-auto max-w-2xl rounded-md border border-dashed py-12 text-center">
        <h2 className="text-lg font-medium">Access denied</h2>
        <Button asChild variant="outline" className="mt-4">
          <Link to="/orgs/$orgId" params={{ orgId: params.orgId }}>
            Back to dashboard
          </Link>
        </Button>
      </div>
    );
  }

  if (!memberRow) {
    return (
      <div className="mx-auto max-w-2xl rounded-md border border-dashed py-12 text-center">
        <h2 className="text-lg font-medium">Member not found</h2>
        <Button asChild variant="outline" className="mt-4">
          <Link to="/orgs/$orgId/members" params={{ orgId: params.orgId }}>
            Back to members
          </Link>
        </Button>
      </div>
    );
  }

  const totals = totalsQuery.data?.rows ?? [];
  const totalSeconds = totals.reduce((s, r) => s + r.totalActiveSeconds, 0);
  const totalEarned = totals.reduce((s, r) => s + (r.earnedCents ?? 0), 0);
  const anyEarned = totals.some((r) => r.earnedCents !== null);
  const entries = recentEntriesQuery.data?.entries ?? [];
  const screenshots = recentScreenshotsQuery.data?.items ?? [];

  return (
    <div className="px-7 py-6">
      <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2 h-7 text-ink3">
        <Link to="/orgs/$orgId/members" params={{ orgId: params.orgId }}>
          <ArrowLeft className="mr-1 h-3.5 w-3.5" />
          All members
        </Link>
      </Button>

      <header className="mb-5 flex items-end justify-between">
        <div className="flex items-center gap-3.5">
          <AvatarLive userId={memberRow.user.id} name={memberRow.user.name} size={48} />
          <div>
            <h1 className="text-[26px] font-semibold tracking-tight">{memberRow.user.name}</h1>
            <p className="mt-0.5 text-[13px] text-ink3">{memberRow.user.email}</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            {isAdmin && (
              <AddTimeDialog
                orgId={params.orgId}
                userId={params.userId}
                userName={memberRow.user.name}
              />
            )}
            {memberRow.membership.role === 'owner' ? (
              <Pill tone="dark">Owner</Pill>
            ) : memberRow.membership.role === 'admin' ? (
              <Pill tone="accent">Admin</Pill>
            ) : (
              <Pill>Member</Pill>
            )}
          </div>
          <span className="text-[11px] text-ink4">
            Joined {formatRelative(memberRow.membership.createdAt)}
          </span>
        </div>
      </header>

      <section className="mb-4 rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2.5">
            <h2 className="text-[13px] font-medium">Time totals</h2>
            <span className="font-mono text-[11px] text-ink4">all time</span>
          </div>
          <span className="font-mono text-[11px] text-ink4">
            {formatHours(totalSeconds)}
            {anyEarned ? ` · ${formatMoney(totalEarned)}` : ''}
          </span>
        </div>
        {totalsQuery.isLoading ? (
          <div className="p-4">
            <Skeleton className="h-32 w-full" />
          </div>
        ) : totals.length === 0 ? (
          <p className="px-4 py-10 text-center text-[13px] text-ink3">No tracked time yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Project</TableHead>
                <TableHead className="text-right">Time</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead className="text-right">Earned</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {totals.map((r) => (
                <TableRow key={r.projectId}>
                  <TableCell className="text-[13px] font-medium">{r.projectName}</TableCell>
                  <TableCell className="text-right font-mono text-[12.5px]">
                    {formatHours(r.totalActiveSeconds)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[12.5px] text-ink3">
                    {formatMoney(r.hourlyRateCents)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[12.5px]">
                    {formatMoney(r.earnedCents)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="text-[13px] font-medium">Total</TableCell>
                <TableCell className="text-right font-mono text-[12.5px] font-medium">
                  {formatHours(totalSeconds)}
                </TableCell>
                <TableCell />
                <TableCell className="text-right font-mono text-[12.5px] font-medium">
                  {anyEarned ? formatMoney(totalEarned) : '—'}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        )}
      </section>

      <section className="mb-4 rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2.5">
            <h2 className="text-[13px] font-medium">Recent sessions</h2>
            <span className="font-mono text-[11px] text-ink4">last 10 entries</span>
          </div>
        </div>
        <div>
          {recentEntriesQuery.isLoading ? (
            <div className="p-4">
              <Skeleton className="h-32 w-full" />
            </div>
          ) : entries.length === 0 ? (
            <p className="px-4 py-10 text-center text-[13px] text-ink3">No sessions yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Ended</TableHead>
                  <TableHead className="text-right">Active</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-mono text-[12px]">
                      {formatDateTime(e.startedAt)}
                    </TableCell>
                    <TableCell className="font-mono text-[12px] text-ink3">
                      {e.endedAt ? (
                        formatDateTime(e.endedAt)
                      ) : (
                        <Pill tone="accent">In progress</Pill>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[12.5px] font-medium">
                      {formatHours(e.totalActiveSeconds)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2.5">
            <h2 className="text-[13px] font-medium">Recent screenshots</h2>
            <span className="font-mono text-[11px] text-ink4">last 12</span>
          </div>
        </div>
        <div className="p-4">
          {recentScreenshotsQuery.isLoading ? (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="aspect-video w-full" />
              ))}
            </div>
          ) : screenshots.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-ink3">No screenshots yet.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
              {screenshots.map((item) => (
                <div
                  key={item.screenshot.id}
                  className="relative aspect-video overflow-hidden rounded-md border border-border bg-muted"
                  title={
                    item.screenshot.activeApp
                      ? `${item.screenshot.activeApp} · ${formatRelative(item.screenshot.capturedAt)}`
                      : formatRelative(item.screenshot.capturedAt)
                  }
                >
                  {item.thumbnailUrl ? (
                    <img
                      src={item.thumbnailUrl}
                      alt={`Screenshot from ${formatRelative(item.screenshot.capturedAt)}`}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="grid h-full place-items-center text-[10px] text-ink4">—</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

interface AddTimeForm {
  projectId: string;
  date: string;
  hours: number;
  minutes: number;
  notes: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Admin-only: manually record time on a member's behalf (project + day +
// duration). Counts as active/billable time on reports, same as tracked time.
function AddTimeDialog({
  orgId,
  userId,
  userName,
}: {
  orgId: string;
  userId: string;
  userName: string;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects(orgId),
    enabled: open,
    queryFn: () => apiGet<{ projects: ProjectDto[] }>(`/orgs/${orgId}/projects`),
  });
  const projects = (projectsQuery.data?.projects ?? []).filter((p) => p.archivedAt === null);

  const form = useForm<AddTimeForm>({
    defaultValues: { projectId: '', date: todayIso(), hours: 1, minutes: 0, notes: '' },
  });

  const mutation = useMutation({
    mutationFn: (input: {
      projectId: string;
      date: string;
      durationSeconds: number;
      notes?: string;
    }) => apiPost<TimeEntryDto>(`/orgs/${orgId}/members/${userId}/time-entries`, input),
    onSuccess: () => {
      // Prefix-match invalidation refreshes the member's time totals and the
      // recent-sessions list regardless of their filter variants.
      queryClient.invalidateQueries({ queryKey: ['orgs', orgId, 'reports', 'time-totals'] });
      queryClient.invalidateQueries({ queryKey: ['orgs', orgId, 'time-entries'] });
      toast({ title: 'Time added', description: `Added to ${userName}'s record.` });
      setOpen(false);
      form.reset({ projectId: '', date: todayIso(), hours: 1, minutes: 0, notes: '' });
    },
    onError: (err) => {
      toast({
        title: 'Could not add time',
        description: err instanceof ApiError ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    if (!values.projectId) {
      form.setError('projectId', { message: 'Pick a project' });
      return;
    }
    const hours = Number(values.hours) || 0;
    const minutes = Number(values.minutes) || 0;
    const durationSeconds = hours * 3600 + minutes * 60;
    if (durationSeconds < 1) {
      form.setError('minutes', { message: 'Enter a duration greater than zero' });
      return;
    }
    if (durationSeconds > 86_400) {
      form.setError('hours', { message: 'Maximum is 24 hours' });
      return;
    }
    mutation.mutate({
      projectId: values.projectId,
      date: values.date,
      durationSeconds,
      ...(values.notes.trim() ? { notes: values.notes.trim() } : {}),
    });
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          Add time
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add time for {userName}</DialogTitle>
          <DialogDescription>
            Manually record time the member didn&apos;t track. It counts as active hours on reports.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="add-time-project">Project</Label>
            <Select
              value={form.watch('projectId')}
              onValueChange={(v) => {
                form.setValue('projectId', v);
                form.clearErrors('projectId');
              }}
            >
              <SelectTrigger id="add-time-project">
                <SelectValue
                  placeholder={projectsQuery.isLoading ? 'Loading…' : 'Select a project'}
                />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.formState.errors.projectId && (
              <p className="text-xs text-destructive">{form.formState.errors.projectId.message}</p>
            )}
            {!projectsQuery.isLoading && projects.length === 0 && (
              <p className="text-[11px] text-ink4">No active projects in this org.</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="add-time-date">Date</Label>
            <Input id="add-time-date" type="date" max={todayIso()} {...form.register('date')} />
          </div>

          <div className="space-y-2">
            <Label>Duration</Label>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <Input
                  id="add-time-hours"
                  type="number"
                  min={0}
                  max={24}
                  className="w-20"
                  {...form.register('hours', { valueAsNumber: true })}
                />
                <span className="text-[12px] text-ink3">h</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Input
                  id="add-time-minutes"
                  type="number"
                  min={0}
                  max={59}
                  className="w-20"
                  {...form.register('minutes', { valueAsNumber: true })}
                />
                <span className="text-[12px] text-ink3">m</span>
              </div>
            </div>
            {(form.formState.errors.hours || form.formState.errors.minutes) && (
              <p className="text-xs text-destructive">
                {form.formState.errors.hours?.message ?? form.formState.errors.minutes?.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="add-time-notes">Note (optional)</Label>
            <Input
              id="add-time-notes"
              type="text"
              placeholder="e.g. forgot to start the tracker"
              {...form.register('notes')}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? <Spinner className="mr-1.5 h-3.5 w-3.5" /> : null}
              Add time
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
