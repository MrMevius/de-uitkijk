import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCameraConfig } from '@uitkijk/shared';
import { StateHub } from '../src/hub.ts';
import { MockSource } from '../src/mock/mock-source.ts';

const load = (file: string) =>
  parseCameraConfig(JSON.parse(readFileSync(new URL(`../../../config/${file}`, import.meta.url), 'utf8')));

function setup(file = 'cameras.json') {
  const cameras = load(file);
  const hub = new StateHub('mock', cameras, 15_000);
  const mock = new MockSource(
    hub,
    cameras.map((c) => c.id),
  );
  const focus = () => hub.snapshot().focus.map((f) => `${f.cameraId}:${f.reason}`);
  return { hub, mock, focus };
}

/** Advance fake time to an absolute offset from the scenario start. */
let t0 = 0;
const at = async (ms: number) => vi.advanceTimersByTimeAsync(t0 + ms - Date.now());

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-08T12:00:00Z'));
  t0 = Date.now();
});
afterEach(() => vi.useRealTimers());

describe('mock scenarios drive the focus state machine', () => {
  it('single alert: focus, 15 s hold, return to standard layout', async () => {
    const { mock, focus, hub } = setup();
    mock.start('single-alert');
    expect(focus()).toEqual([]);
    await at(2_000);
    expect(focus()).toEqual(['voordeur:alert']);
    expect(hub.snapshot().focus[0]!.labels).toEqual(['person']);
    await at(12_000);
    expect(focus()).toEqual(['voordeur:hold']);
    expect(hub.snapshot().focus[0]!.holdUntil).toBe(t0 + 27_000);
    await at(26_999);
    expect(focus()).toEqual(['voordeur:hold']);
    await at(27_000);
    expect(focus()).toEqual([]);
  });

  it('multiple simultaneous alerts end independently, each with its own hold', async () => {
    const { mock, focus } = setup();
    mock.start('multi-alert');
    await at(6_000);
    expect(focus()).toEqual(['oprit:alert', 'achter_1:alert', 'achter_2:alert']);
    await at(12_000);
    expect(focus()).toEqual(['oprit:hold', 'achter_1:alert', 'achter_2:alert']);
    await at(27_000); // oprit hold (12 s + 15 s) has expired
    expect(focus()).toEqual(['achter_1:hold', 'achter_2:hold']);
    await at(31_000);
    expect(focus()).toEqual(['achter_2:hold']);
    await at(35_000);
    expect(focus()).toEqual([]);
  });

  it('expiration and reactivation: a new alert cancels the hold timer', async () => {
    const { mock, focus, hub } = setup();
    mock.start('expire-reactivate');
    await at(6_000);
    expect(hub.snapshot().focus[0]!.holdUntil).toBe(t0 + 21_000);
    await at(14_000);
    expect(focus()).toEqual(['voordeur:alert']);
    await at(21_000); // the first hold would have expired here; the new one runs from 18 s
    expect(focus()).toEqual(['voordeur:hold']);
    expect(hub.snapshot().focus[0]!.holdUntil).toBe(t0 + 33_000);
    await at(18_000 + 15_000 - 1);
    expect(focus()).toEqual(['voordeur:hold']);
    await at(33_000);
    expect(focus()).toEqual([]);
    await at(40_000);
    expect(focus()).toEqual(['voordeur:alert']);
  });

  it('loops deterministically', async () => {
    const { mock, focus } = setup();
    mock.start('single-alert');
    await at(40_000 + 2_000);
    expect(focus()).toEqual(['voordeur:alert']);
  });

  it('camera disconnect and reconnect', async () => {
    const { mock, hub } = setup();
    mock.start('camera-disconnect');
    const availability = () => hub.snapshot().cameras.map((c) => c.availability);
    await at(0);
    expect(availability()).toEqual(['online', 'online', 'online', 'online']);
    await at(5_000);
    expect(availability()).toEqual(['online', 'online', 'offline', 'online']);
    await at(20_000);
    expect(availability()).toEqual(['online', 'online', 'online', 'online']);
  });

  it('alert source unavailable releases focus through the normal hold and recovers', async () => {
    const { mock, focus, hub } = setup();
    mock.start('frigate-unavailable');
    await at(2_000);
    expect(focus()).toEqual(['oprit:alert']);
    await at(6_000);
    expect(hub.snapshot().health.alerts.status).toBe('down');
    expect(focus()).toEqual(['oprit:hold']);
    await at(21_000);
    expect(focus()).toEqual([]);
    await at(30_000);
    expect(hub.snapshot().health.alerts.status).toBe('mock');
    expect(focus()).toEqual(['oprit:alert']);
  });

  it('streaming unavailable is reported in health', async () => {
    const { mock, hub } = setup();
    mock.start('streaming-unavailable');
    await at(3_000);
    expect(hub.snapshot().health.streaming.status).toBe('down');
    expect(mock.streamingSimulated).toBe(true);
    await at(25_000);
    expect(hub.snapshot().health.streaming.status).toBe('ok');
  });

  it('nine cameras: alerts on three cameras, order stays shared', async () => {
    const { mock, focus, hub } = setup('cameras-9.mock.json');
    mock.start('nine-cameras');
    await at(4_000);
    expect(hub.snapshot().cameras).toHaveLength(9);
    expect(focus()).toEqual(['voordeur:alert', 'mock_5:alert', 'mock_9:alert']);
  });

  it('ignores scenario steps for cameras that are not configured', async () => {
    const { mock, focus } = setup('cameras.json');
    mock.start('nine-cameras');
    await at(4_000);
    expect(focus()).toEqual(['voordeur:alert']);
  });

  it('switching scenarios resets state and cancels pending steps', async () => {
    const { mock, focus } = setup();
    mock.start('single-alert');
    await at(2_000);
    mock.start('idle');
    await at(60_000);
    expect(focus()).toEqual([]);
  });
});
