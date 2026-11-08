import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  backoffDelay,
  CameraConfigError,
  formatClock,
  formatDutchDate,
  parseCameraConfig,
  summarizeHealth,
  type DashboardState,
} from '../src/index.ts';

const readConfig = (name: string) => JSON.parse(readFileSync(new URL(`../../../config/${name}`, import.meta.url), 'utf8'));
const cam = (id: string) => ({ id, name: id, streams: { main: `${id}_main`, sub: `${id}_sub` } });

describe('camera configuration', () => {
  it('loads the four logical locations in the shared order', () => {
    const cams = parseCameraConfig(readConfig('cameras.json'));
    expect(cams.map((c) => [c.order, c.name])).toEqual([
      [0, 'Oprit / Pad'],
      [1, 'Voordeur'],
      [2, 'Achter het huis 1'],
      [3, 'Achter het huis 2 / Schuur'],
    ]);
  });

  it('loads the nine-camera fixture and keeps the first four in the same order', () => {
    const nine = parseCameraConfig(readConfig('cameras-9.mock.json'));
    const four = parseCameraConfig(readConfig('cameras.json'));
    expect(nine).toHaveLength(9);
    expect(nine.slice(0, 4).map((c) => c.id)).toEqual(four.map((c) => c.id));
  });

  it('rejects more than nine cameras', () => {
    const ten = { cameras: Array.from({ length: 10 }, (_, i) => cam(`c${i}`)) };
    expect(() => parseCameraConfig(ten)).toThrow(CameraConfigError);
  });

  it('rejects duplicate ids, bad stream names and duplicate Frigate mappings', () => {
    expect(() => parseCameraConfig({ cameras: [cam('a'), cam('a')] })).toThrow(/duplicate id/);
    expect(() => parseCameraConfig({ cameras: [{ ...cam('a'), streams: { main: 'rtsp://x', sub: 'a' } }] })).toThrow(
      /streams.main/,
    );
    expect(() =>
      parseCameraConfig({ cameras: [{ ...cam('a'), frigateCamera: 'x' }, { ...cam('b'), frigateCamera: 'x' }] }),
    ).toThrow(/mapped twice/);
  });
});

describe('backoff', () => {
  const noJitter = () => 0.5;
  it('grows exponentially and is capped', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map((a) => backoffDelay(a, {}, noJitter))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });
  it('never drops below the base delay or exceeds the cap with jitter', () => {
    expect(backoffDelay(0, {}, () => 0)).toBe(1_000);
    expect(backoffDelay(20, {}, () => 1)).toBe(30_000);
  });
});

describe('Dutch date and clock in Europe/Amsterdam', () => {
  it('formats winter time (UTC+1)', () => {
    const t = Date.UTC(2026, 10, 8, 23, 5); // 2026-11-08 23:05 UTC
    expect(formatClock(t)).toBe('00:05');
    expect(formatDutchDate(t)).toBe('maandag 9 november');
  });
  it('formats summer time (UTC+2) with a 24-hour clock', () => {
    const t = Date.UTC(2026, 6, 1, 14, 30);
    expect(formatClock(t)).toBe('16:30');
    expect(formatDutchDate(t)).toBe('woensdag 1 juli');
  });
});

describe('health summary', () => {
  const base: DashboardState = {
    mode: 'live',
    cameras: parseCameraConfig(readConfig('cameras.json')).map((c) => ({ ...c, availability: 'online' })),
    focus: [],
    health: { alerts: { status: 'ok' }, streaming: { status: 'ok' } },
    serverTime: 0,
  };
  it('is ok when everything is up', () => {
    expect(summarizeHealth(base, true)).toEqual({ level: 'ok', messages: [] });
  });
  it('reports Frigate, streaming, offline cameras and backend loss', () => {
    const state: DashboardState = {
      ...base,
      cameras: base.cameras.map((c, i) => (i < 2 ? { ...c, availability: 'offline' } : c)),
      health: { alerts: { status: 'down' }, streaming: { status: 'down' } },
    };
    expect(summarizeHealth(state, false)).toEqual({
      level: 'error',
      messages: ['Server niet bereikbaar', 'Streamingdienst niet bereikbaar', 'Frigate niet bereikbaar', "2 camera's offline"],
    });
  });
});
