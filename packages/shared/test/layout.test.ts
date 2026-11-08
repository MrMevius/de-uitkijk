import { describe, expect, it } from 'vitest';
import { computeLayout, type Rect } from '../src/index.ts';

const W = 1920;
const H = 1080;
const opts = { width: W, height: H, gap: 8 };
const ids = (n: number) => Array.from({ length: n }, (_, i) => `cam${i + 1}`);

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01;
}

function subsets<T>(items: T[]): T[][] {
  return Array.from({ length: 2 ** items.length }, (_, mask) => items.filter((_, i) => mask & (1 << i)));
}

/** Row-major reading order: sort by row (y), then x. */
function readingOrder(rects: Record<string, Rect>, subset: string[]): string[] {
  return [...subset].sort((a, b) => rects[a]!.y - rects[b]!.y || rects[a]!.x - rects[b]!.x);
}

describe('layout', () => {
  it('uses a 2x2 grid for four cameras without focus', () => {
    const r = computeLayout(ids(4), [], opts);
    const ws = new Set(Object.values(r).map((t) => t.w));
    expect(ws.size).toBe(1);
    expect(r.cam1!.y).toBe(r.cam2!.y);
    expect(r.cam3!.y).toBeGreaterThan(r.cam1!.y);
    expect(r.cam1!.w).toBeGreaterThan(900);
  });

  it('uses a 3x3 grid for nine cameras without focus', () => {
    const r = computeLayout(ids(9), [], opts);
    expect(new Set(Object.values(r).map((t) => t.y)).size).toBe(3);
    expect(new Set(Object.values(r).map((t) => t.x)).size).toBe(3);
  });

  it('enlarges one focused camera and keeps others visible', () => {
    const r = computeLayout(ids(4), ['cam2'], opts);
    const big = r.cam2!;
    for (const id of ['cam1', 'cam3', 'cam4']) {
      expect(big.w).toBeGreaterThanOrEqual(r[id]!.w * 1.5);
      expect(r[id]!.w).toBeGreaterThanOrEqual(W * 0.18 - 0.01);
    }
    expect(big.w).toBeGreaterThan(1400);
  });

  it('enlarges both of two focused cameras equally', () => {
    const r = computeLayout(ids(4), ['cam1', 'cam4'], opts);
    expect(r.cam1!.w).toBe(r.cam4!.w);
    expect(r.cam1!.w).toBeGreaterThan(r.cam2!.w * 1.5);
  });

  it('distributes prominence across three or more focused cameras', () => {
    const r = computeLayout(ids(9), ['cam2', 'cam5', 'cam9'], opts);
    expect(new Set(['cam2', 'cam5', 'cam9'].map((id) => r[id]!.w)).size).toBe(1);
    expect(r.cam2!.w).toBeGreaterThan(r.cam1!.w * 1.5);
  });

  it('is deterministic', () => {
    expect(computeLayout(ids(7), ['cam3'], opts)).toEqual(computeLayout(ids(7), ['cam3'], opts));
  });

  // Exhaustive check: every camera count 1-9 and every possible focus subset.
  it('keeps every tile visible, inside the screen, non-overlapping and in shared order', () => {
    for (let n = 1; n <= 9; n++) {
      const cams = ids(n);
      for (const focus of subsets(cams)) {
        const r = computeLayout(cams, focus, opts);
        const label = `n=${n} focus=${focus.join(',')}`;
        expect(Object.keys(r).sort(), label).toEqual([...cams].sort());
        const rects = cams.map((id) => r[id]!);
        for (const t of rects) {
          expect(t.w, label).toBeGreaterThan(100);
          expect(t.x, label).toBeGreaterThanOrEqual(0);
          expect(t.y, label).toBeGreaterThanOrEqual(0);
          expect(t.x + t.w, label).toBeLessThanOrEqual(W + 0.01);
          expect(t.y + t.h, label).toBeLessThanOrEqual(H + 0.01);
          expect(Math.abs(t.w / t.h - 16 / 9), label).toBeLessThan(0.01);
        }
        for (let i = 0; i < rects.length; i++)
          for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i]!, rects[j]!), label).toBe(false);

        const others = cams.filter((id) => !focus.includes(id));
        if (focus.length > 0 && others.length > 0) {
          const minFocus = Math.min(...focus.map((id) => r[id]!.w));
          const maxOther = Math.max(...others.map((id) => r[id]!.w));
          expect(minFocus, label).toBeGreaterThan(maxOther);
          expect(readingOrder(r, focus), label).toEqual(focus);
          expect(readingOrder(r, others), label).toEqual(others);
        } else {
          expect(readingOrder(r, cams), label).toEqual(cams);
        }
      }
    }
  });
});
