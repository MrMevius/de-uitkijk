import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type Role = 'admin' | 'viewer';

export interface User {
  id: number;
  username: string;
  role: Role;
  /** False until the user has set a password through an activation link. */
  active: boolean;
  createdAt: number;
}

export type LinkPurpose = 'activate' | 'reset';

export const SESSION_TTL_MS = 30 * 24 * 3600_000;
export const LINK_TTL_MS = 72 * 3600_000;
/** Sessions are extended at most this often, to avoid a write per request. */
const TOUCH_INTERVAL_MS = 3600_000;

const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export function usernameProblem(username: unknown): string | undefined {
  if (typeof username !== 'string' || !USERNAME.test(username)) {
    return 'Gebruikersnaam: 2–32 tekens, kleine letters, cijfers, punt, streepje of underscore';
  }
  return undefined;
}

/** Only hashes of session and link tokens are stored; the raw token exists only in the cookie or link. */
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

interface UserRow {
  id: number;
  username: string;
  role: Role;
  password_hash: string | null;
  created_at: number;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  username: row.username,
  role: row.role,
  active: row.password_hash !== null,
  createdAt: row.created_at,
});

/**
 * Accounts, sessions and one-time links in SQLite (`node:sqlite`). Synchronous by design: the data is
 * tiny and every operation is a single indexed statement.
 */
export class AuthStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.db = new DatabaseSync(path);
    this.now = now;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
        password_hash TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        touched_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS links (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK (purpose IN ('activate', 'reset')),
        expires_at INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  listUsers(): User[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY username').all() as unknown as UserRow[]).map(toUser);
  }

  findUser(username: string): (User & { passwordHash: string | null }) | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
    return row && { ...toUser(row), passwordHash: row.password_hash };
  }

  getUser(id: number): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row && toUser(row);
  }

  createUser(username: string, role: Role): User {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO users (username, role, created_at) VALUES (?, ?, ?)')
      .run(username, role, this.now());
    return this.getUser(Number(lastInsertRowid))!;
  }

  promoteToAdmin(id: number): void {
    this.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(id);
  }

  deleteUser(id: number): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  adminCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number };
    return Number(row.n);
  }

  // --- One-time links -----------------------------------------------------------------------------

  /** Creates a link token; any earlier unused link for the user stops working. */
  createLink(userId: number, purpose: LinkPurpose): string {
    const token = newToken();
    this.db.prepare('DELETE FROM links WHERE user_id = ?').run(userId);
    this.db
      .prepare('INSERT INTO links (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)')
      .run(digest(token), userId, purpose, this.now() + LINK_TTL_MS);
    return token;
  }

  /** The user a valid, unexpired link belongs to (without consuming it). */
  peekLink(token: string): { user: User; purpose: LinkPurpose } | undefined {
    const row = this.db
      .prepare('SELECT user_id, purpose FROM links WHERE token_hash = ? AND expires_at > ?')
      .get(digest(token), this.now()) as { user_id: number; purpose: LinkPurpose } | undefined;
    const user = row && this.getUser(row.user_id);
    return user && { user, purpose: row.purpose };
  }

  /** Sets the password through a link, consumes the link and ends all existing sessions of the user. */
  redeemLink(token: string, passwordHash: string): User | undefined {
    const link = this.peekLink(token);
    if (!link) return undefined;
    this.db.prepare('DELETE FROM links WHERE user_id = ?').run(link.user.id);
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(link.user.id);
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, link.user.id);
    return this.getUser(link.user.id);
  }

  // --- Sessions -----------------------------------------------------------------------------------

  createSession(userId: number): string {
    const token = newToken();
    const now = this.now();
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, expires_at, touched_at) VALUES (?, ?, ?, ?)')
      .run(digest(token), userId, now + SESSION_TTL_MS, now);
    return token;
  }

  /** Resolves a session token to its user and slides the expiry forward (at most hourly). */
  sessionUser(token: string | undefined): User | undefined {
    if (!token) return undefined;
    const hash = digest(token);
    const now = this.now();
    const row = this.db
      .prepare('SELECT user_id, touched_at FROM sessions WHERE token_hash = ? AND expires_at > ?')
      .get(hash, now) as { user_id: number; touched_at: number } | undefined;
    if (!row) return undefined;
    if (now - row.touched_at > TOUCH_INTERVAL_MS) {
      this.db
        .prepare('UPDATE sessions SET expires_at = ?, touched_at = ? WHERE token_hash = ?')
        .run(now + SESSION_TTL_MS, now, hash);
    }
    const user = this.getUser(row.user_id);
    return user?.active ? user : undefined;
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(token));
  }

  deleteSessionsOf(userId: number): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  purgeExpired(): void {
    const now = this.now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM links WHERE expires_at <= ?').run(now);
  }
}
