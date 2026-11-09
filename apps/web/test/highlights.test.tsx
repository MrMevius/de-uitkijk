import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HighlightSummary } from '@uitkijk/shared';
import { highlightStrip, highlightTime, useHighlightRotation } from '../src/highlights.tsx';

const h = (id: string, score = 3): HighlightSummary => ({
  id,
  cameraId: 'voordeur',
  cameras: ['voordeur'],
  startTime: 1_794_000_000,
  endTime: 1_794_000_020,
  clipDuration: 24,
  description: 'Persoon bij Voordeur',
  ruleDescription: 'Persoon bij Voordeur',
  aiDescribed: false,
  aiNoise: false,
  annotation: null,
  score,
  reasons: [],
  feedback: null,
  hasThumbnail: true,
});

let rotation: HighlightSummary[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(rotation))));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));

describe('highlight rotation', () => {
  it('shows nothing without highlights', async () => {
    rotation = [];
    const { result } = renderHook(() => useHighlightRotation(false));
    await flush();
    expect(result.current.current).toBeNull();
  });

  it('plays in order, puts newly arrived highlights next, and continues after an alert with the next one', async () => {
    rotation = [h('a', 4), h('b', 3)];
    const { result, rerender } = renderHook(({ paused }) => useHighlightRotation(paused), { initialProps: { paused: false } });
    await flush();
    expect(result.current.current?.id).toBe('a');

    rotation = [h('a', 4), h('c', 3.5), h('b', 3)];
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
    act(() => result.current.next());
    expect(result.current.current?.id).toBe('c');

    rerender({ paused: true });
    expect(result.current.current).toBeNull();
    rerender({ paused: false });
    await flush();
    expect(result.current.current?.id).toBe('b');
  });

  it('replays a single highlight with a new play key each turn', async () => {
    rotation = [h('a')];
    const { result } = renderHook(() => useHighlightRotation(false));
    await flush();
    const first = result.current.playKey;
    expect(result.current.current?.id).toBe('a');
    act(() => result.current.next());
    expect(result.current.current?.id).toBe('a');
    expect(result.current.playKey).not.toBe(first);
  });

  it('hides a failing highlight, plays others, and only retries after a pause', async () => {
    rotation = [h('a', 4), h('b', 3)];
    const { result } = renderHook(() => useHighlightRotation(false));
    await flush();
    expect(result.current.current?.id).toBe('a');
    act(() => result.current.fail('a'));
    await flush();
    expect(result.current.current?.id).toBe('b');
    act(() => result.current.fail('b'));
    await flush();
    expect(result.current.current).toBeNull();
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(result.current.current).toBeNull();
    await act(async () => void (await vi.advanceTimersByTimeAsync(10 * 60_000)));
    expect(result.current.current).not.toBeNull();
  });

  it('gives the highlight a strip of about a fifth of the screen beside or below the cameras', () => {
    const land = highlightStrip(1920, 1080, 8);
    expect(land.cameras).toEqual({ width: 1920 - 422, height: 1080 });
    expect(land.highlight).toEqual({ x: 1498, y: 424, w: 414, h: 233 });
    expect(land.highlight.x + land.highlight.w).toBe(1920 - 8);
    const port = highlightStrip(390, 800, 6);
    expect(port.cameras).toEqual({ width: 390, height: 800 - 176 });
    expect(port.highlight.w).toBe(302);
    expect(port.highlight.y + port.highlight.h).toBeLessThanOrEqual(800);
  });

  it('formats times relative to today in Amsterdam', () => {
    const now = Date.UTC(2026, 10, 8, 19, 0);
    expect(highlightTime(Date.UTC(2026, 10, 8, 13, 32) / 1000, now)).toBe('vandaag 14:32');
    expect(highlightTime(Date.UTC(2026, 10, 7, 21, 10) / 1000, now)).toBe('gisteren 22:10');
  });
});
