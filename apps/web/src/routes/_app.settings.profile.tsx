import type { MembershipDto, UserDto } from '@hindsight/shared/dto';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/use-toast';
import { apiPatch } from '@/lib/api';
import { queryKeys } from '@/lib/queries';
import { sessionStore, useUser } from '@/lib/session-store';

const profileSchema = z.object({
  name: z.string().trim().min(1, 'Required').max(100),
});
type ProfileInput = z.infer<typeof profileSchema>;

interface MeResponse {
  user: UserDto;
  memberships: MembershipDto[];
}

export const Route = createFileRoute('/_app/settings/profile')({
  component: ProfilePage,
});

function ProfilePage() {
  const user = useUser();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const form = useForm<ProfileInput>({
    defaultValues: { name: user?.name ?? '' },
  });

  useEffect(() => {
    if (user?.name) form.reset({ name: user.name });
  }, [user?.name, form]);

  const mutation = useMutation({
    mutationFn: (input: ProfileInput) => apiPatch<MeResponse>('/auth/me', input),
    onSuccess: (data) => {
      sessionStore.getState().setUser(data.user);
      queryClient.setQueryData(queryKeys.me(), {
        user: data.user,
        memberships: data.memberships,
        organizations: Object.values(sessionStore.getState().organizations),
      });
      toast({ title: 'Profile updated' });
    },
    onError: (err) => {
      toast({
        title: 'Could not save',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    const parsed = profileSchema.safeParse(values);
    if (!parsed.success) {
      const issues = parsed.error.flatten().fieldErrors;
      if (issues.name?.[0]) form.setError('name', { message: issues.name[0] });
      return;
    }
    if (parsed.data.name === user?.name) return; // no-op
    mutation.mutate(parsed.data);
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <SettingsTabs current="profile" />
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>
            Your account details. Email changes are not available yet.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" value={user?.email ?? ''} disabled readOnly />
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" {...form.register('name')} />
              {form.formState.errors.name && (
                <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
              )}
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? <Spinner /> : 'Save changes'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export function SettingsTabs({ current }: { current: 'profile' | 'password' | 'devices' }) {
  const items: { key: typeof current; label: string; to: string }[] = [
    { key: 'profile', label: 'Profile', to: '/settings/profile' },
    { key: 'password', label: 'Password', to: '/settings/password' },
    { key: 'devices', label: 'Devices', to: '/settings/devices' },
  ];

  return (
    <div className="flex gap-1 border-b">
      {items.map((item) => (
        <Link
          key={item.key}
          to={item.to}
          className={
            'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ' +
            (current === item.key
              ? 'border-foreground text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground')
          }
        >
          {item.label}
        </Link>
      ))}
    </div>
  );
}
