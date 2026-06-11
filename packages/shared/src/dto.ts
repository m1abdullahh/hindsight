// Shared DTO types — consumed by both `@hindsight/api` and `@hindsight/web`.
// Pure types; no runtime imports. Mirrors the Prisma enums by literal union
// so the browser bundle never sees `@prisma/client`.

export type Role = 'owner' | 'admin' | 'member';
export type MembershipStatus = 'active' | 'suspended';
export type InvitationRole = 'admin' | 'member';
export type ScreenshotStatus = 'pending' | 'uploaded' | 'processed' | 'failed';

export interface UserDto {
  id: string;
  email: string;
  name: string;
  emailVerifiedAt: string | null;
  createdAt: string;
}

export interface OrganizationDto {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface MembershipDto {
  id: string;
  orgId: string;
  userId: string;
  role: Role;
  status: MembershipStatus;
  createdAt: string;
}

export interface InvitationDto {
  id: string;
  orgId: string;
  email: string;
  role: InvitationRole;
  invitedById: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedBy: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface ProjectDto {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  screenshotIntervalMinutes: number;
  blurScreenshots: boolean;
  idleTimeoutMinutes: number;
  archivedAt: string | null;
  createdBy: string;
  createdAt: string;
}

export interface ProjectAssignmentDto {
  id: string;
  projectId: string;
  userId: string;
  hourlyRateCents: number | null;
  assignedAt: string;
  removedAt: string | null;
}

export type PresenceState = 'active' | 'idle' | 'offline';

export interface DeviceDto {
  id: string;
  userId: string;
  deviceName: string;
  os: string;
  appVersion: string;
  lastSeenAt: string | null;
  presenceState: PresenceState | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface PresenceEntryDto {
  userId: string;
  state: PresenceState;
  lastSeenAt: string | null;
}

export interface TimeEntryDto {
  id: string;
  userId: string;
  projectId: string;
  deviceId: string;
  startedAt: string;
  endedAt: string | null;
  totalActiveSeconds: number;
  totalIdleSeconds: number;
  notes: string | null;
}

export interface ScreenshotDto {
  id: string;
  timeEntryId: string;
  capturedAt: string;
  width: number;
  height: number;
  monitorIndex: number;
  activeWindowTitle: string | null;
  activeApp: string | null;
  keyboardEventsCount: number;
  mouseEventsCount: number;
  sizeBytes: number | null;
  blurred: boolean;
  status: ScreenshotStatus;
  createdAt: string;
}

export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'invalid_input'
  | 'rate_limited'
  | 'too_many_attempts'
  | 'mail_unavailable'
  | 'mail_send_failed'
  | 'r2_unavailable'
  | 'internal';

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}
