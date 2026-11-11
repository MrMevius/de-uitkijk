import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCameraConfig } from '@uitkijk/shared';
import { buildApp } from '../src/app.ts';
import { hashPassword } from '../src/auth/passwords.ts';
import { AuthStore } from '../src/auth/store.ts';
import { DbBackup, keepDays } from '../src/backup.ts';
import { deviceOf, DisplayRegistry } from '../src/displays.ts';
import { StateHub } from '../src/hub.ts';

const cameras = parseCameraConfig(JSON.parse(readFileSync(new URL('../../../config/cameras.json', import.meta.url), 'utf8')));
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

describe('database backup (0.27.0)', () => {
  it('keeps 30 daily, 12 weekly and 12 monthly copies', () => {
    const days = Array.from({ length: 500 }, (_, i) => new Date(Date.UTC(2025, 6, 1) + i * 86400_000).toISOString().slice(0, 10));
    const keep = keepDays(days, 30, 12, 12);
    const newest = days.at(-1)!;
    expect(keep.has(newest)).toBe(true);
    expect(keep.has(days.at(-30)!)).toBe(true);
    // Sundays (the newest day of a week) further back, and month ends a year back.
    expect(keep.has('2026-09-27')).toBe(true);
    expect(keep.has('2026-09-26')).toBe(false);
    expect(keep.has('2026-01-31')).toBe(true);
    expect(keep.has('2025-07-31')).toBe(false);
    expect(keep.size).toBeLessThanOrEqual(54);
  });

  it('makes a consistent gzip copy once a day after 03:30 Amsterdam time and removes old ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uitkijk-backup-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const db = new DatabaseSync(join(dir, 'uitkijk.db'));
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('geleerd')");
    cleanup.push(() => db.close());
    const out = join(dir, 'backups');
    let now = Date.parse('2026-11-12T02:00:00Z'); // 03:00 in Amsterdam
    const backup = new DbBackup(join(dir, 'uitkijk.db'), out, { now: () => now, daily: 2, weekly: 0, monthly: 0 });
    expect(await backup.runIfDue()).toBe(false);
    now = Date.parse('2026-11-12T02:31:00Z');
    expect(await backup.runIfDue()).toBe(true);
    expect(await backup.runIfDue()).toBe(false);
    const copy = join(dir, 'restored.db');
    writeFileSync(copy, gunzipSync(readFileSync(join(out, 'uitkijk-2026-11-12.db.gz'))));
    const restored = new DatabaseSync(copy, { readOnly: true });
    expect(restored.prepare('SELECT v FROM t').get()).toEqual({ v: 'geleerd' });
    restored.close();
    for (const day of ['13', '14']) {
      now = Date.parse(`2026-11-${day}T03:00:00Z`);
      await backup.runIfDue();
    }
    expect(readdirSync(out).sort()).toEqual(['uitkijk-2026-11-13.db.gz', 'uitkijk-2026-11-14.db.gz']);
    expect(backup.status()).toMatchObject({ lastFile: 'uitkijk-2026-11-14.db.gz', count: 2, lastError: null });
  });
});

describe('screens (0.27.0)', () => {
  it('records what each logged-in dashboard reports and lists it for administrators', async () => {
    const auth = new AuthStore(':memory:');
    const displays = new DisplayRegistry(':memory:', () => 1000);
    const hub = new StateHub('live', cameras, 15_000);
    const app = buildApp({ hub, auth: { store: auth, publicUrl: 'https://u.example' }, displays });
    cleanup.push(() => app.close(), () => hub.stop(), () => auth.close(), () => displays.close());
    const session = async (name: string, role: 'admin' | 'viewer') => {
      const user = auth.createUser(name, role);
      auth.redeemLink(auth.createLink(user.id, 'activate'), await hashPassword('correct horse battery'));
      return { cookie: `uitkijk_session=${auth.createSession(user.id)}`, origin: 'https://u.example' };
    };
    const tv = await session('winkel', 'viewer');
    const report = (payload: object) =>
      app.inject({ method: 'POST', url: '/api/displays/report', headers: { ...tv, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36' }, payload });
    expect((await app.inject({ method: 'POST', url: '/api/displays/report', payload: { id: 'abcdefgh12' } })).statusCode).toBe(401);
    expect((await report({ id: 'x' })).statusCode).toBe(400);
    expect((await report({ id: 'abcdefgh12', profile: 'shop', version: '0.27.0', camerasLive: 3, camerasTotal: 4 })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/admin/displays', headers: tv })).statusCode).toBe(403);
    const admin = await session('mevius', 'admin');
    expect((await app.inject({ url: '/api/admin/displays', headers: admin })).json()).toEqual([
      { id: 'abcdefgh12', profile: 'shop', username: 'winkel', version: '0.27.0', device: 'Windows · Chrome', firstSeen: 1000, lastSeen: 1000, camerasLive: 3, camerasTotal: 4 },
    ]);
    expect((await app.inject({ method: 'DELETE', url: '/api/admin/displays/abcdefgh12', headers: admin })).statusCode).toBe(204);
    expect(displays.list()).toEqual([]);
    expect(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit Safari/604.1')).toBe('iOS · Safari');
  });
});
