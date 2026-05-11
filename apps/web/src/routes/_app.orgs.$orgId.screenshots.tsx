import { useInfiniteQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Camera as CameraIcon, Filter } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { apiGet } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { queryKeys } from '@/lib/queries';

interface ScreenshotListItem {
  screenshot: {
    id: string;
    timeEntryId: string;
    capturedAt: string;
    width: number;
    height: number;
    activeApp: string | null;
    activeWindowTitle: string | null;
    keyboardEventsCount: number;
    mouseEventsCount: number;
    blurred: boolean;
    status: string;
  };
  thumbnailUrl: string | null;
}
interface ScreenshotsResponse {
  items: ScreenshotListItem[];
  nextCursor: string | null;
}

const PAGE_LIMIT = 60;

export const Route = createFileRoute('/_app/orgs/$orgId/screenshots')({
  component: ScreenshotsPage,
});

function ScreenshotsPage() {
  const params = Route.useParams();
  const [showBlurred, setShowBlurred] = useState(false);

  const filters = {};
  const query = useInfiniteQuery({
    queryKey: queryKeys.screenshotsInfinite(params.orgId, filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiGet<ScreenshotsResponse>(`/orgs/${params.orgId}/screenshots`, {
        limit: PAGE_LIMIT,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Always poll so brand-new captures appear without a manual refresh.
    // 10s while anything is still being processed (fast-feedback for the
    // "Processing…" → real thumbnail flip), 30s otherwise.
    refetchInterval: (q) => {
      const pages = q.state.data?.pages ?? [];
      const anyPending = pages.some((p) =>
        p.items.some((it) => it.screenshot.status !== 'processed' || !it.thumbnailUrl),
      );
      return anyPending ? 10_000 : 30_000;
    },
  });

  if (query.isLoading) {
    return (
      <div className="px-7 py-6">
        <PageHeader title="Screenshots" subtitle="Loading recent captures…" />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
          {Array.from({ length: 16 }).map((_, i) => (
            <Skeleton key={i} className="aspect-video w-full" />
          ))}
        </div>
      </div>
    );
  }

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const visible = showBlurred ? items.filter((i) => i.screenshot.blurred) : items;
  const buckets = groupByHour(visible);

  return (
    <div className="px-7 py-6">
      <PageHeader
        kicker={`${items.length} captures loaded`}
        title="Screenshots"
        subtitle="Recent captures across the organization, newest first."
      />

      {/* Filter bar */}
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-[12.5px]">
        <FilterChip icon={<Filter className="h-3 w-3" />}>All members</FilterChip>
        <FilterChip>All projects</FilterChip>
        <FilterChip>Today</FilterChip>
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-ink3">
          <input
            type="checkbox"
            checked={showBlurred}
            onChange={(e) => setShowBlurred(e.target.checked)}
            className="h-3.5 w-3.5 accent-accent"
          />
          Blurred only
        </label>
      </div>

      {buckets.length === 0 ? (
        <EmptyState
          icon={<CameraIcon className="h-7 w-7" />}
          title={showBlurred ? 'No blurred captures yet.' : 'No screenshots yet.'}
          body="They'll appear here once the desktop app uploads them."
        />
      ) : (
        buckets.map((b) => (
          <section key={b.key} className="mb-6">
            <div className="mb-2.5 flex items-baseline justify-between">
              <div className="flex items-center gap-2.5">
                <h2 className="text-[13px] font-semibold">{b.label}</h2>
                <span className="font-mono text-[11px] text-ink4">{b.items.length} captures</span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
              {b.items.map((item) => (
                <Thumbnail key={item.screenshot.id} item={item} />
              ))}
            </div>
          </section>
        ))
      )}

      {query.hasNextPage && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? <Spinner /> : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}

function PageHeader({
  kicker,
  title,
  subtitle,
}: {
  kicker?: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <header className="mb-5">
      {kicker && (
        <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.05em] text-ink4">
          {kicker}
        </div>
      )}
      <h1 className="text-[26px] font-semibold tracking-tight">{title}</h1>
      {subtitle && <p className="mt-1 text-[13px] text-ink3">{subtitle}</p>}
    </header>
  );
}

function FilterChip({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1 text-ink2">
      {icon && <span className="text-ink3">{icon}</span>}
      {children}
    </span>
  );
}

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border-strong bg-card px-6 py-14 text-center">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-muted text-ink3">
        {icon}
      </div>
      <h3 className="mt-3 text-[14px] font-medium">{title}</h3>
      <p className="mt-1 text-[12.5px] text-ink3">{body}</p>
    </div>
  );
}

function Thumbnail({ item }: { item: ScreenshotListItem }) {
  const { screenshot, thumbnailUrl } = item;
  const time = new Date(screenshot.capturedAt).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const isProcessing = screenshot.status !== 'processed';

  return (
    <div
      className="group relative aspect-video overflow-hidden rounded-md border border-border bg-muted"
      title={
        screenshot.activeApp
          ? `${screenshot.activeApp} · ${formatRelative(screenshot.capturedAt)}`
          : formatRelative(screenshot.capturedAt)
      }
    >
      {thumbnailUrl ? (
        <img
          src={thumbnailUrl}
          alt={`Screenshot from ${formatRelative(screenshot.capturedAt)}`}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="grid h-full place-items-center text-[10px] text-ink4">
          {isProcessing ? 'Processing…' : '—'}
        </div>
      )}
      {screenshot.blurred && (
        <span className="absolute right-1 top-1 rounded bg-card/85 px-1.5 py-0.5 font-mono text-[9px] text-ink2">
          BLUR
        </span>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-1 bg-gradient-to-t from-black/70 to-transparent px-2 pt-3 pb-1 font-mono text-[9.5px] text-white">
        <span>{time}</span>
        {screenshot.activeApp && (
          <span className="max-w-[60%] truncate opacity-80">{screenshot.activeApp}</span>
        )}
      </div>
    </div>
  );
}

// ── grouping ───────────────────────────────────────────────────────────

interface Bucket {
  key: string;
  label: string;
  items: ScreenshotListItem[];
}

function groupByHour(items: ScreenshotListItem[]): Bucket[] {
  const byKey = new Map<string, Bucket>();
  for (const it of items) {
    const d = new Date(it.screenshot.capturedAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}`;
    const label = hourLabel(d);
    const b = byKey.get(key) ?? { key, label, items: [] };
    b.items.push(it);
    byKey.set(key, b);
  }
  return Array.from(byKey.values());
}

function hourLabel(d: Date): string {
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
  if (isToday) return `Today · ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (isYesterday) return `Yesterday · ${time}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${time}`;
}
