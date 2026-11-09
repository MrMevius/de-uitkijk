import { backoffDelay, type ActiveAlert, type Camera } from '@uitkijk/shared';
import type { StateHub } from '../hub.ts';

/** Subset of a Frigate 0.17 review item (GET /api/review) that De Uitkijk relies on. */
export interface FrigateReviewItem {
  id: string;
  camera: string;
  start_time: number;
  /** null while the review segment is in progress. */
  end_time: number | null;
  severity: 'alert' | 'detection';
  data?: { objects?: string[] };
}

export interface FrigateSourceOptions {
  url: string;
  pollMs: number;
  /** Open review items older than this are ignored as a safeguard against segments that never close. */
  maxAlertAgeMs: number;
  /** Consecutive failed polls before Frigate is reported down and active alerts are released. */
  failuresBeforeDown?: number;
  /** Look-back window for the review query; must exceed the poll interval. */
  windowMs?: number;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

const STATS_EVERY_N_POLLS = 5;
const DISCOVERY_EVERY_N_POLLS = 150;

/**
 * Derives active alerts from Frigate by bounded polling of the review API (MQTT is not required).
 *
 * Verified against Frigate 0.17.2: `GET /api/review?severity=alert&after=T` returns review segments
 * that overlap [T, now], including segments still in progress (`end_time` null). A segment stays open
 * until `review.alerts.cutoff_time` seconds after the last qualifying activity; its final `end_time` is
 * then set retroactively to that last activity. De Uitkijk therefore treats "open" as active and starts
 * its own hold when it observes the close.
 */
export class FrigateSource {
  private readonly hub: StateHub;
  private readonly opts: Required<Omit<FrigateSourceOptions, 'log'>> & { log: (msg: string) => void };
  private readonly byFrigateName: Map<string, Camera>;
  private timer: NodeJS.Timeout | undefined;
  private failures = 0;
  private polls = 0;
  private stopped = false;
  private running = false;
  private wakePending = false;
  private lastWake = 0;

  constructor(hub: StateHub, cameras: Camera[], options: FrigateSourceOptions) {
    this.hub = hub;
    this.opts = {
      failuresBeforeDown: 3,
      windowMs: 120_000,
      fetch: globalThis.fetch,
      log: () => {},
      ...options,
    };
    this.byFrigateName = new Map(cameras.filter((c) => c.frigateCamera).map((c) => [c.frigateCamera!, c]));
  }

  start(): void {
    this.stopped = false;
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /**
   * Polls right away because Frigate pushed a change (websocket, since 0.20.0): at most every 500 ms, and once
   * more straight after a poll that is running now.
   */
  wake(): void {
    if (this.stopped) return;
    if (this.running) {
      this.wakePending = true;
      return;
    }
    if (Date.now() - this.lastWake < 500) return;
    this.lastWake = Date.now();
    clearTimeout(this.timer);
    void this.tick();
  }

  /** One poll cycle. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.wakePending = false;
    let delay = this.opts.pollMs;
    try {
      if (this.polls % DISCOVERY_EVERY_N_POLLS === 0) await this.discover();
      await this.pollAlerts();
      if (this.polls % STATS_EVERY_N_POLLS === 0) await this.pollStats();
      this.polls++;
      this.failures = 0;
      this.hub.setHealth('alerts', { status: 'ok', lastOk: Date.now() });
    } catch (err) {
      this.failures++;
      this.opts.log(`frigate poll failed (${this.failures}): ${(err as Error).message}`);
      if (this.failures >= this.opts.failuresBeforeDown) {
        this.hub.setHealth('alerts', { status: 'down', detail: 'Frigate niet bereikbaar' });
        // Without a source we cannot know whether alerts are still active; release focus via the normal hold.
        this.hub.setActiveAlerts([]);
        for (const camera of this.byFrigateName.values()) this.hub.setAvailability(camera.id, 'unknown');
      }
      delay = Math.max(this.opts.pollMs, backoffDelay(this.failures - 1, { baseMs: this.opts.pollMs, maxMs: 30_000 }));
    }
    this.running = false;
    if (this.wakePending && this.failures === 0) delay = Math.min(delay, 500);
    clearTimeout(this.timer);
    if (!this.stopped) this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async pollAlerts(): Promise<void> {
    const now = Date.now();
    const params = new URLSearchParams({
      severity: 'alert',
      after: String((now - this.opts.windowMs) / 1000),
      cameras: [...this.byFrigateName.keys()].join(','),
      limit: '100',
    });
    const items = (await this.get(`/api/review?${params}`)) as FrigateReviewItem[];
    if (!Array.isArray(items)) throw new Error('unexpected review response');
    this.hub.setActiveAlerts(toActiveAlerts(items, this.byFrigateName, now, this.opts.maxAlertAgeMs));
  }

  private async pollStats(): Promise<void> {
    const stats = (await this.get('/api/stats')) as { cameras?: Record<string, { camera_fps?: number }> };
    for (const [name, camera] of this.byFrigateName) {
      const fps = stats.cameras?.[name]?.camera_fps;
      this.hub.setAvailability(camera.id, fps === undefined ? 'unknown' : fps > 0 ? 'online' : 'offline');
    }
  }

  /** Verifies that every configured Frigate camera exists. Never reads stream URLs or credentials. */
  private async discover(): Promise<void> {
    const config = (await this.get('/api/config')) as { cameras?: Record<string, unknown> };
    const available = new Set(Object.keys(config.cameras ?? {}));
    const missing = [...this.byFrigateName.keys()].filter((name) => !available.has(name));
    const extra = [...available].filter((name) => !this.byFrigateName.has(name));
    if (missing.length) this.opts.log(`configured Frigate cameras not found: ${missing.join(', ')}`);
    if (extra.length) this.opts.log(`Frigate cameras not shown on the dashboard: ${extra.join(', ')}`);
  }

  private async get(path: string): Promise<unknown> {
    const res = await this.opts.fetch(`${this.opts.url}${path}`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`${path.split('?')[0]} returned HTTP ${res.status}`);
    return res.json();
  }
}

/** Maps open Frigate alert review items to active alerts for configured cameras. */
export function toActiveAlerts(
  items: FrigateReviewItem[],
  byFrigateName: Map<string, Camera>,
  now: number,
  maxAlertAgeMs: number,
): ActiveAlert[] {
  return items.flatMap((item) => {
    const camera = byFrigateName.get(item.camera);
    if (!camera || item.severity !== 'alert' || item.end_time !== null) return [];
    if (now - item.start_time * 1000 > maxAlertAgeMs) return [];
    return [{ id: item.id, cameraId: camera.id, labels: item.data?.objects ?? [] }];
  });
}
