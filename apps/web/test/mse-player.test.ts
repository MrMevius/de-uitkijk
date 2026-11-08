import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MsePlayer, type PlayerDeps, type PlayerStatus } from '../src/player/mse-player.ts';

class FakeMediaSource extends EventTarget {
  static supported = ['avc1.640029', 'hvc1.1.6.L153.B0'];
  static isTypeSupported(type: string) {
    return FakeMediaSource.supported.some((c) => type.includes(c));
  }
  addSourceBuffer() {
    return Object.assign(new EventTarget(), { updating: false, mode: '', buffered: { length: 0 }, appendBuffer() {} });
  }
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  binaryType = '';
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
}

function setup() {
  const video = document.createElement('video');
  video.load = () => {};
  const statuses: PlayerStatus[] = [];
  const deps: Partial<PlayerDeps> = {
    MediaSource: FakeMediaSource as unknown as typeof MediaSource,
    WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    createObjectURL: () => 'blob:fake',
    revokeObjectURL: () => {},
    random: () => 0.5,
  };
  const player = new MsePlayer(video, 'ws://edge/stream/ws?src=oprit_sub', (s) => statuses.push(s), deps);
  return { video, statuses, player };
}

/** MediaSource instances created by the player, in order. */
let mediaSources: FakeMediaSource[] = [];
const OriginalFake = FakeMediaSource;

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  mediaSources = [];
  FakeMediaSource.supported = ['avc1.640029', 'hvc1.1.6.L153.B0'];
});
afterEach(() => vi.useRealTimers());

function trackMediaSources(deps: { MediaSource?: unknown }) {
  deps.MediaSource = class extends OriginalFake {
    constructor() {
      super();
      mediaSources.push(this);
    }
  };
}

describe('MsePlayer', () => {
  it('offers only codecs the browser supports, video only', () => {
    const { player } = setup();
    expect(player.supportedCodecs()).toEqual(['avc1.640029', 'hvc1.1.6.L153.B0']);
  });

  it('reports unsupported without retrying when MSE cannot play anything', () => {
    FakeMediaSource.supported = [];
    const { player, statuses } = setup();
    player.start();
    vi.advanceTimersByTime(120_000);
    expect(statuses).toEqual(['unsupported']);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('reconnects with bounded exponential backoff and stops cleanly', () => {
    const video = document.createElement('video');
    video.load = () => {};
    const statuses: PlayerStatus[] = [];
    const deps: Partial<PlayerDeps> = {
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
      createObjectURL: () => 'blob:fake',
      revokeObjectURL: () => {},
      random: () => 0.5,
    };
    trackMediaSources(deps);
    const player = new MsePlayer(video, 'ws://edge/stream/ws?src=oprit_sub', (s) => statuses.push(s), deps);
    player.start();

    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      // Open the latest MediaSource, then let the socket drop immediately.
      mediaSources.at(-1)!.dispatchEvent(new Event('sourceopen'));
      const ws = FakeWebSocket.instances.at(-1)!;
      ws.onopen?.();
      expect(JSON.parse(ws.sent[0]!)).toEqual({ type: 'mse', value: 'avc1.640029,hvc1.1.6.L153.B0' });
      ws.onclose?.();
      const before = mediaSources.length;
      let waited = 0;
      while (mediaSources.length === before) {
        vi.advanceTimersByTime(100);
        waited += 100;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    expect(FakeWebSocket.instances).toHaveLength(8);
    expect(statuses.filter((s) => s === 'retrying')).toHaveLength(8);
    player.stop();
    expect(video.getAttribute('src')).toBeNull();
    vi.advanceTimersByTime(10 * 60_000);
    expect(mediaSources).toHaveLength(9);
    expect(FakeWebSocket.instances).toHaveLength(8);
  });

  it('treats a stream that never produces frames as failed and clears the video', () => {
    const video = document.createElement('video');
    video.load = () => {};
    const statuses: PlayerStatus[] = [];
    const deps: Partial<PlayerDeps> = {
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
      createObjectURL: () => 'blob:fake',
      revokeObjectURL: () => {},
      random: () => 0.5,
    };
    trackMediaSources(deps);
    const player = new MsePlayer(video, 'ws://x', (s) => statuses.push(s), deps, { startTimeoutMs: 5_000 });
    player.start();
    expect(video.getAttribute('src')).toBe('blob:fake');
    mediaSources[0]!.dispatchEvent(new Event('sourceopen'));
    vi.advanceTimersByTime(6_000);
    expect(statuses).toEqual(['connecting', 'retrying']);
    expect(FakeWebSocket.instances[0]!.closed).toBe(true);
    expect(video.getAttribute('src')).toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(statuses.at(-1)).toBe('connecting');
    player.stop();
  });

  it('fails over on a go2rtc error message such as a codec mismatch', () => {
    const video = document.createElement('video');
    video.load = () => {};
    const statuses: [PlayerStatus, string | undefined][] = [];
    const deps: Partial<PlayerDeps> = {
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
      createObjectURL: () => 'blob:fake',
      revokeObjectURL: () => {},
      random: () => 0.5,
    };
    trackMediaSources(deps);
    const player = new MsePlayer(video, 'ws://x', (s, d) => statuses.push([s, d]), deps);
    player.start();
    mediaSources[0]!.dispatchEvent(new Event('sourceopen'));
    FakeWebSocket.instances[0]!.onmessage?.({
      data: JSON.stringify({ type: 'error', value: 'mse: streams: codecs not matched: video:H265 => video:H264' }),
    });
    expect(statuses.at(-1)).toEqual(['retrying', 'mse: streams: codecs not matched: video:H265 => video:H264']);
    player.stop();
  });
});
