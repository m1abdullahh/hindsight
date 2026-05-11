import type { MembershipDto, ProjectAssignmentDto, UserDto } from '@hindsight/shared/dto';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Check, Pencil, X } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { AvatarLive } from '@/components/ui/avatar-live';
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
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/components/ui/use-toast';
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { dollarsToCents, formatMoney } from '@/lib/money';
import { queryKeys } from '@/lib/queries';
import { useCan } from '@/lib/use-can';

const searchSchema = z.object({
  showRemoved: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
});

interface AssignmentRow {
  assignment: ProjectAssignmentDto;
  user: UserDto;
}
interface AssignmentsResponse {
  assignments: AssignmentRow[];
}

interface MemberRow {
  membership: MembershipDto;
  user: UserDto;
}
interface MembersResponse {
  members: MemberRow[];
}

export const Route = createFileRoute('/_app/orgs/$orgId/projects/$projectId/members')({
  validateSearch: searchSchema,
  component: ProjectMembersPage,
});

function ProjectMembersPage() {
  const params = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const showRemoved = search.showRemoved ?? false;
  const canAssign = useCan('projects:assign_members');

  const assignmentsQuery = useQuery({
    queryKey: queryKeys.assignments(params.projectId, showRemoved),
    queryFn: () =>
      apiGet<AssignmentsResponse>(`/projects/${params.projectId}/assignments`, {
        ...(showRemoved ? { includeRemoved: true } : {}),
      }),
  });

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-[15px] font-medium">Members</h2>
          <p className="text-[12.5px] text-ink3">People assigned to this project.</p>
        </div>
        <div className="flex items-center gap-3">
          {canAssign && (
            <label className="flex items-center gap-1.5 text-[12.5px] text-ink3">
              <input
                type="checkbox"
                checked={showRemoved}
                onChange={(e) =>
                  navigate({
                    search: e.target.checked ? { showRemoved: true } : {},
                  })
                }
                className="h-3.5 w-3.5 accent-accent"
              />
              Show removed
            </label>
          )}
          {canAssign && <AddMemberDialog orgId={params.orgId} projectId={params.projectId} />}
        </div>
      </div>

      {assignmentsQuery.isLoading ? (
        <div className="rounded-lg border border-border bg-card p-4">
          <Skeleton className="h-40 w-full" />
        </div>
      ) : assignmentsQuery.data?.assignments.length ? (
        <div className="rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2.5">
              <h3 className="text-[13px] font-medium">Assignments</h3>
              <span className="font-mono text-[11px] text-ink4">
                {assignmentsQuery.data.assignments.filter((a) => !a.assignment.removedAt).length}{' '}
                active
              </span>
            </div>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Hourly rate</TableHead>
                <TableHead>Assigned</TableHead>
                <TableHead>Status</TableHead>
                {canAssign && <TableHead className="w-32" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {assignmentsQuery.data.assignments.map((row) => (
                <AssignmentTableRow
                  key={row.assignment.id}
                  projectId={params.projectId}
                  row={row}
                  canAssign={canAssign}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border-strong bg-card px-6 py-14 text-center">
          <p className="text-[13px] text-ink3">
            {canAssign ? 'No members yet. Add someone to get started.' : 'No members yet.'}
          </p>
        </div>
      )}
    </div>
  );
}

function AssignmentTableRow({
  projectId,
  row,
  canAssign,
}: {
  projectId: string;
  row: AssignmentRow;
  canAssign: boolean;
}) {
  const [editingRate, setEditingRate] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isRemoved = row.assignment.removedAt !== null;

  const rowClasses = isRemoved ? 'opacity-50' : '';

  return (
    <TableRow className={rowClasses}>
      <TableCell>
        <div className="flex items-center gap-2.5">
          <AvatarLive userId={row.user.id} name={row.user.name} size={28} />
          <div>
            <div className="text-[13px] font-medium">{row.user.name}</div>
            <div className="text-[11px] text-ink4">{row.user.email}</div>
          </div>
        </div>
      </TableCell>
      <TableCell>
        {editingRate && canAssign && !isRemoved ? (
          <RateEditor
            projectId={projectId}
            userId={row.user.id}
            initialCents={row.assignment.hourlyRateCents}
            onClose={() => setEditingRate(false)}
          />
        ) : (
          <div className="flex items-center gap-2">
            <span className="font-mono text-[12.5px]">
              {formatMoney(row.assignment.hourlyRateCents)}
            </span>
            {canAssign && !isRemoved && (
              <button
                type="button"
                onClick={() => setEditingRate(true)}
                className="text-ink4 hover:text-foreground"
                aria-label="Edit rate"
              >
                <Pencil className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
      </TableCell>
      <TableCell className="text-[12px] text-ink3">
        {formatRelative(row.assignment.assignedAt)}
      </TableCell>
      <TableCell>
        {isRemoved ? <Pill tone="danger">Removed</Pill> : <Pill tone="good">● Active</Pill>}
      </TableCell>
      {canAssign && (
        <TableCell>
          {isRemoved ? (
            <ReAddButton
              projectId={projectId}
              userId={row.user.id}
              onSuccess={() => {
                queryClient.invalidateQueries({
                  queryKey: ['projects', projectId, 'assignments'],
                });
                toast({ title: 'Member re-added' });
              }}
            />
          ) : (
            <RemoveAssignmentButton
              projectId={projectId}
              userId={row.user.id}
              userName={row.user.name}
            />
          )}
        </TableCell>
      )}
    </TableRow>
  );
}

function RateEditor({
  projectId,
  userId,
  initialCents,
  onClose,
}: {
  projectId: string;
  userId: string;
  initialCents: number | null;
  onClose: () => void;
}) {
  const initialDollars = initialCents !== null ? (initialCents / 100).toString() : '';
  const [value, setValue] = useState(initialDollars);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: (hourlyRateCents: number | null) =>
      apiPatch(`/projects/${projectId}/assignments/${userId}`, { hourlyRateCents }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'assignments'] });
      toast({ title: 'Rate updated' });
      onClose();
    },
    onError: (err) => {
      toast({
        title: 'Could not update rate',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const submit = () => {
    try {
      const cents = dollarsToCents(value);
      mutation.mutate(cents);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid amount');
    }
  };

  return (
    <div className="flex items-center gap-1">
      <span className="text-muted-foreground">$</span>
      <Input
        autoFocus
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') onClose();
        }}
        className="h-8 w-24"
        placeholder="0.00"
      />
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8"
        onClick={submit}
        disabled={mutation.isPending}
        aria-label="Save rate"
      >
        {mutation.isPending ? <Spinner /> : <Check className="h-4 w-4" />}
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8"
        onClick={onClose}
        aria-label="Cancel rate edit"
      >
        <X className="h-4 w-4" />
      </Button>
      {error && <p className="ml-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

function RemoveAssignmentButton({
  projectId,
  userId,
  userName,
}: {
  projectId: string;
  userId: string;
  userName: string;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: () => apiDelete(`/projects/${projectId}/assignments/${userId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'assignments'] });
      toast({ title: 'Member removed from project' });
      setOpen(false);
    },
    onError: (err) => {
      toast({
        title: 'Could not remove member',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
          Remove
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {userName} from this project?</DialogTitle>
          <DialogDescription>
            They&apos;ll lose access to it but stay in the org. Their existing time entries are
            preserved.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? <Spinner /> : 'Remove'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReAddButton({
  projectId,
  userId,
  onSuccess,
}: {
  projectId: string;
  userId: string;
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const mutation = useMutation({
    mutationFn: () => apiPost(`/projects/${projectId}/assignments`, { userId }),
    onSuccess,
    onError: (err) => {
      toast({
        title: 'Could not re-add member',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
    >
      {mutation.isPending ? <Spinner /> : 'Re-add'}
    </Button>
  );
}

const addSchema = z.object({
  userId: z.string().min(1, 'Pick a member'),
  hourlyRate: z.string().optional(),
});
type AddInput = z.infer<typeof addSchema>;

function AddMemberDialog({ orgId, projectId }: { orgId: string; projectId: string }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const membersQuery = useQuery({
    queryKey: queryKeys.members(orgId),
    enabled: open,
    queryFn: () => apiGet<MembersResponse>(`/orgs/${orgId}/members`),
  });

  const assignmentsQuery = useQuery({
    queryKey: queryKeys.assignments(projectId, false),
    enabled: open,
    queryFn: () => apiGet<AssignmentsResponse>(`/projects/${projectId}/assignments`),
  });

  const form = useForm<AddInput>({ defaultValues: { userId: '', hourlyRate: '' } });

  const mutation = useMutation({
    mutationFn: (body: { userId: string; hourlyRateCents?: number }) =>
      apiPost<ProjectAssignmentDto>(`/projects/${projectId}/assignments`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'assignments'] });
      toast({ title: 'Member added to project' });
      setOpen(false);
      form.reset();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'conflict') {
        form.setError('userId', { message: 'This member is already on the project' });
        return;
      }
      toast({
        title: 'Could not add member',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    const parsed = addSchema.safeParse(values);
    if (!parsed.success) {
      const issues = parsed.error.flatten().fieldErrors;
      if (issues.userId?.[0]) form.setError('userId', { message: issues.userId[0] });
      return;
    }
    const body: { userId: string; hourlyRateCents?: number } = { userId: parsed.data.userId };
    if (parsed.data.hourlyRate) {
      try {
        const cents = dollarsToCents(parsed.data.hourlyRate);
        if (cents !== null) body.hourlyRateCents = cents;
      } catch (e) {
        form.setError('hourlyRate', {
          message: e instanceof Error ? e.message : 'Invalid amount',
        });
        return;
      }
    }
    mutation.mutate(body);
  });

  // Filter the org members down to those NOT currently active on the project.
  const activeAssigneeIds = new Set(
    assignmentsQuery.data?.assignments.filter((a) => !a.assignment.removedAt).map((a) => a.user.id),
  );
  const eligibleMembers =
    membersQuery.data?.members.filter((m) => !activeAssigneeIds.has(m.user.id)) ?? [];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Add member</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a member to this project</DialogTitle>
          <DialogDescription>
            Pick someone from your organization to assign. You can set their rate now or later.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="add-user">Member</Label>
            {membersQuery.isLoading || assignmentsQuery.isLoading ? (
              <Skeleton className="h-10 w-full" />
            ) : eligibleMembers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Everyone in your org is already on this project.
              </p>
            ) : (
              <Select
                value={form.watch('userId')}
                onValueChange={(v) => form.setValue('userId', v)}
              >
                <SelectTrigger id="add-user">
                  <SelectValue placeholder="Choose a member" />
                </SelectTrigger>
                <SelectContent>
                  {eligibleMembers.map((m) => (
                    <SelectItem key={m.user.id} value={m.user.id}>
                      {m.user.name} ({m.user.email})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {form.formState.errors.userId && (
              <p className="text-xs text-destructive">{form.formState.errors.userId.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="add-rate">Hourly rate (optional)</Label>
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground">$</span>
              <Input id="add-rate" placeholder="0.00" {...form.register('hourlyRate')} />
            </div>
            {form.formState.errors.hourlyRate && (
              <p className="text-xs text-destructive">{form.formState.errors.hourlyRate.message}</p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending || eligibleMembers.length === 0}>
              {mutation.isPending ? <Spinner /> : 'Add member'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
