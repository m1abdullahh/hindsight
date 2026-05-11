import type { MembershipDto, OrganizationDto, UserDto } from '@hindsight/shared/dto';
import { useMutation } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { AuthCard } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { ApiError, apiPost } from '@/lib/api';
import { sessionStore } from '@/lib/session-store';

const searchSchema = z.object({ token: z.string().optional() });

const acceptSchema = z.object({
  password: z.string().min(12, 'At least 12 characters').max(128).optional(),
  name: z.string().min(1).max(100).optional(),
});
type AcceptInput = z.infer<typeof acceptSchema>;

interface AcceptResponse {
  user: UserDto;
  organization: OrganizationDto;
  memberships: MembershipDto[];
  token: string;
  expiresAt: string | null;
}

interface AcceptDetails {
  requires?: ('password' | 'name')[];
  existingUser?: boolean;
}

export const Route = createFileRoute('/accept-invite')({
  validateSearch: searchSchema,
  component: AcceptInvitePage,
});

function AcceptInvitePage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const form = useForm<AcceptInput>({ defaultValues: { password: '', name: '' } });

  const mutation = useMutation({
    mutationFn: async (input: AcceptInput) => {
      const token = search.token;
      if (!token) throw new Error('Invitation token missing');
      const body: { token: string; password?: string; name?: string } = { token };
      if (input.password) body.password = input.password;
      if (input.name) body.name = input.name;
      return apiPost<AcceptResponse>('/auth/invitations/accept', body);
    },
    onSuccess: (data) => {
      sessionStore.getState().setSession({
        token: data.token,
        user: data.user,
        organizations: [data.organization],
        memberships: data.memberships,
      });
      void navigate({ to: '/orgs/$orgId', params: { orgId: data.organization.id } });
    },
  });

  if (!search.token) {
    return (
      <AuthCard
        title="Invalid invitation link"
        description="This link is missing its token."
        footer={
          <Link to="/login" className="hover:underline">
            Back to login
          </Link>
        }
      >
        <p className="text-sm text-muted-foreground">
          Ask the person who invited you to send a fresh link.
        </p>
      </AuthCard>
    );
  }

  const apiError = mutation.error instanceof ApiError ? mutation.error : null;
  const details: AcceptDetails | null =
    apiError && typeof apiError.details === 'object' && apiError.details !== null
      ? (apiError.details as AcceptDetails)
      : null;

  // Show "existing user" success path: just submit with empty body again.
  if (apiError?.status === 400 && details?.existingUser === true) {
    return (
      <AuthCard
        title="Accept invitation"
        description="You already have an account — just confirm to join the org."
      >
        <Button
          className="w-full"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate({})}
        >
          {mutation.isPending ? <Spinner /> : 'Join organization'}
        </Button>
      </AuthCard>
    );
  }

  if (apiError?.status === 404) {
    return (
      <AuthCard
        title="Invitation no longer valid"
        description="This invitation may have expired, been revoked, or already been accepted."
        footer={
          <Link to="/login" className="hover:underline">
            Back to login
          </Link>
        }
      >
        <p className="text-sm text-muted-foreground">
          Ask the person who invited you to send a fresh link.
        </p>
      </AuthCard>
    );
  }

  const onSubmit = form.handleSubmit((values) => {
    const parsed = acceptSchema.safeParse(values);
    if (!parsed.success) {
      for (const [k, v] of Object.entries(parsed.error.flatten().fieldErrors)) {
        if (v?.[0]) form.setError(k as keyof AcceptInput, { message: v[0] });
      }
      return;
    }
    mutation.mutate(parsed.data);
  });

  const formError = (() => {
    if (!apiError) return null;
    if (apiError.status === 422) return apiError.message;
    if (apiError.status === 400 && details && !details.existingUser) return apiError.message;
    return apiError.message;
  })();

  return (
    <AuthCard
      title="Accept your invitation"
      description="Set a password and complete your profile to join."
      footer={
        <Link to="/login" className="hover:underline">
          Already have an account? Log in
        </Link>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="name">Your name</Label>
          <Input id="name" autoComplete="name" {...form.register('name')} />
          {form.formState.errors.name && (
            <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            {...form.register('password')}
          />
          {form.formState.errors.password && (
            <p className="text-xs text-destructive">{form.formState.errors.password.message}</p>
          )}
          <p className="text-xs text-muted-foreground">At least 12 characters.</p>
        </div>
        {formError && <p className="text-sm text-destructive">{formError}</p>}
        <Button type="submit" className="w-full" disabled={mutation.isPending}>
          {mutation.isPending ? <Spinner /> : 'Accept invitation'}
        </Button>
      </form>
    </AuthCard>
  );
}
