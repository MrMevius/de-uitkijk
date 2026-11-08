import type { Camera } from '@uitkijk/shared';

export interface CameraVideoStatus {
  id: string;
  video: 'ok' | 'failed' | 'unknown';
  checkedAt: number | null;
  detail?: string;
}

/**
 * Checks every few minutes that go2rtc can deliver a picture from each camera's substream (one JPEG frame
 * through go2rtc's internal API). While someone is watching, go2rtc reuses the running camera session;
 * otherwise it opens one briefly. For monitoring only: the dashboard never depends on it.
 */
export class CameraVideoProbe {
  private readonly cameras: Camera[];
  private readonly url: string;
  private readonly intervalMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly status = new Map<string, CameraVideoStatus>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;

  constructor(cameras: Camera[], go2rtcUrl: string, options: { intervalMs?: number; fetch?: typeof fetch } = {}) {
    this.cameras = cameras;
    this.url = go2rtcUrl.replace(/\/$/, '');
    this.intervalMs = options.intervalMs ?? 5 * 60_000;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    for (const c of cameras) this.status.set(c.id, { id: c.id, video: 'unknown', checkedAt: null });
  }

  start(): void {
    this.running = true;
    const loop = async () => {
      await this.checkAll();
      if (this.running) this.timer = setTimeout(loop, this.intervalMs);
    };
    this.timer = setTimeout(loop, 30_000);
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
  }

  snapshot(): CameraVideoStatus[] {
    return this.cameras.map((c) => this.status.get(c.id)!);
  }

  async checkAll(): Promise<void> {
    // One camera at a time: never more than one extra camera session at once.
    for (const c of this.cameras) {
      const now = Date.now() / 1000;
      try {
        const res = await this.fetchFn(`${this.url}/api/frame.jpeg?src=${encodeURIComponent(c.streams.sub)}`, {
          signal: AbortSignal.timeout(20_000),
        });
        const body = new Uint8Array(await res.arrayBuffer());
        if (!res.ok || body.length < 1000 || body[0] !== 0xff || body[1] !== 0xd8) throw new Error(`HTTP ${res.status}, ${body.length} bytes`);
        this.status.set(c.id, { id: c.id, video: 'ok', checkedAt: now });
      } catch (err) {
        this.status.set(c.id, { id: c.id, video: 'failed', checkedAt: now, detail: (err as Error).message.slice(0, 120) });
      }
    }
  }
}
