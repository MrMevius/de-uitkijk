import type { StateHub } from './hub.ts';

/**
 * Periodically checks that go2rtc answers on its internal API. This only feeds the health indicator;
 * browsers connect to go2rtc directly (through the edge proxy) and never through the backend.
 */
export class StreamingProbe {
  private timer: NodeJS.Timeout | undefined;
  private readonly hub: StateHub;
  private readonly url: string;
  private readonly intervalMs: number;
  private readonly suppressed: () => boolean;
  private readonly fetchFn: typeof fetch;

  constructor(
    hub: StateHub,
    url: string,
    options: { intervalMs?: number; suppressed?: () => boolean; fetch?: typeof fetch } = {},
  ) {
    this.hub = hub;
    this.url = url;
    this.intervalMs = options.intervalMs ?? 15_000;
    this.suppressed = options.suppressed ?? (() => false);
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  start(): void {
    void this.check();
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  async check(): Promise<void> {
    if (!this.suppressed()) {
      try {
        const res = await this.fetchFn(`${this.url}/api`, { signal: AbortSignal.timeout(3_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.hub.setHealth('streaming', { status: 'ok', lastOk: Date.now() });
      } catch {
        this.hub.setHealth('streaming', { status: 'down', detail: 'Streamingdienst niet bereikbaar' });
      }
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.check(), this.intervalMs);
  }
}
