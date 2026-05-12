import type {
  InvitationDto,
  MembershipDto,
  PresenceEntryDto,
  UserDto,
} from '@hindsight/shared/dto';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { MoreHorizontal, Plus, Search } from 'lucide-react';
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
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/components/ui/use-toast';
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { queryKeys } from '@/lib/queries';
import { useUser } from '@/lib/session-store';
import { useCan } from '@/lib/use-can';

interface MemberRow {
  membership: MembershipDto;
  user: UserDto;
}

interface MembersResponse {
  members: MemberRow[];
}

interface InvitationsResponse {
  invitations: InvitationDto[];
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

interface PresenceResponse {
  entries: PresenceEntryDto[];
}

const startOfTodayIso = (): string => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

const formatHm = (seconds: number): string => {
  const safe = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  return `${h}h ${m.toString().padStart(2, '0')}m`;
};

export const Route = createFileRoute('/_app/orgs/$orgId/members')({
  component: MembersPage,
});

function MembersPage() {
  const params = Route.useParams();
  const canInvite = useCan('members:invite');
  const canManage = useCan('members:manage');
  const currentUser = useUser();
  const [search, setSearch] = useState('');

  const membersQuery = useQuery({
    queryKey: queryKeys.members(params.orgId),
    queryFn: () => apiGet<MembersResponse>(`/orgs/${params.orgId}/members`),
  });

  const invitationsQuery = useQuery({
    queryKey: queryKeys.invitations(params.orgId),
    enabled: canInvite,
    queryFn: () => apiGet<InvitationsResponse>(`/orgs/${params.orgId}/invitations`),
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

  // Wider window for "assigned" projects + per-user default rate. The API
  // doesn't expose org-wide assignments in a single call, so we derive these
  // from recent activity — good enough for the members overview.
  const recentTotalsQuery = useQuery({
    queryKey: queryKeys.timeTotals(params.orgId, {}),
    queryFn: () => apiGet<TimeTotalsResponse>(`/orgs/${params.orgId}/reports/time-totals`, {}),
  });

  const presenceQuery = useQuery({
    queryKey: queryKeys.presence(params.orgId),
    queryFn: () => apiGet<PresenceResponse>(`/orgs/${params.orgId}/presence`),
    refetchInterval: 15_000,
    staleTime: 0,
  });

  const members = membersQuery.data?.members ?? [];
  const invitations = invitationsQuery.data?.invitations ?? [];

  const memberCount = members.length;
  const owners = members.filter((m) => m.membership.role === 'owner').length;
  const admins = members.filter((m) => m.membership.role === 'admin').length;
  const memberRoleCount = memberCount - owners - admins;
  const pendingCount = invitations.length;

  const presenceByUser = useMemo(() => {
    const map = new Map<string, PresenceEntryDto['state']>();
    for (const e of presenceQuery.data?.entries ?? []) map.set(e.userId, e.state);
    return map;
  }, [presenceQuery.data]);

  const todaySecondsByUser = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of todayTotalsQuery.data?.rows ?? []) {
      map.set(r.userId, (map.get(r.userId) ?? 0) + r.totalActiveSeconds);
    }
    return map;
  }, [todayTotalsQuery.data]);

  // Per-user derived view of "projects" and "default rate" from recent
  // time-totals. We use distinct project count and pick the most-frequent
  // hourly rate across that user's projects.
  const projectsAndRateByUser = useMemo(() => {
    const projects = new Map<string, Set<string>>();
    const rates = new Map<string, Map<number, number>>();
    for (const r of recentTotalsQuery.data?.rows ?? []) {
      let set = projects.get(r.userId);
      if (!set) {
        set = new Set();
        projects.set(r.userId, set);
      }
      set.add(r.projectId);
      if (r.hourlyRateCents !== null) {
        let counts = rates.get(r.userId);
        if (!counts) {
          counts = new Map();
          rates.set(r.userId, counts);
        }
        counts.set(r.hourlyRateCents, (counts.get(r.hourlyRateCents) ?? 0) + 1);
      }
    }
    const result = new Map<string, { projectCount: number; rateCents: number | null }>();
    const allUserIds = new Set<string>([...projects.keys(), ...rates.keys()]);
    for (const userId of allUserIds) {
      const set = projects.get(userId);
      const counts = rates.get(userId);
      let topRate: number | null = null;
      let topCount = 0;
      if (counts) {
        for (const [rate, c] of counts) {
          if (c > topCount) {
            topRate = rate;
            topCount = c;
          }
        }
      }
      result.set(userId, {
        projectCount: set?.size ?? 0,
        rateCents: topRate,
      });
    }
    return result;
  }, [recentTotalsQuery.data]);

  const trackingNow = useMemo(() => {
    let n = 0;
    for (const m of members) {
      const p = presenceByUser.get(m.user.id);
      if (p === 'active' || p === 'idle') n++;
    }
    return n;
  }, [members, presenceByUser]);

  const filteredMembers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return members;
    return members.filter(
      (m) => m.user.name.toLowerCase().includes(q) || m.user.email.toLowerCase().includes(q),
    );
  }, [members, search]);

  // Look up the inviter's name for "Invited by …" labels on pending invites.
  const memberById = useMemo(() => {
    const map = new Map<string, UserDto>();
    for (const m of members) map.set(m.user.id, m.user);
    return map;
  }, [members]);

  const mostRecentInvite = invitations.reduce<InvitationDto | null>((acc, inv) => {
    if (!acc) return inv;
    return new Date(inv.createdAt) > new Date(acc.createdAt) ? inv : acc;
  }, null);

  return (
    <div className="px-7 py-6">
      <header className="mb-5">
        <h1 className="text-[26px] font-semibold tracking-tight">Members</h1>
        <p className="mt-1 text-[13px] text-ink3">People with access to this organization.</p>
      </header>

      {canInvite && (
        <HeaderActionsPortal>
          <InviteMemberDialog orgId={params.orgId} />
        </HeaderActionsPortal>
      )}

      <div className="mb-4 grid grid-cols-1 gap-3.5 md:grid-cols-3">
        <div className="rounded-lg border border-border bg-card px-4 py-3.5">
          <div className="text-[11px] tracking-wide text-ink3">Total members</div>
          <div className="mt-1.5 font-mono text-2xl font-medium tabular-nums">{memberCount}</div>
          <div className="mt-1 text-[11.5px] text-ink3">
            {owners} owner{owners === 1 ? '' : 's'} · {admins} admin{admins === 1 ? '' : 's'} ·{' '}
            {memberRoleCount} member{memberRoleCount === 1 ? '' : 's'}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card px-4 py-3.5">
          <div className="text-[11px] tracking-wide text-ink3">Active today</div>
          <div className="mt-1.5 font-mono text-2xl font-medium tabular-nums">{trackingNow}</div>
          <div className="mt-1 text-[11.5px] text-ink3">
            {trackingNow === 0 ? 'no one tracking' : 'tracking right now'}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card px-4 py-3.5">
          <div className="text-[11px] tracking-wide text-ink3">Pending invitations</div>
          <div className="mt-1.5 font-mono text-2xl font-medium tabular-nums">{pendingCount}</div>
          <div className="mt-1 text-[11.5px] text-ink3">
            {pendingCount === 0
              ? 'no open invites'
              : mostRecentInvite
                ? `sent ${formatRelative(mostRecentInvite.createdAt)}`
                : 'awaiting acceptance'}
          </div>
        </div>
      </div>

      <section className="mb-4 rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2.5">
            <h2 className="text-[13px] font-medium">Active members</h2>
            <span className="font-mono text-[11px] text-ink4">{memberCount} people</span>
          </div>
          <div className="flex h-7 w-[240px] items-center gap-1.5 rounded-md border border-border bg-background px-2.5">
            <Search className="h-3 w-3 text-ink4" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search members..."
              className="flex-1 bg-transparent text-[12px] text-foreground placeholder:text-ink4 focus:outline-none"
            />
          </div>
        </div>
        {membersQuery.isLoading ? (
          <div className="p-4">
            <Skeleton className="h-32 w-full" />
          </div>
        ) : filteredMembers.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="h-10 text-[10.5px] uppercase tracking-wide text-ink4">
                  Name
                </TableHead>
                <TableHead className="h-10 text-[10.5px] uppercase tracking-wide text-ink4">
                  Role
                </TableHead>
                <TableHead className="h-10 text-[10.5px] uppercase tracking-wide text-ink4">
                  Default rate
                </TableHead>
                <TableHead className="h-10 text-[10.5px] uppercase tracking-wide text-ink4">
                  Projects
                </TableHead>
                <TableHead className="h-10 text-[10.5px] uppercase tracking-wide text-ink4">
                  Today
                </TableHead>
                <TableHead className="h-10 text-[10.5px] uppercase tracking-wide text-ink4">
                  Status
                </TableHead>
                {canManage && <TableHead className="h-10 w-12" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredMembers.map(({ membership, user }) => {
                const presence = presenceByUser.get(user.id) ?? 'offline';
                const secondsToday = todaySecondsByUser.get(user.id) ?? 0;
                const stats = projectsAndRateByUser.get(user.id);
                const isStaffRole = membership.role === 'owner' || membership.role === 'admin';
                const rateLabel =
                  isStaffRole || !stats || stats.rateCents === null
                    ? '—'
                    : `${formatMoney(stats.rateCents)}/h`;
                const projectCount = stats?.projectCount ?? 0;
                const isTracking = presence === 'active' || presence === 'idle';
                return (
                  <TableRow key={membership.id}>
                    <TableCell className="py-2.5 font-medium">
                      <div className="flex items-center gap-2.5">
                        <AvatarLive userId={user.id} name={user.name} size={32} live={isTracking} />
                        <div>
                          <Link
                            to="/orgs/$orgId/members/$userId"
                            params={{ orgId: params.orgId, userId: user.id }}
                            className="text-[13px] font-medium hover:underline"
                          >
                            {user.name}
                          </Link>
                          <div className="text-[11px] text-ink4">{user.email}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="py-2.5">
                      {membership.role === 'owner' ? (
                        <Pill tone="dark">Owner</Pill>
                      ) : membership.role === 'admin' ? (
                        <Pill tone="accent">Admin</Pill>
                      ) : (
                        <Pill>Member</Pill>
                      )}
                    </TableCell>
                    <TableCell className="py-2.5 text-[13px] tabular-nums text-ink2">
                      {rateLabel}
                    </TableCell>
                    <TableCell className="py-2.5 text-[13px] tabular-nums text-ink2">
                      {projectCount}
                    </TableCell>
                    <TableCell className="py-2.5 font-mono text-[12.5px] tabular-nums text-ink2">
                      {secondsToday > 0 ? formatHm(secondsToday) : '—'}
                    </TableCell>
                    <TableCell className="py-2.5">
                      {isTracking ? <Pill tone="good">● Tracking</Pill> : <Pill>Offline</Pill>}
                    </TableCell>
                    {canManage && (
                      <TableCell className="py-2.5">
                        {currentUser?.id !== user.id && (
                          <MemberRowActions
                            orgId={params.orgId}
                            membership={membership}
                            userName={user.name}
                          />
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <p className="px-4 py-10 text-center text-[13px] text-ink3">
            {search ? 'No members match your search.' : 'No members yet.'}
          </p>
        )}
      </section>

      {canInvite && (
        <section className="rounded-lg border border-border bg-card">
          <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
            <h2 className="text-[13px] font-medium">Pending invitations</h2>
            <span className="font-mono text-[11px] text-ink4">{pendingCount} pending</span>
          </div>
          {invitationsQuery.isLoading ? (
            <div className="p-4">
              <Skeleton className="h-20 w-full" />
            </div>
          ) : invitations.length ? (
            <ul className="divide-y divide-border">
              {invitations.map((inv) => {
                const inviter = memberById.get(inv.invitedById);
                return (
                  <li key={inv.id} className="flex flex-wrap items-center gap-4 px-4 py-3">
                    <div className="flex min-w-0 flex-1 items-center gap-2.5">
                      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-muted text-ink4">
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                          <circle cx="8.5" cy="7" r="4" />
                          <line x1="20" y1="8" x2="20" y2="14" />
                          <line x1="23" y1="11" x2="17" y2="11" />
                        </svg>
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium">{inv.email}</div>
                        <div className="text-[11px] text-ink4">
                          Invited by {inviter?.name ?? 'a teammate'}
                        </div>
                      </div>
                    </div>
                    <Pill tone={inv.role === 'admin' ? 'accent' : 'neutral'}>{inv.role}</Pill>
                    <div className="text-[12px] text-ink3">
                      Invitation sent {formatRelative(inv.createdAt)}
                    </div>
                    <div className="flex items-center gap-2">
                      <ResendInvitationButton orgId={params.orgId} invitation={inv} />
                      <RevokeInvitationButton orgId={params.orgId} invitationId={inv.id} />
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-4 py-10 text-center text-[13px] text-ink3">No pending invitations.</p>
          )}
        </section>
      )}
    </div>
  );
}

// Renders children into the AppShell's top-bar action slot. The slot div is
// in the DOM on the first paint after the route mounts, so we resolve it in
// an effect to avoid SSR/hydration-style mismatches and re-render once.
function HeaderActionsPortal({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(document.getElementById('page-header-actions'));
  }, []);
  if (!target) return null;
  return createPortal(children, target);
}

const inviteSchema = z.object({
  email: z.string().email('Enter a valid email'),
  role: z.enum(['admin', 'member']),
});
type InviteInput = z.infer<typeof inviteSchema>;

function InviteMemberDialog({ orgId }: { orgId: string }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const form = useForm<InviteInput>({
    defaultValues: { email: '', role: 'member' },
  });

  const mutation = useMutation({
    mutationFn: (input: InviteInput) =>
      apiPost<{ invitation: InvitationDto; mailed: boolean; mailError?: string }>(
        `/orgs/${orgId}/invitations`,
        input,
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invitations(orgId) });
      if (data.mailed) {
        toast({ title: 'Invitation sent', description: data.invitation.email });
      } else {
        toast({
          title: 'Invitation created (email failed)',
          description: data.mailError ?? 'The invite was saved but the email could not be sent.',
          variant: 'destructive',
        });
      }
      setOpen(false);
      form.reset();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'conflict') {
        form.setError('email', { message: err.message });
        return;
      }
      toast({
        title: 'Failed to send invitation',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    const parsed = inviteSchema.safeParse(values);
    if (!parsed.success) {
      const issues = parsed.error.flatten().fieldErrors;
      if (issues.email?.[0]) form.setError('email', { message: issues.email[0] });
      return;
    }
    mutation.mutate(parsed.data);
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="h-9 gap-1.5 px-3.5">
          <Plus className="h-3.5 w-3.5" />
          Invite member
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a teammate</DialogTitle>
          <DialogDescription>
            They&apos;ll get an email with a link to set up their account.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="invite-email">Email</Label>
            <Input id="invite-email" type="email" {...form.register('email')} />
            {form.formState.errors.email && (
              <p className="text-xs text-destructive">{form.formState.errors.email.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="invite-role">Role</Label>
            <Select
              value={form.watch('role')}
              onValueChange={(v) => form.setValue('role', v as 'admin' | 'member')}
            >
              <SelectTrigger id="invite-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Member</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? <Spinner /> : 'Send invitation'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MemberRowActions({
  orgId,
  membership,
  userName,
}: {
  orgId: string;
  membership: MembershipDto;
  userName: string;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const roleMutation = useMutation({
    mutationFn: (role: 'owner' | 'admin' | 'member') =>
      apiPatch(`/orgs/${orgId}/members/${membership.userId}`, { role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.members(orgId) });
      toast({ title: 'Role updated' });
    },
    onError: (err) => {
      const msg =
        err instanceof ApiError && err.code === 'conflict'
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to update role';
      toast({ title: 'Could not change role', description: msg, variant: 'destructive' });
    },
  });

  const removeMutation = useMutation({
    mutationFn: () => apiDelete(`/orgs/${orgId}/members/${membership.userId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.members(orgId) });
      toast({ title: 'Member removed' });
      setConfirmOpen(false);
    },
    onError: (err) => {
      const msg =
        err instanceof ApiError && err.code === 'conflict'
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to remove member';
      toast({ title: 'Could not remove member', description: msg, variant: 'destructive' });
    },
  });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Actions for ${userName}`}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuLabel>Change role</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={membership.role}
            onValueChange={(v) => roleMutation.mutate(v as 'owner' | 'admin' | 'member')}
          >
            <DropdownMenuRadioItem value="owner">Owner</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="admin">Admin</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="member">Member</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={(e) => {
              e.preventDefault();
              setConfirmOpen(true);
            }}
          >
            Remove from org
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {userName}?</DialogTitle>
            <DialogDescription>
              They&apos;ll lose access to this organization immediately. They can be re-invited
              later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => removeMutation.mutate()}
              disabled={removeMutation.isPending}
            >
              {removeMutation.isPending ? <Spinner /> : 'Remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ResendInvitationButton({
  orgId,
  invitation,
}: {
  orgId: string;
  invitation: InvitationDto;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // The API enforces "one pending invite per email"; revoke first, then
  // recreate so the recipient gets a fresh email with a working token.
  const mutation = useMutation({
    mutationFn: async () => {
      await apiDelete(`/orgs/${orgId}/invitations/${invitation.id}`);
      return apiPost<{ invitation: InvitationDto; mailed: boolean; mailError?: string }>(
        `/orgs/${orgId}/invitations`,
        { email: invitation.email, role: invitation.role },
      );
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invitations(orgId) });
      if (data.mailed) {
        toast({ title: 'Invitation resent', description: data.invitation.email });
      } else {
        toast({
          title: 'Invitation re-created (email failed)',
          description: data.mailError ?? 'The invite was saved but the email could not be sent.',
          variant: 'destructive',
        });
      }
    },
    onError: (err) => {
      toast({
        title: 'Could not resend',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
    >
      {mutation.isPending ? <Spinner /> : 'Resend'}
    </Button>
  );
}

function RevokeInvitationButton({ orgId, invitationId }: { orgId: string; invitationId: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: () => apiDelete(`/orgs/${orgId}/invitations/${invitationId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invitations(orgId) });
      toast({ title: 'Invitation revoked' });
    },
    onError: (err) => {
      toast({
        title: 'Could not revoke',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
    >
      Revoke
    </Button>
  );
}
