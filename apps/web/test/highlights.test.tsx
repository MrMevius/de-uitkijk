import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HighlightSummary } from '@uitkijk/shared';
import { HighlightTile, highlightCapacity, highlightStrip, highlightTime, useHighlightRotation } from '../src/highlights.tsx';

const h = (id: string, score = 3): HighlightSummary => ({
  id,
  cameraId: 'voordeur',
  cameras: ['voordeur'],
  startTime: 1_794_000_000,
  endTime: 1_794_000_020,
  clipDuration: 24,
  stillOffset: 6,
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

const ids = (r: { tiles: ({ highlight: HighlightSummary } | null)[] }) => r.tiles.map((t) => t?.highlight.id ?? null);

describe('highlight rotation', () => {
  it('shows nothing without highlights', async () => {
    rotation = [];
    const { result } = renderHook(() => useHighlightRotation(false, 5));
    await flush();
    expect(ids(result.current)).toEqual([null, null, null, null, null]);
  });

  it('gives a newly arrived highlight a tile at once, and fills the tiles again after an alert', async () => {
    rotation = [h('a', 4), h('b', 3)];
    const { result, rerender } = renderHook(({ paused }) => useHighlightRotation(paused), { initialProps: { paused: false } });
    await flush();
    expect(ids(result.current)).toEqual(['a']);

    rotation = [h('a', 4), h('c', 3.5), h('b', 3)];
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
    expect(ids(result.current)).toEqual(['c']);

    rerender({ paused: true });
    expect(result.current.tiles).toEqual([]);
    rerender({ paused: false });
    await flush();
    expect(ids(result.current)).toEqual(['b']);
  });

  it('plays a highlight once and again after the interval from the admin page, moving on when others wait', async () => {
    rotation = [h('a'), h('b'), h('c')];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/settings') ? { replayMinutes: 5 } : rotation))));
    const { result } = renderHook(() => useHighlightRotation(false, 2));
    await flush();
    expect(ids(result.current)).toEqual(['a', 'b']);
    await act(async () => void (await vi.advanceTimersByTimeAsync(4 * 60_000)));
    expect(ids(result.current)).toEqual(['a', 'b']);
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000 + 5_000)));
    // Tile 0 takes 'c' (waiting longest); tile 1 then takes 'a', which just left tile 0.
    expect(ids(result.current)).toEqual(['c', 'a']);
  });

  it('shows several different highlights at once and moves each tile on to one that is not shown', async () => {
    rotation = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => h(id));
    const { result } = renderHook(() => useHighlightRotation(false, 5));
    await flush();
    expect(ids(result.current)).toEqual(['a', 'b', 'c', 'd', 'e']);
    act(() => result.current.next(1));
    expect(ids(result.current)).toEqual(['a', 'f', 'c', 'd', 'e']);
    act(() => result.current.next(0));
    act(() => result.current.next(2));
    // The queue wraps: 'b' is free again, the others are still on screen.
    expect(ids(result.current)).toEqual(['g', 'f', 'b', 'd', 'e']);
    expect(new Set(ids(result.current)).size).toBe(5);
  });

  it('with fewer highlights than tiles keeps each on its tile and replays it in place', async () => {
    rotation = [h('a'), h('b')];
    const { result } = renderHook(() => useHighlightRotation(false, 5));
    await flush();
    expect(ids(result.current)).toEqual(['a', 'b', null, null, null]);
    const first = result.current.tiles[0]!;
    act(() => result.current.next(0));
    expect(ids(result.current)).toEqual(['a', 'b', null, null, null]);
    // Same play key: the tile is not rebuilt, so the clip is not loaded again; the round plays it again.
    expect(result.current.tiles[0]).toMatchObject({ playKey: first.playKey, round: first.round + 1 });
    rotation = [h('a'), h('b'), h('c')];
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
    expect(ids(result.current)).toEqual(['a', 'b', 'c', null, null]);
  });

  it('lets another highlight take over from a failing one, and keeps the still when there is none', async () => {
    rotation = [h('a', 4), h('b', 3)];
    const { result } = renderHook(() => useHighlightRotation(false));
    await flush();
    expect(ids(result.current)).toEqual(['a']);
    act(() => result.current.fail(0));
    await flush();
    expect(ids(result.current)).toEqual(['b']);
    // 'a' is skipped for ten minutes, so 'b' stays even though it fails too.
    act(() => result.current.fail(0));
    await flush();
    expect(ids(result.current)).toEqual(['b']);
    // At the next play (after ten minutes) 'a' may play again.
    await act(async () => void (await vi.advanceTimersByTimeAsync(10 * 60_000 + 5_000)));
    expect(ids(result.current)).toEqual(['a']);
  });

  it('puts five highlights in a column beside the cameras, fewer in a row on a phone', () => {
    const land = highlightStrip(1920, 1080, 8, 5);
    expect(land.cameras).toEqual({ width: 1920 - 374, height: 1080 });
    expect(land.highlights).toHaveLength(5);
    expect(land.highlights[0]).toEqual({ x: 1546, y: 9, w: 366, h: 206 });
    expect(land.highlights[4]!.y + land.highlights[4]!.h).toBeLessThanOrEqual(1080 - 8);
    // Two highlights keep the same size, centred.
    const two = highlightStrip(1920, 1080, 8, 2);
    expect(two.highlights.map((r) => r.w)).toEqual([366, 366]);
    expect(two.highlights[0]!.y).toBe(Math.round((1080 - 2 * 206 - 8) / 2));
    // A 4:3 screen: the column is capped at a quarter of the width.
    expect(highlightStrip(1024, 768, 8, 5).cameras.width).toBe(1024 - 256);

    expect(highlightCapacity(390, 800, 6)).toBe(2);
    const port = highlightStrip(390, 800, 6, 2);
    expect(port.highlights.map((r) => r.w)).toEqual([186, 186]);
    expect(port.cameras.height).toBe(800 - port.highlights[0]!.h - 6);
    expect(port.highlights[0]!.y + port.highlights[0]!.h).toBeLessThanOrEqual(800);
  });

  it('formats times relative to today in Amsterdam', () => {
    const now = Date.UTC(2026, 10, 8, 19, 0);
    expect(highlightTime(Date.UTC(2026, 10, 8, 13, 32) / 1000, now)).toBe('vandaag 14:32');
    expect(highlightTime(Date.UTC(2026, 10, 7, 21, 10) / 1000, now)).toBe('gisteren 22:10');
  });
});

describe('highlight tile', () => {
  it('stops at the most interesting moment after playing (0.25.0)', () => {
    const { container } = render(<HighlightTile highlight={h('a')} rect={{ x: 0, y: 0, w: 320, h: 180 }} cameraName="Voordeur" onFail={() => {}} />);
    const video = container.querySelector('video')!;
    fireEvent.ended(video);
    expect(video.currentTime).toBe(6);
  });
});
