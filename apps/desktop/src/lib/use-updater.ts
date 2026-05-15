import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { useCallback, useEffect, useRef, useState } from 'react';

// Re-check this often once the app has booted. The check itself is a cheap
// HEAD-then-GET against latest.json so we don't worry about hammering GitHub.
const POLL_INTERVAL_MS = 1 * 60 * 60 * 1000;

// Delay the first check after boot so we don't compete with login + initial
// /auth/me + capture-permission flows for the network and the user's attention.
const INITIAL_DELAY_MS = 30 * 1000;

export type UpdaterPhase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; notes: string | null; date: string | null }
  | { kind: 'downloading'; version: string; downloaded: number; total: number | null }
  | { kind: 'installing'; version: string }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string };

export interface UpdaterApi {
  phase: UpdaterPhase;
  startInstall: () => Promise<void>;
  restart: () => Promise<void>;
  dismiss: () => void;
}

export function useUpdater(): UpdaterApi {
  const [phase, setPhase] = useState<UpdaterPhase>({ kind: 'idle' });
  // Held across renders so startInstall() can find the Update we discovered in
  // the background check, without re-fetching latest.json.
  const pendingUpdate = useRef<Update | null>(null);
  const dismissedVersions = useRef<Set<string>>(new Set());

  const runCheck = useCallback(async () => {
    setPhase((prev) => (prev.kind === 'idle' ? { kind: 'checking' } : prev));
    try {
      const update = await check();
      if (!update) {
        setPhase({ kind: 'idle' });
        return;
      }
      if (dismissedVersions.current.has(update.version)) {
        // User already said "later" for this version in this session. We'll
        // surface it again next time the app starts.
        setPhase({ kind: 'idle' });
        return;
      }
      pendingUpdate.current = update;
      setPhase({
        kind: 'available',
        version: update.version,
        notes: update.body ?? null,
        date: update.date ?? null,
      });
    } catch (err) {
      // Network blip, GitHub 5xx, or signature mismatch. We don't surface a
      // dialog for these — there's nothing useful the user can do, and we'll
      // try again on the next interval.
      console.warn('[updater] check failed', err);
      setPhase({ kind: 'idle' });
    }
  }, []);

  useEffect(() => {
    const startTimer = setTimeout(() => {
      void runCheck();
    }, INITIAL_DELAY_MS);
    const pollTimer = setInterval(() => {
      void runCheck();
    }, POLL_INTERVAL_MS);
    return () => {
      clearTimeout(startTimer);
      clearInterval(pollTimer);
    };
  }, [runCheck]);

  const startInstall = useCallback(async () => {
    const update = pendingUpdate.current;
    if (!update) return;
    let total: number | null = null;
    let downloaded = 0;
    setPhase({ kind: 'downloading', version: update.version, downloaded: 0, total: null });
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            total = event.data.contentLength ?? null;
            setPhase({ kind: 'downloading', version: update.version, downloaded: 0, total });
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            setPhase({ kind: 'downloading', version: update.version, downloaded, total });
            break;
          case 'Finished':
            setPhase({ kind: 'installing', version: update.version });
            break;
        }
      });
      // On Windows the installer kills us before we ever reach this line — the
      // NSIS installer in `passive` mode runs and the app exits. On
      // macOS/Linux we still need an explicit relaunch prompt.
      setPhase({ kind: 'ready', version: update.version });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPhase({ kind: 'error', message });
    }
  }, []);

  const restart = useCallback(async () => {
    await relaunch();
  }, []);

  const dismiss = useCallback(() => {
    if (phase.kind === 'available') {
      dismissedVersions.current.add(phase.version);
    }
    setPhase({ kind: 'idle' });
  }, [phase]);

  return { phase, startInstall, restart, dismiss };
}
