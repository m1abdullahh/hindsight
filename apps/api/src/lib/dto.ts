import type {
  Device,
  Invitation,
  Membership,
  Organization,
  Project,
  ProjectAssignment,
  Screenshot,
  TimeEntry,
  User,
} from '@prisma/client';

import type {
  DeviceDto,
  InvitationDto,
  MembershipDto,
  OrganizationDto,
  PresenceState,
  ProjectAssignmentDto,
  ProjectDto,
  ScreenshotDto,
  TimeEntryDto,
  UserDto,
} from '@hindsight/shared/dto';

export type {
  DeviceDto,
  ErrorBody,
  ErrorCode,
  InvitationDto,
  InvitationRole,
  MembershipDto,
  MembershipStatus,
  OrganizationDto,
  PresenceEntryDto,
  PresenceState,
  ProjectAssignmentDto,
  ProjectDto,
  Role,
  ScreenshotDto,
  ScreenshotStatus,
  TimeEntryDto,
  UserDto,
} from '@hindsight/shared/dto';

export const toUserDto = (u: User): UserDto => ({
  id: u.id,
  email: u.email,
  name: u.name,
  emailVerifiedAt: u.emailVerifiedAt?.toISOString() ?? null,
  createdAt: u.createdAt.toISOString(),
});

export const toOrgDto = (o: Organization): OrganizationDto => ({
  id: o.id,
  name: o.name,
  slug: o.slug,
  createdAt: o.createdAt.toISOString(),
});

export const toMembershipDto = (m: Membership): MembershipDto => ({
  id: m.id,
  orgId: m.orgId,
  userId: m.userId,
  role: m.role,
  status: m.status,
  createdAt: m.createdAt.toISOString(),
});

export const toInvitationDto = (i: Invitation): InvitationDto => ({
  id: i.id,
  orgId: i.orgId,
  email: i.email,
  role: i.role as InvitationDto['role'],
  invitedById: i.invitedById,
  expiresAt: i.expiresAt.toISOString(),
  acceptedAt: i.acceptedAt?.toISOString() ?? null,
  acceptedBy: i.acceptedBy ?? null,
  revokedAt: i.revokedAt?.toISOString() ?? null,
  createdAt: i.createdAt.toISOString(),
});

export const toProjectDto = (p: Project): ProjectDto => ({
  id: p.id,
  orgId: p.orgId,
  name: p.name,
  description: p.description,
  screenshotIntervalMinutes: p.screenshotIntervalMinutes,
  blurScreenshots: p.blurScreenshots,
  idleTimeoutMinutes: p.idleTimeoutMinutes,
  archivedAt: p.archivedAt?.toISOString() ?? null,
  createdBy: p.createdBy,
  createdAt: p.createdAt.toISOString(),
});

export const toProjectAssignmentDto = (a: ProjectAssignment): ProjectAssignmentDto => ({
  id: a.id,
  projectId: a.projectId,
  userId: a.userId,
  hourlyRateCents: a.hourlyRateCents,
  assignedAt: a.assignedAt.toISOString(),
  removedAt: a.removedAt?.toISOString() ?? null,
});

const asPresenceState = (s: string | null): PresenceState | null =>
  s === 'active' || s === 'idle' || s === 'offline' ? s : null;

export const toDeviceDto = (d: Device): DeviceDto => ({
  id: d.id,
  userId: d.userId,
  deviceName: d.deviceName,
  os: d.os,
  appVersion: d.appVersion,
  lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
  presenceState: asPresenceState(d.presenceState),
  createdAt: d.createdAt.toISOString(),
  revokedAt: d.revokedAt?.toISOString() ?? null,
});

export const toTimeEntryDto = (t: TimeEntry): TimeEntryDto => ({
  id: t.id,
  userId: t.userId,
  projectId: t.projectId,
  deviceId: t.deviceId,
  startedAt: t.startedAt.toISOString(),
  endedAt: t.endedAt?.toISOString() ?? null,
  totalActiveSeconds: t.totalActiveSeconds,
  totalIdleSeconds: t.totalIdleSeconds,
  notes: t.notes,
});

export const toScreenshotDto = (s: Screenshot): ScreenshotDto => ({
  id: s.id,
  timeEntryId: s.timeEntryId,
  capturedAt: s.capturedAt.toISOString(),
  width: s.width,
  height: s.height,
  monitorIndex: s.monitorIndex,
  activeWindowTitle: s.activeWindowTitle,
  activeApp: s.activeApp,
  keyboardEventsCount: s.keyboardEventsCount,
  mouseEventsCount: s.mouseEventsCount,
  sizeBytes: s.sizeBytes,
  blurred: s.blurred,
  status: s.status,
  createdAt: s.createdAt.toISOString(),
});
