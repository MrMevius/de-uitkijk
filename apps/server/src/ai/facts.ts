import { DatabaseSync } from 'node:sqlite';

/** A household fact the AI may use, e.g. "Rode Tesla Model 3 met kenteken XX-123-Y is van Jasper". */
export interface Fact {
  id: number;
  text: string;
  createdBy: string;
  createdAt: number;
}

export const MAX_FACTS = 50;
export const MAX_FACT_LENGTH = 200;

export function factProblem(text: unknown): string | undefined {
  if (typeof text !== 'string' || text.trim().length < 3) return 'Een feit heeft minimaal 3 tekens';
  if (text.trim().length > MAX_FACT_LENGTH) return `Een feit heeft maximaal ${MAX_FACT_LENGTH} tekens`;
  return undefined;
}

/** Facts entered by administrators; stored in the application database, sent to the AI with each description. */
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

  add(text: string, createdBy: string, at: number = Date.now() / 1000): Fact {
    if (this.list().length >= MAX_FACTS) throw new Error(`Maximaal ${MAX_FACTS} feiten`);
    // One plain line: no line breaks, so a fact cannot break out of its place in the prompt.
    const clean = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    const { lastInsertRowid } = this.db.prepare('INSERT INTO ai_facts (text, created_by, created_at) VALUES (?, ?, ?)').run(clean, createdBy, at);
    return this.list().find((f) => f.id === Number(lastInsertRowid))!;
  }

  remove(id: number): boolean {
    return this.db.prepare('DELETE FROM ai_facts WHERE id = ?').run(id).changes > 0;
  }
}
