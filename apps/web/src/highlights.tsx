import { useCallback, useEffect, useRef, useState } from 'react';
import { formatClock, type HighlightSummary, type Rect } from '@uitkijk/shared';

/** Layout id of the highlight tile; it always comes after the cameras in the shared order. */
export const HIGHLIGHT_TILE = '__highlight';

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

/**
 * The highlight to show now, or null.
 *
 * - Polls the rotation (the best 0–15 of the last 24 h) every minute.
 * - Plays them in order, but a highlight that was not there before is played next.
 * - While `paused` (active alert) nothing is shown; afterwards it continues with the next highlight.
 */
export function useHighlightRotation(paused: boolean, url = '/api/highlights/rotation') {
  const [list, setList] = useState<HighlightSummary[]>([]);
  const [current, setCurrent] = useState<HighlightSummary | null>(null);
  const queue = useRef<string[]>([]);
  const seen = useRef(new Set<string>());

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
    };
  }, [url]);

  // Keep the queue in sync with the list: new highlights first, removed ones dropped.
  useEffect(() => {
    const ids = list.map((h) => h.id);
    const fresh = ids.filter((id) => !seen.current.has(id));
    for (const id of fresh) seen.current.add(id);
    queue.current = [...fresh, ...queue.current.filter((id) => ids.includes(id) && !fresh.includes(id))];
    setCurrent((c) => (c && !ids.includes(c.id) ? null : c));
  }, [list]);

  const next = useCallback(() => {
    setCurrent((c) => {
      if (!list.length) return null;
      if (!queue.current.length) queue.current = list.map((h) => h.id);
      // Do not repeat the same clip back to back when there is a choice.
      let id = queue.current.shift()!;
      if (c && id === c.id && list.length > 1) {
        queue.current.push(id);
        id = queue.current.shift()!;
      }
      return list.find((h) => h.id === id) ?? null;
    });
  }, [list]);

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

  return { current: paused ? null : current, next };
}

interface TileProps {
  highlight: HighlightSummary;
  rect: Rect;
  cameraName: string;
  onDone: () => void;
}

/** Plays one highlight clip once, muted, with time and description; then asks for the next. */
export function HighlightTile({ highlight, rect, cameraName, onDone }: TileProps) {
  const [playing, setPlaying] = useState(false);

  // Safety net: a stalled or failing clip never blocks the rotation.
  useEffect(() => {
    setPlaying(false);
    const timer = setTimeout(onDone, (highlight.clipDuration + 20) * 1000);
    return () => clearTimeout(timer);
  }, [highlight.id, highlight.clipDuration, onDone]);

  return (
    <div className="tile tile--highlight" data-camera={HIGHLIGHT_TILE} style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      <video
        key={highlight.id}
        className={playing ? 'tile__video' : 'tile__video tile__video--hidden'}
        src={`/api/highlights/${encodeURIComponent(highlight.id)}/clip.mp4`}
        autoPlay
        muted
        playsInline
        onPlaying={() => setPlaying(true)}
        onEnded={onDone}
        onError={() => setTimeout(onDone, 2_000)}
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
