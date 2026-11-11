import type { Bundler } from './bundle.ts';
import type { HouseholdStore } from './store.ts';

/** When the bundling runs by itself (since 0.28.0): never, daily or weekly at a time of day in Europe/Amsterdam. */
export interface BundleSchedule {
  frequency: 'off' | 'daily' | 'weekly';
  /** 1 = Monday … 7 = Sunday; used when weekly. */
  weekday: number;
  /** "HH:MM", 24-hour clock. */
  time: string;
}

/** Sunday morning, after the nightly database copy (03:30) and the VM backup (04:00). */
export const DEFAULT_SCHEDULE: BundleSchedule = { frequency: 'weekly', weekday: 7, time: '05:00' };

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A valid schedule from untrusted input, or an error in Dutch. */
export function parseSchedule(input: unknown): BundleSchedule | string {
  const b = (input ?? {}) as Record<string, unknown>;
  if (b.frequency !== 'off' && b.frequency !== 'daily' && b.frequency !== 'weekly') return 'Kies uit, dagelijks of wekelijks';
  const weekday = Number(b.weekday ?? DEFAULT_SCHEDULE.weekday);
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) return 'Kies een dag van de week';
  if (typeof b.time !== 'string' || !TIME.test(b.time)) return 'Kies een tijd (uu:mm)';
  return { frequency: b.frequency, weekday, time: b.time };
}

const PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Amsterdam',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function local(ms: number) {
  const p = Object.fromEntries(PARTS.formatToParts(ms).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hour: Number(p.hour), minute: Number(p.minute), weekday: WEEKDAYS.indexOf(p.weekday!) + 1 };
}

/** Epoch milliseconds of a wall-clock time in Amsterdam (twice corrected, so DST changes come out right). */
function amsterdam(y: number, m: number, d: number, hour: number, minute: number): number {
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  let ms = wall;
  for (let i = 0; i < 2; i++) {
    const l = local(ms);
    ms += wall - Date.UTC(l.y, l.m - 1, l.d, l.hour, l.minute);
  }
  return ms;
}

/** Scheduled moments (epoch ms) around `now`: the latest at or before it and the first after it; null when off. */
export function slots(s: BundleSchedule, nowMs: number): { last: number; next: number } | null {
  if (s.frequency === 'off') return null;
  const [hour, minute] = s.time.split(':').map(Number) as [number, number];
  const today = local(nowMs);
  const candidates: number[] = [];
  for (let offset = -8; offset <= 8; offset++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + offset, 12));
    const weekday = ((day.getUTCDay() + 6) % 7) + 1;
    if (s.frequency === 'weekly' && weekday !== s.weekday) continue;
    candidates.push(amsterdam(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute));
  }
  return { last: Math.max(...candidates.filter((c) => c <= nowMs)), next: Math.min(...candidates.filter((c) => c > nowMs)) };
}

/** A moment missed while the server was down is made up for when it starts within this time; later it waits for the next one. */
const CATCH_UP_MS = 6 * 3600_000;

/**
 * Starts the bundling at the scheduled moments (since 0.28.0; the weekly run promised for 0.23.0 was never built).
 * The handled moment is stored, so a restart neither runs twice nor skips a run; changing the schedule never starts
 * a run straight away.
 */
export class BundleScheduler {
  private readonly store: Pick<HouseholdStore, 'getMeta' | 'setMeta'>;
  private readonly bundler: Pick<Bundler, 'start' | 'busy'>;
  private readonly now: () => number;
  private readonly checkMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    store: Pick<HouseholdStore, 'getMeta' | 'setMeta'>,
    bundler: Pick<Bundler, 'start' | 'busy'>,
    { now = Date.now, checkMs = 60_000 }: { now?: () => number; checkMs?: number } = {},
  ) {
    this.store = store;
    this.bundler = bundler;
    this.now = now;
    this.checkMs = checkMs;
  }

  schedule(): BundleSchedule {
    const raw = this.store.getMeta('bundle_schedule');
    const parsed = raw ? parseSchedule(JSON.parse(raw)) : DEFAULT_SCHEDULE;
    return typeof parsed === 'string' ? DEFAULT_SCHEDULE : parsed;
  }

  setSchedule(s: BundleSchedule): void {
    this.store.setMeta('bundle_schedule', JSON.stringify(s));
    this.markHandled(s);
  }

  /** Epoch seconds of the next automatic run, or null when off. */
  next(): number | null {
    const s = slots(this.schedule(), this.now());
    return s ? Math.round(s.next / 1000) : null;
  }

  private markHandled(s: BundleSchedule): void {
    const at = slots(s, this.now());
    if (at) this.store.setMeta('bundle_slot', String(at.last));
  }

  start(): void {
    // The first start counts the moment that just passed as handled: no run right after a deployment.
    if (!this.store.getMeta('bundle_slot')) this.markHandled(this.schedule());
    this.timer = setInterval(() => this.tick(), this.checkMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Starts a run when a scheduled moment passed that was not handled yet. Returns the run id. */
  tick(): number | null {
    const at = slots(this.schedule(), this.now());
    if (!at || at.last <= Number(this.store.getMeta('bundle_slot') ?? 0)) return null;
    if (this.bundler.busy) return null;
    this.store.setMeta('bundle_slot', String(at.last));
    if (this.now() - at.last > CATCH_UP_MS) return null;
    return this.bundler.start('systeem');
  }
}
