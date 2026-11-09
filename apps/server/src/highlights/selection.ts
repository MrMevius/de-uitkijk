/**
 * Highlight selection: pure functions, no I/O.
 *
 * Candidates are Frigate alert review items, grouped across cameras when they follow each other closely.
 * Each group gets a rule-based score; groups at or above the threshold are highlights, unless a
 * higher-scoring highlight on one of the same cameras lies within the burst window.
 *
 * Tuned on seven days of real alerts (2026-11-01..08): 6–14 highlights per day.
 */

export interface ReviewItem {
  id: string;
  /** Frigate camera name. */
  camera: string;
  startTime: number;
  endTime: number;
  objects: string[];
  /** Recognised faces / sub labels, e.g. household members. */
  subLabels: string[];
  detections: string[];
  /** Time of Frigate's best frame for this alert (epoch seconds), when known. */
  thumbTime?: number;
}

export interface ScoredGroup {
  items: ReviewItem[];
  score: number;
  reasons: string[];
}

export const SELECTION = {
  /** Items on any camera that start within this many seconds after the previous item ended form one group. */
  groupGapS: 30,
  /** Default; administrators can change it (see `THRESHOLD_RANGE` and the store's `threshold()`). */
  threshold: 2.0,
  /** Same-camera highlights closer together than this keep only the best one. */
  burstWindowS: 30 * 60,
  maxRotation: 15,
  rotationWindowS: 24 * 3600,
  /** Days of history used for the camera/hour baseline. */
  baselineDays: 7,
} as const;

/** Allowed values for the administrator's threshold setting. */
export const THRESHOLD_RANGE = { min: 1.0, max: 5.0 } as const;

/**
 * Score multiplier for known people and vehicles: a face Frigate recognised, a vehicle the AI matched to a
 * household fact, or a highlight an administrator identified as a resident, visitor or vehicle owner.
 */
export const KNOWN_FACTOR = 0.4;

/** Splits items (any order) into groups of consecutive activity across cameras. */
export function groupItems(items: ReviewItem[], gapS: number = SELECTION.groupGapS): ReviewItem[][] {
  const sorted = [...items].sort((a, b) => a.startTime - b.startTime);
  const groups: ReviewItem[][] = [];
  let groupEnd = -Infinity;
  for (const item of sorted) {
    const last = groups.at(-1);
    if (last && item.startTime - groupEnd <= gapS) {
      last.push(item);
      groupEnd = Math.max(groupEnd, item.endTime);
    } else {
      groups.push([item]);
      groupEnd = item.endTime;
    }
  }
  return groups;
}

/** Alert counts per `camera|hour` over the baseline period. */
export type Baseline = Map<string, number>;

export function baselineKey(camera: string, hour: number): string {
  return `${camera}|${hour}`;
}

export function buildBaseline(items: Pick<ReviewItem, 'camera' | 'startTime'>[], hourOf: (t: number) => number): Baseline {
  const baseline: Baseline = new Map();
  for (const item of items) {
    const key = baselineKey(item.camera, hourOf(item.startTime));
    baseline.set(key, (baseline.get(key) ?? 0) + 1);
  }
  return baseline;
}

/**
 * Rule-based interest score. No fixed camera weighting: rarity is relative to each camera's own
 * activity at that hour, so a busy garden by day scores low and the same garden at night scores high.
 */
export function scoreGroup(
  items: ReviewItem[],
  baseline: Baseline,
  hourOf: (t: number) => number,
  baselineDays: number = SELECTION.baselineDays,
): ScoredGroup {
  const reasons: string[] = [];
  const rarity = Math.max(
    ...items.map((i) => 1 / (1 + (baseline.get(baselineKey(i.camera, hourOf(i.startTime))) ?? 0) / baselineDays)),
  );
  let score = 3 * rarity;
  if (rarity >= 0.75) reasons.push('ongewoon voor deze camera en dit uur');

  const hour = hourOf(items[0]!.startTime);
  if (hour >= 23 || hour < 6) {
    score += 1.5;
    reasons.push("'s nachts");
  }
  const objects = new Set(items.flatMap((i) => i.objects));
  if (objects.has('car')) {
    score += 1;
    reasons.push('auto');
  }
  const cameras = new Set(items.map((i) => i.camera));
  if (cameras.size > 1) {
    score += Math.min(2, cameras.size - 1) * 0.75;
    reasons.push(`${cameras.size} camera's`);
  }
  // Recognised household members are usually not news: they count, but low (operator decision).
  if (items.some((i) => i.subLabels.length > 0)) {
    score *= KNOWN_FACTOR;
    reasons.push('bekende persoon');
  }
  return { items, score: Math.round(score * 100) / 100, reasons };
}

export interface Candidate {
  id: string;
  startTime: number;
  cameras: string[];
  score: number;
}

/**
 * Which candidates are highlights: score at or above the threshold and the best on each of their cameras
 * within the burst window. Deterministic: ties go to the earlier candidate.
 */
export function selectHighlights(
  candidates: Candidate[],
  threshold: number = SELECTION.threshold,
  burstWindowS: number = SELECTION.burstWindowS,
): Set<string> {
  const ranked = candidates
    .filter((c) => c.score >= threshold)
    .sort((a, b) => b.score - a.score || a.startTime - b.startTime);
  const kept: Candidate[] = [];
  for (const c of ranked) {
    const clash = kept.some(
      (k) => Math.abs(k.startTime - c.startTime) < burstWindowS && k.cameras.some((cam) => c.cameras.includes(cam)),
    );
    if (!clash) kept.push(c);
  }
  return new Set(kept.map((c) => c.id));
}

/** Time-of-day period used to learn from feedback: similar events happen at similar times. */
export function periodOf(hour: number): 'nacht' | 'avond' | 'dag' {
  if (hour >= 23 || hour < 6) return 'nacht';
  if (hour >= 19) return 'avond';
  return 'dag';
}

export const feedbackKey = (camera: string, hour: number) => `${camera}|${periodOf(hour)}`;

/**
 * Score adjustment learned from administrator feedback on earlier highlights with the same camera and
 * time-of-day period (last 90 days): +0.4 per 👍, -0.4 per 👎 or deletion, capped at +1.0 / -1.5.
 */
export function feedbackAdjustment(sum: number): number {
  return Math.round(Math.max(-1.5, Math.min(1, 0.4 * sum)) * 100) / 100;
}

export const FEEDBACK_WINDOW_S = 90 * 86400;
