import { z } from 'zod';

const DeviceName = z.string().trim().min(1).max(100);
const Os = z.enum(['windows', 'macos', 'linux']);
const SemVer = z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/, 'must be semver');

export const registerDeviceInput = z.object({
  deviceName: DeviceName,
  os: Os,
  appVersion: SemVer,
});
export type RegisterDeviceInput = z.infer<typeof registerDeviceInput>;

export const presenceState = z.enum(['active', 'idle', 'offline']);
export type PresenceState = z.infer<typeof presenceState>;

export const heartbeatInput = z.object({
  appVersion: SemVer,
  state: presenceState.optional(),
});
export type HeartbeatInput = z.infer<typeof heartbeatInput>;
