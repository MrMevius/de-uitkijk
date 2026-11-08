import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { computeLayout, summarizeHealth, type DashboardState, type DisplayProfile } from '@uitkijk/shared';
import { CameraTile } from './CameraTile.tsx';
import { StatusBar } from './StatusBar.tsx';

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
  const rects = useMemo(
    () =>
      computeLayout(cameraIds, focusedIds, {
        width,
        height,
        gap: profile.gapPx,
        minOtherWidthFraction: profile.minOtherWidthFraction,
      }),
    [cameraIds, focusedIds, width, height, profile],
  );
  const health = summarizeHealth(state, connected);
  const scale = profile.overlayScale * (height / 1080);

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
      {!state && <div className="dashboard__empty">Verbinden met De Uitkijk…</div>}
      <StatusBar health={health} />
    </main>
  );
}
