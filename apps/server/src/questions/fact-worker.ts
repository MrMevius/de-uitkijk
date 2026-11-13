import type { Camera } from '@uitkijk/shared';
import type { FactWriter } from '../ai/fact-writer.ts';
import type { FactStore } from '../ai/facts.ts';
import type { HighlightStore, StoredCandidate } from '../highlights/store.ts';
import type { QuestionStore } from './store.ts';

export interface FactWorkerOptions {
  cameras: Camera[];
  /** Full-resolution still for the highlight (as for descriptions); falls back to the stored thumbnail. */
  still?: (c: StoredCandidate) => Promise<Uint8Array | undefined>;
  toJpeg: (webp: Uint8Array) => Promise<Uint8Array>;
  intervalMs?: number;
  dailyCap?: number;
  maxAttempts?: number;
  now?: () => number;
  log?: (msg: string) => void;
  /** Fact calls logged today (the AI log), so the cap survives a restart (since 0.31.0). */
  callsToday?: () => number;
}

const amsterdamDay = (epochS: number) => new Date(epochS * 1000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });

/**
 * Turns answers about people into facts: the AI looks at the highlight's still together with the answer
 * and writes one fact based on visible, stable features (vehicle, logo, company van), or nothing.
 * One at a time, a few per day; failures are retried a few times and never affect anything else.
 */
export class FactWorker {
  private readonly questions: QuestionStore;
  private readonly highlights: HighlightStore;
  private readonly facts: FactStore;
  private readonly write: FactWriter;
  private readonly opts: Required<Omit<FactWorkerOptions, 'cameras'>>;
  private readonly names: Map<string, string>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private day = '';
  private calls = 0;

  constructor(questions: QuestionStore, highlights: HighlightStore, facts: FactStore, write: FactWriter, options: FactWorkerOptions) {
    this.questions = questions;
    this.highlights = highlights;
    this.facts = facts;
    this.write = write;
    this.names = new Map(options.cameras.map((c) => [c.id, c.name]));
    this.opts = {
      still: async () => undefined,
      intervalMs: 120_000,
      dailyCap: 30,
      maxAttempts: 3,
      now: () => Date.now() / 1000,
      log: () => {},
      callsToday: () => 0,
      ...options,
    };
  }

  start(): void {
    const loop = async () => {
      await this.runOnce().catch((err: Error) => this.opts.log(`facts: ${err.message}`));
      this.timer = setTimeout(loop, this.opts.intervalMs);
    };
    this.timer = setTimeout(loop, 30_000);
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  /** Handles at most one answered question. Returns true when one was attempted. */
  async runOnce(): Promise<boolean> {
    const today = amsterdamDay(this.opts.now());
    if (today !== this.day) {
      this.day = today;
      this.calls = this.opts.callsToday();
    }
    if (this.calls >= this.opts.dailyCap) return false;
    const q = this.questions.factPending(this.opts.maxAttempts)[0];
    if (!q) return false;
    const h = q.highlightId ? this.highlights.get(q.highlightId) : undefined;
    const thumb = h && this.highlights.thumbnail(h.id);
    if (!h || !thumb) {
      this.questions.setFact(q.id, 'none');
      return false;
    }
    this.calls++;
    try {
      const still = await this.opts.still(h).catch(() => undefined);
      const fact = await this.write(still ?? (await this.opts.toJpeg(thumb)), {
        question: `${q.title} (${q.body})`,
        answer: q.answer ?? '',
        cameraName: this.names.get(h.camera) ?? h.camera,
      });
      if (fact) {
        const stored = this.facts.add(fact, `AI (vraag ${q.id})`, this.opts.now());
        this.questions.setFact(q.id, 'done', stored.text);
      } else {
        this.questions.setFact(q.id, 'none');
      }
    } catch (err) {
      this.questions.factFailure(q.id, this.opts.maxAttempts);
      this.opts.log(`facts: question ${q.id}: ${(err as Error).message}`);
    }
    return true;
  }
}
