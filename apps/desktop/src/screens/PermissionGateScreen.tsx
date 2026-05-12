import { invoke } from '@tauri-apps/api/core';
import { Camera, ExternalLink, RotateCw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Spinner } from '@/components/ui/spinner';

type PermissionStatus = 'granted' | 'denied' | 'not_supported';

/**
 * macOS Screen Recording permission gate. Renders nothing on platforms
 * where the OS doesn't gate screencapture (Windows, X11). On macOS,
 * blocks the tracker UI until the user has granted permission so the
 * very first session doesn't silently capture blank frames.
 *
 * Two paths:
 *   1. First-time users: click "Allow screen recording" → calls
 *      CGRequestScreenCaptureAccess which triggers the native dialog.
 *   2. Users who previously denied: native dialog won't re-trigger;
 *      the "Open System Settings" button deep-links into the right pane,
 *      and we re-check on window focus so flipping the toggle dismisses
 *      the gate automatically.
 */
export function PermissionGateScreen({ onGranted }: { onGranted: () => void }) {
  const [status, setStatus] = useState<PermissionStatus | null>(null);
  const [requesting, setRequesting] = useState(false);

  const recheck = useCallback(async () => {
    try {
      const next = await invoke<PermissionStatus>('check_screen_capture_permission');
      setStatus(next);
      if (next === 'granted') onGranted();
    } catch {
      // If the IPC fails (very rare in Tauri), assume granted to avoid
      // bricking the app — the capture pipeline will surface the real
      // error if it actually fails.
      setStatus('granted');
      onGranted();
    }
  }, [onGranted]);

  useEffect(() => {
    void recheck();
  }, [recheck]);

  // Re-check when the user comes back from System Settings.
  useEffect(() => {
    const handler = () => void recheck();
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  }, [recheck]);

  const onAllow = async () => {
    setRequesting(true);
    try {
      const next = await invoke<PermissionStatus>('request_screen_capture_permission');
      setStatus(next);
      if (next === 'granted') onGranted();
    } finally {
      setRequesting(false);
    }
  };

  const onOpenSettings = () => {
    void invoke('open_screen_capture_settings');
  };

  if (status === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-ink3">
        Checking permissions…
      </div>
    );
  }

  if (status === 'granted' || status === 'not_supported') {
    // Caller has already been notified via onGranted; render nothing while
    // the parent swaps in the tracker.
    return null;
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-8 text-center">
      <div className="mb-3 grid h-12 w-12 place-items-center rounded-full bg-accent-soft text-accent">
        <Camera className="h-6 w-6" />
      </div>
      <h2 className="text-[16px] font-semibold tracking-tight">Allow screen recording</h2>
      <p className="mt-1.5 max-w-[320px] text-[12.5px] leading-relaxed text-ink3">
        Hindsight captures screenshots of your active workspace during tracked sessions. macOS needs
        your permission before it can do this.
      </p>

      <div className="mt-5 flex flex-col gap-2">
        <button
          type="button"
          onClick={onAllow}
          disabled={requesting}
          className="inline-flex h-9 min-w-[220px] items-center justify-center gap-1.5 rounded-md bg-foreground text-[13px] font-medium text-background disabled:opacity-60"
        >
          {requesting ? (
            <Spinner />
          ) : (
            <>
              <ShieldCheck className="h-3.5 w-3.5" />
              Allow screen recording
            </>
          )}
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          className="inline-flex h-9 min-w-[220px] items-center justify-center gap-1.5 rounded-md border border-border-strong bg-card text-[13px] font-medium hover:bg-muted"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open System Settings
        </button>
        <button
          type="button"
          onClick={() => void recheck()}
          className="inline-flex h-7 items-center justify-center gap-1 text-[12px] text-ink3 hover:text-foreground"
        >
          <RotateCw className="h-3 w-3" />
          Re-check
        </button>
      </div>

      <p className="mt-5 max-w-[320px] text-[11px] leading-relaxed text-ink4">
        If the system dialog doesn&apos;t appear, open System Settings → Privacy &amp; Security →
        Screen Recording, enable Hindsight, and come back here. The gate clears automatically when
        permission is granted.
      </p>
    </div>
  );
}
