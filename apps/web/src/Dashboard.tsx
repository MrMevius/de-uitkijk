import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { computeLayout, summarizeHealth, type DashboardState, type DisplayProfile, type Rect } from '@uitkijk/shared';
import { CameraTile } from './CameraTile.tsx';
import { StatusBar } from './StatusBar.tsx';
import { highlightCapacity, highlightStrip, HighlightTile, useHighlightRotation } from './highlights.tsx';

interface Props {
  state: DashboardState | null;
  connected: boolean;
  profile: DisplayProfile;
}

function useViewport() {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

/** True after the pointer has not moved for a while: the cursor is hidden on TVs, but not while someone uses a mouse. */
function usePointerIdle(delayMs = 3_000) {
  const [idle, setIdle] = useState(true);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onMove = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), delayMs);
    };
    window.addEventListener('pointermove', onMove);
    return () => {
      window.removeEventListener('pointermove', onMove);
      clearTimeout(timer);
    };
  }, [delayMs]);
  return idle;
}

/** The TV dashboard: no controls, no audio; layout follows alerts automatically. */
export function Dashboard({ state, connected, profile }: Props) {
  const { width, height } = useViewport();
  const pointerIdle = usePointerIdle();
  const cameras = state?.cameras ?? [];
  const cameraIds = useMemo(() => cameras.map((c) => c.id), [cameras]);
  const focusedIds = useMemo(() => state?.focus.map((f) => f.cameraId) ?? [], [state?.focus]);
  const scale = profile.overlayScale * (height / 1080);
  // On a landscape screen the status bar sits in the space around the 16:9 tiles. A portrait screen
  // (phone) has no such space, so reserve a band at the top for it.
  const topBand = height > width ? Math.round(18 * scale * 2.6) : 0;
  // Up to five highlights in a column beside the cameras (fewer in a row on a phone), except while a camera has
  // an alert (then live cameras get all space).
  const capacity = highlightCapacity(width, height - topBand, profile.gapPx);
  const { tiles, fail: failHighlight } = useHighlightRotation(focusedIds.length > 0, capacity);
  const playing = tiles.filter((t) => t !== null).length;
  const { rects, highlightRects } = useMemo(() => {
    const available = height - topBand;
    const strip = playing > 0 ? highlightStrip(width, available, profile.gapPx, playing, capacity) : undefined;
    const layout = computeLayout(cameraIds, focusedIds, {
      width: strip?.cameras.width ?? width,
      height: strip?.cameras.height ?? available,
      gap: profile.gapPx,
      minOtherWidthFraction: profile.minOtherWidthFraction,
    });
    const shift = (r: Rect): Rect => ({ ...r, y: r.y + topBand });
    return {
      rects: Object.fromEntries(Object.entries(layout).map(([id, r]) => [id, shift(r)])),
      highlightRects: strip?.highlights.map(shift) ?? [],
    };
  }, [cameraIds, focusedIds, width, height, topBand, profile, playing, capacity]);
  const health = summarizeHealth(state, connected);

  return (
    <main className={pointerIdle ? 'dashboard dashboard--idle' : 'dashboard'} style={{ '--scale': scale } as CSSProperties}>
      {/* Tiles are always rendered in the shared camera order with stable keys. */}
      {cameras.map((camera) => (
        <CameraTile
          key={camera.id}
          camera={camera}
          rect={rects[camera.id]!}
          streamName={camera.streams[profile.streamQuality]}
          focus={state?.focus.find((f) => f.cameraId === camera.id)}
          showObjectType={profile.showObjectType}
        />
      ))}
      {/* Filled tiles take the centred positions in order; each keeps its key while its clip plays. */}
      {tiles
        .map((t, index) => (t ? { ...t, index } : null))
        .filter((t) => t !== null)
        .map((t, position) => (
          <HighlightTile
            key={t.playKey}
            highlight={t.highlight}
            round={t.round}
            rect={highlightRects[position]!}
            cameraName={cameras.find((c) => c.id === t.highlight.cameraId)?.name ?? ''}
            onFail={() => failHighlight(t.index)}
          />
        ))}
      {!state && <div className="dashboard__empty">Verbinden met De Uitkijk…</div>}
      <StatusBar health={health} />
    </main>
  );
}
