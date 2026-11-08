import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCameraConfig, type DashboardState } from '@uitkijk/shared';
import { buildApp } from '../src/app.ts';
import { StateHub } from '../src/hub.ts';
import { MockSource } from '../src/mock/mock-source.ts';
import { StreamingProbe } from '../src/streaming-probe.ts';

const cameras = parseCameraConfig(
  JSON.parse(readFileSync(new URL('../../../config/cameras.json', import.meta.url), 'utf8')),
);

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

function mockApp() {
  const hub = new StateHub('mock', cameras, 15_000);
  const mock = new MockSource(
    hub,
    cameras.map((c) => c.id),
  );
  mock.start('idle');
  const app = buildApp({ hub, mock });
  cleanup.push(() => mock.stop(), () => hub.stop(), () => app.close());
  return { hub, mock, app };
}

describe('HTTP API', () => {
  it('returns the dashboard state without any source URLs', async () => {
    const { app } = mockApp();
    const res = await app.inject('/api/state');
    const state = res.json<DashboardState>();
    expect(state.mode).toBe('mock');
    expect(state.cameras.map((c) => c.name)).toEqual([
      'Oprit / Pad',
      'Voordeur',
      'Achter het huis 1',
      'Achter het huis 2 / Schuur',
    ]);
    expect(res.body).not.toMatch(/rtsp:|@|password/i);
  });

  it('switches mock scenarios through the dev API and rejects unknown ones', async () => {
    const { app } = mockApp();
    expect((await app.inject('/api/dev/scenarios')).json().scenarios.length).toBeGreaterThan(5);
    const ok = await app.inject({ method: 'POST', url: '/api/dev/scenario', payload: { name: 'multi-alert' } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject('/api/state')).json().scenario).toBe('multi-alert');
    const bad = await app.inject({ method: 'POST', url: '/api/dev/scenario', payload: { name: 'nope' } });
    expect(bad.statusCode).toBe(400);
  });

  it('has no dev API in live mode', async () => {
    const hub = new StateHub('live', cameras, 15_000);
    const app = buildApp({ hub });
    cleanup.push(() => app.close());
    expect((await app.inject('/api/dev/scenarios')).statusCode).toBe(404);
    expect((await app.inject('/api/health')).json()).toMatchObject({ status: 'ok', mode: 'live' });
  });

  it('streams state changes over server-sent events', async () => {
    const { app, hub } = mockApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as { port: number };
    const controller = new AbortController();
    cleanup.unshift(() => controller.abort());
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const nextState = async (): Promise<DashboardState> => {
      for (;;) {
        const match = buffer.match(/event: state\ndata: (.*)\n\n/);
        if (match) {
          buffer = buffer.slice(match.index! + match[0].length);
          return JSON.parse(match[1]!);
        }
        const { value } = await reader.read();
        buffer += decoder.decode(value);
      }
    };
    expect((await nextState()).focus).toEqual([]);
    hub.setActiveAlerts([{ id: 'x', cameraId: 'oprit', labels: ['person'] }]);
    expect((await nextState()).focus).toMatchObject([{ cameraId: 'oprit', reason: 'alert' }]);
  });
});

describe('StreamingProbe', () => {
  it('reports go2rtc up and down and can be suppressed', async () => {
    const hub = new StateHub('mock', cameras, 15_000);
    let up = true;
    let suppressed = false;
    const probe = new StreamingProbe(hub, 'http://go2rtc:1984', {
      suppressed: () => suppressed,
      fetch: (async () => {
        if (!up) throw new Error('down');
        return new Response('{}');
      }) as typeof fetch,
    });
    cleanup.push(() => probe.stop());
    await probe.check();
    expect(hub.snapshot().health.streaming.status).toBe('ok');
    up = false;
    await probe.check();
    expect(hub.snapshot().health.streaming.status).toBe('down');
    up = true;
    suppressed = true;
    await probe.check();
    expect(hub.snapshot().health.streaming.status).toBe('down');
  });
});
