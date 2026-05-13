import type { MembershipDto, OrganizationDto, UserDto } from '@hindsight/shared/dto';
import { invoke } from '@tauri-apps/api/core';
import { hostname, platform } from '@tauri-apps/plugin-os';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/use-toast';
import { apiGet, apiPost, clearTokenCache } from '@/lib/api';
import { session } from '@/lib/session-store';

declare const __APP_VERSION__: string;

interface LoginResponse {
  user: UserDto;
  memberships: MembershipDto[];
  token: string;
}
interface RegisterResponse {
  device: { id: string; deviceName: string };
  deviceId: string;
  deviceToken: string;
}

type DeviceOs = 'windows' | 'macos' | 'linux';

const OS_LABEL: Record<DeviceOs, string> = {
  windows: 'Windows',
  macos: 'Mac',
  linux: 'Linux',
};

// Pull real device info from the OS via plugin-os. Tauri's `platform()`
// returns one of "linux" | "macos" | "windows" | "ios" | "android" | ...;
// the API only accepts the three desktop targets so anything exotic falls
// back to linux. `hostname()` may return null on platforms where the call
// isn't available; in that case we synthesize a readable name like
// "Mac · 2026-05-13".
const getDeviceInfo = async (): Promise<{ deviceName: string; os: DeviceOs }> => {
  const raw = await platform();
  const os: DeviceOs = raw === 'macos' || raw === 'windows' ? raw : 'linux';
  const host = ((await hostname().catch(() => null)) ?? '').trim().replace(/\.local$/, '');
  const fallback = `${OS_LABEL[os]} · ${new Date().toISOString().slice(0, 10)}`;
  return { deviceName: (host || fallback).slice(0, 100), os };
};

export function LoginScreen() {
  const setLoggedIn = session((s) => s.setLoggedIn);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      // 1. Login → web token (in memory only).
      const login = await apiPost<LoginResponse>('/auth/login', { email, password });

      // Desktop is for tracking members only. Admins/owners manage from
      // the web; block them here before we register a device.
      if (login.memberships.some((m) => m.role !== 'member')) {
        toast({
          title: 'This app is for members only',
          description: 'Admins and owners manage time tracking from the web app.',
          variant: 'destructive',
        });
        return;
      }

      // 2. Register a device using the web token explicitly (override the
      //    cached/stored token for this single call).
      const idemKey = crypto.randomUUID();
      const { deviceName, os } = await getDeviceInfo();
      const reg = await apiPost<RegisterResponse>(
        '/devices/register',
        { deviceName, os, appVersion: __APP_VERSION__ },
        idemKey,
        login.token,
      );

      // 3. Persist the device token in Credential Manager and refresh the cache.
      await invoke('set_device_token', { token: reg.deviceToken });
      clearTokenCache();

      // 4. Hydrate org rows.
      const orgs = (
        await Promise.all(
          login.memberships.map((m) =>
            apiGet<OrganizationDto>(`/orgs/${m.orgId}`).catch(() => null),
          ),
        )
      ).filter((o): o is OrganizationDto => o !== null);

      setLoggedIn({ user: login.user, orgs, memberships: login.memberships });
    } catch (err) {
      toast({
        title: 'Could not sign in',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-md bg-foreground text-[18px] font-bold text-background">
            H
          </div>
          <h1 className="text-[26px] font-semibold tracking-tight">Hindsight</h1>
          <p className="mt-1 text-[13px] text-ink3">Sign in to start tracking.</p>
        </div>
        <form onSubmit={onSubmit} className="space-y-3.5">
          <div className="space-y-1.5">
            <Label
              htmlFor="email"
              className="text-[11px] font-medium uppercase tracking-[0.05em] text-ink3"
            >
              Email
            </Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="h-10"
            />
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor="password"
              className="text-[11px] font-medium uppercase tracking-[0.05em] text-ink3"
            >
              Password
            </Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="h-10"
            />
          </div>
          <Button type="submit" className="h-10 w-full" disabled={submitting}>
            {submitting ? <Spinner /> : 'Sign in'}
          </Button>
        </form>
        <p className="text-center font-mono text-[10.5px] text-ink4">v{__APP_VERSION__}</p>
      </div>
    </div>
  );
}
