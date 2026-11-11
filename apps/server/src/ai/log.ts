import { DatabaseSync } from 'node:sqlite';
import type { CodexImageCall } from './codex.ts';

/** What a call was for, shown on Beheer → AI-log. */
export type AiPurpose = 'beschrijving' | 'feit' | 'huishouden';

/** One AI call as sent and received: the raw conversation for administrators (since 0.23.0). */
export interface AiCall {
  id: number;
  at: number;
  purpose: AiPurpose;
  model: string | null;
  effort: string;
  prompt: string;
  /** The JSON schema the answer had to follow. */
  schema: string;
  /** Codex's final message exactly as returned, or null after an error. */
  answer: string | null;
  error: string | null;
  durationMs: number;
  hasImage: boolean;
}

interface Row {
  id: number;
  at: number;
  purpose: AiPurpose;
  model: string | null;
  effort: string;
  prompt: string;
  schema: string;
  answer: string | null;
  error: string | null;
  duration_ms: number;
  has_image: number;
}

const COLUMNS = 'id, at, purpose, model, effort, prompt, schema, answer, error, duration_ms, image IS NOT NULL AS has_image';

const fromRow = (r: Row): AiCall => ({
  id: Number(r.id),
  at: r.at,
  purpose: r.purpose,
  model: r.model,
  effort: r.effort,
  prompt: r.prompt,
  schema: r.schema,
  answer: r.answer,
  error: r.error,
  durationMs: Number(r.duration_ms),
  hasImage: Number(r.has_image) === 1,
});

export interface AiLogOptions {
  /** Days a call is kept; the image goes with it. */
  keepDays?: number;
  /** Turns the JPEG sent to the AI into the small image that is stored (a 640-px WebP in production). */
  shrink?: (jpeg: Uint8Array) => Promise<Uint8Array>;
  /** Epoch seconds. */
  now?: () => number;
}

/**
 * Every AI call with prompt, image, schema and raw answer, so administrators can see what the AI was asked and
 * what it said. Kept for 14 days (about 60 calls a day, ~30 KB image each). Logging never breaks a call.
 */
export class AiLog {
  private readonly db: DatabaseSync;
  private readonly keepDays: number;
  private readonly shrink: (jpeg: Uint8Array) => Promise<Uint8Array>;
  /** Epoch seconds; also the time stamp of logged calls. */
  readonly now: () => number;

  constructor(path: string, { keepDays = 14, shrink = async (j) => j, now = () => Date.now() / 1000 }: AiLogOptions = {}) {
    this.db = new DatabaseSync(path);
    this.keepDays = keepDays;
    this.shrink = shrink;
    this.now = now;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS ai_calls (
        id INTEGER PRIMARY KEY,
        at REAL NOT NULL,
        purpose TEXT NOT NULL,
        model TEXT,
        effort TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schema TEXT NOT NULL,
        answer TEXT,
        error TEXT,
        duration_ms INTEGER NOT NULL,
        image BLOB
      );
      CREATE INDEX IF NOT EXISTS ai_calls_at ON ai_calls (at);
    `);
  }

  close(): void {
    this.db.close();
  }

  async add(entry: Omit<AiCall, 'id' | 'hasImage'> & { jpeg: Uint8Array | null }): Promise<void> {
    const image = entry.jpeg ? await this.shrink(entry.jpeg).catch(() => null) : null;
    this.db
      .prepare('INSERT INTO ai_calls (at, purpose, model, effort, prompt, schema, answer, error, duration_ms, image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(entry.at, entry.purpose, entry.model, entry.effort, entry.prompt, entry.schema, entry.answer, entry.error, Math.round(entry.durationMs), image);
    this.db.prepare('DELETE FROM ai_calls WHERE at < ?').run(this.now() - this.keepDays * 86400);
  }

  /** Newest first; `before` is an id for paging. */
  list({ purpose, before, limit = 30 }: { purpose?: AiPurpose; before?: number; limit?: number } = {}): AiCall[] {
    const where = ['1 = 1'];
    const args: (string | number)[] = [];
    if (purpose) {
      where.push('purpose = ?');
      args.push(purpose);
    }
    if (before) {
      where.push('id < ?');
      args.push(before);
    }
    args.push(Math.min(Math.max(limit, 1), 100));
    return (this.db.prepare(`SELECT ${COLUMNS} FROM ai_calls WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...args) as unknown as Row[]).map(fromRow);
  }

  image(id: number): Uint8Array | undefined {
    const row = this.db.prepare('SELECT image FROM ai_calls WHERE id = ?').get(id) as { image: Uint8Array | null } | undefined;
    return row?.image ?? undefined;
  }
}

/** Wraps a Codex call so every request and answer (or error) is logged; the call itself behaves exactly as before. */
export function loggedCall(call: CodexImageCall, log: AiLog | undefined, purpose: AiPurpose, model: string | null, onLogError: (err: Error) => void = () => {}): CodexImageCall {
  if (!log) return call;
  return async (jpeg, prompt, schema, effort = 'low') => {
    const at = log.now();
    const started = performance.now();
    const record = (answer: string | null, error: string | null) =>
      void log
        .add({ at, purpose, model, effort, prompt, schema: JSON.stringify(schema), answer, error, durationMs: performance.now() - started, jpeg })
        .catch(onLogError);
    try {
      const answer = await call(jpeg, prompt, schema, effort);
      record(answer, null);
      return answer;
    } catch (err) {
      record(null, (err as Error).message);
      throw err;
    }
  };
}
