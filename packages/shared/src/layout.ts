/** Rectangle in viewport pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutOptions {
  width: number;
  height: number;
  /** Gap between tiles and around the edges, in pixels. */
  gap: number;
  /** Tile aspect ratio (width / height). Cameras are 16:9. */
  aspect?: number;
  /** Minimum width of a non-focused tile as a fraction of the viewport width. */
  minOtherWidthFraction?: number;
  /** A focused tile must be at least this many times wider than a non-focused tile. */
  minProminence?: number;
}

interface Grid {
  tileW: number;
  rects: Rect[];
}

const SPLITS = Array.from({ length: 15 }, (_, i) => 0.5 + i * 0.025);
const RELAXATION = [1, 0.75, 0.5];

/**
 * Computes tile rectangles for all cameras.
 *
 * - No focus, or every camera focused: one uniform grid in the shared order.
 * - Otherwise focused cameras share a primary region and the remaining cameras a strip on the right or
 *   bottom. The split that gives focused tiles the most space while keeping other tiles readable wins.
 *
 * Every camera always receives a rectangle; the result is deterministic for identical input.
 */
export function computeLayout(
  cameraIds: readonly string[],
  focusedIds: readonly string[],
  options: LayoutOptions,
): Record<string, Rect> {
  const { width, height, gap } = options;
  const aspect = options.aspect ?? 16 / 9;
  const focusSet = new Set(focusedIds);
  const focused = cameraIds.filter((id) => focusSet.has(id));
  const others = cameraIds.filter((id) => !focusSet.has(id));
  const full: Rect = { x: gap, y: gap, w: width - 2 * gap, h: height - 2 * gap };

  if (focused.length === 0 || others.length === 0) {
    return assign(cameraIds, bestGrid(cameraIds.length, full, gap, aspect).rects);
  }

  const minOther = (options.minOtherWidthFraction ?? 0.18) * width;
  const minProminence = options.minProminence ?? 1.5;
  for (const factor of RELAXATION) {
    let best: { focus: Grid; other: Grid; placement: 'right' | 'bottom' } | null = null;
    for (const placement of ['right', 'bottom'] as const) {
      for (const split of SPLITS) {
        const [primary, strip] = splitRect(full, placement, split, gap);
        const focus = bestGrid(focused.length, primary, gap, aspect);
        const other = bestGrid(others.length, strip, gap, aspect);
        if (other.tileW < minOther * factor) continue;
        if (focus.tileW < other.tileW * minProminence) continue;
        if (
          !best ||
          focus.tileW > best.focus.tileW + 0.5 ||
          (Math.abs(focus.tileW - best.focus.tileW) <= 0.5 && other.tileW > best.other.tileW + 0.5)
        ) {
          best = { focus, other, placement };
        }
      }
    }
    if (best) {
      const [focusRects, otherRects] = packTogether(best.focus.rects, best.other.rects, best.placement, full, gap);
      return { ...assign(focused, focusRects), ...assign(others, otherRects) };
    }
  }
  return assign(cameraIds, bestGrid(cameraIds.length, full, gap, aspect).rects);
}

/**
 * Removes the empty band between the focus group and the strip: both groups are moved next to each
 * other (one gap apart) and centred together along the split axis.
 */
function packTogether(a: Rect[], b: Rect[], placement: 'right' | 'bottom', full: Rect, gap: number): [Rect[], Rect[]] {
  const axis = placement === 'right' ? 'x' : 'y';
  const size = placement === 'right' ? 'w' : 'h';
  const start = (rs: Rect[]) => Math.min(...rs.map((r) => r[axis]));
  const end = (rs: Rect[]) => Math.max(...rs.map((r) => r[axis] + r[size]));
  const total = end(a) - start(a) + gap + (end(b) - start(b));
  const from = full[axis] + (full[size] - total) / 2;
  const shiftA = from - start(a);
  const shiftB = from + (end(a) - start(a)) + gap - start(b);
  const move = (rs: Rect[], d: number) => rs.map((r) => round({ ...r, [axis]: r[axis] + d }));
  return [move(a, shiftA), move(b, shiftB)];
}

function splitRect(full: Rect, placement: 'right' | 'bottom', split: number, gap: number): [Rect, Rect] {
  if (placement === 'right') {
    const primaryW = Math.floor(full.w * split);
    return [
      { x: full.x, y: full.y, w: primaryW, h: full.h },
      { x: full.x + primaryW + gap, y: full.y, w: full.w - primaryW - gap, h: full.h },
    ];
  }
  const primaryH = Math.floor(full.h * split);
  return [
    { x: full.x, y: full.y, w: full.w, h: primaryH },
    { x: full.x, y: full.y + primaryH + gap, w: full.w, h: full.h - primaryH - gap },
  ];
}

/** Largest uniform grid of `n` tiles with the given aspect inside `region`, centred, row-major order. */
function bestGrid(n: number, region: Rect, gap: number, aspect: number): Grid {
  let best = { cols: 1, rows: n, tileW: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cellW = (region.w - gap * (cols - 1)) / cols;
    const cellH = (region.h - gap * (rows - 1)) / rows;
    const tileW = Math.max(0, Math.min(cellW, cellH * aspect));
    if (tileW > best.tileW + 0.01) best = { cols, rows, tileW };
  }
  const { cols, rows, tileW } = best;
  const tileH = tileW / aspect;
  const gridH = rows * tileH + (rows - 1) * gap;
  const top = region.y + (region.h - gridH) / 2;
  const rects: Rect[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const inRow = Math.min(cols, n - row * cols);
    const rowW = inRow * tileW + (inRow - 1) * gap;
    const left = region.x + (region.w - rowW) / 2;
    rects.push(
      round({ x: left + (i % cols) * (tileW + gap), y: top + row * (tileH + gap), w: tileW, h: tileH }),
    );
  }
  return { tileW, rects };
}

function assign(ids: readonly string[], rects: Rect[]): Record<string, Rect> {
  return Object.fromEntries(ids.map((id, i) => [id, rects[i]!]));
}

function round(r: Rect): Rect {
  const q = (v: number) => Math.round(v * 100) / 100;
  return { x: q(r.x), y: q(r.y), w: q(r.w), h: q(r.h) };
}
