import { DatabaseSync } from 'node:sqlite';
import type { HighlightSummary } from '@uitkijk/shared';
import { REPLAY_MINUTES, SELECTION, THRESHOLD_RANGE } from './selection.ts';

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
  /** Frigate tracked-object ids of all alerts in the group (face training attempts are named after them). */
  detections?: string[];
  clipStart: number;
  clipEnd: number;
  /** Best frame of the representative alert (epoch seconds), for a full-resolution still. */
  frameTime?: number;
  eventStart: number;
  eventEnd: number;
  labels: string[];
  subLabels: string[];
  /** Number plates Frigate's LPR read on the group's vehicles (since 0.20.0). */
  plates?: string[];
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
  ai_updated: number | null;
  base_score: number | null;
  feedback_adj: number;
  frame_time: number | null;
  ai_vehicle: string | null;
  ai_vehicle_known: number | null;
  annotation: string | null;
  detections: string | null;
  annotation_known: number;
  known_factor: number;
  ai_person_marker: number | null;
  ai_redo: number;
  ai_vehicles: string | null;
  plates: string | null;
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
  /** Epoch seconds of the last AI description (or failed attempt). */
  aiUpdated: number | null;
  /** Rule-based score before feedback learning. */
  baseScore: number;
  /** Adjustment learned from feedback on similar highlights (part of `score`). */
  feedbackAdj: number;
  aiVehicle: string | null;
  aiVehicleKnown: boolean;
  /** Every vehicle the AI saw clearly, also parked ones (since 0.18.0); empty for older descriptions. */
  aiVehicles: { description: string; known: boolean }[];
  /** Administrator's answer about who or what is shown. */
  annotation: string | null;
  detections: string[];
  /** The answer names a resident, visitor or vehicle owner: the highlight counts as known. */
  annotationKnown: boolean;
  /** Multiplier on the base score for known people and vehicles (1 = unknown). */
  knownFactor: number;
  /** AI: a person is recognisable by a stable feature other than the face (uniform, logo, own vehicle). */
  aiPersonMarker: boolean | null;
  /** Waiting for a new AI description after an administrator's answer. */
  aiRedo: boolean;
  plates: string[];
}

const COLUMNS =
  'id, start_time, end_time, cameras, camera, frigate_camera, rep_event, clip_start, clip_end, event_start, event_end, labels, sub_labels, score, reasons, description, selected, feedback, deleted, thumbnail IS NOT NULL AS has_thumbnail, ai_description, ai_real, ai_status, ai_attempts, ai_updated, base_score, feedback_adj, frame_time, ai_vehicle, ai_vehicle_known, annotation, detections, annotation_known, known_factor, ai_person_marker, ai_redo, ai_vehicles, plates';

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
  aiUpdated: r.ai_updated,
  baseScore: r.base_score ?? r.score,
  feedbackAdj: Number(r.feedback_adj ?? 0),
  aiVehicle: r.ai_vehicle,
  aiVehicleKnown: r.ai_vehicle_known === 1,
  aiVehicles: r.ai_vehicles ? (JSON.parse(r.ai_vehicles) as { description: string; known: boolean }[]) : [],
  annotation: r.annotation,
  detections: r.detections ? (JSON.parse(r.detections) as string[]) : [r.rep_event],
  annotationKnown: r.annotation_known === 1,
  knownFactor: Number(r.known_factor ?? 1),
  aiPersonMarker: r.ai_person_marker === null ? null : r.ai_person_marker === 1,
  aiRedo: r.ai_redo === 1,
  plates: r.plates ? (JSON.parse(r.plates) as string[]) : [],
});

export const toSummary = (c: StoredCandidate): HighlightSummary => ({
  id: c.id,
  cameraId: c.camera,
  cameras: c.cameras,
  startTime: c.startTime,
  endTime: c.endTime,
  clipDuration: Math.round(c.clipEnd - c.clipStart),
  stillOffset: Math.round(Math.min(Math.max((c.frameTime ?? c.clipStart + 3) - c.clipStart, 0), c.clipEnd - c.clipStart) * 10) / 10,
  description: c.aiDescription ?? c.description,
  ruleDescription: c.description,
  aiDescribed: c.aiDescription !== null,
  aiNoise: c.aiRealEvent === false,
  annotation: c.annotation,
  score: c.score,
  reasons: [
    ...c.reasons,
    ...(c.knownFactor < 1 && c.subLabels.length === 0 ? ['bekend volgens beheer of AI'] : []),
    ...(c.feedbackAdj ? [`feedback ${c.feedbackAdj > 0 ? '+' : ''}${c.feedbackAdj.toFixed(1)}`] : []),
  ],
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
      // Added in 0.10.0 (questions).
      ['ai_vehicle', 'TEXT'],
      ['ai_vehicle_known', 'INTEGER'],
      ['annotation', 'TEXT'],
      // Added in 0.13.0 (face learning, known factor, re-description after answers).
      ['detections', 'TEXT'],
      ['annotation_known', 'INTEGER NOT NULL DEFAULT 0'],
      ['known_factor', 'REAL NOT NULL DEFAULT 1'],
      ['ai_person_marker', 'INTEGER'],
      ['ai_redo', 'INTEGER NOT NULL DEFAULT 0'],
      // Added in 0.18.0 (all clearly visible vehicles, also parked ones, for "whose car" questions).
      ['ai_vehicles', 'TEXT'],
      // Added in 0.20.0 (number plates from Frigate's LPR).
      ['plates', 'TEXT'],
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

  /** Selection threshold set by an administrator, or the default. */
  threshold(): number {
    const v = Number(this.getMeta('threshold'));
    return Number.isFinite(v) && v >= THRESHOLD_RANGE.min && v <= THRESHOLD_RANGE.max ? v : SELECTION.threshold;
  }

  setThreshold(value: number): void {
    this.setMeta('threshold', String(Math.round(value * 10) / 10));
  }

  /** Minutes between two plays of a highlight on the TV, set by an administrator, or the default. */
  replayMinutes(): number {
    const v = Number(this.getMeta('replay_minutes'));
    return Number.isInteger(v) && v >= REPLAY_MINUTES.min && v <= REPLAY_MINUTES.max ? v : REPLAY_MINUTES.default;
  }

  setReplayMinutes(value: number): void {
    this.setMeta('replay_minutes', String(Math.round(value)));
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
             event_start, event_end, labels, sub_labels, score, reasons, description, base_score, frame_time, detections, plates)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          c.id, c.startTime, c.endTime, JSON.stringify(c.cameras), c.camera, c.frigateCamera, c.repEvent, c.clipStart,
          c.clipEnd, c.eventStart, c.eventEnd, JSON.stringify(c.labels), JSON.stringify(c.subLabels), c.score,
          JSON.stringify(c.reasons), c.description, c.score, c.frameTime ?? null, c.detections ? JSON.stringify(c.detections) : null,
          c.plates?.length ? JSON.stringify(c.plates) : null,
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

  /** Stores the learned score parts; `score` becomes base score times known factor plus feedback adjustment. */
  setScoreParts(id: string, adjustment: number, knownFactor = 1): void {
    this.db
      .prepare(
        `UPDATE candidates SET base_score = COALESCE(base_score, score), feedback_adj = ?, known_factor = ?,
           score = ROUND(COALESCE(base_score, score) * ? + ?, 2) WHERE id = ?`,
      )
      .run(adjustment, knownFactor, knownFactor, adjustment, id);
  }

  /** Deletes a highlight: keeps a tombstone (no thumbnail, never selected) so it is not re-imported. */
  tombstone(id: string): void {
    this.db.prepare('UPDATE candidates SET deleted = 1, selected = 0, thumbnail = NULL WHERE id = ?').run(id);
  }

  /**
   * Highlights waiting for an AI description: re-descriptions after an answer first (any age, also when the
   * answer made the highlight drop out of the selection), then new highlights oldest first.
   */
  aiPending(since: number, maxAttempts: number): StoredCandidate[] {
    return (
      this.db
        .prepare(
          `SELECT ${COLUMNS} FROM candidates WHERE deleted = 0 AND thumbnail IS NOT NULL AND ai_status IS NULL AND ai_attempts < ?
             AND (ai_redo = 1 OR (selected = 1 AND start_time >= ?)) ORDER BY ai_redo DESC, annotation IS NOT NULL DESC, start_time`,
        )
        .all(maxAttempts, since) as unknown as Row[]
    ).map(fromRow);
  }

  setAiResult(
    id: string,
    description: string,
    realEvent: boolean,
    at: number,
    vehicle: string | null = null,
    vehicleKnown = false,
    personMarker: boolean | null = null,
    vehicles: { description: string; known: boolean }[] = [],
  ): void {
    this.db
      .prepare(
        `UPDATE candidates SET ai_description = ?, ai_real = ?, ai_status = 'done', ai_updated = ?, ai_vehicle = ?, ai_vehicle_known = ?,
           ai_person_marker = ?, ai_vehicles = ?, ai_redo = 0 WHERE id = ?`,
      )
      .run(
        description, realEvent ? 1 : 0, at, vehicle, vehicleKnown ? 1 : 0, personMarker === null ? null : personMarker ? 1 : 0,
        vehicles.length ? JSON.stringify(vehicles) : null, id,
      );
  }

  /**
   * An administrator's answer about who or what is in the highlight (from the questions tab). `known` marks
   * a named resident, visitor or vehicle owner, so the highlight counts low like a recognised face.
   */
  setAnnotation(id: string, text: string | null, known = false): void {
    this.db.prepare('UPDATE candidates SET annotation = ?, annotation_known = ? WHERE id = ?').run(text, known ? 1 : 0, id);
  }

  /** Moves clip windows that miss the AI still's moment so they contain it (same rule as `clipStartFor`); returns the count. */
  moveClipsToFrame(): number {
    return Number(
      this.db
        .prepare(
          `UPDATE candidates SET clip_start = frame_time - 15, clip_end = MIN(frame_time + 15, MAX(frame_time - 10, end_time + 2, frame_time + 5))
             WHERE deleted = 0 AND frame_time IS NOT NULL AND (frame_time < clip_start OR frame_time > clip_end)`,
        )
        .run().changes,
    );
  }

  /** Describe again with the latest answer and facts; the current description stays until the new one is there. */
  requestRedescribe(id: string): void {
    this.db.prepare('UPDATE candidates SET ai_redo = 1, ai_status = NULL, ai_attempts = 0 WHERE id = ? AND deleted = 0').run(id);
  }

  setAiFailure(id: string, maxAttempts: number, at: number): void {
    this.db
      .prepare(
        `UPDATE candidates SET ai_attempts = ai_attempts + 1, ai_updated = ?,
           ai_status = CASE WHEN ai_attempts + 1 >= ? THEN 'failed' ELSE NULL END,
           ai_redo = CASE WHEN ai_attempts + 1 >= ? THEN 0 ELSE ai_redo END WHERE id = ?`,
      )
      .run(at, maxAttempts, maxAttempts, id);
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
    // Highlights an administrator identified stay in the archive, also when that made them count low.
    const where = ['(selected = 1 OR annotation_known = 1)', 'deleted = 0'];
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
