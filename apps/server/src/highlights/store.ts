import { DatabaseSync } from 'node:sqlite';
import type { HighlightSummary } from '@uitkijk/shared';

/** A scored group of Frigate alerts. Highlights are the selected candidates. */
export interface CandidateRecord {
  id: string;
  startTime: number;
  endTime: number;
  /** De Uitkijk camera ids, in order of appearance. */
  cameras: string[];
  /** Representative camera (De Uitkijk id) and its Frigate name and best detection. */
  camera: string;
  frigateCamera: string;
  repEvent: string;
  clipStart: number;
  clipEnd: number;
  /** Best frame of the representative alert (epoch seconds), for a full-resolution still. */
  frameTime?: number;
  eventStart: number;
  eventEnd: number;
  labels: string[];
  subLabels: string[];
  score: number;
  reasons: string[];
  description: string;
}

interface Row {
  id: string;
  start_time: number;
  end_time: number;
  cameras: string;
  camera: string;
  frigate_camera: string;
  rep_event: string;
  clip_start: number;
  clip_end: number;
  event_start: number;
  event_end: number;
  labels: string;
  sub_labels: string;
  score: number;
  reasons: string;
  description: string;
  selected: number;
  feedback: number | null;
  deleted: number;
  has_thumbnail: number;
  ai_description: string | null;
  ai_real: number | null;
  ai_status: string | null;
  ai_attempts: number;
  base_score: number | null;
  feedback_adj: number;
  frame_time: number | null;
}

export interface StoredCandidate extends CandidateRecord {
  selected: boolean;
  feedback: -1 | 1 | null;
  deleted: boolean;
  hasThumbnail: boolean;
  aiDescription: string | null;
  /** AI verdict: true real event, false noise, null not (yet) assessed. */
  aiRealEvent: boolean | null;
  aiStatus: 'done' | 'failed' | null;
  aiAttempts: number;
  /** Rule-based score before feedback learning. */
  baseScore: number;
  /** Adjustment learned from feedback on similar highlights (part of `score`). */
  feedbackAdj: number;
}

const COLUMNS =
  'id, start_time, end_time, cameras, camera, frigate_camera, rep_event, clip_start, clip_end, event_start, event_end, labels, sub_labels, score, reasons, description, selected, feedback, deleted, thumbnail IS NOT NULL AS has_thumbnail, ai_description, ai_real, ai_status, ai_attempts, base_score, feedback_adj, frame_time';

const fromRow = (r: Row): StoredCandidate => ({
  id: r.id,
  startTime: r.start_time,
  endTime: r.end_time,
  cameras: JSON.parse(r.cameras),
  camera: r.camera,
  frigateCamera: r.frigate_camera,
  repEvent: r.rep_event,
  clipStart: r.clip_start,
  clipEnd: r.clip_end,
  frameTime: r.frame_time ?? r.clip_start + 3,
  eventStart: r.event_start,
  eventEnd: r.event_end,
  labels: JSON.parse(r.labels),
  subLabels: JSON.parse(r.sub_labels),
  score: r.score,
  reasons: JSON.parse(r.reasons),
  description: r.description,
  selected: r.selected === 1,
  feedback: r.feedback === 1 || r.feedback === -1 ? r.feedback : null,
  deleted: r.deleted === 1,
  hasThumbnail: Number(r.has_thumbnail) === 1,
  aiDescription: r.ai_description,
  aiRealEvent: r.ai_real === null ? null : r.ai_real === 1,
  aiStatus: r.ai_status === 'done' || r.ai_status === 'failed' ? r.ai_status : null,
  aiAttempts: Number(r.ai_attempts),
  baseScore: r.base_score ?? r.score,
  feedbackAdj: Number(r.feedback_adj ?? 0),
});

export const toSummary = (c: StoredCandidate): HighlightSummary => ({
  id: c.id,
  cameraId: c.camera,
  cameras: c.cameras,
  startTime: c.startTime,
  endTime: c.endTime,
  clipDuration: Math.round(c.clipEnd - c.clipStart),
  description: c.aiDescription ?? c.description,
  ruleDescription: c.description,
  aiDescribed: c.aiDescription !== null,
  aiNoise: c.aiRealEvent === false,
  score: c.score,
  reasons: c.feedbackAdj ? [...c.reasons, `feedback ${c.feedbackAdj > 0 ? '+' : ''}${c.feedbackAdj.toFixed(1)}`] : c.reasons,
  feedback: c.feedback,
  hasThumbnail: c.hasThumbnail,
});

export interface ArchiveQuery {
  from?: number;
  to?: number;
  camera?: string;
  minScore?: number;
  limit: number;
  offset: number;
}

/**
 * Candidates, highlights and processed review ids. Metadata and one thumbnail per highlight are kept
 * indefinitely; video stays in Frigate (never duplicated permanently).
 * Deleted highlights stay as tombstones (no thumbnail) so their review items are never imported again.
 */
export class HighlightStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS highlight_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS candidates (
        id TEXT PRIMARY KEY,
        start_time REAL NOT NULL,
        end_time REAL NOT NULL,
        cameras TEXT NOT NULL,
        camera TEXT NOT NULL,
        frigate_camera TEXT NOT NULL,
        rep_event TEXT NOT NULL,
        clip_start REAL NOT NULL,
        clip_end REAL NOT NULL,
        event_start REAL NOT NULL,
        event_end REAL NOT NULL,
        labels TEXT NOT NULL,
        sub_labels TEXT NOT NULL,
        score REAL NOT NULL,
        reasons TEXT NOT NULL,
        description TEXT NOT NULL,
        selected INTEGER NOT NULL DEFAULT 0,
        feedback INTEGER,
        deleted INTEGER NOT NULL DEFAULT 0,
        thumbnail BLOB
      );
      CREATE INDEX IF NOT EXISTS candidates_start ON candidates (start_time);
      CREATE TABLE IF NOT EXISTS processed_reviews (
        review_id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL
      );
    `);
    // Added in 0.5.0 (AI descriptions).
    const columns = new Set((this.db.prepare('PRAGMA table_info(candidates)').all() as { name: string }[]).map((c) => c.name));
    for (const [name, type] of [
      ['ai_description', 'TEXT'],
      ['ai_real', 'INTEGER'],
      ['ai_status', 'TEXT'],
      ['ai_attempts', 'INTEGER NOT NULL DEFAULT 0'],
      ['ai_updated', 'REAL'],
      // Added in 0.7.0 (feedback learning).
      ['base_score', 'REAL'],
      ['feedback_adj', 'REAL NOT NULL DEFAULT 0'],
      ['feedback_at', 'REAL'],
      // Added in 0.8.0 (full-resolution still for the AI).
      ['frame_time', 'REAL'],
    ] as const) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE candidates ADD COLUMN ${name} ${type}`);
    }
  }

  close(): void {
    this.db.close();
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM highlight_meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO highlight_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  isProcessed(reviewId: string): boolean {
    return this.db.prepare('SELECT 1 FROM processed_reviews WHERE review_id = ?').get(reviewId) !== undefined;
  }

  /** Inserts a candidate and marks its review items processed, atomically. */
  insert(c: CandidateRecord, reviewIds: string[]): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO candidates (id, start_time, end_time, cameras, camera, frigate_camera, rep_event, clip_start, clip_end,
             event_start, event_end, labels, sub_labels, score, reasons, description, base_score, frame_time)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          c.id, c.startTime, c.endTime, JSON.stringify(c.cameras), c.camera, c.frigateCamera, c.repEvent, c.clipStart,
          c.clipEnd, c.eventStart, c.eventEnd, JSON.stringify(c.labels), JSON.stringify(c.subLabels), c.score,
          JSON.stringify(c.reasons), c.description, c.score, c.frameTime ?? null,
        );
      const mark = this.db.prepare('INSERT OR IGNORE INTO processed_reviews (review_id, candidate_id) VALUES (?, ?)');
      for (const id of reviewIds) mark.run(id, c.id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  get(id: string): StoredCandidate | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM candidates WHERE id = ?`).get(id) as Row | undefined;
    return row && fromRow(row);
  }

  /** Non-deleted candidates starting at or after `since`. */
  candidatesSince(since: number): StoredCandidate[] {
    return (
      this.db.prepare(`SELECT ${COLUMNS} FROM candidates WHERE deleted = 0 AND start_time >= ? ORDER BY start_time`).all(since) as unknown as Row[]
    ).map(fromRow);
  }

  setSelected(id: string, selected: boolean): void {
    this.db.prepare('UPDATE candidates SET selected = ? WHERE id = ?').run(selected ? 1 : 0, id);
  }

  setThumbnail(id: string, webp: Uint8Array): void {
    this.db.prepare('UPDATE candidates SET thumbnail = ? WHERE id = ? AND deleted = 0').run(webp, id);
  }

  thumbnail(id: string): Uint8Array | undefined {
    const row = this.db.prepare('SELECT thumbnail FROM candidates WHERE id = ? AND deleted = 0').get(id) as
      | { thumbnail: Uint8Array | null }
      | undefined;
    return row?.thumbnail ?? undefined;
  }

  setFeedback(id: string, value: -1 | 1 | null, at: number = Date.now() / 1000): void {
    this.db.prepare('UPDATE candidates SET feedback = ?, feedback_at = ? WHERE id = ?').run(value, value === null ? null : at, id);
  }

  /**
   * Feedback signals since `since`, per representative camera and start time: 👍 = +1, 👎 = -1,
   * deleted without 👍 = -1.
   */
  feedbackSignals(since: number): { camera: string; startTime: number; value: number }[] {
    return (
      this.db
        .prepare(
          `SELECT camera, start_time AS startTime, CASE WHEN feedback = 1 THEN 1 ELSE -1 END AS value FROM candidates
             WHERE start_time >= ? AND (feedback IN (1, -1) OR deleted = 1)`,
        )
        .all(since) as { camera: string; startTime: number; value: number }[]
    ).map((r) => ({ ...r, value: Number(r.value) }));
  }

  /** Stores the feedback adjustment; `score` becomes base score plus adjustment. */
  setFeedbackAdjustment(id: string, adjustment: number): void {
    this.db
      .prepare('UPDATE candidates SET base_score = COALESCE(base_score, score), feedback_adj = ?, score = ROUND(COALESCE(base_score, score) + ?, 2) WHERE id = ?')
      .run(adjustment, adjustment, id);
  }

  /** Deletes a highlight: keeps a tombstone (no thumbnail, never selected) so it is not re-imported. */
  tombstone(id: string): void {
    this.db.prepare('UPDATE candidates SET deleted = 1, selected = 0, thumbnail = NULL WHERE id = ?').run(id);
  }

  /** Highlights waiting for an AI description, oldest first. */
  aiPending(since: number, maxAttempts: number): StoredCandidate[] {
    return (
      this.db
        .prepare(
          `SELECT ${COLUMNS} FROM candidates WHERE selected = 1 AND deleted = 0 AND thumbnail IS NOT NULL AND start_time >= ?
             AND ai_status IS NULL AND ai_attempts < ? ORDER BY start_time`,
        )
        .all(since, maxAttempts) as unknown as Row[]
    ).map(fromRow);
  }

  setAiResult(id: string, description: string, realEvent: boolean, at: number): void {
    this.db
      .prepare("UPDATE candidates SET ai_description = ?, ai_real = ?, ai_status = 'done', ai_updated = ? WHERE id = ?")
      .run(description, realEvent ? 1 : 0, at, id);
  }

  setAiFailure(id: string, maxAttempts: number, at: number): void {
    this.db
      .prepare(
        "UPDATE candidates SET ai_attempts = ai_attempts + 1, ai_updated = ?, ai_status = CASE WHEN ai_attempts + 1 >= ? THEN 'failed' ELSE NULL END WHERE id = ?",
      )
      .run(at, maxAttempts, id);
  }

  /** Highlights for the dashboard: selected in the window, not judged noise by the AI nor 👎, best first. */
  rotation(since: number, limit: number): StoredCandidate[] {
    return (
      this.db
        .prepare(`SELECT ${COLUMNS} FROM candidates WHERE selected = 1 AND deleted = 0 AND (ai_real IS NULL OR ai_real = 1) AND (feedback IS NULL OR feedback = 1) AND start_time >= ? ORDER BY score DESC, start_time DESC LIMIT ?`)
        .all(since, limit) as unknown as Row[]
    ).map(fromRow);
  }

  archive(q: ArchiveQuery): { items: StoredCandidate[]; total: number } {
    const where = ['selected = 1', 'deleted = 0'];
    const args: (string | number)[] = [];
    if (q.from !== undefined) where.push('start_time >= ?'), args.push(q.from);
    if (q.to !== undefined) where.push('start_time < ?'), args.push(q.to);
    if (q.camera) where.push('(camera = ? OR cameras LIKE ?)'), args.push(q.camera, `%"${q.camera}"%`);
    if (q.minScore !== undefined) where.push('score >= ?'), args.push(q.minScore);
    const clause = where.join(' AND ');
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS n FROM candidates WHERE ${clause}`).get(...args) as { n: number }).n,
    );
    const items = (
      this.db
        .prepare(`SELECT ${COLUMNS} FROM candidates WHERE ${clause} ORDER BY start_time DESC LIMIT ? OFFSET ?`)
        .all(...args, q.limit, q.offset) as unknown as Row[]
    ).map(fromRow);
    return { items, total };
  }
}
