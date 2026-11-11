import { DatabaseSync } from 'node:sqlite';

/** A dashboard screen (TV, laptop, phone) as it last reported itself (since 0.27.0). */
export interface Display {
  id: string;
  profile: string;
  username: string;
  version: string;
  /** Short device description from the browser, e.g. "Windows · Chrome". */
  device: string;
  firstSeen: number;
  lastSeen: number;
  /** Cameras showing a picture out of all cameras, at the last report. */
  camerasLive: number;
  camerasTotal: number;
}

interface Row {
  id: string;
  profile: string;
  username: string;
  version: string;
  device: string;
  first_seen: number;
  last_seen: number;
  cameras_live: number;
  cameras_total: number;
}

const fromRow = (r: Row): Display => ({
  id: r.id,
  profile: r.profile,
  username: r.username,
  version: r.version,
  device: r.device,
  firstSeen: r.first_seen,
  lastSeen: r.last_seen,
  camerasLive: Number(r.cameras_live),
  camerasTotal: Number(r.cameras_total),
});

/** Browser and operating system from a user agent, for recognising a screen in the list. */
export function deviceOf(userAgent: string): string {
  const os = /Windows/.test(userAgent)
    ? 'Windows'
    : /Android/.test(userAgent)
      ? 'Android'
      : /iPhone|iPad/.test(userAgent)
        ? 'iOS'
        : /Mac OS X/.test(userAgent)
          ? 'macOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : 'onbekend';
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Chrome\//.test(userAgent) ? 'Chrome' : /Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : 'browser';
  return `${os} · ${browser}`;
}

/**
 * Dashboards report every minute which version they run and how many cameras show a picture, so administrators
 * see on Beheer → Overzicht when a TV hangs or still runs an old version. Screens not seen for 30 days are forgotten.
 */
export class DisplayRegistry {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(path: string, now: () => number = () => Date.now() / 1000) {
    this.db = new DatabaseSync(path);
    this.now = now;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS displays (
        id TEXT PRIMARY KEY,
        profile TEXT NOT NULL,
        username TEXT NOT NULL,
        version TEXT NOT NULL,
        device TEXT NOT NULL,
        first_seen REAL NOT NULL,
        last_seen REAL NOT NULL,
        cameras_live INTEGER NOT NULL,
        cameras_total INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  report(d: Omit<Display, 'firstSeen' | 'lastSeen'>): void {
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO displays (id, profile, username, version, device, first_seen, last_seen, cameras_live, cameras_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET profile = excluded.profile, username = excluded.username, version = excluded.version,
             device = excluded.device, last_seen = excluded.last_seen, cameras_live = excluded.cameras_live, cameras_total = excluded.cameras_total`,
      )
      .run(d.id, d.profile, d.username, d.version, d.device, at, at, d.camerasLive, d.camerasTotal);
    this.db.prepare('DELETE FROM displays WHERE last_seen < ?').run(at - 30 * 86400);
  }

  /** Most recently seen first. */
  list(): Display[] {
    return (this.db.prepare('SELECT * FROM displays ORDER BY last_seen DESC').all() as unknown as Row[]).map(fromRow);
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM displays WHERE id = ?').run(id).changes > 0;
  }
}
