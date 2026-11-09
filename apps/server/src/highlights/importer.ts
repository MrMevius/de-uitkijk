import type { Camera } from '@uitkijk/shared';
import {
  buildBaseline,
  FEEDBACK_WINDOW_S,
  feedbackAdjustment,
  feedbackKey,
  groupItems,
  KNOWN_FACTOR,
  scoreGroup,
  selectHighlights,
  SELECTION,
  type Baseline,
  type ReviewItem,
} from './selection.ts';
import type { CandidateRecord, HighlightStore } from './store.ts';

export interface ImporterOptions {
  frigateUrl: string;
  cameras: Camera[];
  intervalMs?: number;
  /** Wait this long after an alert ends before importing it, so neighbouring alerts can be grouped. */
  settleS?: number;
  fetch?: typeof fetch;
  /** Epoch seconds. */
  now?: () => number;
  log?: (msg: string) => void;
}

interface FrigateReview {
  id: string;
  camera: string;
  start_time: number;
  end_time: number | null;
  severity: string;
  data: { objects?: string[]; sub_labels?: string[]; detections?: string[]; thumb_time?: number };
}

interface FrigateEvent {
  id: string;
  top_score?: number | null;
  /** For a vehicle with a known plate (`lpr.known_plates`): its name. */
  sub_label?: string | [string, number] | null;
  data?: { top_score?: number | null; recognized_license_plate?: string | null };
}

/** Plates Frigate's LPR read on these detections, upper case without spaces or dashes, deduplicated. */
export function platesOf(events: FrigateEvent[]): string[] {
  const plates = events.map((e) => (e.data?.recognized_license_plate ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
  return [...new Set(plates.filter((p) => p.length >= 4))];
}

const AMSTERDAM_HOUR = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Europe/Amsterdam' });
export const hourInAmsterdam = (epochS: number) => Number(AMSTERDAM_HOUR.format(epochS * 1000));

const OBJECT_NL: Record<string, string> = { person: 'Persoon', car: 'Auto' };

/** Short Dutch description from rules (AI descriptions are a later phase). */
export function describe(items: ReviewItem[], cameraName: (frigate: string) => string): string {
  const names = [...new Set(items.flatMap((i) => i.subLabels))];
  const objects = [...new Set(items.flatMap((i) => i.objects.map((o) => o.replace(/-verified$/, ''))))];
  const subject = names.length
    ? names.join(' en ')
    : objects.map((o, n) => (n === 0 ? OBJECT_NL[o] ?? o : (OBJECT_NL[o] ?? o).toLowerCase())).join(' en ') || 'Beweging';
  const places = [...new Set(items.map((i) => cameraName(i.camera)))];
  const where = places.length === 1 ? `bij ${places[0]}` : `bij ${places[0]}, daarna ${places.slice(1).join(', ')}`;
  const hour = hourInAmsterdam(items[0]!.startTime);
  return `${subject} ${where}${hour >= 23 || hour < 6 ? ", 's nachts" : ''}`;
}

/**
 * Turns Frigate alerts into highlight candidates.
 *
 * - Starts at the first activation (never imports older events) and keeps a cursor, so alerts missed
 *   during an outage are caught up; processed review ids make every import idempotent.
 * - Groups alerts across cameras, scores them, picks the representative camera by the best detection
 *   score, then re-runs selection over the last two days and fetches thumbnails for new highlights.
 */
export class HighlightImporter {
  private readonly store: HighlightStore;
  private readonly opts: Required<Omit<ImporterOptions, 'cameras'>>;
  private readonly byFrigate: Map<string, Camera>;
  private baseline: Baseline = new Map();
  private baselineAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  /** For monitoring: last successful import cycle (epoch seconds) and last error. */
  lastOkAt: number | null = null;
  lastError: string | null = null;

  constructor(store: HighlightStore, options: ImporterOptions) {
    this.store = store;
    this.byFrigate = new Map(options.cameras.filter((c) => c.frigateCamera).map((c) => [c.frigateCamera!, c]));
    this.opts = {
      intervalMs: 60_000,
      settleS: 60,
      fetch: globalThis.fetch,
      now: () => Date.now() / 1000,
      log: () => {},
      ...options,
      frigateUrl: options.frigateUrl.replace(/\/$/, ''),
    };
  }

  start(): void {
    const loop = async () => {
      await this.runOnce().then(
        () => {
          this.lastOkAt = this.opts.now();
          this.lastError = null;
        },
        (err: Error) => {
          this.lastError = err.message.slice(0, 200);
          this.opts.log(`highlights: ${err.message}`);
        },
      );
      if (this.running) this.timer = setTimeout(loop, this.opts.intervalMs);
    };
    this.running = true;
    void loop();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.opts.fetch(`${this.opts.frigateUrl}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Frigate ${path.split('?')[0]} HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private toItem(r: FrigateReview): ReviewItem {
    return {
      id: r.id,
      camera: r.camera,
      startTime: r.start_time,
      endTime: r.end_time ?? r.start_time,
      objects: r.data.objects ?? [],
      subLabels: r.data.sub_labels ?? [],
      detections: r.data.detections ?? [],
      ...(typeof r.data.thumb_time === 'number' ? { thumbTime: r.data.thumb_time } : {}),
    };
  }

  private async refreshBaseline(now: number): Promise<void> {
    if (now - this.baselineAt < 3600 && this.baseline.size) return;
    const after = now - SELECTION.baselineDays * 86400;
    const items = await this.get<FrigateReview[]>(`/api/review?severity=alert&after=${after}&before=${now}&limit=10000`);
    this.baseline = buildBaseline(
      items.filter((r) => this.byFrigate.has(r.camera)).map((r) => ({ camera: r.camera, startTime: r.start_time })),
      hourInAmsterdam,
    );
    this.baselineAt = now;
  }

  /** One import cycle. Returns the number of new candidates. */
  async runOnce(): Promise<number> {
    const now = this.opts.now();
    let activated = Number(this.store.getMeta('activated_at'));
    if (!activated) {
      activated = now;
      this.store.setMeta('activated_at', String(now));
      this.opts.log(`highlights: activated at ${new Date(now * 1000).toISOString()}; earlier events are not imported`);
    }
    const cursor = Math.max(activated, Number(this.store.getMeta('cursor')) || activated);

    await this.refreshBaseline(now);
    const reviews = await this.get<FrigateReview[]>(
      `/api/review?severity=alert&after=${cursor - 300}&before=${now}&limit=2000`,
    );
    const relevant = reviews.filter((r) => this.byFrigate.has(r.camera) && r.start_time >= activated);
    const settled = relevant.filter((r) => r.end_time !== null && r.end_time < now - this.opts.settleS);
    const pending = settled.filter((r) => !this.store.isProcessed(r.id)).map((r) => this.toItem(r));

    let created = 0;
    for (const group of groupItems(pending)) {
      await this.importGroup(group);
      created++;
    }

    // Next time start from the oldest alert that could not be processed yet.
    const unsettled = relevant.filter((r) => r.end_time === null || r.end_time >= now - this.opts.settleS);
    const nextCursor = unsettled.length ? Math.min(...unsettled.map((r) => r.start_time)) : now - this.opts.settleS;
    if (nextCursor > cursor) this.store.setMeta('cursor', String(nextCursor));

    await this.reselect(now);
    return created;
  }

  private async importGroup(items: ReviewItem[]): Promise<void> {
    const scored = scoreGroup(items, this.baseline, hourInAmsterdam);
    const detectionIds = items.flatMap((i) => i.detections);
    const events = detectionIds.length
      ? await this.get<FrigateEvent[]>(`/api/events?ids=${detectionIds.map(encodeURIComponent).join(',')}&limit=100`)
      : [];
    const scoreOf = new Map(events.map((e) => [e.id, e.data?.top_score ?? e.top_score ?? 0]));
    // Representative: the alert with the most confident detection; on a tie the longer one.
    let rep = items[0]!;
    let repEvent = rep.detections[0] ?? '';
    let best = -1;
    for (const item of items) {
      for (const d of item.detections) {
        const s = scoreOf.get(d) ?? 0;
        if (s > best || (s === best && item.endTime - item.startTime > rep.endTime - rep.startTime)) {
          best = s;
          rep = item;
          repEvent = d;
        }
      }
    }
    const camera = this.byFrigate.get(rep.camera)!;
    const clipStart = rep.startTime - 2;
    const clipEnd = Math.max(clipStart + 5, Math.min(rep.endTime + 2, clipStart + 30));
    const groupStart = Math.min(...items.map((i) => i.startTime));
    const groupEnd = Math.max(...items.map((i) => i.endTime));
    const record: CandidateRecord = {
      id: items[0]!.id,
      startTime: groupStart,
      endTime: groupEnd,
      cameras: [...new Set(items.map((i) => this.byFrigate.get(i.camera)!.id))],
      camera: camera.id,
      frigateCamera: rep.camera,
      repEvent,
      detections: [...new Set(items.flatMap((i) => i.detections))],
      clipStart,
      clipEnd,
      frameTime: rep.thumbTime ?? rep.startTime + 1,
      eventStart: Math.max(rep.startTime - 5, groupStart - 5),
      eventEnd: Math.min(groupEnd + 5, rep.startTime + 600),
      labels: [...new Set(items.flatMap((i) => i.objects))],
      subLabels: [...new Set(items.flatMap((i) => i.subLabels))],
      plates: platesOf(events),
      score: scored.score,
      reasons: scored.reasons,
      description: describe(items, (f) => this.byFrigate.get(f)?.name ?? f),
    };
    this.store.insert(record, items.map((i) => i.id));
  }

  /** Re-runs selection over the last two days and stores thumbnails of newly selected highlights. */
  private async reselect(now: number): Promise<void> {
    // Learn from feedback: similar recent candidates (same camera and time-of-day period) move up or down.
    const sums = new Map<string, number>();
    for (const f of this.store.feedbackSignals(now - FEEDBACK_WINDOW_S)) {
      const key = feedbackKey(f.camera, hourInAmsterdam(f.startTime));
      sums.set(key, (sums.get(key) ?? 0) + f.value);
    }
    for (const c of this.store.candidatesSince(now - 2 * 86400)) {
      const adjustment = feedbackAdjustment(sums.get(feedbackKey(c.camera, hourInAmsterdam(c.startTime))) ?? 0);
      // Known from answers or facts counts low, like a recognised face (already part of the base score).
      const known = c.subLabels.length === 0 && (c.aiVehicleKnown || c.annotationKnown) ? KNOWN_FACTOR : 1;
      if (adjustment !== c.feedbackAdj || known !== c.knownFactor) this.store.setScoreParts(c.id, adjustment, known);
    }
    const recent = this.store.candidatesSince(now - 2 * 86400);
    const selected = selectHighlights(
      recent.map((c) => ({ id: c.id, startTime: c.startTime, cameras: c.cameras, score: c.score })),
      this.store.threshold(),
    );
    for (const c of recent) {
      const want = selected.has(c.id);
      if (want !== c.selected) this.store.setSelected(c.id, want);
      if (want && !c.hasThumbnail && c.repEvent) {
        try {
          const res = await this.opts.fetch(`${this.opts.frigateUrl}/api/events/${encodeURIComponent(c.repEvent)}/snapshot-clean.webp`, {
            signal: AbortSignal.timeout(15_000),
          });
          if (res.ok) this.store.setThumbnail(c.id, new Uint8Array(await res.arrayBuffer()));
        } catch {
          // Retried on the next cycle.
        }
      }
    }
  }
}
