import type { MembershipDto, ScreenshotDto, TimeEntryDto, UserDto } from '@hindsight/shared/dto';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Image as ImageIcon } from 'lucide-react';
import { useMemo, useState } from 'react';

import { ScreenshotDialog } from '@/components/screenshot-dialog';
import { initialsOf } from '@/components/ui/avatar-live';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { apiGet } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { queryKeys } from '@/lib/queries';

interface ScreenshotListItem {
  screenshot: ScreenshotDto;
  thumbnailUrl: string | null;
  thumbnailExpiresAt: string | null;
}
interface ScreenshotsPage {
  items: ScreenshotListItem[];
  nextCursor: string | null;
}
interface MembersResponse {
  members: { membership: MembershipDto; user: UserDto }[];
}
interface TimeEntriesResponse {
  entries: TimeEntryDto[];
  nextCursor: string | null;
}
interface Bucket {
  key: string;
  label: string;
  items: ScreenshotListItem[];
}

const PAGE_LIMIT = 48;
const PALETTE: [string, string][] = [
  ['#e2e2f9', '#5b5bd6'],
  ['#fde2d3', '#c2410c'],
  ['#d8f0e1', '#16a34a'],
  ['#fce5f3', '#be185d'],
  ['#e2eef9', '#1d4ed8'],
];

export const Route = createFileRoute('/_app/orgs/$orgId/projects/$projectId/screenshots')({
  component: ProjectScreenshotsPage,
});

function ProjectScreenshotsPage() {
  const params = Route.useParams();
  const queryClient = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);

  const filters = { projectId: params.projectId };
  const query = useInfiniteQuery({
    queryKey: queryKeys.screenshotsInfinite(params.orgId, filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiGet<ScreenshotsPage>(`/orgs/${params.orgId}/screenshots`, {
        projectId: params.projectId,
        limit: PAGE_LIMIT,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (q) => {
      const pages = q.state.data?.pages ?? [];
      const anyPending = pages.some((p) =>
        p.items.some((it) => it.screenshot.status !== 'processed' || !it.thumbnailUrl),
      );
      return anyPending ? 10_000 : 30_000;
    },
  });

  const membersQuery = useQuery({
    queryKey: queryKeys.members(params.orgId),
    queryFn: () => apiGet<MembersResponse>(`/orgs/${params.orgId}/members`),
  });

  const timeEntriesQuery = useQuery({
    queryKey: ['orgs', params.orgId, 'time-entries', { projectId: params.projectId, limit: 100 }],
    queryFn: () =>
      apiGet<TimeEntriesResponse>(`/orgs/${params.orgId}/time-entries`, {
        projectId: params.projectId,
        limit: 100,
      }),
  });

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const members = membersQuery.data?.members ?? [];
  const userById = useMemo(() => new Map(members.map((m) => [m.user.id, m.user])), [members]);
  const entryById = useMemo(() => {
    const map = new Map<string, TimeEntryDto>();
    for (const entry of timeEntriesQuery.data?.entries ?? []) map.set(entry.id, entry);
    return map;
  }, [timeEntriesQuery.data]);
  const buckets = useMemo(() => groupByHour(items), [items]);

  if (query.isLoading) {
    return (
      <div>
        <div className="mb-5">
          <h2 className="text-[15px] font-medium">Screenshots</h2>
          <p className="text-[12.5px] text-ink3">
            Hourly capture groups for this project. Click a thumbnail to open the full image.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
          {Array.from({ length: 16 }).map((_, i) => (
            <Skeleton key={i} className="aspect-video w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (query.error) {
    return (
      <div className="rounded-lg border border-dashed border-border-strong bg-card px-6 py-14 text-center">
        <p className="text-[13px] text-destructive">
          {query.error instanceof Error ? query.error.message : 'Could not load screenshots.'}
        </p>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border-strong bg-card px-6 py-14 text-center">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-muted text-ink3">
          <ImageIcon className="h-6 w-6" />
        </div>
        <p className="mt-3 text-[14px] font-medium">No screenshots yet</p>
        <p className="mt-1 text-[12.5px] text-ink3">
          They&apos;ll appear here once a tracked session uploads them.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-5 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-medium">Screenshots</h2>
          <p className="text-[12.5px] text-ink3">
            Grouped by capture hour so the project activity reads like a timeline.
          </p>
        </div>
        <span className="font-mono text-[11px] text-ink4">{items.length} loaded</span>
      </div>

      <div className="space-y-7">
        {buckets.map((bucket) => {
          const idleCount = bucket.items.filter(isIdle).length;
          const userCount = new Set(
            bucket.items
              .map((item) => entryById.get(item.screenshot.timeEntryId)?.userId)
              .filter(Boolean),
          ).size;

          return (
            <section key={bucket.key}>
              <div className="mb-2.5 flex items-baseline justify-between gap-3">
                <div className="flex items-baseline gap-2.5">
                  <h3 className="text-[14px] font-semibold tracking-tight">{bucket.label}</h3>
                  <span className="font-mono text-[11px] text-ink4">
                    {bucket.items.length} captures
                    {idleCount > 0 ? ` · ${idleCount} idle` : ''}
                  </span>
                </div>
                <span className="text-[11px] text-ink4">
                  across {userCount} member{userCount === 1 ? '' : 's'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
                {bucket.items.map((item) => {
                  const user = entryById.has(item.screenshot.timeEntryId)
                    ? (userById.get(entryById.get(item.screenshot.timeEntryId)!.userId) ?? null)
                    : null;

                  return (
                    <ThumbnailCard
                      key={item.screenshot.id}
                      item={item}
                      user={user}
                      onOpen={() => setOpenId(item.screenshot.id)}
                    />
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      {query.hasNextPage && (
        <div className="flex justify-center pt-5">
          <Button
            variant="outline"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? <Spinner /> : 'Load more'}
          </Button>
        </div>
      )}

      {openId && (
        <ScreenshotDialog
          screenshotId={openId}
          onClose={() => setOpenId(null)}
          invalidateOnDelete={() => {
            queryClient.invalidateQueries({
              queryKey: queryKeys.screenshotsInfinite(params.orgId, {
                projectId: params.projectId,
              }),
            });
            queryClient.invalidateQueries({
              queryKey: queryKeys.screenshots(params.orgId, {}),
            });
          }}
        />
      )}
    </div>
  );
}

function ThumbnailCard({
  item,
  user,
  onOpen,
}: {
  item: ScreenshotListItem;
  user: UserDto | null;
  onOpen: () => void;
}) {
  const { screenshot, thumbnailUrl } = item;
  const isProcessing = screenshot.status !== 'processed';
  const idle = isIdle(item);
  const palette = user ? paletteFor(user.id) : PALETTE[0]!;
  const initials = user ? initialsOf(user.name) : '??';
  const time = new Date(screenshot.capturedAt).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative aspect-video w-full overflow-hidden rounded-md border border-border bg-[#0f1115] text-left transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2"
      title={formatDateTime(screenshot.capturedAt)}
    >
      {thumbnailUrl ? (
        <img
          src={thumbnailUrl}
          alt={`Screenshot from ${formatDateTime(screenshot.capturedAt)}`}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-[10px] text-ink4">
          {isProcessing ? 'Processing...' : 'No preview'}
        </div>
      )}

      <div className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full bg-black/45 px-1.5 py-0.5 text-[9.5px] font-medium text-white shadow-sm ring-1 ring-black/20 backdrop-blur-sm">
        <span
          className="grid h-4 w-4 place-items-center rounded-full text-[8.5px] font-semibold"
          style={{ background: palette[0], color: palette[1] }}
        >
          {initials}
        </span>
        <span className="font-mono">{initials}</span>
      </div>

      <div className="absolute right-1.5 top-1.5 flex items-center gap-1">
        {idle && (
          <span className="rounded bg-amber-500/90 px-1.5 py-0.5 font-mono text-[9px] font-medium text-white">
            IDLE
          </span>
        )}
        {screenshot.blurred && (
          <span className="rounded bg-white/15 px-1.5 py-0.5 font-mono text-[9px] font-medium text-white backdrop-blur-sm">
            BLUR
          </span>
        )}
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/80 to-transparent px-2 pt-4 pb-1.5 font-mono text-[10px] text-white">
        <span>{time}</span>
        <span className="opacity-90">{activityPercent(item).toFixed(0)}%</span>
      </div>
    </button>
  );
}

function groupByHour(items: ScreenshotListItem[]): Bucket[] {
  const byKey = new Map<string, Bucket>();
  for (const item of items) {
    const date = new Date(item.screenshot.capturedAt);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}`;
    const bucket = byKey.get(key) ?? { key, label: hourLabel(date), items: [] };
    bucket.items.push(item);
    byKey.set(key, bucket);
  }
  return Array.from(byKey.values());
}

function hourLabel(d: Date): string {
  return d
    .toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
    .replace(/:00\s/, ' ');
}

function isIdle(item: ScreenshotListItem): boolean {
  return (
    (item.screenshot.keyboardEventsCount ?? 0) === 0 &&
    (item.screenshot.mouseEventsCount ?? 0) === 0
  );
}

// Real activity % from input-event counts (keyboard + mouse) over the
// capture window. Saturates at ~1000 events for "fully active".
const ACTIVITY_SATURATION_EVENTS = 1000;
function activityPercent(item: ScreenshotListItem): number {
  const events =
    (item.screenshot.keyboardEventsCount ?? 0) + (item.screenshot.mouseEventsCount ?? 0);
  if (events === 0) return 0;
  return Math.min(100, (events / ACTIVITY_SATURATION_EVENTS) * 100);
}

function paletteFor(id: string): [string, string] {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length] ?? PALETTE[0]!;
}
