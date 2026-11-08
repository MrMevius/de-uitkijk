import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { frigateFetch, readFrigateAuth } from '../src/frigate/client.ts';

function selfSigned(dir: string, name: string) {
  const key = join(dir, `${name}.key`);
  const cert = join(dir, `${name}.pem`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/O=FRIGATE DEFAULT CERT/CN=*', '-keyout', key, '-out', cert], {
    stdio: 'ignore',
  });
  return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') };
}

let dir: string;
let server: Server;
let base: string;
let pem: { key: string; cert: string };
let other: { key: string; cert: string };
let validToken = 'token-1';
const seenCookies: string[] = [];
let logins = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'frigate-client-'));
  pem = selfSigned(dir, 'frigate');
  other = selfSigned(dir, 'other');
  server = createServer({ key: pem.key, cert: pem.cert }, (req, res) => {
    if (req.url === '/api/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        logins++;
        const { user, password } = JSON.parse(body) as { user: string; password: string };
        if (user !== 'uitkijk' || password !== 'geheim') return res.writeHead(401).end();
        res.writeHead(200, { 'set-cookie': `frigate_token=${validToken}; Path=/; HttpOnly` }).end('{}');
      });
      return;
    }
    seenCookies.push(req.headers.cookie ?? '');
    if (req.headers.cookie !== `frigate_token=${validToken}`) return res.writeHead(401).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ path: req.url }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Frigate client', () => {
  it('logs in as viewer, sends the session cookie and logs in again after a 401', async () => {
    const fetch = frigateFetch(base, { username: 'uitkijk', password: 'geheim', certificate: pem.cert });
    expect(await (await fetch(`${base}/api/review?x=1`)).json()).toEqual({ path: '/api/review?x=1' });
    expect(await (await fetch(`${base}/api/events`)).json()).toEqual({ path: '/api/events' });
    expect(logins).toBe(1);
    validToken = 'token-2';
    expect((await fetch(`${base}/api/stats`)).status).toBe(200);
    expect(logins).toBe(2);
    expect(seenCookies.at(-1)).toBe('frigate_token=token-2');
  });

  it('refuses a server that presents a different certificate', async () => {
    const fetch = frigateFetch(base, { username: 'uitkijk', password: 'geheim', certificate: other.cert });
    await expect(fetch(`${base}/api/version`)).rejects.toThrow();
  });

  it('reports a failed login and only serves the Frigate base URL', async () => {
    const wrong = frigateFetch(base, { username: 'uitkijk', password: 'fout', certificate: pem.cert });
    await expect(wrong(`${base}/api/version`)).rejects.toThrow('Frigate login failed (HTTP 401)');
    await expect(wrong('https://example.org/api/version')).rejects.toThrow('only serves the Frigate base URL');
  });

  it('reads the credentials file; empty means unauthenticated', () => {
    const empty = join(dir, 'empty.json');
    writeFileSync(empty, '');
    expect(readFrigateAuth(empty)).toBeUndefined();
    expect(readFrigateAuth(undefined)).toBeUndefined();
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ username: 'u', password: 'p' }));
    expect(() => readFrigateAuth(bad)).toThrow('certificate');
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify({ username: 'u', password: 'p', certificate: pem.cert }));
    expect(readFrigateAuth(good)).toMatchObject({ username: 'u' });
  });
});
