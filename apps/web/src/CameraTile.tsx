import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { dutchObjectLabel, type Camera, type FocusEntry, type Rect } from '@uitkijk/shared';
import { MsePlayer, type PlayerStatus } from './player/mse-player.ts';

interface Props {
  camera: Camera;
  rect: Rect;
  /** Position in the camera order; staggers the tiles' movement when the layout changes. */
  order: number;
  streamName: string;
  focus: FocusEntry | undefined;
  showObjectType: boolean;
}

export function streamUrl(streamName: string): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/stream/ws?src=${encodeURIComponent(streamName)}`;
}

/**
 * One camera tile. Position and size come from props and animate via CSS (focus transition: the focused tile
 * glides on top with a glow, the others follow staggered and dim); the player lifecycle depends only on the
 * stream name, so moving or resizing a tile never recreates its video connection.
 */
export const CameraTile = memo(function CameraTile({ camera, rect, order, streamName, focus, showObjectType }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<PlayerStatus>('connecting');
  // After a failure, reconnect attempts keep showing "Geen beeld" until the stream is live again.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const player = new MsePlayer(video, streamUrl(streamName), (s) => {
      setStatus(s);
      if (s === 'retrying') setFailed(true);
      if (s === 'live') setFailed(false);
    });
    player.start();
    return () => player.stop();
  }, [streamName]);

  const live = status === 'live';
  const offline = camera.availability === 'offline';
  const message = live
    ? null
    : offline
      ? 'Camera offline'
      : status === 'unsupported'
        ? 'Video niet ondersteund'
        : failed || status === 'retrying'
          ? 'Geen beeld'
          : 'Verbinden…';

  return (
    <div
      className={`tile${focus ? ` tile--${focus.reason}` : ''}`}
      data-camera={camera.id}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, '--order': order } as CSSProperties}
    >
      <video ref={videoRef} className={live ? 'tile__video' : 'tile__video tile__video--hidden'} autoPlay muted playsInline />
      {message && <div className="tile__placeholder">{message}</div>}
      {focus && (
        <div className="tile__alert">
          <span className="tile__alert-dot" />
          {showObjectType && focus.labels.length > 0 && focus.labels.map(dutchObjectLabel).join(', ')}
        </div>
      )}
      <div className="tile__name">{camera.name}</div>
    </div>
  );
});
