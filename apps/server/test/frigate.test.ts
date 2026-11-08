import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCameraConfig } from '@uitkijk/shared';
import { loadConfig } from '../src/config.ts';
import { FrigateSource, toActiveAlerts, type FrigateReviewItem } from '../src/frigate/frigate-source.ts';
import { StateHub } from '../src/hub.ts';

const cameras = parseCameraConfig(
  JSON.parse(readFileSync(new URL('../../../config/cameras.json', import.meta.url), 'utf8')),
);
const byName = new Map(cameras.map((c) => [c.frigateCamera!, c]));
const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);

const review = (id: string, camera: string, end: number | null, extra: Partial<FrigateReviewItem> = {}) => ({
  id,
  camera,
  start_time: NOW / 1000 - 20,
  end_time: end,
  severity: 'alert' as const,
  data: { objects: ['person'] },
  ...extra,
});

describe('toActiveAlerts', () => {
  it('keeps only open alert segments of configured cameras', () => {
    const items = [
      review('open', 'Vriezenveen_voordeur', null),
      review('closed', 'Vriezenveen_oprit', NOW / 1000 - 5),
      review('detection', 'Vriezenveen_oprit', null, { severity: 'detection' }),
      review('unknown', 'Garage', null),
      review('stale', 'Vriezenveen_achter_thuis_1', null, { start_time: NOW / 1000 - 3_600 }),
    ];
    expect(toActiveAlerts(items, byName, NOW, 1_800_000)).toEqual([
      { id: 'open', cameraId: 'voordeur', labels: ['person'] },
    ]);
  });
});

describe('FrigateSource', () => {
  let responses: Record<string, unknown>;
  let failing: boolean;
  let requested: string[];
  const fakeFetch = (async (input: string | URL) => {
    const url = String(input);
    requested.push(url);
    if (failing) throw new Error('connect ECONNREFUSED');
    const path = new URL(url).pathname;
    return new Response(JSON.stringify(responses[path]), { status: 200 });
  }) as typeof fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    failing = false;
    requested = [];
    responses = {
      '/api/config': { cameras: Object.fromEntries(cameras.map((c) => [c.frigateCamera, {}])) },
      '/api/review': [],
      '/api/stats': {
        cameras: {
          Vriezenveen_oprit: { camera_fps: 5 },
          Vriezenveen_voordeur: { camera_fps: 5 },
          Vriezenveen_achter_thuis_1: { camera_fps: 0 },
        },
      },
    };
  });
  afterEach(() => vi.useRealTimers());

  function setup() {
    const hub = new StateHub('live', cameras, 15_000);
    const logs: string[] = [];
    const source = new FrigateSource(hub, cameras, {
      url: 'http://frigate.test:5000',
      pollMs: 2_000,
      maxAlertAgeMs: 1_800_000,
      fetch: fakeFetch,
      log: (m) => logs.push(m),
    });
    return { hub, source, logs };
  }

  it('polls review alerts for configured cameras with a bounded look-back window', async () => {
    const { source } = setup();
    await source.tick();
    const reviewUrl = new URL(requested.find((u) => u.includes('/api/review'))!);
    expect(reviewUrl.searchParams.get('severity')).toBe('alert');
    expect(Number(reviewUrl.searchParams.get('after'))).toBe(NOW / 1000 - 120);
    expect(reviewUrl.searchParams.get('cameras')!.split(',')).toHaveLength(4);
    source.stop();
  });

  it('focuses on an open alert and holds 15 s after Frigate closes it', async () => {
    const { hub, source } = setup();
    responses['/api/review'] = [review('a', 'Vriezenveen_voordeur', null, { data: { objects: ['car'] } })];
    await source.tick();
    expect(hub.snapshot().focus).toEqual([{ cameraId: 'voordeur', reason: 'alert', labels: ['car'], holdUntil: null }]);
    expect(hub.snapshot().health.alerts.status).toBe('ok');

    await vi.advanceTimersByTimeAsync(10_000);
    responses['/api/review'] = [review('a', 'Vriezenveen_voordeur', NOW / 1000 - 30)];
    await source.tick();
    expect(hub.snapshot().focus[0]).toMatchObject({ reason: 'hold', holdUntil: Date.now() + 15_000 });
    source.stop();
  });

  it('derives camera availability from Frigate camera fps', async () => {
    const { hub, source } = setup();
    await source.tick();
    expect(hub.snapshot().cameras.map((c) => c.availability)).toEqual(['online', 'online', 'offline', 'unknown']);
    source.stop();
  });

  it('reports Frigate down after three failures and releases alerts through the hold', async () => {
    const { hub, source } = setup();
    responses['/api/review'] = [review('a', 'Vriezenveen_oprit', null)];
    await source.tick();
    failing = true;
    await source.tick();
    await source.tick();
    expect(hub.snapshot().health.alerts.status).toBe('ok');
    expect(hub.snapshot().focus[0]!.reason).toBe('alert');
    await source.tick();
    expect(hub.snapshot().health.alerts).toMatchObject({ status: 'down' });
    expect(hub.snapshot().focus[0]!.reason).toBe('hold');
    expect(hub.snapshot().cameras.every((c) => c.availability === 'unknown')).toBe(true);
    source.stop();
  });

  it('backs off between failed polls up to a bounded maximum', async () => {
    const { source } = setup();
    failing = true;
    source.start();
    await vi.advanceTimersByTimeAsync(0);
    const count = () => requested.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // Without backoff ten minutes at 2 s would be 300 polls; capped at 30 s it is roughly 25.
    expect(count()).toBeLessThan(40);
    expect(count()).toBeGreaterThan(15);
    source.stop();
  });

  it('logs configured cameras that Frigate does not know', async () => {
    responses['/api/config'] = { cameras: { Vriezenveen_oprit: {}, Garage: {} } };
    const { source, logs } = setup();
    await source.tick();
    expect(logs.join('\n')).toMatch(/not found: Vriezenveen_voordeur/);
    expect(logs.join('\n')).toMatch(/not shown on the dashboard: Garage/);
    source.stop();
  });
});

describe('server configuration', () => {
  const base = { UITKIJK_CAMERA_CONFIG: new URL('../../../config/cameras.json', import.meta.url).pathname };
  it('defaults to mock mode with the dev API enabled', () => {
    const c = loadConfig(base);
    expect(c.mode).toBe('mock');
    expect(c.devApi).toBe(true);
    expect(c.holdMs).toBe(15_000);
  });
  it('requires a Frigate URL without credentials in live mode', () => {
    expect(() => loadConfig({ ...base, UITKIJK_MODE: 'live' })).toThrow(/FRIGATE_URL/);
    expect(() => loadConfig({ ...base, UITKIJK_MODE: 'live', FRIGATE_URL: 'http://u:p@frigate:5000' })).toThrow(
      /credentials/,
    );
    const c = loadConfig({ ...base, UITKIJK_MODE: 'live', FRIGATE_URL: 'http://frigate:5000/' });
    expect(c.frigate?.url).toBe('http://frigate:5000');
    expect(c.devApi).toBe(false);
  });
});
