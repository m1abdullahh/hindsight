import { useMutation } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { AuthCard } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { apiPost } from '@/lib/api';

const forgotSchema = z.object({
  email: z.string().email('Enter a valid email'),
});
type ForgotInput = z.infer<typeof forgotSchema>;

export const Route = createFileRoute('/forgot-password')({
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const form = useForm<ForgotInput>({ defaultValues: { email: '' } });

  const mutation = useMutation({
    mutationFn: (input: ForgotInput) => apiPost<undefined>('/auth/password/forgot', input),
  });

  const onSubmit = form.handleSubmit((values) => {
    const parsed = forgotSchema.safeParse(values);
    if (!parsed.success) {
      const issues = parsed.error.flatten().fieldErrors;
      if (issues.email?.[0]) form.setError('email', { message: issues.email[0] });
      return;
    }
    mutation.mutate(parsed.data);
  });

  return (
    <AuthCard
      title="Reset your password"
      description="We'll email you a link if your account exists."
      footer={
        <Link to="/login" className="hover:underline">
          Back to login
        </Link>
      }
    >
      {mutation.isSuccess ? (
        <div className="space-y-2">
          <p className="text-sm">
            If <strong>{form.getValues('email')}</strong> is registered, a reset link is on the way.
          </p>
          <p className="text-sm text-muted-foreground">
            Check your inbox. The link expires in 60 minutes.
          </p>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="email" {...form.register('email')} />
            {form.formState.errors.email && (
              <p className="text-xs text-destructive">{form.formState.errors.email.message}</p>
            )}
          </div>
          <Button type="submit" className="w-full" disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner /> : 'Send reset link'}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
