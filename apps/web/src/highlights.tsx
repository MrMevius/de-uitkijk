import { useCallback, useEffect, useRef, useState } from 'react';
import { formatClock, type HighlightSummary, type Rect } from '@uitkijk/shared';

/** Share of the screen width (landscape) or height (portrait) given to the highlight strip. */
export const HIGHLIGHT_STRIP = 0.22;

/**
 * Splits the screen into an area for the live cameras and a smaller 16:9 highlight tile beside them
 * (landscape: strip on the right) or below them (portrait). The highlight ends up at roughly half the
 * size of a camera tile, so live video stays the main thing.
 */
export function highlightStrip(width: number, height: number, gap: number): { cameras: { width: number; height: number }; highlight: Rect } {
  if (width >= height) {
    const stripW = Math.round(width * HIGHLIGHT_STRIP);
    // Same outer margin as the camera grid.
    const w = stripW - gap;
    const h = Math.round((w * 9) / 16);
    return {
      cameras: { width: width - stripW, height },
      highlight: { x: width - stripW, y: Math.round((height - h) / 2), w, h },
    };
  }
  const stripH = Math.round(height * HIGHLIGHT_STRIP);
  const w = Math.min(width - 2 * gap, Math.round(((stripH - gap) * 16) / 9));
  const h = Math.round((w * 9) / 16);
  return {
    cameras: { width, height: height - stripH },
    highlight: { x: Math.round((width - w) / 2), y: height - stripH + Math.round((stripH - h) / 2), w, h },
  };
}

const POLL_MS = 60_000;

/** "vandaag 14:32", "gisteren 22:10" or "zo 8 nov 09:15" in Europe/Amsterdam. */
export function highlightTime(epochS: number, nowMs = Date.now()): string {
  const day = (ms: number) => new Intl.DateTimeFormat('nl-NL', { dateStyle: 'short', timeZone: 'Europe/Amsterdam' }).format(ms);
  const ms = epochS * 1000;
  const clock = formatClock(ms);
  if (day(ms) === day(nowMs)) return `vandaag ${clock}`;
  if (day(ms) === day(nowMs - 86_400_000)) return `gisteren ${clock}`;
  const date = new Intl.DateTimeFormat('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Amsterdam' }).format(ms);
  return `${date} ${clock}`;
}

/** A highlight that failed to play is skipped for this long (others play meanwhile). */
const FAILED_SKIP_MS = 10 * 60_000;
/** After a failure, wait this long before trying the next highlight. */
const RETRY_AFTER_FAIL_MS = 30_000;

/**
 * The highlight to show now, or null.
 *
 * - Polls the rotation (the best 0–15 of the last 24 h) every minute.
 * - Plays them in order, but a highlight that was not there before is played next.
 * - While `paused` (active alert) nothing is shown; afterwards it continues with the next highlight.
 * - Every turn gets a new `playKey`, so the same highlight replays (also when it is the only one).
 * - A highlight that fails to play is hidden and skipped for ten minutes; nothing retries in a tight loop.
 */
export function useHighlightRotation(paused: boolean, url = '/api/highlights/rotation') {
  const [list, setList] = useState<HighlightSummary[]>([]);
  const [current, setCurrent] = useState<{ highlight: HighlightSummary; play: number } | null>(null);
  const queue = useRef<string[]>([]);
  const seen = useRef(new Set<string>());
  const failedUntil = useRef(new Map<string, number>());
  const plays = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    const load = () =>
      fetch(url)
        .then((r) => (r.ok ? (r.json() as Promise<HighlightSummary[]>) : []))
        .then((items) => !disposed && setList(items), () => {});
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
      clearTimeout(retry.current);
    };
  }, [url]);

  // Keep the queue in sync with the list: new highlights first, removed ones dropped.
  useEffect(() => {
    const ids = list.map((h) => h.id);
    const fresh = ids.filter((id) => !seen.current.has(id));
    for (const id of fresh) seen.current.add(id);
    queue.current = [...fresh, ...queue.current.filter((id) => ids.includes(id) && !fresh.includes(id))];
    setCurrent((c) => (c && !ids.includes(c.highlight.id) ? null : c));
  }, [list]);

  const next = useCallback(() => {
    setCurrent((c) => {
      const now = Date.now();
      const playable = list.filter((h) => (failedUntil.current.get(h.id) ?? 0) <= now);
      if (!playable.length) return null;
      const ids = playable.map((h) => h.id);
      queue.current = queue.current.filter((id) => ids.includes(id));
      if (!queue.current.length) queue.current = [...ids];
      // Do not repeat the same clip back to back when there is a choice.
      let id = queue.current.shift()!;
      if (c && id === c.highlight.id && ids.length > 1) {
        queue.current.push(id);
        id = queue.current.shift()!;
      }
      return { highlight: playable.find((h) => h.id === id)!, play: ++plays.current };
    });
  }, [list]);

  const fail = useCallback(
    (id: string) => {
      failedUntil.current.set(id, Date.now() + FAILED_SKIP_MS);
      setCurrent(null);
      clearTimeout(retry.current);
      retry.current = setTimeout(next, RETRY_AFTER_FAIL_MS);
    },
    [next],
  );

  // Start when highlights arrive; continue with the next one after an alert.
  const wasPaused = useRef(paused);
  useEffect(() => {
    if (paused) {
      wasPaused.current = true;
      return;
    }
    if (wasPaused.current || !current) {
      wasPaused.current = false;
      if (list.length) next();
    }
  }, [paused, list, current, next]);

  const shown = paused ? null : current;
  return { current: shown?.highlight ?? null, playKey: shown ? `${shown.highlight.id}:${shown.play}` : '', next, fail };
}

interface TileProps {
  highlight: HighlightSummary;
  rect: Rect;
  cameraName: string;
  onDone: () => void;
  onFail: () => void;
}

/** Plays one highlight clip once, muted, with time and description; then asks for the next. */
export function HighlightTile({ highlight, rect, cameraName, onDone, onFail }: TileProps) {
  const [playing, setPlaying] = useState(false);

  // Safety net: a clip that does not start or stalls counts as failed, so the rotation never gets stuck.
  useEffect(() => {
    setPlaying(false);
    const timer = setTimeout(onFail, (highlight.clipDuration + 20) * 1000);
    return () => clearTimeout(timer);
  }, [highlight.id, highlight.clipDuration, onFail]);

  return (
    <div className="tile tile--highlight" data-camera="highlight" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      <video
        key={highlight.id}
        className={playing ? 'tile__video' : 'tile__video tile__video--hidden'}
        src={`/api/highlights/${encodeURIComponent(highlight.id)}/clip.mp4`}
        autoPlay
        muted
        playsInline
        onPlaying={() => setPlaying(true)}
        onEnded={onDone}
        onError={onFail}
      />
      {!playing && <div className="tile__placeholder">Highlight laden…</div>}
      <div className="tile__highlight-label">Highlight · {highlightTime(highlight.startTime)}</div>
      <div className="tile__name">
        {highlight.description}
        <span className="tile__sub">{cameraName}</span>
      </div>
    </div>
  );
}
