import { useCallback, useEffect, useRef, useState } from 'react';
import { formatClock, type HighlightSummary, type Rect } from '@uitkijk/shared';

/** At most this many highlights at once, in a column beside the cameras (landscape) or a row below them (portrait). */
export const MAX_HIGHLIGHTS = 5;
/** The column never takes more than this share of the screen width, so the cameras stay the main thing. */
const MAX_COLUMN_SHARE = 0.25;
/** In a portrait row, a highlight tile is at least this wide (px). */
const MIN_ROW_TILE_W = 150;

/** How many highlights fit beside or below the cameras. */
export function highlightCapacity(width: number, height: number, gap: number, max = MAX_HIGHLIGHTS): number {
  if (width >= height) return max;
  return Math.max(1, Math.min(max, Math.floor((width - gap) / (MIN_ROW_TILE_W + gap))));
}

/**
 * Splits the screen into an area for the live cameras and a strip with up to `capacity` 16:9 highlight tiles:
 * a column on the right (landscape) or a row at the bottom (portrait). Tile size depends on the capacity only,
 * so tiles do not jump when highlights come and go; `shown` tiles are centred in the strip.
 */
export function highlightStrip(
  width: number,
  height: number,
  gap: number,
  shown: number,
  capacity = highlightCapacity(width, height, gap),
): { cameras: { width: number; height: number }; highlights: Rect[] } {
  const n = Math.max(0, Math.min(shown, capacity));
  if (width >= height) {
    let h = Math.floor((height - (capacity + 1) * gap) / capacity);
    let w = Math.round((h * 16) / 9);
    if (w + gap > width * MAX_COLUMN_SHARE) {
      w = Math.floor(width * MAX_COLUMN_SHARE) - gap;
      h = Math.round((w * 9) / 16);
    }
    const stripW = w + gap;
    const y0 = Math.round((height - (n * h + (n - 1) * gap)) / 2);
    return {
      cameras: { width: width - stripW, height },
      highlights: Array.from({ length: n }, (_, i) => ({ x: width - stripW, y: y0 + i * (h + gap), w, h })),
    };
  }
  const w = Math.floor((width - (capacity + 1) * gap) / capacity);
  const h = Math.round((w * 9) / 16);
  const stripH = h + gap;
  const x0 = Math.round((width - (n * w + (n - 1) * gap)) / 2);
  return {
    cameras: { width, height: height - stripH },
    highlights: Array.from({ length: n }, (_, i) => ({ x: x0 + i * (w + gap), y: height - stripH, w, h })),
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
/** Until the server says otherwise: play a highlight again after this many minutes. */
const DEFAULT_REPLAY_MINUTES = 10;
const TICK_MS = 5_000;

interface Slot {
  highlight: HighlightSummary;
  /** Identifies the tile instance; changes only when the tile gets another highlight. */
  play: number;
  /** Counts plays of the same highlight on this tile; a new round replays the clip in place. */
  round: number;
  /** Date.now() when the current round started. */
  startedAt: number;
}

/**
 * The highlights to show now: one entry per tile (`slots` tiles), null for an empty tile.
 *
 * - Polls the rotation (the best 0–15 of the last 24 h) and the replay interval every minute.
 * - A tile plays its clip once and then stops at the most interesting moment (the AI still). Every `replayMinutes` (set in the admin page,
 *   default 10) it plays again: the highlight that has been off screen longest, or the same one when all
 *   others are on screen.
 * - A highlight that arrives while all tiles are in use takes over the tile that started longest ago, at once.
 * - While `paused` (active alert) nothing is shown; afterwards the tiles fill again and play.
 * - A highlight that fails to play is skipped for ten minutes when another one can take its tile; otherwise its
 *   still stays visible.
 */
export function useHighlightRotation(
  paused: boolean,
  slots = 1,
  url = '/api/highlights/rotation',
  settingsUrl = '/api/highlights/settings',
) {
  const [list, setList] = useState<HighlightSummary[]>([]);
  const [replayMs, setReplayMs] = useState(DEFAULT_REPLAY_MINUTES * 60_000);
  const [shown, setShown] = useState<(Slot | null)[]>([]);
  const queue = useRef<string[]>([]);
  const seen = useRef(new Set<string>());
  const arrived = useRef<string[]>([]);
  const failedUntil = useRef(new Map<string, number>());
  const plays = useRef(0);

  useEffect(() => {
    let disposed = false;
    const load = () => {
      fetch(url)
        .then((r) => (r.ok ? (r.json() as Promise<HighlightSummary[]>) : []))
        .then((items) => !disposed && setList(items), () => {});
      fetch(settingsUrl)
        .then((r) => (r.ok ? (r.json() as Promise<{ replayMinutes?: number }>) : {}))
        .then((s: { replayMinutes?: number }) => {
          if (!disposed && typeof s.replayMinutes === 'number' && s.replayMinutes > 0) setReplayMs(s.replayMinutes * 60_000);
        }, () => {});
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [url, settingsUrl]);

  // Keep the queue in sync with the list: new highlights first, removed ones dropped.
  useEffect(() => {
    const ids = list.map((h) => h.id);
    const first = seen.current.size === 0;
    const fresh = ids.filter((id) => !seen.current.has(id));
    for (const id of fresh) seen.current.add(id);
    // Highlights that arrive later (not the first load) take over a tile at once.
    if (!first) arrived.current = [...arrived.current, ...fresh];
    queue.current = [...fresh, ...queue.current.filter((id) => ids.includes(id) && !fresh.includes(id))];
  }, [list]);

  /** The next highlight for tile `index`, given what the other tiles show; may be the tile's own. */
  const pick = useCallback(
    (current: (Slot | null)[], index: number): HighlightSummary | null => {
      const now = Date.now();
      const elsewhere = new Set(current.flatMap((s, i) => (s && i !== index ? [s.highlight.id] : [])));
      const free = list.filter((h) => (failedUntil.current.get(h.id) ?? 0) <= now && !elsewhere.has(h.id));
      if (!free.length) return null;
      const ids = free.map((h) => h.id);
      const own = current[index]?.highlight.id;
      // The highlight leaving this tile goes to the back, so the one off screen longest comes first.
      if (own) queue.current = [...queue.current.filter((q) => q !== own), own];
      // Do not repeat the same clip on this tile when there is a choice.
      const wanted = (id: string) => ids.includes(id) && (id !== own || ids.length === 1);
      if (!queue.current.some(wanted)) queue.current = [...queue.current, ...list.map((h) => h.id).filter((id) => !queue.current.includes(id))];
      if (!queue.current.some(wanted)) queue.current = [...queue.current, ...ids];
      const id = queue.current.find(wanted)!;
      queue.current = [...queue.current.filter((q) => q !== id), id];
      return free.find((h) => h.id === id)!;
    },
    [list],
  );

  const place = (highlight: HighlightSummary): Slot => ({ highlight, play: ++plays.current, round: 0, startedAt: Date.now() });

  /** Tile `index` plays again: another highlight, or the same one in place. */
  const advance = useCallback(
    (cur: (Slot | null)[], index: number): (Slot | null)[] => {
      const s = cur[index];
      if (!s) return cur;
      const picked = pick(cur, index);
      const out = [...cur];
      out[index] =
        !picked || picked.id === s.highlight.id ? { ...s, round: s.round + 1, startedAt: Date.now() } : place(picked);
      return out;
    },
    [pick],
  );

  // Fill empty tiles, drop highlights that left the rotation, and give newly arrived highlights a tile.
  useEffect(() => {
    if (paused) {
      setShown([]);
      return;
    }
    setShown((cur) => {
      const ids = new Set(list.map((h) => h.id));
      const out = Array.from({ length: slots }, (_, i) => {
        const s = cur[i] ?? null;
        return s && ids.has(s.highlight.id) ? s : null;
      });
      for (let i = 0; i < out.length; i++) if (!out[i]) out[i] = (() => {
        const h = pick(out, i);
        return h ? place(h) : null;
      })();
      for (const id of arrived.current.splice(0)) {
        const h = list.find((x) => x.id === id);
        if (!h || out.some((s) => s?.highlight.id === id) || !out.length) continue;
        let oldest = 0;
        out.forEach((s, i) => {
          if (s && s.startedAt < (out[oldest]?.startedAt ?? Infinity)) oldest = i;
        });
        queue.current = [...queue.current.filter((q) => q !== id), id];
        out[oldest] = place(h);
      }
      return out.length === cur.length && out.every((s, i) => s === cur[i]) ? cur : out;
    });
  }, [paused, list, slots, pick]);

  // Every few seconds: tiles whose interval has passed play again.
  useEffect(() => {
    if (paused) return;
    const timer = setInterval(
      () =>
        setShown((cur) => {
          let out = cur;
          for (let i = 0; i < out.length; i++) if (out[i] && Date.now() - out[i]!.startedAt >= replayMs) out = advance(out, i);
          return out;
        }),
      TICK_MS,
    );
    return () => clearInterval(timer);
  }, [paused, replayMs, advance]);

  /** Plays tile `index` again now (also used by tests). */
  const next = useCallback((index: number) => setShown((cur) => advance(cur, index)), [advance]);

  /** Tile `index` could not play its clip: skip it for a while if another highlight can take over; else keep it (still image). */
  const fail = useCallback(
    (index: number) =>
      setShown((cur) => {
        const s = cur[index];
        if (!s) return cur;
        failedUntil.current.set(s.highlight.id, Date.now() + FAILED_SKIP_MS);
        const picked = pick(cur, index);
        if (!picked || picked.id === s.highlight.id) return cur;
        const out = [...cur];
        out[index] = place(picked);
        return out;
      }),
    [pick],
  );

  const tiles = paused ? [] : shown;
  return {
    tiles: tiles.map((s) => (s ? { highlight: s.highlight, playKey: `${s.highlight.id}:${s.play}`, round: s.round } : null)),
    next,
    fail,
  };
}

interface TileProps {
  highlight: HighlightSummary;
  rect: Rect;
  cameraName: string;
  /** A higher round plays the clip again from the start, in place. */
  round?: number;
  onFail: () => void;
}

/**
 * Shows one highlight: its still right away, then the clip once, muted, with time and description. After the
 * clip it stops at the most interesting moment (the AI still, since 0.25.0; before, the last frame stayed);
 * a new `round` plays it again in place (no reload).
 */
export function HighlightTile({ highlight, rect, cameraName, round = 0, onFail }: TileProps) {
  const [playing, setPlaying] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const endedRound = useRef(-1);
  const failRef = useRef(onFail);
  failRef.current = onFail;

  useEffect(() => {
    const v = video.current;
    if (round === 0 || !v) return;
    v.currentTime = 0;
    void v.play()?.catch(() => {});
  }, [round]);

  // Safety net: a clip that does not start or stalls counts as failed (another highlight may take over).
  // Restarts for every round, not when the dashboard re-renders.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (endedRound.current !== round) failRef.current();
    }, (highlight.clipDuration + 20) * 1000);
    return () => clearTimeout(timer);
  }, [highlight.id, highlight.clipDuration, round]);

  const id = encodeURIComponent(highlight.id);
  return (
    <div className="tile tile--highlight" data-camera="highlight" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      {highlight.hasThumbnail && <img className="tile__video" src={`/api/highlights/${id}/thumb.webp`} alt="" />}
      <video
        key={highlight.id}
        ref={video}
        className={playing ? 'tile__video' : 'tile__video tile__video--hidden'}
        src={`/api/highlights/${id}/clip.mp4`}
        autoPlay
        muted
        playsInline
        onPlaying={() => setPlaying(true)}
        onEnded={(e) => {
          endedRound.current = round;
          e.currentTarget.currentTime = highlight.stillOffset;
        }}
        onError={() => onFail()}
      />
      {!playing && !highlight.hasThumbnail && <div className="tile__placeholder">Highlight laden…</div>}
      <div className="tile__highlight-label">{highlightTime(highlight.startTime)}</div>
      <div className="tile__name">
        {highlight.description}
        <span className="tile__sub">
          {cameraName}
          {highlight.annotation && !highlight.annotation.includes('onbekend') ? ` · ${highlight.annotation}` : ''}
        </span>
      </div>
    </div>
  );
}
