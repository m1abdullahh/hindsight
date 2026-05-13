import type { ScreenshotDto } from '@hindsight/shared/dto';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/use-toast';
import { ApiError, apiDelete, apiGet } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { queryKeys } from '@/lib/queries';
import { useCurrentMembership, useUser } from '@/lib/session-store';

interface ScreenshotDetail {
  screenshot: ScreenshotDto;
  fullUrl: string;
  expiresAt: string;
  ownerUserId: string;
  orgId: string;
}

/**
 * Modal that fetches the full-resolution screenshot and shows it with metadata.
 * Owners/admins get a delete button. `invalidateOnDelete` lets the caller flush
 * its own list queries (the org page and the project page key these differently).
 */
export function ScreenshotDialog({
  screenshotId,
  onClose,
  invalidateOnDelete,
}: {
  screenshotId: string;
  onClose: () => void;
  invalidateOnDelete?: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const membership = useCurrentMembership();
  const user = useUser();

  const detailQuery = useQuery({
    queryKey: queryKeys.screenshot(screenshotId),
    queryFn: () => apiGet<ScreenshotDetail>(`/screenshots/${screenshotId}`),
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiDelete(`/screenshots/${screenshotId}`),
    onSuccess: () => {
      invalidateOnDelete?.();
      // Hard delete also decremented TimeEntry.totalActiveSeconds on the
      // server — invalidate everything that reads from it so the new lower
      // number propagates without waiting for the next poll.
      const orgId = detailQuery.data?.orgId;
      if (orgId) {
        queryClient.invalidateQueries({
          queryKey: ['orgs', orgId, 'reports', 'time-totals'],
        });
        queryClient.invalidateQueries({
          queryKey: ['orgs', orgId, 'time-entries'],
        });
      }
      // Always nuke the per-screenshot cache too so a stale row can't load.
      queryClient.removeQueries({ queryKey: queryKeys.screenshot(screenshotId) });
      toast({ title: 'Screenshot deleted' });
      onClose();
    },
    onError: (err) => {
      toast({
        title: 'Could not delete screenshot',
        description:
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const detail = detailQuery.data;
  const meta = detail?.screenshot;
  // Owners/admins can delete any capture; a member can delete only their own.
  const canDelete =
    !!membership &&
    !!detail &&
    (membership.role === 'owner' || membership.role === 'admin' || user?.id === detail.ownerUserId);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>{meta ? formatDateTime(meta.capturedAt) : 'Screenshot'}</DialogTitle>
          {meta?.activeApp && (
            <DialogDescription>
              {meta.activeApp}
              {meta.activeWindowTitle ? ` — ${meta.activeWindowTitle}` : ''}
            </DialogDescription>
          )}
        </DialogHeader>

        {detailQuery.isLoading ? (
          <Skeleton className="aspect-video w-full" />
        ) : detailQuery.error ? (
          <div className="rounded-md border border-dashed py-12 text-center text-sm text-destructive">
            {detailQuery.error instanceof Error
              ? detailQuery.error.message
              : 'Could not load screenshot.'}
          </div>
        ) : detail ? (
          <div className="space-y-3">
            <div className="overflow-hidden rounded-md border bg-muted/30">
              <img
                src={detail.fullUrl}
                alt={`Screenshot from ${formatDateTime(detail.screenshot.capturedAt)}`}
                className="block max-h-[70vh] w-full object-contain"
              />
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
              <Meta label="Size">
                {detail.screenshot.width} × {detail.screenshot.height}
              </Meta>
              <Meta label="Monitor">#{detail.screenshot.monitorIndex + 1}</Meta>
              <Meta label="Keyboard">{detail.screenshot.keyboardEventsCount}</Meta>
              <Meta label="Mouse">{detail.screenshot.mouseEventsCount}</Meta>
            </dl>
          </div>
        ) : null}

        <DialogFooter>
          {canDelete && (
            <Button
              variant="destructive"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending || !detail}
            >
              {deleteMutation.isPending ? (
                <Spinner />
              ) : (
                <>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </>
              )}
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium">{children}</dd>
    </div>
  );
}
