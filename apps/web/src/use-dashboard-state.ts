import { useEffect, useState } from 'react';
import { backoffDelay, DEFAULT_HOLD_MS, type DashboardState } from '@uitkijk/shared';

const CACHE_KEY = 'uitkijk.state.v1';

export interface DashboardConnection {
  state: DashboardState | null;
  /** True while the backend event stream is open. */
  connected: boolean;
}

/**
 * Subscribes to the backend's server-sent events.
 *
 * Backend outages do not affect video: players talk to the streaming service directly. While the
 * backend is unreachable the last known cameras stay on screen (also across a page reload, via a
 * local cache), and any focus is released after the normal hold so the layout cannot get stuck.
 */
export function useDashboardState(eventsUrl = '/api/events'): DashboardConnection {
  const [state, setState] = useState<DashboardState | null>(() => readCache());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let disposed = false;

    const open = () => {
      source = new EventSource(eventsUrl);
      source.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      source.addEventListener('state', (ev) => {
        const next = JSON.parse((ev as MessageEvent<string>).data) as DashboardState;
        setState(next);
        writeCache(next);
      });
      source.onerror = () => {
        setConnected(false);
        // EventSource retries by itself unless the response was an HTTP error; then it closes for good.
        if (source?.readyState === EventSource.CLOSED && !disposed) {
          source.close();
          retry = setTimeout(open, backoffDelay(attempt++));
          // From outside the LAN a missing or expired login closes the stream: go to the login page.
          void fetch('/api/state', { method: 'HEAD' }).then((res) => {
            if (res.status === 401 && !disposed) {
              location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
            }
          }, () => {});
        }
      };
    };
    open();
    return () => {
      disposed = true;
      clearTimeout(retry);
      source?.close();
    };
  }, [eventsUrl]);

  // Release focus after the hold period if the backend stays unreachable.
  useEffect(() => {
    if (connected) return;
    const timer = setTimeout(() => setState((s) => (s && s.focus.length ? { ...s, focus: [] } : s)), DEFAULT_HOLD_MS);
    return () => clearTimeout(timer);
  }, [connected]);

  return { state, connected };
}

function readCache(): DashboardState | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as DashboardState;
    // Only the camera list is trusted from cache; alerts and health are unknown until the backend answers.
    return {
      ...cached,
      focus: [],
      cameras: cached.cameras.map((c) => ({ ...c, availability: 'unknown' })),
      health: { alerts: { status: 'unknown' }, streaming: { status: 'unknown' } },
    };
  } catch {
    return null;
  }
}

function writeCache(state: DashboardState): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or disabled: caching is best-effort.
  }
}
