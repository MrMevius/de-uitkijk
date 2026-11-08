import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCameraConfig } from '@uitkijk/shared';
import { buildApp } from '../src/app.ts';
import { hashPassword, verifyPassword } from '../src/auth/passwords.ts';
import { AuthStore, LINK_TTL_MS, SESSION_TTL_MS } from '../src/auth/store.ts';
import { StateHub } from '../src/hub.ts';

const cameras = parseCameraConfig(
  JSON.parse(readFileSync(new URL('../../../config/cameras.json', import.meta.url), 'utf8')),
);
const ORIGIN = 'https://uitkijk.example.nl';
const PASSWORD = 'correct horse battery';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

function setup() {
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const store = new AuthStore(':memory:', now);
  const hub = new StateHub('live', cameras, 15_000);
  const app = buildApp({ hub, auth: { store, publicUrl: ORIGIN, now } });
  cleanup.push(() => app.close(), () => hub.stop(), () => store.close());
  const pub = { 'x-uitkijk-access': 'public', 'x-uitkijk-client': '203.0.113.7' };
  return {
    app,
    store,
    pub,
    advance: (ms: number) => (clock += ms),
    async activeUser(username: string, role: 'admin' | 'viewer') {
      const user = store.createUser(username, role);
      store.redeemLink(store.createLink(user.id, 'activate'), await hashPassword(PASSWORD));
      return user;
    },
    async login(username: string, password = PASSWORD, client = '203.0.113.7') {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { ...pub, 'x-uitkijk-client': client, origin: ORIGIN },
        payload: { username, password },
      });
      const cookie = String(res.headers['set-cookie'] ?? '').split(';')[0]!;
      return { res, cookie };
    },
  };
}

describe('passwords', () => {
  it('hashes with a salt and verifies only the right password', async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword('wrong password!', a)).toBe(false);
    expect(await verifyPassword(PASSWORD, null)).toBe(false);
  });
});

describe('access policy', () => {
  it('keeps the LAN open but closes login and administration there', async () => {
    const { app } = setup();
    const local = { 'x-uitkijk-access': 'local' };
    expect((await app.inject({ url: '/api/state', headers: local })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/admin/users', headers: local })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers: local, payload: {} })).statusCode).toBe(
      403,
    );
  });

  it('requires a session for everything but health on the public side, and fails closed without the header', async () => {
    const { app, pub } = setup();
    expect((await app.inject({ url: '/api/health', headers: pub })).statusCode).toBe(200);
    for (const url of ['/api/state', '/api/events', '/api/auth/check', '/api/auth/me', '/api/admin/users']) {
      expect((await app.inject({ url, headers: pub })).statusCode, url).toBe(401);
    }
    expect((await app.inject({ url: '/api/state' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/state', headers: { 'x-uitkijk-access': 'LOCAL' } })).statusCode).toBe(401);
  });

  it('logs in with a secure cookie, opens the API and logs out', async () => {
    const t = setup();
    await t.activeUser('mark', 'viewer');
    const { res, cookie } = await t.login('Mark');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ username: 'mark', role: 'viewer' });
    expect(String(res.headers['set-cookie'])).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    const headers = { ...t.pub, cookie };
    expect((await t.app.inject({ url: '/api/state', headers })).statusCode).toBe(200);
    expect((await t.app.inject({ url: '/api/auth/check', headers })).statusCode).toBe(204);
    expect((await t.app.inject({ url: '/api/admin/users', headers })).statusCode).toBe(403);
    await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...headers, origin: ORIGIN } });
    expect((await t.app.inject({ url: '/api/state', headers })).statusCode).toBe(401);
  });

  it('expires idle sessions after 30 days and slides active ones', async () => {
    const t = setup();
    await t.activeUser('mark', 'viewer');
    const { cookie } = await t.login('mark');
    const headers = { ...t.pub, cookie };
    t.advance(SESSION_TTL_MS - 3600_000);
    expect((await t.app.inject({ url: '/api/auth/check', headers })).statusCode).toBe(204);
    t.advance(SESSION_TTL_MS - 3600_000);
    expect((await t.app.inject({ url: '/api/auth/check', headers })).statusCode).toBe(204);
    t.advance(SESSION_TTL_MS + 1);
    expect((await t.app.inject({ url: '/api/auth/check', headers })).statusCode).toBe(401);
  });

  it('rejects writes from a foreign origin', async () => {
    const t = setup();
    await t.activeUser('mark', 'viewer');
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...t.pub, origin: 'https://evil.example' },
      payload: { username: 'mark', password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('login throttling', () => {
  it('blocks a username after five failures for 15 minutes, even with the right password', async () => {
    const t = setup();
    await t.activeUser('mark', 'viewer');
    for (let i = 0; i < 5; i++) expect((await t.login('mark', 'wrong password!', `198.51.100.${i}`)).res.statusCode).toBe(401);
    expect((await t.login('mark')).res.statusCode).toBe(429);
    t.advance(15 * 60_000 + 1);
    expect((await t.login('mark')).res.statusCode).toBe(200);
  });

  it('blocks a client address after ten failures', async () => {
    const t = setup();
    await t.activeUser('mark', 'viewer');
    for (let i = 0; i < 10; i++) await t.login(`nobody${i}`, 'wrong password!');
    expect((await t.login('mark')).res.statusCode).toBe(429);
    expect((await t.login('mark', PASSWORD, '198.51.100.99')).res.statusCode).toBe(200);
  });
});

describe('one-time links and administration', () => {
  it('lets an admin invite a user who sets a password once', async () => {
    const t = setup();
    await t.activeUser('beheer', 'admin');
    const { cookie } = await t.login('beheer');
    const admin = { ...t.pub, cookie, origin: ORIGIN };
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: admin,
      payload: { username: 'oma', role: 'viewer' },
    });
    expect(created.statusCode).toBe(201);
    const link: string = created.json().link;
    expect(link.startsWith(`${ORIGIN}/activeer#`)).toBe(true);
    const token = link.split('#')[1]!;

    const peek = await t.app.inject({ method: 'POST', url: '/api/auth/link', headers: t.pub, payload: { token } });
    expect(peek.json()).toEqual({ username: 'oma', purpose: 'activate' });

    const short = await t.app.inject({
      method: 'POST',
      url: '/api/auth/activate',
      headers: t.pub,
      payload: { token, password: 'kort' },
    });
    expect(short.statusCode).toBe(400);
    const activated = await t.app.inject({
      method: 'POST',
      url: '/api/auth/activate',
      headers: t.pub,
      payload: { token, password: PASSWORD },
    });
    expect(activated.statusCode).toBe(200);
    expect(String(activated.headers['set-cookie'])).toContain('uitkijk_session=');
    const again = await t.app.inject({
      method: 'POST',
      url: '/api/auth/activate',
      headers: t.pub,
      payload: { token, password: PASSWORD },
    });
    expect(again.statusCode).toBe(404);
    expect((await t.login('oma')).res.statusCode).toBe(200);
  });

  it('expires links after 72 hours and ends old sessions on a password reset', async () => {
    const t = setup();
    const user = await t.activeUser('mark', 'viewer');
    const { cookie } = await t.login('mark');
    const stale = t.store.createLink(user.id, 'reset');
    t.advance(LINK_TTL_MS + 1);
    expect(t.store.peekLink(stale)).toBeUndefined();
    const fresh = t.store.createLink(user.id, 'reset');
    t.store.redeemLink(fresh, await hashPassword('another long password'));
    expect((await t.app.inject({ url: '/api/state', headers: { ...t.pub, cookie } })).statusCode).toBe(401);
  });

  it('protects the last administrator and the own account', async () => {
    const t = setup();
    const admin = await t.activeUser('beheer', 'admin');
    const { cookie } = await t.login('beheer');
    const headers = { ...t.pub, cookie, origin: ORIGIN };
    const self = await t.app.inject({ method: 'DELETE', url: `/api/admin/users/${admin.id}`, headers });
    expect(self.statusCode).toBe(400);
    const viewer = t.store.createUser('gast', 'viewer');
    expect((await t.app.inject({ method: 'DELETE', url: `/api/admin/users/${viewer.id}`, headers })).statusCode).toBe(204);
    expect(t.store.listUsers().map((u) => u.username)).toEqual(['beheer']);
  });

  it('validates new users', async () => {
    const t = setup();
    await t.activeUser('beheer', 'admin');
    const { cookie } = await t.login('beheer');
    const headers = { ...t.pub, cookie, origin: ORIGIN };
    const post = (payload: object) => t.app.inject({ method: 'POST', url: '/api/admin/users', headers, payload });
    expect((await post({ username: 'X', role: 'viewer' })).statusCode).toBe(400);
    expect((await post({ username: 'oma', role: 'root' })).statusCode).toBe(400);
    expect((await post({ username: 'beheer', role: 'viewer' })).statusCode).toBe(409);
  });
});
