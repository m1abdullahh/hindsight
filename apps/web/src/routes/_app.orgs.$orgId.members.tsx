import type { InvitationDto, MembershipDto, UserDto } from '@hindsight/shared/dto';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { MoreHorizontal } from 'lucide-react';
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
import { ApiError, apiDelete, apiPatch, apiPost, apiGet } from '@/lib/api';
import { formatRelative } from '@/lib/format';
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

export const Route = createFileRoute('/_app/orgs/$orgId/members')({
  component: MembersPage,
});

function MembersPage() {
  const params = Route.useParams();
  const canInvite = useCan('members:invite');
  const canManage = useCan('members:manage');
  const currentUser = useUser();

  const membersQuery = useQuery({
    queryKey: queryKeys.members(params.orgId),
    queryFn: () => apiGet<MembersResponse>(`/orgs/${params.orgId}/members`),
  });

  const invitationsQuery = useQuery({
    queryKey: queryKeys.invitations(params.orgId),
    enabled: canInvite,
    queryFn: () => apiGet<InvitationsResponse>(`/orgs/${params.orgId}/invitations`),
  });

  const memberCount = membersQuery.data?.members.length ?? 0;
  const pendingCount = invitationsQuery.data?.invitations.length ?? 0;
  const owners =
    membersQuery.data?.members.filter((m) => m.membership.role === 'owner').length ?? 0;
  const admins =
    membersQuery.data?.members.filter((m) => m.membership.role === 'admin').length ?? 0;
  const memberRoleCount = memberCount - owners - admins;

  return (
    <div className="px-7 py-6">
      <header className="mb-5 flex items-end justify-between">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight">Members</h1>
          <p className="mt-1 text-[13px] text-ink3">People with access to this organization.</p>
        </div>
        {canInvite && <InviteMemberDialog orgId={params.orgId} />}
      </header>

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
          <div className="text-[11px] tracking-wide text-ink3">Roles</div>
          <div className="mt-1.5 flex items-center gap-2">
            <Pill tone="dark">{owners} owner</Pill>
            <Pill tone="accent">{admins} admin</Pill>
            <Pill>{memberRoleCount} member</Pill>
          </div>
          <div className="mt-1 text-[11.5px] text-ink3">in this organization</div>
        </div>
        <div className="rounded-lg border border-border bg-card px-4 py-3.5">
          <div className="text-[11px] tracking-wide text-ink3">Pending invitations</div>
          <div className="mt-1.5 font-mono text-2xl font-medium tabular-nums">{pendingCount}</div>
          <div className="mt-1 text-[11.5px] text-ink3">
            {pendingCount === 0 ? 'no open invites' : 'awaiting acceptance'}
          </div>
        </div>
      </div>

      <section className="mb-4 rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2.5">
            <h2 className="text-[13px] font-medium">Active members</h2>
            <span className="font-mono text-[11px] text-ink4">{memberCount} people</span>
          </div>
        </div>
        {membersQuery.isLoading ? (
          <div className="p-4">
            <Skeleton className="h-32 w-full" />
          </div>
        ) : membersQuery.data?.members.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                {canManage && <TableHead className="w-12" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {membersQuery.data.members.map(({ membership, user }) => (
                <TableRow key={membership.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2.5">
                      <AvatarLive userId={user.id} name={user.name} size={28} />
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
                  <TableCell>
                    {membership.role === 'owner' ? (
                      <Pill tone="dark">Owner</Pill>
                    ) : membership.role === 'admin' ? (
                      <Pill tone="accent">Admin</Pill>
                    ) : (
                      <Pill>Member</Pill>
                    )}
                  </TableCell>
                  <TableCell>
                    {membership.status === 'active' ? (
                      <Pill tone="good">● Active</Pill>
                    ) : (
                      <Pill tone="danger">Suspended</Pill>
                    )}
                  </TableCell>
                  {canManage && (
                    <TableCell>
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
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="px-4 py-10 text-center text-[13px] text-ink3">No members yet.</p>
        )}
      </section>

      {canInvite && (
        <section className="rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2.5">
              <h2 className="text-[13px] font-medium">Pending invitations</h2>
              <span className="font-mono text-[11px] text-ink4">
                {invitationsQuery.data?.invitations.length ?? 0} pending
              </span>
            </div>
          </div>
          {invitationsQuery.isLoading ? (
            <div className="p-4">
              <Skeleton className="h-20 w-full" />
            </div>
          ) : invitationsQuery.data?.invitations.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {invitationsQuery.data.invitations.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell className="text-[13px]">{inv.email}</TableCell>
                    <TableCell>
                      <Pill tone={inv.role === 'admin' ? 'accent' : 'neutral'}>{inv.role}</Pill>
                    </TableCell>
                    <TableCell className="text-[12.5px] text-ink3">
                      {formatRelative(inv.createdAt)}
                    </TableCell>
                    <TableCell>
                      <RevokeInvitationButton orgId={params.orgId} invitationId={inv.id} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="px-4 py-10 text-center text-[13px] text-ink3">No pending invitations.</p>
          )}
        </section>
      )}
    </div>
  );
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
        <Button>Invite member</Button>
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
      variant="ghost"
      size="sm"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
    >
      Revoke
    </Button>
  );
}
