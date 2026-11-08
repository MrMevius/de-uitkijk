import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hashPassword, passwordProblem, verifyPassword } from './passwords.ts';
import { usernameProblem, type AuthStore, type Role, type User } from './store.ts';

export const SESSION_COOKIE = 'uitkijk_session';
/** Sessions never expire (operator decision); the cookie lives as long as browsers allow and is renewed on use. */
const COOKIE_MAX_AGE_S = 400 * 24 * 3600;

/** Header set by the edge: the client address (as seen by SWAG on the public listener). */
export const CLIENT_HEADER = 'x-uitkijk-client';

export interface AuthOptions {
  store: AuthStore;
  /** External HTTPS base URL, used for one-time links and the Origin check. */
  publicUrl: string;
  now?: () => number;
}

/** Routes that work without a session. */
const OPEN = new Set(['/api/health', '/api/health/detail', '/api/auth/login', '/api/auth/logout', '/api/auth/link', '/api/auth/activate']);

const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES_PER_IP = 10;
const MAX_FAILURES_PER_USER = 5;

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

/** Counts failed logins per key within a fixed window. In memory: a restart resets it, which is acceptable. */
class FailureCounter {
  private readonly entries = new Map<string, { count: number; since: number }>();
  private readonly now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }
  blocked(key: string, max: number): boolean {
    const e = this.entries.get(key);
    if (!e) return false;
    if (this.now() - e.since > WINDOW_MS) {
      this.entries.delete(key);
      return false;
    }
    return e.count >= max;
  }
  fail(key: string): void {
    const e = this.entries.get(key);
    if (!e || this.now() - e.since > WINDOW_MS) this.entries.set(key, { count: 1, since: this.now() });
    else e.count++;
  }
  clear(key: string): void {
    this.entries.delete(key);
  }
}

function cookieValue(request: FastifyRequest, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.header(
    'set-cookie',
    `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Strict`,
  );
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
}

const publicUser = (u: User) => ({ id: u.id, username: u.username, role: u.role, active: u.active });

/**
 * Login for every viewer (operator decision: one public address, login everywhere).
 *
 * Every API route except health, login, logout and the one-time-link routes needs a session;
 * administration needs the admin role. Video is checked by the edge through `/api/auth/check`.
 */
export function registerAuth(app: FastifyInstance, { store, publicUrl, now = Date.now }: AuthOptions): void {
  const origin = new URL(publicUrl).origin;
  const failures = new FailureCounter(now);
  const linkFor = (token: string) => `${origin}/activeer#${token}`;

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]!;
    if (!path.startsWith('/api/')) return;
    // Cross-site writes: SameSite=Strict already blocks the cookie; also reject foreign origins outright.
    const requestOrigin = request.headers.origin;
    if (request.method !== 'GET' && request.method !== 'HEAD' && requestOrigin && requestOrigin !== origin) {
      return reply.code(403).send({ error: 'Onbekende herkomst' });
    }
    request.user = store.sessionUser(cookieValue(request, SESSION_COOKIE));
    if (OPEN.has(path)) return;
    if (!request.user) return reply.code(401).send({ error: 'Niet ingelogd' });
    if (path.startsWith('/api/admin/') && request.user.role !== 'admin') {
      return reply.code(403).send({ error: 'Alleen voor beheerders' });
    }
  });

  const clientKey = (request: FastifyRequest) => {
    const forwarded = request.headers[CLIENT_HEADER];
    return `ip:${typeof forwarded === 'string' && forwarded ? forwarded : request.ip}`;
  };

  app.post<{ Body: { username?: unknown; password?: unknown } }>('/api/auth/login', async (request, reply) => {
    const username = typeof request.body?.username === 'string' ? request.body.username.trim().toLowerCase() : '';
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    const ipKey = clientKey(request);
    const userKey = `user:${username}`;
    if (failures.blocked(ipKey, MAX_FAILURES_PER_IP) || failures.blocked(userKey, MAX_FAILURES_PER_USER)) {
      return reply.code(429).send({ error: 'Te veel mislukte pogingen, probeer het over 15 minuten opnieuw' });
    }
    const user = username ? store.findUser(username) : undefined;
    const ok = await verifyPassword(password, user?.passwordHash ?? null);
    if (!user || !ok) {
      failures.fail(ipKey);
      failures.fail(userKey);
      request.log.warn({ username, client: ipKey }, 'login failed');
      return reply.code(401).send({ error: 'Onjuiste gebruikersnaam of wachtwoord' });
    }
    failures.clear(userKey);
    setSessionCookie(reply, store.createSession(user.id));
    request.log.info({ username }, 'login');
    return publicUser(user);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = cookieValue(request, SESSION_COOKIE);
    if (token) store.deleteSession(token);
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  /** The dashboard calls this on load and daily; it renews the cookie so a TV stays logged in. */
  app.get('/api/auth/me', async (request, reply) => {
    const token = cookieValue(request, SESSION_COOKIE);
    if (token) setSessionCookie(reply, token);
    return publicUser(request.user!);
  });

  /** Used by the edge (`auth_request`, cached there) before it proxies a video stream. 200 so nginx can cache it. */
  app.get('/api/auth/check', async () => 'ok');

  app.post<{ Body: { token?: unknown } }>('/api/auth/link', async (request, reply) => {
    const link = typeof request.body?.token === 'string' ? store.peekLink(request.body.token) : undefined;
    if (!link) return reply.code(404).send({ error: 'Deze link is ongeldig of verlopen' });
    return { username: link.user.username, purpose: link.purpose };
  });

  app.post<{ Body: { token?: unknown; password?: unknown } }>('/api/auth/activate', async (request, reply) => {
    const problem = passwordProblem(request.body?.password);
    if (problem) return reply.code(400).send({ error: problem });
    const token = typeof request.body?.token === 'string' ? request.body.token : '';
    if (!store.peekLink(token)) return reply.code(404).send({ error: 'Deze link is ongeldig of verlopen' });
    const user = store.redeemLink(token, await hashPassword(request.body!.password as string));
    if (!user) return reply.code(404).send({ error: 'Deze link is ongeldig of verlopen' });
    setSessionCookie(reply, store.createSession(user.id));
    request.log.info({ username: user.username }, 'password set through one-time link');
    return publicUser(user);
  });

  // --- Administration -----------------------------------------------------------------------------

  app.get('/api/admin/users', async () => store.listUsers().map(publicUser));

  app.post<{ Body: { username?: unknown; role?: unknown } }>('/api/admin/users', async (request, reply) => {
    const username = typeof request.body?.username === 'string' ? request.body.username.trim().toLowerCase() : '';
    const role = request.body?.role;
    const problem = usernameProblem(username);
    if (problem) return reply.code(400).send({ error: problem });
    if (role !== 'admin' && role !== 'viewer') return reply.code(400).send({ error: 'Onbekende rol' });
    if (store.findUser(username)) return reply.code(409).send({ error: 'Gebruikersnaam bestaat al' });
    const user = store.createUser(username, role as Role);
    request.log.info({ by: request.user!.username, username, role }, 'user created');
    return reply.code(201).send({ user: publicUser(user), link: linkFor(store.createLink(user.id, 'activate')) });
  });

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/link', async (request, reply) => {
    const user = store.getUser(Number(request.params.id));
    if (!user) return reply.code(404).send({ error: 'Gebruiker niet gevonden' });
    const link = linkFor(store.createLink(user.id, user.active ? 'reset' : 'activate'));
    request.log.info({ by: request.user!.username, username: user.username }, 'one-time link created');
    return { link };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/users/:id', async (request, reply) => {
    const user = store.getUser(Number(request.params.id));
    if (!user) return reply.code(404).send({ error: 'Gebruiker niet gevonden' });
    if (user.id === request.user!.id) return reply.code(400).send({ error: 'Je kunt jezelf niet verwijderen' });
    if (user.role === 'admin' && store.adminCount() <= 1) {
      return reply.code(400).send({ error: 'De laatste beheerder kan niet worden verwijderd' });
    }
    store.deleteUser(user.id);
    request.log.info({ by: request.user!.username, username: user.username }, 'user deleted');
    return reply.code(204).send();
  });
}
