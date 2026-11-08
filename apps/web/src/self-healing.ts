import { useEffect, useRef } from 'react';

const CHECK_MS = 5 * 60_000;
const RELOAD_GUARD_KEY = 'uitkijk.lastReload';
/** Never reload more often than this, whatever happens (protects against reload loops). */
const MIN_RELOAD_GAP_MS = 10 * 60_000;
const NIGHTLY_HOUR = 4;

/** Milliseconds until the next 04:00 in Europe/Amsterdam. */
export function msUntilNightly(nowMs = Date.now()): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
    timeZone: 'Europe/Amsterdam',
  }).formatToParts(nowMs);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const secondsToday = get('hour') * 3600 + get('minute') * 60 + get('second');
  let wait = NIGHTLY_HOUR * 3600 - secondsToday;
  if (wait <= 0) wait += 86400;
  return wait * 1000;
}

function reload(): boolean {
  const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? 0);
  if (Date.now() - last < MIN_RELOAD_GAP_MS) return false;
  sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  location.reload();
  return true;
}

/**
 * Keeps an unattended TV fresh: reloads every night at 04:00 and soon after a new release goes live.
 * Never during an active alert (`busy`); then it tries again shortly after.
 */
export function useSelfHealing(busy: boolean, appVersion: string = __APP_VERSION__): void {
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    let nightly: ReturnType<typeof setTimeout>;
    const scheduleNightly = (ms: number) => {
      nightly = setTimeout(() => {
        if (busyRef.current || !reload()) scheduleNightly(5 * 60_000);
      }, ms);
    };
    scheduleNightly(msUntilNightly());

    const check = setInterval(() => {
      if (busyRef.current) return;
      fetch('/api/health')
        .then((r) => (r.ok ? (r.json() as Promise<{ version?: string }>) : null))
        .then((h) => {
          if (h?.version && h.version !== appVersion) reload();
        }, () => {});
    }, CHECK_MS);

    return () => {
      clearTimeout(nightly);
      clearInterval(check);
    };
  }, [appVersion]);
}
