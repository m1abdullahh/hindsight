import { Download, RotateCw, X as CloseIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { UpdaterApi } from '@/lib/use-updater';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface UpdaterDialogProps {
  updater: UpdaterApi;
}

export function UpdaterDialog({ updater }: UpdaterDialogProps) {
  const { phase, startInstall, restart, dismiss } = updater;

  // `checking` and `idle` never render — we only surface UI once there's
  // something the user needs to know about or act on.
  if (phase.kind === 'idle' || phase.kind === 'checking') return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="updater-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
    >
      <div className="w-full max-w-sm rounded-lg border border-border bg-background p-4 shadow-xl">
        <div className="mb-3 flex items-start justify-between gap-2">
          <h2 id="updater-title" className="text-sm font-semibold">
            {phase.kind === 'available' && `Update available · ${phase.version}`}
            {phase.kind === 'downloading' && `Downloading ${phase.version}`}
            {phase.kind === 'installing' && `Installing ${phase.version}`}
            {phase.kind === 'ready' && `Update ready · ${phase.version}`}
            {phase.kind === 'error' && 'Update failed'}
          </h2>
          {(phase.kind === 'available' || phase.kind === 'error') && (
            <button
              type="button"
              onClick={dismiss}
              className="text-ink3 hover:text-foreground"
              aria-label="Dismiss"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          )}
        </div>

        {phase.kind === 'available' && (
          <>
            {phase.notes && (
              <p className="mb-3 max-h-32 overflow-y-auto whitespace-pre-wrap text-[12px] text-ink2">
                {phase.notes}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={dismiss}>
                Later
              </Button>
              <Button size="sm" onClick={() => void startInstall()}>
                <Download className="mr-1.5 h-4 w-4" />
                Install
              </Button>
            </div>
          </>
        )}

        {phase.kind === 'downloading' && (
          <>
            <DownloadBar downloaded={phase.downloaded} total={phase.total} />
            <p className="mt-1 text-[11px] text-ink3">
              {phase.total != null
                ? `${formatBytes(phase.downloaded)} of ${formatBytes(phase.total)}`
                : formatBytes(phase.downloaded)}
            </p>
          </>
        )}

        {phase.kind === 'installing' && (
          <p className="text-[12px] text-ink2">Installing… the app will close briefly.</p>
        )}

        {phase.kind === 'ready' && (
          <>
            <p className="mb-3 text-[12px] text-ink2">Restart Hindsight to finish updating.</p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={dismiss}>
                Later
              </Button>
              <Button size="sm" onClick={() => void restart()}>
                <RotateCw className="mr-1.5 h-4 w-4" />
                Restart now
              </Button>
            </div>
          </>
        )}

        {phase.kind === 'error' && (
          <>
            <p className="mb-3 break-words text-[12px] text-destructive">{phase.message}</p>
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" onClick={dismiss}>
                Close
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DownloadBar({ downloaded, total }: { downloaded: number; total: number | null }) {
  const pct = total != null && total > 0 ? Math.min(100, (downloaded / total) * 100) : null;
  return (
    <div className="h-2 w-full overflow-hidden rounded bg-muted">
      <div
        className={
          pct == null ? 'h-full w-1/3 animate-pulse bg-primary' : 'h-full bg-primary transition-all'
        }
        style={pct == null ? undefined : { width: `${pct}%` }}
      />
    </div>
  );
}
