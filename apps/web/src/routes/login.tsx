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

const searchSchema = z.object({
  next: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Password required'),
});
type LoginInput = z.infer<typeof loginSchema>;

interface LoginResponse {
  user: UserDto;
  memberships: MembershipDto[];
  token: string;
  expiresAt: string | null;
}

const sanitizeNext = (raw: string | undefined): string => {
  if (!raw) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
};

export const Route = createFileRoute('/login')({
  validateSearch: searchSchema,
  beforeLoad: ({ search }) => {
    if (sessionStore.getState().token) {
      throw redirect({ to: search.next ? sanitizeNext(search.next) : '/' });
    }
  },
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const form = useForm<LoginInput>({
    defaultValues: { email: '', password: '' },
  });

  const mutation = useMutation({
    mutationFn: async (input: LoginInput) => {
      return apiPost<LoginResponse>('/auth/login', input);
    },
    onSuccess: async (data) => {
      // We need org rows for the AppShell. Fetch them lazily after login.
      const orgs = await Promise.all(
        data.memberships.map((m) => fetchOrg(m.orgId, data.token).catch(() => null)),
      );
      sessionStore.getState().setSession({
        token: data.token,
        user: data.user,
        organizations: orgs.filter((o): o is OrganizationDto => o !== null),
        memberships: data.memberships,
      });
      void navigate({ to: sanitizeNext(search.next) });
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    const parsed = loginSchema.safeParse(values);
    if (!parsed.success) {
      const issues = parsed.error.flatten().fieldErrors;
      if (issues.email?.[0]) form.setError('email', { message: issues.email[0] });
      if (issues.password?.[0]) form.setError('password', { message: issues.password[0] });
      return;
    }
    mutation.mutate(parsed.data);
  });

  const apiError = mutation.error instanceof ApiError ? mutation.error : null;
  const inlineError = (() => {
    if (!apiError) return null;
    if (apiError.status === 401) return 'Invalid email or password.';
    if (apiError.status === 429) {
      const ra = apiError.retryAfter;
      return ra
        ? `Too many attempts. Try again in ${Math.ceil(ra / 60)} min.`
        : 'Too many attempts. Try again later.';
    }
    return apiError.message;
  })();

  return (
    <AuthCard
      title="Welcome back"
      description="Log in to your account."
      footer={
        <div className="flex items-center justify-between">
          <Link to="/signup" className="hover:underline">
            Create an account
          </Link>
          <Link to="/forgot-password" className="hover:underline">
            Forgot password?
          </Link>
        </div>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="email" {...form.register('email')} />
          {form.formState.errors.email && (
            <p className="text-xs text-destructive">{form.formState.errors.email.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            {...form.register('password')}
          />
          {form.formState.errors.password && (
            <p className="text-xs text-destructive">{form.formState.errors.password.message}</p>
          )}
        </div>
        {inlineError && <p className="text-sm text-destructive">{inlineError}</p>}
        {/*
          Added 'login-btn' for scoping uppercase style for the login button only.
          This avoids overbroad selectors or needing to uppercase the string directly.
        */}
        <Button type="submit" className="w-full login-btn" disabled={mutation.isPending}>
          {mutation.isPending ? <Spinner /> : 'Log in'}
        </Button>
      </form>
    </AuthCard>
  );
}

async function fetchOrg(orgId: string, token: string): Promise<OrganizationDto> {
  const res = await fetch(`/api/v1/orgs/${orgId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('failed');
  return (await res.json()) as OrganizationDto;
}
