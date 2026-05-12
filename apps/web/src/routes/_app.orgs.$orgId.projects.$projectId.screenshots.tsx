import type { ScreenshotDto } from '@hindsight/shared/dto';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Image as ImageIcon } from 'lucide-react';
import { useState } from 'react';

import { ScreenshotDialog } from '@/components/screenshot-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { apiGet } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
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

const PAGE_LIMIT = 48;

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

  if (query.isLoading) {
    return (
      <div>
        <div className="mb-4">
          <h2 className="text-[15px] font-medium">Screenshots</h2>
          <p className="text-[12.5px] text-ink3">
            Most recent first. Click a thumbnail to view the full image.
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

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

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
      <div className="mb-4 flex items-end justify-between">
        <div>
          <h2 className="text-[15px] font-medium">Screenshots</h2>
          <p className="text-[12.5px] text-ink3">
            Most recent first. Click a thumbnail to view the full image.
          </p>
        </div>
        <span className="font-mono text-[11px] text-ink4">{items.length} loaded</span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
        {items.map((item) => (
          <ThumbnailCard
            key={item.screenshot.id}
            item={item}
            onOpen={() => setOpenId(item.screenshot.id)}
          />
        ))}
      </div>

      {query.hasNextPage && (
        <div className="flex justify-center pt-4">
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

function ThumbnailCard({ item, onOpen }: { item: ScreenshotListItem; onOpen: () => void }) {
  const { screenshot, thumbnailUrl } = item;
  const isProcessing = screenshot.status !== 'processed';

  const time = new Date(screenshot.capturedAt).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative aspect-video w-full overflow-hidden rounded-md border border-border bg-muted text-left transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2"
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
          {isProcessing ? 'Processing…' : 'No preview'}
        </div>
      )}
      {screenshot.blurred && (
        <span className="absolute right-1 top-1 rounded bg-card/85 px-1.5 py-0.5 font-mono text-[9px] text-ink2">
          BLUR
        </span>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 pt-3 pb-1 font-mono text-[9.5px] text-white">
        {time} · {formatRelative(screenshot.capturedAt)}
      </div>
    </button>
  );
}
