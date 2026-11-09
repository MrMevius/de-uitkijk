import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

/** Credentials for Frigate's authenticated API (port 8971): a dedicated viewer account. */
export interface FrigateAuth {
  username: string;
  password: string;
  /** PEM of Frigate's own (self-signed) certificate, pinned instead of trusting public CAs. */
  certificate: string;
}

/** Reads `{ "username", "password", "certificate" }`; an empty or missing file means no authentication. */
export function readFrigateAuth(path: string | undefined): FrigateAuth | undefined {
  if (!path) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  const json = JSON.parse(raw) as Partial<FrigateAuth>;
  if (!json.username || !json.password || !json.certificate?.includes('BEGIN CERTIFICATE')) {
    throw new Error('Frigate auth file needs username, password and certificate');
  }
  return { username: json.username, password: json.password, certificate: json.certificate };
}

type Fetch = typeof fetch;

/** One HTTPS request that trusts only the pinned certificate (Frigate's default certificate has CN "*"). */
function pinnedFetch(certificate: string): Fetch {
  return ((input: string | URL, init: RequestInit = {}) =>
    new Promise<Response>((resolve, reject) => {
      const headers = new Headers(init.headers);
      const body = typeof init.body === 'string' || init.body instanceof Uint8Array ? init.body : undefined;
      const req = httpsRequest(
        String(input),
        {
          method: init.method ?? 'GET',
          headers: Object.fromEntries(headers),
          ca: certificate,
          // The pinned self-signed certificate is the trust anchor; its name ("*") does not match an IP.
          checkServerIdentity: () => undefined,
          ...(init.signal ? { signal: init.signal } : {}),
        },
        (res) => {
          const out = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) v.forEach((x) => out.append(k, x));
            else if (v !== undefined) out.set(k, v);
          }
          const status = res.statusCode ?? 500;
          const stream = status === 204 || status === 304 ? null : (Readable.toWeb(res) as ReadableStream);
          resolve(new Response(stream, { status, headers: out }));
        },
      );
      req.on('error', reject);
      req.end(body);
    })) as Fetch;
}

/**
 * A `fetch` for Frigate. Without credentials it is the global fetch (internal port 5000). With credentials it
 * logs in to the authenticated API as a viewer, sends the session cookie, pins Frigate's certificate and logs
 * in again once when Frigate answers 401 (expired session).
 */
export function frigateFetch(baseUrl: string, auth: FrigateAuth | undefined): Fetch {
  if (!auth) return globalThis.fetch;
  const base = baseUrl.replace(/\/$/, '');
  const raw = pinnedFetch(auth.certificate);
  let cookie: string | undefined;
  let login: Promise<string> | undefined;

  const signIn = () =>
    (login ??= (async () => {
      const res = await raw(`${base}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user: auth.username, password: auth.password }),
        signal: AbortSignal.timeout(10_000),
      });
      await res.body?.cancel();
      const token = /frigate_token=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
      if (!res.ok || !token) throw new Error(`Frigate login failed (HTTP ${res.status})`);
      return `frigate_token=${token}`;
    })().finally(() => (login = undefined)));

  return (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (!url.startsWith(`${base}/`)) throw new Error('frigateFetch only serves the Frigate base URL');
    const send = (c: string) => raw(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), cookie: c } });
    cookie ??= await signIn();
    let res = await send(cookie);
    if (res.status === 401) {
      await res.body?.cancel();
      cookie = await signIn();
      res = await send(cookie);
    }
    return res;
  }) as Fetch;
}
