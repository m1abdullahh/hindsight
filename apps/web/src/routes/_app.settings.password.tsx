import { useMutation } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/use-toast';
import { ApiError, apiPost } from '@/lib/api';

import { SettingsTabs } from './_app.settings.profile';

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(12, 'At least 12 characters'),
    newPassword: z.string().min(12, 'At least 12 characters'),
    confirmNewPassword: z.string().min(1, 'Confirm your password'),
  })
  .refine((v) => v.newPassword === v.confirmNewPassword, {
    message: 'Passwords must match',
    path: ['confirmNewPassword'],
  });
type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const Route = createFileRoute('/_app/settings/password')({
  component: PasswordPage,
});

function PasswordPage() {
  const { toast } = useToast();
  const form = useForm<ChangePasswordInput>({
    defaultValues: { currentPassword: '', newPassword: '', confirmNewPassword: '' },
  });

  const mutation = useMutation({
    mutationFn: (input: ChangePasswordInput) =>
      apiPost<undefined>('/auth/password/change', {
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
      }),
    onSuccess: () => {
      toast({
        title: 'Password changed',
        description: 'Other sessions have been signed out.',
      });
      form.reset();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 401) {
        form.setError('currentPassword', { message: 'Current password is incorrect' });
        return;
      }
      toast({
        title: 'Could not change password',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    const parsed = changePasswordSchema.safeParse(values);
    if (!parsed.success) {
      for (const [k, v] of Object.entries(parsed.error.flatten().fieldErrors)) {
        if (v?.[0]) form.setError(k as keyof ChangePasswordInput, { message: v[0] });
      }
      return;
    }
    mutation.mutate(parsed.data);
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <SettingsTabs current="password" />

      <Card>
        <CardHeader>
          <CardTitle>Change password</CardTitle>
          <CardDescription>
            We&apos;ll sign out your other sessions when you change it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="currentPassword">Current password</Label>
              <Input
                id="currentPassword"
                type="password"
                autoComplete="current-password"
                {...form.register('currentPassword')}
              />
              {form.formState.errors.currentPassword && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.currentPassword.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="newPassword">New password</Label>
              <Input
                id="newPassword"
                type="password"
                autoComplete="new-password"
                {...form.register('newPassword')}
              />
              {form.formState.errors.newPassword && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.newPassword.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmNewPassword">Confirm new password</Label>
              <Input
                id="confirmNewPassword"
                type="password"
                autoComplete="new-password"
                {...form.register('confirmNewPassword')}
              />
              {form.formState.errors.confirmNewPassword && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.confirmNewPassword.message}
                </p>
              )}
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? <Spinner /> : 'Change password'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sign out everywhere</CardTitle>
          <CardDescription>
            Revoke every other session signed in to your account. You&apos;ll stay signed in here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SignOutEverywhereButton />
        </CardContent>
      </Card>
    </div>
  );
}

function SignOutEverywhereButton() {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: () => apiPost<undefined>('/auth/sign-out-everywhere', { keepCurrent: true }),
    onSuccess: () => {
      toast({ title: 'Other sessions signed out' });
      setOpen(false);
    },
    onError: (err) => {
      toast({
        title: 'Could not sign out everywhere',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">Sign out other sessions</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sign out everywhere?</DialogTitle>
          <DialogDescription>
            Other browsers and devices will be signed out immediately. You&apos;ll need to log back
            in on each. Your current session here will remain.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner /> : 'Sign out other sessions'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
