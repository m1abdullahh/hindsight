import { prisma } from '../../lib/prisma.js';
import type { PresenceEntryDto, PresenceState } from '../../lib/dto.js';

// A device is considered "live" if it has heartbeated within this window.
// Heartbeats fire every 15s, so 35s gives one full miss of tolerance before
// the user flips to offline.
const STALE_AFTER_MS = 35_000;

const rankOf = (s: PresenceState): number => (s === 'active' ? 2 : s === 'idle' ? 1 : 0);

const parsePresenceState = (s: string | null): PresenceState => {
  if (s === 'active' || s === 'idle' || s === 'offline') return s;
  return 'offline';
};

interface PresenceResult {
  entries: PresenceEntryDto[];
}

/**
 * Aggregate presence for every active member of an org. For each member, we
 * look at all non-revoked devices owned by that user and pick the "best"
 * state across devices, where active > idle > offline. Devices that haven't
 * heartbeated within STALE_AFTER_MS are treated as offline regardless of
 * stored state.
 */
export const computePresence = async (orgId: string): Promise<PresenceResult> => {
  const members = await prisma.membership.findMany({
    where: { orgId, status: 'active' },
    select: { userId: true },
  });
  if (members.length === 0) return { entries: [] };

  const userIds = members.map((m) => m.userId);
  const devices = await prisma.device.findMany({
    where: {
      userId: { in: userIds },
      revokedAt: null,
    },
    select: {
      userId: true,
      lastSeenAt: true,
      presenceState: true,
    },
  });

  const now = Date.now();
  const byUser = new Map<string, { state: PresenceState; lastSeenAt: Date | null }>();
  for (const d of devices) {
    const fresh = d.lastSeenAt !== null && now - d.lastSeenAt.getTime() <= STALE_AFTER_MS;
    const state: PresenceState = fresh ? parsePresenceState(d.presenceState) : 'offline';
    const current = byUser.get(d.userId);
    if (!current) {
      byUser.set(d.userId, { state, lastSeenAt: d.lastSeenAt });
      continue;
    }
    // Pick the device with the higher-ranked state; ties broken by recency.
    const pickIncoming =
      rankOf(state) > rankOf(current.state) ||
      (rankOf(state) === rankOf(current.state) &&
        (d.lastSeenAt?.getTime() ?? 0) > (current.lastSeenAt?.getTime() ?? 0));
    if (pickIncoming) {
      byUser.set(d.userId, { state, lastSeenAt: d.lastSeenAt });
    }
  }

  const entries: PresenceEntryDto[] = userIds.map((userId) => {
    const row = byUser.get(userId);
    return {
      userId,
      state: row?.state ?? 'offline',
      lastSeenAt: row?.lastSeenAt?.toISOString() ?? null,
    };
  });

  return { entries };
};
