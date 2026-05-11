import type { PresenceState } from '@hindsight/shared/dto';
import { useEffect, useRef } from 'react';

import { apiPost } from './api';
import { session } from './session-store';

declare const __APP_VERSION__: string;

const HEARTBEAT_INTERVAL_MS = 15_000;

// Map session state → presence state. Tracking & not paused = active; tracking
// & paused (manual or idle) = idle; everything else = offline. The web reads
// the state with a 35s staleness window, so sending 'offline' explicitly is
// what makes Stop flip the badge within one heartbeat instead of three.
const stateFromSession = (
  stage: 'login' | 'picking' | 'tracking',
  pauseReason: 'manual' | 'idle' | null,
): PresenceState => {
  if (stage !== 'tracking') return 'offline';
  return pauseReason ? 'idle' : 'active';
};

const sendHeartbeat = (state: PresenceState): Promise<unknown> =>
  apiPost('/devices/heartbeat', { appVersion: __APP_VERSION__, state }).catch(() => undefined);

/**
 * While signed in, POST /devices/heartbeat every 15s with the current state.
 * Sends one immediate heartbeat on mount and on every state transition so the
 * web sees changes within the next 15s, not the next refetch cycle.
 */
export function usePresenceHeartbeat(): void {
  const stage = session((s) => s.stage);
  const pauseReason = session((s) => s.pauseReason);

  const lastSentRef = useRef<PresenceState | null>(null);

  useEffect(() => {
    if (stage === 'login') {
      lastSentRef.current = null;
      return;
    }

    const current = stateFromSession(stage, pauseReason);
    // Always send on mount / transition so the server reflects state asap.
    if (lastSentRef.current !== current) {
      lastSentRef.current = current;
      void sendHeartbeat(current);
    }

    const id = window.setInterval(() => {
      void sendHeartbeat(
        stateFromSession(session.getState().stage, session.getState().pauseReason),
      );
    }, HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [stage, pauseReason]);
}
