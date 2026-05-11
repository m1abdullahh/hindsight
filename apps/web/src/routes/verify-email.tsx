import { useMutation } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { z } from 'zod';

import { AuthCard } from '@/components/auth-card';
import { Spinner } from '@/components/ui/spinner';
import { apiPost } from '@/lib/api';

const searchSchema = z.object({
  token: z.string().optional(),
});

export const Route = createFileRoute('/verify-email')({
  validateSearch: searchSchema,
  component: VerifyEmailPage,
});

function VerifyEmailPage() {
  const search = Route.useSearch();

  const mutation = useMutation({
    mutationFn: (token: string) => apiPost<{ verifiedAt: string }>('/auth/email/verify', { token }),
  });

  useEffect(() => {
    if (search.token && mutation.isIdle) mutation.mutate(search.token);
  }, [search.token, mutation]);

  if (!search.token) {
    return (
      <AuthCard
        title="Invalid link"
        description="This verification link is missing the token."
        footer={
          <Link to="/login" className="hover:underline">
            Back to login
          </Link>
        }
      >
        <p className="text-sm text-muted-foreground">
          If you arrived here from an email, the link may be malformed.
        </p>
      </AuthCard>
    );
  }

  if (mutation.isPending || mutation.isIdle) {
    return (
      <AuthCard title="Verifying your email">
        <div className="flex justify-center py-6">
          <Spinner className="h-6 w-6 text-muted-foreground" />
        </div>
      </AuthCard>
    );
  }

  if (mutation.isSuccess) {
    return (
      <AuthCard
        title="Email verified"
        description="You can close this tab and return to the app."
        footer={
          <Link to="/login" className="hover:underline">
            Continue to login
          </Link>
        }
      >
        <p className="text-sm">Thanks for confirming your address.</p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Verification failed"
      description="This link is invalid, expired, or has already been used."
      footer={
        <Link to="/login" className="hover:underline">
          Back to login
        </Link>
      }
    >
      <p className="text-sm text-muted-foreground">
        Sign in and request a new verification email from your settings.
      </p>
    </AuthCard>
  );
}
