import type { MembershipDto, OrganizationDto, ProjectDto, UserDto } from '@hindsight/shared/dto';
import { create } from 'zustand';

export type Stage = 'login' | 'picking' | 'tracking';

export type PauseReason = 'manual' | 'idle' | 'locked';

export interface DesktopSession {
  stage: Stage;
  user: UserDto | null;
  organizations: OrganizationDto[];
  memberships: MembershipDto[];
  currentOrgId: string | null;
  currentProject: ProjectDto | null;
  timeEntryId: string | null;
  startedAt: string | null;
  // Seconds already tracked today on currentProject before this session started.
  // The tracking timer renders this + (now - startedAt) so the displayed value
  // continues from today's accumulated time instead of resetting to 0.
  baselineTodaySeconds: number;
  pendingUploads: number;
  // Pause / idle state. `pauseReason` is non-null iff currently paused.
  // `pauseStartedAt` is the wall-clock ms when the current pause began.
  // `accumulatedPausedMs` is the total paused time across earlier pause cycles
  // in this session (does not include the current ongoing pause).
  pauseReason: PauseReason | null;
  pauseStartedAt: number | null;
  accumulatedPausedMs: number;
  setLoggedIn: (s: {
    user: UserDto;
    orgs: OrganizationDto[];
    memberships: MembershipDto[];
  }) => void;
  setOrg: (orgId: string) => void;
  setProject: (project: ProjectDto) => void;
  startTracking: (timeEntryId: string, startedAt: string, baselineTodaySeconds: number) => void;
  stopTracking: () => void;
  // Swap the live time entry for a fresh one without ending the session —
  // used by the midnight split so no entry ever spans a calendar day.
  rotateEntry: (timeEntryId: string, startedAt: string) => void;
  setPendingUploads: (count: number) => void;
  pause: (reason: PauseReason) => void;
  resume: () => void;
  signOut: () => void;
}

export const session = create<DesktopSession>((set) => ({
  stage: 'login',
  user: null,
  organizations: [],
  memberships: [],
  currentOrgId: null,
  currentProject: null,
  timeEntryId: null,
  startedAt: null,
  baselineTodaySeconds: 0,
  pendingUploads: 0,
  pauseReason: null,
  pauseStartedAt: null,
  accumulatedPausedMs: 0,
  setLoggedIn: ({ user, orgs, memberships }) =>
    set({
      user,
      organizations: orgs,
      memberships,
      currentOrgId: orgs[0]?.id ?? null,
      stage: 'picking',
    }),
  setOrg: (orgId) => set({ currentOrgId: orgId }),
  setProject: (project) => set({ currentProject: project }),
  startTracking: (timeEntryId, startedAt, baselineTodaySeconds) =>
    set({
      timeEntryId,
      startedAt,
      baselineTodaySeconds,
      stage: 'tracking',
      pauseReason: null,
      pauseStartedAt: null,
      accumulatedPausedMs: 0,
    }),
  stopTracking: () =>
    set({
      timeEntryId: null,
      startedAt: null,
      baselineTodaySeconds: 0,
      stage: 'picking',
      pauseReason: null,
      pauseStartedAt: null,
      accumulatedPausedMs: 0,
    }),
  rotateEntry: (timeEntryId, startedAt) =>
    set((s) => ({
      timeEntryId,
      startedAt,
      // The new entry is for a brand-new calendar day, so nothing has been
      // tracked on it yet — baseline and prior paused time both reset.
      baselineTodaySeconds: 0,
      accumulatedPausedMs: 0,
      // If a pause is ongoing across the split, restart its clock against the
      // new entry so currentPauseMs counts only time paused within this entry.
      pauseStartedAt: s.pauseReason ? Date.now() : null,
    })),
  setPendingUploads: (count) => set({ pendingUploads: count }),
  pause: (reason) =>
    set((s) => (s.pauseReason ? s : { pauseReason: reason, pauseStartedAt: Date.now() })),
  resume: () =>
    set((s) => {
      if (!s.pauseReason || s.pauseStartedAt === null) return s;
      return {
        pauseReason: null,
        pauseStartedAt: null,
        accumulatedPausedMs: s.accumulatedPausedMs + (Date.now() - s.pauseStartedAt),
      };
    }),
  signOut: () =>
    set({
      stage: 'login',
      user: null,
      organizations: [],
      memberships: [],
      currentOrgId: null,
      currentProject: null,
      timeEntryId: null,
      startedAt: null,
      baselineTodaySeconds: 0,
      pauseReason: null,
      pauseStartedAt: null,
      accumulatedPausedMs: 0,
    }),
}));
