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
  /** Fact derived from the answer: pending (AI to write), done, none (nothing usable), failed. */
  factStatus: 'pending' | 'done' | 'none' | 'failed' | null;
  fact: string | null;
  /** Face learning in Frigate from the answer: pending, done, none (no face to learn), failed. */
  faceStatus: 'pending' | 'done' | 'none' | 'failed' | null;
  /** Name the face is (to be) stored under in Frigate's library. */
  faceName: string | null;
  /** Outcome for the history, e.g. "3 gezichtsfoto's toegevoegd aan Tineke Mevius". */
  faceResult: string | null;
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
  fact_status: Question['factStatus'];
  fact: string | null;
  fact_attempts: number;
  face_status: Question['faceStatus'];
  face_name: string | null;
  face_result: string | null;
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
  factStatus: r.fact_status ?? null,
  fact: r.fact ?? null,
  faceStatus: r.face_status ?? null,
  faceName: r.face_name ?? null,
  faceResult: r.face_result ?? null,
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
    // Added in 0.11.0 (facts derived from answers).
    const columns = new Set((this.db.prepare('PRAGMA table_info(questions)').all() as { name: string }[]).map((c) => c.name));
    for (const [name, type] of [
      ['fact_status', 'TEXT'],
      ['fact', 'TEXT'],
      ['fact_attempts', 'INTEGER NOT NULL DEFAULT 0'],
      // Added in 0.13.0 (face learning in Frigate).
      ['face_status', 'TEXT'],
      ['face_name', 'TEXT'],
      ['face_result', 'TEXT'],
      ['face_attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ] as const) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE questions ADD COLUMN ${name} ${type}`);
    }
  }

  setFact(id: number, status: 'pending' | 'done' | 'none' | 'failed', fact: string | null = null): void {
    this.db.prepare('UPDATE questions SET fact_status = ?, fact = ? WHERE id = ?').run(status, fact, id);
  }

  /** Answered questions whose fact still has to be written, oldest first. */
  factPending(maxAttempts: number): Question[] {
    return (
      this.db
        .prepare("SELECT * FROM questions WHERE fact_status = 'pending' AND fact_attempts < ? ORDER BY answered_at")
        .all(maxAttempts) as unknown as Row[]
    ).map(fromRow);
  }

  factFailure(id: number, maxAttempts: number): void {
    this.db
      .prepare("UPDATE questions SET fact_attempts = fact_attempts + 1, fact_status = CASE WHEN fact_attempts + 1 >= ? THEN 'failed' ELSE fact_status END WHERE id = ?")
      .run(maxAttempts, id);
  }

  setFace(id: number, status: 'pending' | 'done' | 'none' | 'failed', name: string | null = null, result: string | null = null): void {
    this.db.prepare('UPDATE questions SET face_status = ?, face_name = COALESCE(?, face_name), face_result = ? WHERE id = ?').run(status, name, result, id);
  }

  /** Answered questions whose face still has to be stored in Frigate, oldest first. */
  facePending(maxAttempts: number): Question[] {
    return (
      this.db
        .prepare("SELECT * FROM questions WHERE face_status = 'pending' AND face_attempts < ? ORDER BY answered_at")
        .all(maxAttempts) as unknown as Row[]
    ).map(fromRow);
  }

  faceFailure(id: number, maxAttempts: number, error: string): void {
    this.db
      .prepare(
        "UPDATE questions SET face_attempts = face_attempts + 1, face_result = ?, face_status = CASE WHEN face_attempts + 1 >= ? THEN 'failed' ELSE face_status END WHERE id = ?",
      )
      .run(error.slice(0, 200), maxAttempts, id);
  }

  /** Answered person questions from before 0.11/0.13 that never had a fact or face step. */
  legacyPersonAnswers(): Question[] {
    return (
      this.db.prepare("SELECT * FROM questions WHERE kind = 'person' AND status = 'answered' AND fact_status IS NULL AND face_status IS NULL").all() as unknown as Row[]
    ).map(fromRow);
  }

  /** Whether any question (open or handled) was ever asked about this highlight: one question per highlight. */
  hasForHighlight(highlightId: string, kind?: QuestionKind): boolean {
    return kind
      ? this.db.prepare('SELECT 1 FROM questions WHERE highlight_id = ? AND kind = ?').get(highlightId, kind) !== undefined
      : this.db.prepare('SELECT 1 FROM questions WHERE highlight_id = ?').get(highlightId) !== undefined;
  }

  /** Whether an open question about this highlight is waiting (a vehicle question may follow an answered one). */
  hasOpenForHighlight(highlightId: string): boolean {
    return this.db.prepare("SELECT 1 FROM questions WHERE highlight_id = ? AND status = 'open'").get(highlightId) !== undefined;
  }

  /** Closes an open question that no longer applies (the system's own decision, shown as "systeem"). */
  withdraw(id: number, at: number): void {
    this.db.prepare("UPDATE questions SET status = 'dismissed', answered_by = 'systeem', answered_at = ? WHERE id = ? AND status = 'open'").run(at, id);
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
