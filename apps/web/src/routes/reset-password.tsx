import type { UserDto } from '@hindsight/shared/dto';
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

const searchSchema = z.object({
  token: z.string().optional(),
});

const resetSchema = z
  .object({
    password: z.string().min(12, 'At least 12 characters'),
    confirmPassword: z.string().min(1, 'Confirm your password'),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: 'Passwords must match',
    path: ['confirmPassword'],
  });
type ResetInput = z.infer<typeof resetSchema>;

interface ResetResponse {
  user: UserDto;
  token: string;
  expiresAt: string | null;
}

export const Route = createFileRoute('/reset-password')({
  validateSearch: searchSchema,
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const form = useForm<ResetInput>({ defaultValues: { password: '', confirmPassword: '' } });

  const mutation = useMutation({
    mutationFn: (input: ResetInput) =>
      apiPost<ResetResponse>('/auth/password/reset', {
        token: search.token,
        password: input.password,
      }),
    onSuccess: (data) => {
      sessionStore.getState().setSession({
        token: data.token,
        user: data.user,
        memberships: [],
      });
      void navigate({ to: '/' });
    },
  });

  if (!search.token) {
    return (
      <AuthCard
        title="Invalid link"
        description="This reset link is missing the token. Request a new one."
        footer={
          <Link to="/forgot-password" className="hover:underline">
            Request a new link
          </Link>
        }
      >
        <p className="text-sm text-muted-foreground">
          Reset links expire 60 minutes after they&apos;re sent.
        </p>
      </AuthCard>
    );
  }

  const onSubmit = form.handleSubmit((values) => {
    const parsed = resetSchema.safeParse(values);
    if (!parsed.success) {
      for (const [k, v] of Object.entries(parsed.error.flatten().fieldErrors)) {
        if (v?.[0]) form.setError(k as keyof ResetInput, { message: v[0] });
      }
      return;
    }
    mutation.mutate(parsed.data);
  });

  const apiError = mutation.error instanceof ApiError ? mutation.error : null;
  const formError = (() => {
    if (!apiError) return null;
    if (apiError.status === 401) return 'This reset link is invalid or has expired.';
    if (apiError.status === 422) return apiError.message;
    return apiError.message;
  })();

  return (
    <AuthCard
      title="Set a new password"
      description="Choose a password you haven't used before."
      footer={
        <Link to="/login" className="hover:underline">
          Back to login
        </Link>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="password">New password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            {...form.register('password')}
          />
          {form.formState.errors.password && (
            <p className="text-xs text-destructive">{form.formState.errors.password.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirmPassword">Confirm password</Label>
          <Input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            {...form.register('confirmPassword')}
          />
          {form.formState.errors.confirmPassword && (
            <p className="text-xs text-destructive">
              {form.formState.errors.confirmPassword.message}
            </p>
          )}
        </div>
        {formError && <p className="text-sm text-destructive">{formError}</p>}
        <Button type="submit" className="w-full" disabled={mutation.isPending}>
          {mutation.isPending ? <Spinner /> : 'Set new password'}
        </Button>
      </form>
    </AuthCard>
  );
}
