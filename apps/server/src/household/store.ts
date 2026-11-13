import { DatabaseSync } from 'node:sqlite';

/** Roles a person can have, the same as the answer buttons of "Wie is dit?" (empty: not known yet). */
export const PERSON_ROLES = ['bewoner', 'familie', 'bezoeker', 'buren', 'vaste hulp', 'bezorger of dienstverlener', ''] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];

export const VEHICLE_KINDS = ['auto', 'bestelbus', 'motor', 'scooter', 'fiets'] as const;
export type VehicleKind = (typeof VEHICLE_KINDS)[number];

export interface Person {
  id: number;
  name: string;
  role: PersonRole;
  /** Only ever set by an administrator, e.g. "vriendin van Jasper". */
  relation: string;
  /** Other spellings that refer to this person, e.g. "Tini" for "Tineke Mevius". */
  aliases: string[];
  /** Where the entry comes from, e.g. ["vraag 30", "feit 3"]. */
  sources: string[];
  /** Fields an administrator set by hand; the weekly bundling never changes them. */
  locked: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Vehicle {
  id: number;
  kind: VehicleKind;
  make: string;
  model: string;
  colour: string;
  plate: string;
  /** Fixed parts that make it recognisable: a child seat, a logo. */
  features: string;
  ownerId: number | null;
  /** Where it usually stands, e.g. "carport". */
  place: string;
  sources: string[];
  locked: string[];
  createdAt: number;
  updatedAt: number;
}

export type PersonFields = Pick<Person, 'name' | 'role' | 'relation' | 'aliases'>;
export type VehicleFields = Pick<Vehicle, 'kind' | 'make' | 'model' | 'colour' | 'plate' | 'features' | 'ownerId' | 'place'>;

/**
 * A change the weekly bundling suggests; an administrator accepts or rejects it.
 * `question` is a contradiction or doubt the AI found; it changes nothing by itself.
 */
export interface Proposal {
  id: number;
  runId: number;
  kind: 'person' | 'vehicle' | 'question';
  action: 'add' | 'update' | 'question';
  targetId: number | null;
  /** Existing vehicles that are the same as the target and go into it. */
  mergeIds: number[];
  /** New field values; a vehicle's owner is a name here, resolved when the proposal is accepted. */
  data: Record<string, string>;
  sources: string[];
  /** Dutch one-liner written by the server, not by the AI. */
  summary: string;
  /** The AI's short reason, shown as context. */
  reason: string;
  status: 'pending' | 'accepted' | 'rejected' | 'stale';
  createdAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
}

export interface Run {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  status: 'running' | 'done' | 'failed';
  error: string | null;
  proposals: number;
  by: string;
}

export interface HistoryEntry {
  id: number;
  at: number;
  by: string;
  text: string;
}

type Row = Record<string, unknown>;
const json = <T>(v: unknown, fallback: T): T => {
  try {
    return typeof v === 'string' ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};

const personFrom = (r: Row): Person => ({
  id: Number(r.id),
  name: String(r.name),
  role: (PERSON_ROLES as readonly string[]).includes(String(r.role)) ? (r.role as PersonRole) : '',
  relation: String(r.relation ?? ''),
  aliases: json<string[]>(r.aliases, []),
  sources: json<string[]>(r.sources, []),
  locked: json<string[]>(r.locked, []),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const vehicleFrom = (r: Row): Vehicle => ({
  id: Number(r.id),
  kind: (VEHICLE_KINDS as readonly string[]).includes(String(r.kind)) ? (r.kind as VehicleKind) : 'auto',
  make: String(r.make ?? ''),
  model: String(r.model ?? ''),
  colour: String(r.colour ?? ''),
  plate: String(r.plate ?? ''),
  features: String(r.features ?? ''),
  ownerId: r.owner_id === null || r.owner_id === undefined ? null : Number(r.owner_id),
  place: String(r.place ?? ''),
  sources: json<string[]>(r.sources, []),
  locked: json<string[]>(r.locked, []),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const proposalFrom = (r: Row): Proposal => ({
  id: Number(r.id),
  runId: Number(r.run_id),
  kind: r.kind as Proposal['kind'],
  action: r.action as Proposal['action'],
  targetId: r.target_id === null ? null : Number(r.target_id),
  mergeIds: json<number[]>(r.merge_ids, []),
  data: json<Record<string, string>>(r.data, {}),
  sources: json<string[]>(r.sources, []),
  summary: String(r.summary),
  reason: String(r.reason ?? ''),
  status: r.status as Proposal['status'],
  createdAt: Number(r.created_at),
  decidedBy: (r.decided_by as string | null) ?? null,
  decidedAt: r.decided_at === null ? null : Number(r.decided_at),
});

/** One plain line, so nothing can break out of its place in a prompt. */
export const cleanText = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/<[^>]*>/g, ' ').replace(/[\r\n\t<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Upper-case letters and digits only: "xx-123-y" and "XX123Y" are the same plate. */
export const plateKey = (plate: string): string => plate.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** "Tineke Mevius", "tineke" (unique first name) or an alias. */
export function findPerson(people: Person[], name: string): Person | undefined {
  const lower = name.trim().toLowerCase();
  if (!lower) return undefined;
  const exact = people.find((p) => p.name.toLowerCase() === lower || p.aliases.some((a) => a.toLowerCase() === lower));
  if (exact) return exact;
  const byFirst = people.filter((p) => p.name.toLowerCase().split(' ')[0] === lower);
  return byFirst.length === 1 ? byFirst[0] : undefined;
}

/** "rode Tesla Model 3, kenteken XX-123-Y" */
export function vehicleLabel(v: Pick<Vehicle, 'kind' | 'make' | 'model' | 'colour' | 'plate'>): string {
  const what = [v.colour, v.make, v.model].filter(Boolean).join(' ') || v.kind;
  return v.plate ? `${what}, kenteken ${v.plate}` : what;
}

/**
 * The household register (since 0.22.0): who is who and whose vehicle is which, built from the raw facts and
 * answers by the weekly bundling and by administrators. Lives in the application database.
 */
export class HouseholdStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS household_people (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT '',
        relation TEXT NOT NULL DEFAULT '',
        aliases TEXT NOT NULL DEFAULT '[]',
        sources TEXT NOT NULL DEFAULT '[]',
        locked TEXT NOT NULL DEFAULT '[]',
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS household_vehicles (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'auto',
        make TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        colour TEXT NOT NULL DEFAULT '',
        plate TEXT NOT NULL DEFAULT '',
        features TEXT NOT NULL DEFAULT '',
        owner_id INTEGER,
        place TEXT NOT NULL DEFAULT '',
        sources TEXT NOT NULL DEFAULT '[]',
        locked TEXT NOT NULL DEFAULT '[]',
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS household_runs (
        id INTEGER PRIMARY KEY,
        started_at REAL NOT NULL,
        finished_at REAL,
        status TEXT NOT NULL,
        error TEXT,
        proposals INTEGER NOT NULL DEFAULT 0,
        by TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS household_proposals (
        id INTEGER PRIMARY KEY,
        run_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        action TEXT NOT NULL,
        target_id INTEGER,
        merge_ids TEXT NOT NULL DEFAULT '[]',
        data TEXT NOT NULL DEFAULT '{}',
        sources TEXT NOT NULL DEFAULT '[]',
        summary TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at REAL NOT NULL,
        decided_by TEXT,
        decided_at REAL
      );
      CREATE TABLE IF NOT EXISTS household_history (
        id INTEGER PRIMARY KEY,
        at REAL NOT NULL,
        by TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS household_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  getMeta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM household_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO household_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  close(): void {
    this.db.close();
  }

  people(): Person[] {
    return (this.db.prepare('SELECT * FROM household_people ORDER BY name COLLATE NOCASE').all() as Row[]).map(personFrom);
  }

  person(id: number): Person | undefined {
    const r = this.db.prepare('SELECT * FROM household_people WHERE id = ?').get(id) as Row | undefined;
    return r ? personFrom(r) : undefined;
  }

  vehicles(): Vehicle[] {
    return (this.db.prepare('SELECT * FROM household_vehicles ORDER BY id').all() as Row[]).map(vehicleFrom);
  }

  vehicle(id: number): Vehicle | undefined {
    const r = this.db.prepare('SELECT * FROM household_vehicles WHERE id = ?').get(id) as Row | undefined;
    return r ? vehicleFrom(r) : undefined;
  }

  addPerson(f: Partial<PersonFields> & { name: string }, sources: string[], locked: string[], at: number): Person {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO household_people (name, role, relation, aliases, sources, locked, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(f.name, f.role ?? '', f.relation ?? '', JSON.stringify(f.aliases ?? []), JSON.stringify(sources), JSON.stringify(locked), at, at);
    return this.person(Number(lastInsertRowid))!;
  }

  updatePerson(id: number, f: Partial<PersonFields>, opts: { sources?: string[]; lock?: boolean; at: number }): Person | undefined {
    const p = this.person(id);
    if (!p) return undefined;
    const next = { ...p, ...f };
    const changed = Object.keys(f).filter((k) => JSON.stringify(f[k as keyof PersonFields]) !== JSON.stringify(p[k as keyof Person]));
    const locked = opts.lock ? [...new Set([...p.locked, ...changed])] : p.locked;
    const sources = [...new Set([...p.sources, ...(opts.sources ?? [])])];
    this.db
      .prepare('UPDATE household_people SET name = ?, role = ?, relation = ?, aliases = ?, sources = ?, locked = ?, updated_at = ? WHERE id = ?')
      .run(next.name, next.role, next.relation, JSON.stringify(next.aliases), JSON.stringify(sources), JSON.stringify(locked), opts.at, id);
    return this.person(id);
  }

  removePerson(id: number, at: number = Date.now() / 1000): boolean {
    this.db.prepare('UPDATE household_vehicles SET owner_id = NULL WHERE owner_id = ?').run(id);
    return this.removed(this.db.prepare('DELETE FROM household_people WHERE id = ?').run(id).changes > 0, at);
  }

  /** Removals count as a change of the register (since 0.31.0), see `lastChange`. */
  private removed(changed: boolean, at: number): boolean {
    if (changed) this.setMeta('removed_at', String(at));
    return changed;
  }

  /** Puts `fromId` into `intoId`: its name becomes an alias, its vehicles move over. */
  mergePeople(intoId: number, fromId: number, at: number): Person | undefined {
    const into = this.person(intoId);
    const from = this.person(fromId);
    if (!into || !from || intoId === fromId) return undefined;
    const aliases = [...new Set([...into.aliases, from.name, ...from.aliases].filter((a) => a.toLowerCase() !== into.name.toLowerCase()))];
    this.db.prepare('UPDATE household_vehicles SET owner_id = ? WHERE owner_id = ?').run(intoId, fromId);
    this.updatePerson(intoId, { aliases, role: into.role || from.role, relation: into.relation || from.relation }, { sources: from.sources, at });
    this.removed(this.db.prepare('DELETE FROM household_people WHERE id = ?').run(fromId).changes > 0, at);
    return this.person(intoId);
  }

  addVehicle(f: Partial<VehicleFields>, sources: string[], locked: string[], at: number): Vehicle {
    const { lastInsertRowid } = this.db
      .prepare(
        'INSERT INTO household_vehicles (kind, make, model, colour, plate, features, owner_id, place, sources, locked, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(f.kind ?? 'auto', f.make ?? '', f.model ?? '', f.colour ?? '', f.plate ?? '', f.features ?? '', f.ownerId ?? null, f.place ?? '', JSON.stringify(sources), JSON.stringify(locked), at, at);
    return this.vehicle(Number(lastInsertRowid))!;
  }

  updateVehicle(id: number, f: Partial<VehicleFields>, opts: { sources?: string[]; lock?: boolean; at: number }): Vehicle | undefined {
    const v = this.vehicle(id);
    if (!v) return undefined;
    const next = { ...v, ...f };
    const changed = Object.keys(f).filter((k) => f[k as keyof VehicleFields] !== v[k as keyof Vehicle]);
    const locked = opts.lock ? [...new Set([...v.locked, ...changed])] : v.locked;
    const sources = [...new Set([...v.sources, ...(opts.sources ?? [])])];
    this.db
      .prepare(
        'UPDATE household_vehicles SET kind = ?, make = ?, model = ?, colour = ?, plate = ?, features = ?, owner_id = ?, place = ?, sources = ?, locked = ?, updated_at = ? WHERE id = ?',
      )
      .run(next.kind, next.make, next.model, next.colour, next.plate, next.features, next.ownerId, next.place, JSON.stringify(sources), JSON.stringify(locked), opts.at, id);
    return this.vehicle(id);
  }

  /** Epoch seconds of the newest change to a person or vehicle, removals included; null when nothing changed yet. */
  lastChange(): number | null {
    const row = this.db
      .prepare(
        "SELECT MAX(at) AS at FROM (SELECT MAX(updated_at) AS at FROM household_people UNION ALL SELECT MAX(updated_at) FROM household_vehicles UNION ALL SELECT CAST(value AS REAL) FROM household_meta WHERE key = 'removed_at')",
      )
      .get() as { at: number | null };
    return row.at;
  }

  removeVehicle(id: number, at: number = Date.now() / 1000): boolean {
    return this.removed(this.db.prepare('DELETE FROM household_vehicles WHERE id = ?').run(id).changes > 0, at);
  }

  startRun(by: string, at: number): Run {
    const { lastInsertRowid } = this.db.prepare("INSERT INTO household_runs (started_at, status, by) VALUES (?, 'running', ?)").run(at, by);
    return this.run(Number(lastInsertRowid))!;
  }

  finishRun(id: number, result: { error?: string; proposals: number }, at: number): void {
    this.db
      .prepare('UPDATE household_runs SET finished_at = ?, status = ?, error = ?, proposals = ? WHERE id = ?')
      .run(at, result.error ? 'failed' : 'done', result.error?.slice(0, 300) ?? null, result.proposals, id);
  }

  run(id: number): Run | undefined {
    const r = this.db.prepare('SELECT * FROM household_runs WHERE id = ?').get(id) as Row | undefined;
    return r ? this.runFrom(r) : undefined;
  }

  lastRun(): Run | undefined {
    const r = this.db.prepare('SELECT * FROM household_runs ORDER BY id DESC LIMIT 1').get() as Row | undefined;
    return r ? this.runFrom(r) : undefined;
  }

  /** A run still marked running after a restart never finished. */
  failInterruptedRuns(at: number): void {
    this.db.prepare("UPDATE household_runs SET status = 'failed', error = 'onderbroken door een herstart', finished_at = ? WHERE status = 'running'").run(at);
  }

  private runFrom(r: Row): Run {
    return {
      id: Number(r.id),
      startedAt: Number(r.started_at),
      finishedAt: r.finished_at === null ? null : Number(r.finished_at),
      status: r.status as Run['status'],
      error: (r.error as string | null) ?? null,
      proposals: Number(r.proposals),
      by: String(r.by),
    };
  }

  addProposal(p: Omit<Proposal, 'id' | 'status' | 'decidedBy' | 'decidedAt'>): Proposal {
    const { lastInsertRowid } = this.db
      .prepare(
        'INSERT INTO household_proposals (run_id, kind, action, target_id, merge_ids, data, sources, summary, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(p.runId, p.kind, p.action, p.targetId, JSON.stringify(p.mergeIds), JSON.stringify(p.data), JSON.stringify(p.sources), p.summary, p.reason, p.createdAt);
    return this.proposal(Number(lastInsertRowid))!;
  }

  proposal(id: number): Proposal | undefined {
    const r = this.db.prepare('SELECT * FROM household_proposals WHERE id = ?').get(id) as Row | undefined;
    return r ? proposalFrom(r) : undefined;
  }

  proposals(status: Proposal['status'] | 'all' = 'pending', limit = 200): Proposal[] {
    const rows =
      status === 'all'
        ? this.db.prepare('SELECT * FROM household_proposals ORDER BY id DESC LIMIT ?').all(limit)
        : this.db.prepare('SELECT * FROM household_proposals WHERE status = ? ORDER BY id LIMIT ?').all(status, limit);
    return (rows as Row[]).map(proposalFrom);
  }

  decide(id: number, status: 'accepted' | 'rejected' | 'stale', by: string, at: number): void {
    this.db.prepare('UPDATE household_proposals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(status, by, at, id);
  }

  /** A new bundling replaces the suggestions nobody decided on yet. */
  staleOpenProposals(at: number): void {
    this.db.prepare("UPDATE household_proposals SET status = 'stale', decided_at = ? WHERE status = 'pending'").run(at);
  }

  log(text: string, by: string, at: number): void {
    this.db.prepare('INSERT INTO household_history (at, by, text) VALUES (?, ?, ?)').run(at, by, text.slice(0, 300));
  }

  history(limit = 50): HistoryEntry[] {
    return (this.db.prepare('SELECT * FROM household_history ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map((r) => ({
      id: Number(r.id),
      at: Number(r.at),
      by: String(r.by),
      text: String(r.text),
    }));
  }
}
