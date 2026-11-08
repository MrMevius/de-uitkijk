import { backoffDelay } from '@uitkijk/shared';

export type PlayerStatus = 'connecting' | 'live' | 'retrying' | 'unsupported';

export interface PlayerDeps {
  MediaSource?: typeof MediaSource;
  /** True for Safari's ManagedMediaSource (iPhone), which is attached via srcObject. */
  managed?: boolean;
  WebSocket: typeof WebSocket;
  createObjectURL: (ms: MediaSource) => string;
  revokeObjectURL: (url: string) => void;
  random: () => number;
}

export interface PlayerOptions {
  /** No first frame within this time counts as a failure. */
  startTimeoutMs?: number;
  /** No playback progress for this long while live counts as a stall. */
  stallTimeoutMs?: number;
  /** Jump to the live edge when more than this many seconds are buffered ahead. */
  maxLatencySec?: number;
  /** Reset the backoff after this much uninterrupted live playback. */
  stableAfterMs?: number;
}

/** Codecs offered to go2rtc. Video only: the dashboard never plays audio. */
const CANDIDATE_CODECS = ['avc1.640029', 'avc1.64002A', 'avc1.640033', 'hvc1.1.6.L153.B0', 'hev1.1.6.L153.B0'];

// iPhone Safari (iOS 17.1+) has no MediaSource, only ManagedMediaSource.
const managedMediaSource = (globalThis as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource;

const defaultDeps = (): PlayerDeps => ({
  MediaSource: globalThis.MediaSource ?? managedMediaSource,
  managed: !globalThis.MediaSource && !!managedMediaSource,
  WebSocket: globalThis.WebSocket,
  createObjectURL: (ms) => URL.createObjectURL(ms),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  random: Math.random,
});

/**
 * Minimal go2rtc MSE client (WebSocket `/api/ws?src=` protocol): offers the codecs this browser can
 * decode, receives fragmented MP4 and appends it to a MediaSource.
 *
 * - Failures tear down the WebSocket and MediaSource and clear the video element, so a frozen frame is
 *   never shown as live, then reconnect with bounded exponential backoff.
 * - The video element is owned by the caller and survives reconnects and layout changes.
 */
export class MsePlayer {
  private readonly video: HTMLVideoElement;
  private readonly url: string;
  private readonly onStatus: (status: PlayerStatus, detail?: string) => void;
  private readonly deps: PlayerDeps;
  private readonly opts: Required<PlayerOptions>;
  private ws: WebSocket | undefined;
  private ms: MediaSource | undefined;
  private sb: SourceBuffer | undefined;
  private objectUrl: string | undefined;
  private attached = false;
  private queue: ArrayBuffer[] = [];
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private lastTime = -1;
  private lastProgressAt = 0;
  private liveSince = 0;
  private connectedAt = 0;
  private status: PlayerStatus | undefined;
  private stopped = false;

  constructor(
    video: HTMLVideoElement,
    url: string,
    onStatus: (status: PlayerStatus, detail?: string) => void,
    deps: Partial<PlayerDeps> = {},
    options: PlayerOptions = {},
  ) {
    this.video = video;
    this.url = url;
    this.onStatus = onStatus;
    this.deps = { ...defaultDeps(), ...deps };
    this.opts = { startTimeoutMs: 15_000, stallTimeoutMs: 6_000, maxLatencySec: 2, stableAfterMs: 30_000, ...options };
  }

  /** Codecs this browser can decode through MSE, in go2rtc's comma-separated format. */
  supportedCodecs(): string[] {
    const MS = this.deps.MediaSource;
    if (!MS) return [];
    return CANDIDATE_CODECS.filter((c) => MS.isTypeSupported(`video/mp4; codecs="${c}"`));
  }

  start(): void {
    this.stopped = false;
    this.video.muted = true;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.teardown();
  }

  private setStatus(status: PlayerStatus, detail?: string): void {
    if (status === this.status && status !== 'retrying') return;
    this.status = status;
    this.onStatus(status, detail);
  }

  private connect(): void {
    const MS = this.deps.MediaSource;
    const codecs = this.supportedCodecs();
    if (!MS || codecs.length === 0) {
      this.setStatus('unsupported', 'Browser ondersteunt MSE-video niet');
      return;
    }
    this.setStatus('connecting');
    const ms = new MS();
    this.ms = ms;
    if (this.deps.managed) {
      // ManagedMediaSource only opens with remote playback disabled.
      this.video.disableRemotePlayback = true;
      this.video.srcObject = ms as unknown as MediaProvider;
    } else {
      this.objectUrl = this.deps.createObjectURL(ms);
      this.video.src = this.objectUrl;
    }
    this.attached = true;
    this.connectedAt = Date.now();
    this.lastTime = -1;
    this.lastProgressAt = Date.now();
    this.watchdog = setInterval(() => this.check(), 1_000);

    ms.addEventListener(
      'sourceopen',
      () => {
        if (this.ms !== ms) return;
        const ws = new this.deps.WebSocket(this.url);
        this.ws = ws;
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => ws.send(JSON.stringify({ type: 'mse', value: codecs.join(',') }));
        ws.onmessage = (ev) => this.onMessage(ev.data);
        ws.onclose = () => this.fail('Verbinding met streamingdienst verbroken');
      },
      { once: true },
    );
  }

  private onMessage(data: unknown): void {
    if (typeof data === 'string') {
      let msg: { type?: string; value?: string };
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg.type === 'mse' && msg.value && this.ms) {
        try {
          const sb = this.ms.addSourceBuffer(msg.value);
          sb.mode = 'segments';
          sb.addEventListener('updateend', () => this.flush());
          this.sb = sb;
        } catch {
          this.fail(`Codec niet ondersteund: ${msg.value}`);
        }
      } else if (msg.type === 'error') {
        this.fail(msg.value ?? 'Streamfout');
      }
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.queue.push(data);
      this.flush();
    }
  }

  private flush(): void {
    const sb = this.sb;
    if (!sb || sb.updating) return;
    const next = this.queue.shift();
    try {
      if (next) {
        sb.appendBuffer(next);
        return;
      }
      // Trim old media so a 24/7 kiosk never hits the SourceBuffer quota.
      const b = sb.buffered;
      if (b.length > 0 && this.video.currentTime - b.start(0) > 30) sb.remove(b.start(0), this.video.currentTime - 10);
    } catch (err) {
      this.fail(`Buffer: ${(err as Error).message}`);
    }
  }

  private check(): void {
    const now = Date.now();
    const v = this.video;
    const b = v.buffered;
    if (b.length > 0) {
      const end = b.end(b.length - 1);
      if (end - v.currentTime > this.opts.maxLatencySec) v.currentTime = Math.max(b.start(0), end - 0.3);
      if (v.paused) void v.play().catch(() => {});
    }
    if (v.currentTime !== this.lastTime) {
      this.lastTime = v.currentTime;
      this.lastProgressAt = now;
      if (v.currentTime > 0 && this.status !== 'live') {
        this.liveSince = now;
        this.setStatus('live');
      }
    }
    if (this.status === 'live') {
      if (now - this.liveSince > this.opts.stableAfterMs) this.attempt = 0;
      if (now - this.lastProgressAt > this.opts.stallTimeoutMs) this.fail('Beeld bevroren');
    } else if (now - this.connectedAt > this.opts.startTimeoutMs) {
      this.fail('Geen beeld ontvangen');
    }
  }

  private fail(reason: string): void {
    if (this.stopped || !this.ms) return;
    this.teardown();
    const delay = backoffDelay(this.attempt++, { baseMs: 1_000, maxMs: 30_000 }, this.deps.random);
    this.setStatus('retrying', reason);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private teardown(): void {
    clearInterval(this.watchdog);
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.close();
    }
    this.sb = undefined;
    this.queue = [];
    this.ms = undefined;
    if (this.objectUrl) {
      this.deps.revokeObjectURL(this.objectUrl);
      this.objectUrl = undefined;
    }
    if (this.attached) {
      this.attached = false;
      // Drop the last decoded frame: an unavailable stream must not look live.
      if (this.video.srcObject) this.video.srcObject = null;
      this.video.removeAttribute('src');
      this.video.load();
    }
  }
}
