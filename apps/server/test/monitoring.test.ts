import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCameraConfig } from '@uitkijk/shared';
import { buildApp } from '../src/app.ts';
import { AuthStore } from '../src/auth/store.ts';
import { CameraVideoProbe } from '../src/camera-probe.ts';
import { StateHub } from '../src/hub.ts';

const cameras = parseCameraConfig(
  JSON.parse(readFileSync(new URL('../../../config/cameras.json', import.meta.url), 'utf8')),
);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

const jpeg = new Uint8Array(2000).fill(1);
jpeg[0] = 0xff;
jpeg[1] = 0xd8;

describe('camera picture probe', () => {
  it('marks cameras ok or failed from one go2rtc frame each, one camera at a time', async () => {
    const requested: string[] = [];
    let active = 0;
    let maxActive = 0;
    const fetchImpl = (async (input: string | URL) => {
      const src = new URL(String(input)).searchParams.get('src')!;
      requested.push(src);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      if (src === 'achter_1_sub') return new Response('stream not found', { status: 500 });
      if (src === 'voordeur_sub') return new Response(new Uint8Array(10));
      return new Response(jpeg);
    }) as typeof fetch;
    const probe = new CameraVideoProbe(cameras, 'http://go2rtc:1984', { fetch: fetchImpl });
    expect(probe.snapshot().every((c) => c.video === 'unknown')).toBe(true);
    await probe.checkAll();
    expect(requested).toEqual(['oprit_sub', 'voordeur_sub', 'achter_1_sub', 'achter_2_sub']);
    expect(maxActive).toBe(1);
    expect(Object.fromEntries(probe.snapshot().map((c) => [c.id, c.video]))).toEqual({
      oprit: 'ok',
      voordeur: 'failed',
      achter_1: 'failed',
      achter_2: 'ok',
    });
  });
});

describe('monitoring detail endpoint', () => {
  it('is available without a session and reports version, cameras, highlights and AI', async () => {
    const hub = new StateHub('live', cameras, 15_000);
    const store = new AuthStore(':memory:');
    const app = buildApp({
      hub,
      version: '9.9.9',
      auth: { store, publicUrl: 'https://uitkijk.example.nl' },
      detail: () => ({ cameras: [{ id: 'oprit', video: 'ok', checkedAt: 1 }], highlights: { enabled: true, lastOkAt: 2, lastError: null }, ai: { enabled: false } }),
    });
    cleanup.push(() => app.close(), () => hub.stop(), () => store.close());
    const res = await app.inject('/api/health/detail');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ version: '9.9.9', cameras: [{ id: 'oprit', video: 'ok' }], highlights: { lastOkAt: 2 }, ai: { enabled: false } });
    expect((await app.inject('/api/health')).json()).toMatchObject({ version: '9.9.9' });
    expect((await app.inject('/api/state')).statusCode).toBe(401);
  });
});
