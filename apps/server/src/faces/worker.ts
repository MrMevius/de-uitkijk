import type { HighlightStore } from '../highlights/store.ts';
import type { QuestionStore } from '../questions/store.ts';
import { matchFaceName, type FaceLibrary } from './library.ts';

export interface FaceWorkerOptions {
  intervalMs?: number;
  maxAttempts?: number;
  /** At most this many face crops per answer go into the library (best guesses first). */
  maxPerAnswer?: number;
  log?: (msg: string) => void;
}

/**
 * Teaches Frigate's face recognition from answers about people (operator decision 2026-11-09): the unrecognised
 * face crops Frigate kept for the highlight's detections are stored under the name the administrator gave.
 * Frigate then recognises that person in later alerts, which makes them count low and lets the AI name them.
 */
export class FaceWorker {
  private readonly questions: QuestionStore;
  private readonly highlights: HighlightStore;
  private readonly faces: FaceLibrary;
  private readonly opts: Required<FaceWorkerOptions>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy: Promise<void> | undefined;

  constructor(questions: QuestionStore, highlights: HighlightStore, faces: FaceLibrary, options: FaceWorkerOptions = {}) {
    this.questions = questions;
    this.highlights = highlights;
    this.faces = faces;
    this.opts = { intervalMs: 5 * 60_000, maxAttempts: 5, maxPerAnswer: 10, log: () => {}, ...options };
  }

  start(): void {
    const loop = async () => {
      await this.kick();
      this.timer = setTimeout(loop, this.opts.intervalMs);
    };
    this.timer = setTimeout(loop, 45_000);
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  /** Processes all pending answers now (also called right after an answer); never runs twice at once. */
  kick(): Promise<void> {
    this.busy ??= this.runOnce()
      .catch((err: Error) => this.opts.log(`faces: ${err.message}`))
      .finally(() => (this.busy = undefined));
    return this.busy;
  }

  async runOnce(): Promise<void> {
    const pending = this.questions.facePending(this.opts.maxAttempts);
    if (!pending.length) return;
    await this.faces.refresh();
    for (const q of pending) {
      const h = q.highlightId ? this.highlights.get(q.highlightId) : undefined;
      const attempts = h ? this.faces.attemptsFor(h.detections).slice(0, this.opts.maxPerAnswer) : [];
      if (!q.faceName || !attempts.length) {
        this.questions.setFace(q.id, 'none', null, 'Geen bruikbaar gezicht bewaard door Frigate');
        continue;
      }
      const name = matchFaceName(q.faceName, this.faces.knownNames());
      try {
        for (const a of attempts) await this.faces.classify(name, a.file);
        const n = attempts.length;
        this.questions.setFace(q.id, 'done', name, `${n} ${n === 1 ? 'gezichtsfoto' : "gezichtsfoto's"} toegevoegd aan ${name}`);
      } catch (err) {
        this.questions.faceFailure(q.id, this.opts.maxAttempts, (err as Error).message);
        this.opts.log(`faces: question ${q.id}: ${(err as Error).message}`);
      }
    }
  }
}
