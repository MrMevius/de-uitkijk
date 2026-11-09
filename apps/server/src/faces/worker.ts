import type { HighlightStore } from '../highlights/store.ts';
import type { QuestionStore } from '../questions/store.ts';
import { matchFaceName, type FaceLibrary } from './library.ts';
import type { RecordingFaces } from './recording.ts';

export interface FaceWorkerOptions {
  intervalMs?: number;
  maxAttempts?: number;
  /** At most this many face crops per answer go into the library (best guesses first). */
  maxPerAnswer?: number;
  /** At most this many faces from the recording per answer, when Frigate kept no crop. */
  maxFromRecording?: number;
  /** Faces from the recording when Frigate kept no crop of its own (since 0.19.0). */
  recording?: RecordingFaces;
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
  private readonly opts: Required<Omit<FaceWorkerOptions, 'recording'>>;
  private readonly recording: RecordingFaces | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy: Promise<void> | undefined;

  constructor(questions: QuestionStore, highlights: HighlightStore, faces: FaceLibrary, options: FaceWorkerOptions = {}) {
    this.questions = questions;
    this.highlights = highlights;
    this.faces = faces;
    const { recording, ...rest } = options;
    this.recording = recording;
    this.opts = { intervalMs: 5 * 60_000, maxAttempts: 5, maxPerAnswer: 10, maxFromRecording: 3, log: () => {}, ...rest };
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
      if (!q.faceName || !h) {
        this.questions.setFace(q.id, 'none', null, 'Geen bruikbaar gezicht bewaard door Frigate');
        continue;
      }
      const name = matchFaceName(q.faceName, this.faces.knownNames());
      const attempts = this.faces.attemptsFor(h.detections).slice(0, this.opts.maxPerAnswer);
      try {
        if (attempts.length) {
          for (const a of attempts) await this.faces.classify(name, a.file);
          this.questions.setFace(q.id, 'done', name, `${photos(attempts.length)} toegevoegd aan ${name}`);
          continue;
        }
        const n = this.recording ? await this.fromRecording(name, h.detections) : 0;
        if (n) this.questions.setFace(q.id, 'done', name, `${photos(n)} uit de opname toegevoegd aan ${name}`);
        else this.questions.setFace(q.id, 'none', null, this.recording ? 'Geen bruikbaar gezicht, ook niet in de opname' : 'Geen bruikbaar gezicht bewaard door Frigate');
      } catch (err) {
        this.questions.faceFailure(q.id, this.opts.maxAttempts, (err as Error).message);
        this.opts.log(`faces: question ${q.id}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Faces of the person from the 4K recording, stored under `name`. Faces Frigate is unsure about or gets wrong
   * go first: they teach it most (Frigate took Tineke for Johan, Mark and Jasper at 0.97 on the back camera).
   */
  private async fromRecording(name: string, detections: string[]): Promise<number> {
    const found: { jpeg: Uint8Array; sure: boolean }[] = [];
    let unprocessed = 0;
    for (const jpeg of await this.recording!.crops(detections)) {
      const r = await this.faces.recognize(jpeg);
      if (r === undefined) unprocessed++;
      else if (r) found.push({ jpeg, sure: r.name === name && r.score >= 0.9 });
    }
    // Retried later (as a failure) rather than concluding there is no face.
    if (!found.length && unprocessed) throw new Error("Frigate kon de beelden nu niet verwerken; later opnieuw");
    const chosen = found.sort((a, b) => Number(a.sure) - Number(b.sure)).slice(0, this.opts.maxFromRecording);
    for (const f of chosen) await this.faces.register(name, f.jpeg);
    return chosen.length;
  }
}

const photos = (n: number) => `${n} ${n === 1 ? 'gezichtsfoto' : "gezichtsfoto's"}`;
