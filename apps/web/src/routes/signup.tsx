import type { MembershipDto, OrganizationDto, UserDto } from '@hindsight/shared/dto';
import { useMutation } from '@tanstack/react-query';
import { Link, createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { AuthCard } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { ApiError, apiPost } from '@/lib/api';
import { sessionStore } from '@/lib/session-store';

const signupSchema = z.object({
  name: z.string().min(1, 'Required').max(100),
  email: z.string().email('Enter a valid email'),
  organizationName: z.string().min(1, 'Required').max(100),
  password: z.string().min(12, 'At least 12 characters').max(128),
});
type SignupInput = z.infer<typeof signupSchema>;

interface SignupResponse {
  user: UserDto;
  organization: OrganizationDto;
  token: string;
  expiresAt: string | null;
}

export const Route = createFileRoute('/signup')({
  beforeLoad: () => {
    if (sessionStore.getState().token) throw redirect({ to: '/' });
  },
  component: SignupPage,
});

function SignupPage() {
  const navigate = useNavigate();
  const form = useForm<SignupInput>({
    defaultValues: { name: '', email: '', organizationName: '', password: '' },
  });

  const mutation = useMutation({
    mutationFn: (input: SignupInput) => apiPost<SignupResponse>('/auth/signup', input),
    onSuccess: (data) => {
      const ownerMembership: MembershipDto = {
        id: '',
        orgId: data.organization.id,
        userId: data.user.id,
        role: 'owner',
        status: 'active',
        createdAt: data.organization.createdAt,
      };
      sessionStore.getState().setSession({
        token: data.token,
        user: data.user,
        organizations: [data.organization],
        memberships: [ownerMembership],
      });
      void navigate({ to: '/orgs/$orgId', params: { orgId: data.organization.id } });
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    const parsed = signupSchema.safeParse(values);
    if (!parsed.success) {
      for (const [k, v] of Object.entries(parsed.error.flatten().fieldErrors)) {
        if (v?.[0]) form.setError(k as keyof SignupInput, { message: v[0] });
      }
      return;
    }
    mutation.mutate(parsed.data);
  });

  const apiError = mutation.error instanceof ApiError ? mutation.error : null;
  const formError = (() => {
    if (!apiError) return null;
    if (apiError.code === 'conflict') return 'That email is already registered.';
    if (apiError.status === 422) return apiError.message;
    return apiError.message;
  })();

  return (
    <AuthCard
      title="Create your account"
      description="Start a new organization."
      footer={
        <div>
          Already have an account?{' '}
          <Link to="/login" className="hover:underline">
            Log in
          </Link>
        </div>
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
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="email" {...form.register('email')} />
          {form.formState.errors.email && (
            <p className="text-xs text-destructive">{form.formState.errors.email.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="organizationName">Organization name</Label>
          <Input id="organizationName" {...form.register('organizationName')} />
          {form.formState.errors.organizationName && (
            <p className="text-xs text-destructive">
              {form.formState.errors.organizationName.message}
            </p>
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
          {mutation.isPending ? <Spinner /> : 'Create account'}
        </Button>
      </form>
    </AuthCard>
  );
}
