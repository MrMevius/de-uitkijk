import { createReadStream, createWriteStream, readdirSync, statSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

export interface BackupOptions {
  /** Local time of day (Europe/Amsterdam) after which the daily copy is made: before the 04:00 VM backup. */
  hour?: number;
  minute?: number;
  daily?: number;
  weekly?: number;
  monthly?: number;
  checkMs?: number;
  /** Epoch milliseconds. */
  now?: () => number;
  log?: (msg: string) => void;
}

export interface BackupStatus {
  lastAt: number | null;
  lastFile: string | null;
  lastBytes: number | null;
  count: number;
  lastError: string | null;
}

const FILE = /^uitkijk-(\d{4}-\d{2}-\d{2})\.db\.gz$/;

const amsterdam = (ms: number) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
};

/** Monday of the ISO week of a `yyyy-mm-dd` day, as the week's key. */
const weekOf = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

/**
 * Days whose copy is kept: the newest `daily` days, the newest copy of each of the last `weekly` weeks and of each
 * of the last `monthly` months (OPS-3: 30 daily, 12 weekly, 12 monthly).
 */
export function keepDays(days: string[], daily: number, weekly: number, monthly: number): Set<string> {
  const sorted = [...days].sort().reverse();
  const keep = new Set(sorted.slice(0, daily));
  const newestPer = (key: (d: string) => string, n: number) => {
    const seen = new Set<string>();
    for (const d of sorted) {
      if (seen.has(key(d))) continue;
      seen.add(key(d));
      if (seen.size > n) break;
      keep.add(d);
    }
  };
  newestPer(weekOf, weekly);
  newestPer((d) => d.slice(0, 7), monthly);
  return keep;
}

/**
 * Daily consistent copy of the SQLite database (accounts, highlights, answers, facts, household, AI log) as
 * gzip in `dir`, made with VACUUM INTO while the server keeps running (since 0.27.0). The nightly full-VM
 * backup takes the copies off the host; restoring is described in docs/deployment.md.
 */
export class DbBackup {
  private readonly dbPath: string;
  private readonly dir: string;
  private readonly opts: Required<BackupOptions>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private lastError: string | null = null;

  constructor(dbPath: string, dir: string, options: BackupOptions = {}) {
    this.dbPath = dbPath;
    this.dir = dir;
    this.opts = { hour: 3, minute: 30, daily: 30, weekly: 12, monthly: 12, checkMs: 15 * 60_000, now: Date.now, log: () => {}, ...options };
  }

  start(): void {
    const check = () => void this.runIfDue();
    this.timer = setInterval(check, this.opts.checkMs);
    check();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private files(): { name: string; day: string }[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.dir);
    } catch {
      // No copies yet.
    }
    return names.flatMap((name) => {
      const m = FILE.exec(name);
      return m ? [{ name, day: m[1]! }] : [];
    });
  }

  /** Makes today's copy once the time of day has passed and there is none yet. Returns whether it ran. */
  async runIfDue(): Promise<boolean> {
    const { day, minutes } = amsterdam(this.opts.now());
    if (minutes < this.opts.hour * 60 + this.opts.minute || this.running) return false;
    if (this.files().some((f) => f.day === day)) return false;
    await this.run();
    return true;
  }

  /** Makes a copy now (named after today) and removes copies outside the retention. */
  async run(): Promise<string | undefined> {
    this.running = true;
    const { day } = amsterdam(this.opts.now());
    const name = `uitkijk-${day}.db.gz`;
    const raw = join(this.dir, `.uitkijk-${day}.db`);
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await rm(raw, { force: true });
      const db = new DatabaseSync(this.dbPath);
      try {
        db.prepare('VACUUM INTO ?').run(raw);
      } finally {
        db.close();
      }
      await pipeline(createReadStream(raw), createGzip({ level: 6 }), createWriteStream(join(this.dir, `.${name}`), { mode: 0o600 }));
      await rename(join(this.dir, `.${name}`), join(this.dir, name));
      const keep = keepDays(this.files().map((f) => f.day), this.opts.daily, this.opts.weekly, this.opts.monthly);
      for (const f of this.files()) if (!keep.has(f.day)) await rm(join(this.dir, f.name), { force: true });
      this.lastError = null;
      return name;
    } catch (err) {
      this.lastError = (err as Error).message.slice(0, 200);
      this.opts.log(`backup: ${this.lastError}`);
      return undefined;
    } finally {
      await rm(raw, { force: true }).catch(() => {});
      this.running = false;
    }
  }

  status(): BackupStatus {
    const files = this.files().sort((a, b) => b.day.localeCompare(a.day));
    const last = files[0];
    let info: { mtimeMs: number; size: number } | undefined;
    try {
      info = last ? statSync(join(this.dir, last.name)) : undefined;
    } catch {
      info = undefined;
    }
    return {
      lastAt: info ? Math.round(info.mtimeMs / 1000) : null,
      lastFile: last?.name ?? null,
      lastBytes: info?.size ?? null,
      count: files.length,
      lastError: this.lastError,
    };
  }
}
