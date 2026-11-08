import { DatabaseSync } from 'node:sqlite';

export type QuestionKind = 'person' | 'vehicle' | 'highlight' | 'noise' | 'system';
export type QuestionStatus = 'open' | 'answered' | 'dismissed';

export interface Question {
  id: number;
  kind: QuestionKind;
  /** Deduplication key: a key is asked once, whatever the answer. */
  key: string;
  highlightId: string | null;
  title: string;
  body: string;
  /** Kind-specific data, e.g. the AI's vehicle description to prefill. */
  data: Record<string, unknown>;
  status: QuestionStatus;
  answer: string | null;
  answeredBy: string | null;
  createdAt: number;
  answeredAt: number | null;
}

interface Row {
  id: number;
  kind: QuestionKind;
  key: string;
  highlight_id: string | null;
  title: string;
  body: string;
  data: string;
  status: QuestionStatus;
  answer: string | null;
  answered_by: string | null;
  created_at: number;
  answered_at: number | null;
}

const fromRow = (r: Row): Question => ({
  id: Number(r.id),
  kind: r.kind,
  key: r.key,
  highlightId: r.highlight_id,
  title: r.title,
  body: r.body,
  data: JSON.parse(r.data) as Record<string, unknown>,
  status: r.status,
  answer: r.answer,
  answeredBy: r.answered_by,
  createdAt: r.created_at,
  answeredAt: r.answered_at,
});

/** Questions and suggestions for administrators, with their answers (kept as history). */
export class QuestionStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS questions (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        key TEXT NOT NULL UNIQUE,
        highlight_id TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'open',
        answer TEXT,
        answered_by TEXT,
        created_at REAL NOT NULL,
        answered_at REAL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  has(key: string): boolean {
    return this.db.prepare('SELECT 1 FROM questions WHERE key = ?').get(key) !== undefined;
  }

  openCount(kind: QuestionKind): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM questions WHERE kind = ? AND status = 'open'").get(kind) as { n: number }).n);
  }

  /** Adds a question unless its key was ever used. Returns whether it was added. */
  add(q: { kind: QuestionKind; key: string; highlightId?: string | null; title: string; body: string; data?: Record<string, unknown> }, at: number): boolean {
    const res = this.db
      .prepare('INSERT OR IGNORE INTO questions (kind, key, highlight_id, title, body, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(q.kind, q.key, q.highlightId ?? null, q.title, q.body, JSON.stringify(q.data ?? {}), at);
    return res.changes > 0;
  }

  get(id: number): Question | undefined {
    const row = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as Row | undefined;
    return row && fromRow(row);
  }

  list(status: QuestionStatus | 'all', limit = 100): Question[] {
    const rows = (status === 'all'
      ? this.db.prepare('SELECT * FROM questions ORDER BY created_at DESC LIMIT ?').all(limit)
      : this.db.prepare('SELECT * FROM questions WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)) as unknown as Row[];
    return rows.map(fromRow);
  }

  resolve(id: number, status: 'answered' | 'dismissed', answer: string | null, by: string, at: number): void {
    this.db
      .prepare("UPDATE questions SET status = ?, answer = ?, answered_by = ?, answered_at = ? WHERE id = ? AND status = 'open'")
      .run(status, answer, by, at, id);
  }

  /** Open questions about a highlight that no longer exists or was deleted are closed silently. */
  dismissForHighlight(highlightId: string, at: number): void {
    this.db
      .prepare("UPDATE questions SET status = 'dismissed', answered_by = 'systeem', answered_at = ? WHERE highlight_id = ? AND status = 'open'")
      .run(at, highlightId);
  }
}
