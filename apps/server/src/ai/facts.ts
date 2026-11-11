import { DatabaseSync } from 'node:sqlite';

/** A household fact the AI may use, e.g. "Rode Tesla Model 3 met kenteken XX-123-Y is van Jasper". */
export interface Fact {
  id: number;
  text: string;
  /** Who or what produced it, e.g. "mark (vraag 12)" or "AI (vraag 14)". */
  createdBy: string;
  createdAt: number;
}

export const MAX_FACT_LENGTH = 200;

/** Dutch-style plate ("XX-123-Y") in a fact, used to replace an older fact about the same vehicle. */
export function plateOf(text: string): string | null {
  const m = /\b([A-Z0-9]{1,3})-([A-Z0-9]{1,3})-([A-Z0-9]{1,3})\b/i.exec(text);
  return m ? `${m[1]}-${m[2]}-${m[3]}`.toUpperCase() : null;
}

const normalize = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Facts derived from answered questions; stored in the application database, sent to the AI with each description. */
export class FactStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS ai_facts (
        id INTEGER PRIMARY KEY,
        text TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at REAL NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  list(): Fact[] {
    return (
      this.db.prepare('SELECT id, text, created_by, created_at FROM ai_facts ORDER BY id').all() as {
        id: number;
        text: string;
        created_by: string;
        created_at: number;
      }[]
    ).map((r) => ({ id: Number(r.id), text: r.text, createdBy: r.created_by, createdAt: r.created_at }));
  }

  /**
   * Adds a fact. An identical fact is not added twice; a fact with the same plate replaces the older one
   * (the newest answer about a vehicle wins). No upper limit on the number of facts.
   */
  add(text: string, createdBy: string, at: number = Date.now() / 1000): Fact {
    // One plain line: no line breaks, so a fact cannot break out of its place in the prompt.
    const clean = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_LENGTH);
    const existing = this.list();
    const same = existing.find((f) => normalize(f.text) === normalize(clean));
    if (same) return same;
    const plate = plateOf(clean);
    const samePlate = plate ? existing.find((f) => plateOf(f.text) === plate) : undefined;
    if (samePlate) {
      this.db.prepare('UPDATE ai_facts SET text = ?, created_by = ?, created_at = ? WHERE id = ?').run(clean, createdBy, at, samePlate.id);
      return this.list().find((f) => f.id === samePlate.id)!;
    }
    const { lastInsertRowid } = this.db.prepare('INSERT INTO ai_facts (text, created_by, created_at) VALUES (?, ?, ?)').run(clean, createdBy, at);
    return this.list().find((f) => f.id === Number(lastInsertRowid))!;
  }

  /** Epoch seconds of the newest added or replaced fact; null without facts. */
  lastChange(): number | null {
    const row = this.db.prepare('SELECT MAX(created_at) AS at FROM ai_facts').get() as { at: number | null };
    return row.at;
  }

  remove(id: number): boolean {
    return this.db.prepare('DELETE FROM ai_facts WHERE id = ?').run(id).changes > 0;
  }
}
