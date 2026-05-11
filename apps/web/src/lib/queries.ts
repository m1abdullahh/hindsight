// Centralized query-key factory so invalidations stay consistent.
export const queryKeys = {
  me: () => ['auth', 'me'] as const,
  members: (orgId: string) => ['orgs', orgId, 'members'] as const,
  invitations: (orgId: string) => ['orgs', orgId, 'invitations'] as const,
  devices: () => ['devices'] as const,
  org: (orgId: string) => ['orgs', orgId] as const,
  projects: (orgId: string, includeArchived = false) =>
    ['orgs', orgId, 'projects', { includeArchived }] as const,
  project: (projectId: string) => ['projects', projectId] as const,
  assignments: (projectId: string, includeRemoved = false) =>
    ['projects', projectId, 'assignments', { includeRemoved }] as const,
  screenshots: (orgId: string, filters: { projectId?: string; userId?: string } = {}) =>
    ['orgs', orgId, 'screenshots', filters] as const,
  // Infinite-pagination variant — kept on a distinct key so its
  // { pages, pageParams } cache shape never collides with the flat
  // { items, nextCursor } shape used by the regular `screenshots` query
  // on Overview. Sharing the key crashed useInfiniteQuery on mount.
  screenshotsInfinite: (orgId: string, filters: { projectId?: string; userId?: string } = {}) =>
    ['orgs', orgId, 'screenshots', 'infinite', filters] as const,
  screenshot: (id: string) => ['screenshots', id] as const,
  timeTotals: (
    orgId: string,
    filters: {
      projectId?: string;
      userId?: string;
      from?: string;
      to?: string;
    } = {},
  ) => ['orgs', orgId, 'reports', 'time-totals', filters] as const,
  presence: (orgId: string) => ['orgs', orgId, 'presence'] as const,
};
