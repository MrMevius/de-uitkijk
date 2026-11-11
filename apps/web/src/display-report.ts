import { useEffect } from 'react';

const ID_KEY = 'uitkijk.display.id';

/** A random id per browser, so Beheer → Overzicht can tell screens apart. */
function displayId(): string {
  let id = localStorage.getItem(ID_KEY);
  if (!id) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(ID_KEY, id);
  }
  return id;
}

/** Live camera tiles (not highlights) whose video plays. */
function camerasLive(): { live: number; total: number } {
  const tiles = [...document.querySelectorAll('.tile[data-camera]:not([data-camera="highlight"])')];
  return { live: tiles.filter((t) => t.querySelector('video:not(.tile__video--hidden)')).length, total: tiles.length };
}

/**
 * Reports this dashboard every minute (version, profile, cameras with a picture) for the screen list on
 * Beheer → Overzicht (since 0.27.0). Failures are ignored: reporting never affects the dashboard.
 */
export function useDisplayReport(profile: string, version: string = __APP_VERSION__, intervalMs = 60_000): void {
  useEffect(() => {
    const report = () => {
      const { live, total } = camerasLive();
      void fetch('/api/displays/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: displayId(), profile, version, camerasLive: live, camerasTotal: total }),
      }).catch(() => {});
    };
    // First report once the players had time to start.
    const first = setTimeout(report, 15_000);
    const timer = setInterval(report, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [profile, version, intervalMs]);
}
