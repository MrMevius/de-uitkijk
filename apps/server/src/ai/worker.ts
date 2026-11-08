import { spawn } from 'node:child_process';
import type { Camera } from '@uitkijk/shared';
import type { HighlightStore, StoredCandidate } from '../highlights/store.ts';
import type { Describer } from './codex.ts';

export interface AiWorkerOptions {
  cameras: Camera[];
  intervalMs?: number;
  /** Upper bound on AI calls per day, to stay well inside the plan's usage limits. */
  dailyCap?: number;
  maxAttempts?: number;
  /** Epoch seconds. */
  now?: () => number;
  log?: (msg: string) => void;
  /** Shown in the status. */
  model?: string;
  /** Household facts for the prompt. */
  facts?: () => string[];
  /** A better still for the AI (full-resolution recording frame); falls back to the stored thumbnail. */
  still?: (c: StoredCandidate) => Promise<Uint8Array | undefined>;
  /** Converts the stored WebP thumbnail to JPEG; override in tests. */
  toJpeg?: (webp: Uint8Array) => Promise<Uint8Array>;
}

export interface AiStatus {
  enabled: true;
  provider: 'codex';
  model: string;
  callsToday: number;
  dailyCap: number;
  lastSuccessAt: number | null;
  lastError: string | null;
  pending: number;
}

/** WebP → JPEG with ffmpeg through pipes (no files). */
export const ffmpegToJpeg = (webp: Uint8Array): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'mjpeg', '-q:v', '3', 'pipe:1']);
    const out: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}`))));
    proc.stdin.end(Buffer.from(webp));
  });

const dayFormat = new Intl.DateTimeFormat('nl-NL', { dateStyle: 'short', timeZone: 'Europe/Amsterdam' });
const timeFormat = new Intl.DateTimeFormat('nl-NL', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Amsterdam',
});

/**
 * Adds AI descriptions to highlights, one at a time, after rule-based selection (AI-1). Failures are
 * logged and retried a few times; they never affect live video, alerts or rule-based highlights (AI-7).
 */
export class AiWorker {
  private readonly store: HighlightStore;
  private readonly describe: Describer;
  private readonly opts: Required<Omit<AiWorkerOptions, 'cameras'>>;
  private readonly names: Map<string, string>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private day = '';
  private callsToday = 0;
  private lastSuccessAt: number | null = null;
  private lastError: string | null = null;

  constructor(store: HighlightStore, describe: Describer, options: AiWorkerOptions) {
    this.store = store;
    this.describe = describe;
    this.names = new Map(options.cameras.map((c) => [c.id, c.name]));
    this.opts = {
      intervalMs: 120_000,
      dailyCap: 60,
      maxAttempts: 3,
      now: () => Date.now() / 1000,
      log: () => {},
      model: 'standaard',
      facts: () => [],
      still: async () => undefined,
      toJpeg: ffmpegToJpeg,
      ...options,
    };
  }

  start(): void {
    const loop = async () => {
      await this.runOnce().catch((err: Error) => this.opts.log(`ai: ${err.message}`));
      if (this.running) this.timer = setTimeout(loop, this.opts.intervalMs);
    };
    this.running = true;
    this.timer = setTimeout(loop, 10_000);
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
  }

  status(): AiStatus {
    return {
      enabled: true,
      provider: 'codex',
      model: this.opts.model,
      callsToday: this.day === dayFormat.format(this.opts.now() * 1000) ? this.callsToday : 0,
      dailyCap: this.opts.dailyCap,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      pending: this.store.aiPending(this.opts.now() - 86400, this.opts.maxAttempts).length,
    };
  }

  /** Describes at most one highlight. Returns true when one was attempted. */
  async runOnce(): Promise<boolean> {
    const now = this.opts.now();
    const today = dayFormat.format(now * 1000);
    if (today !== this.day) {
      this.day = today;
      this.callsToday = 0;
    }
    if (this.callsToday >= this.opts.dailyCap) return false;
    const next = this.store.aiPending(now - 86400, this.opts.maxAttempts)[0];
    if (!next) return false;
    const webp = this.store.thumbnail(next.id);
    if (!webp) return false;
    this.callsToday++;
    try {
      const still = await this.opts.still(next).catch(() => undefined);
      const verdict = await this.describe(still ?? (await this.opts.toJpeg(webp)), {
        cameraName: this.names.get(next.camera) ?? next.camera,
        time: timeFormat.format(next.startTime * 1000),
        objects: next.labels.map((l) => l.replace(/-verified$/, '')),
        recognized: next.subLabels,
        facts: this.opts.facts(),
      });
      this.store.setAiResult(next.id, verdict.description, verdict.realEvent, now, verdict.vehicle ?? null, verdict.vehicleKnown ?? false);
      this.lastSuccessAt = now;
      this.lastError = null;
    } catch (err) {
      this.lastError = (err as Error).message.slice(0, 300);
      this.store.setAiFailure(next.id, this.opts.maxAttempts, now);
      this.opts.log(`ai: highlight ${next.id}: ${this.lastError}`);
    }
    return true;
  }
}
