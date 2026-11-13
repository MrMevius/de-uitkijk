import { firstName, type Register } from '../ai/knowledge.ts';
import { plateKey } from '../household/store.ts';
import type { FrigateFetch } from './client.ts';

/** Frigate's `lpr.known_plates`: a name per vehicle and the plates that belong to it. */
export type KnownPlates = Record<string, string[]>;

/**
 * The register's vehicles with a plate, as Frigate's known plates (since 0.35.0): "Tesla Model 3 van Mark" → ["G929VD"].
 * Frigate then puts that name on the car (its UI, search and review) and corrects plates it reads one character off.
 * Names are unique and without dots (Frigate's config paths use dots); a second vehicle with the same name gets its
 * plate added.
 */
export function knownPlatesFor(register: Register): KnownPlates {
  const owner = new Map(register.people.map((p) => [p.id, p.name]));
  const out: KnownPlates = {};
  const seen = new Set<string>();
  for (const v of register.vehicles) {
    const plate = plateKey(v.plate);
    if (plate.length < 4 || seen.has(plate)) continue;
    seen.add(plate);
    const what = [v.make, v.model].filter(Boolean).join(' ') || v.kind;
    const who = v.ownerId !== null ? owner.get(v.ownerId) : undefined;
    let name = `${what}${who ? ` van ${firstName(who)}` : ''}`.replace(/[.\\]/g, '').replace(/\s+/g, ' ').trim();
    if (out[name]) name = `${name} (${plate})`;
    out[name] = [plate];
  }
  return out;
}

const canonical = (plates: KnownPlates) =>
  JSON.stringify(Object.keys(plates).sort().map((k) => [k, [...plates[k]!].sort()]));

export interface KnownPlatesStatus {
  /** Epoch seconds of the last check, the last change written to Frigate, and the last error. */
  checkedAt: number | null;
  changedAt: number | null;
  error: string | null;
  /** Vehicles with a plate in Frigate after the last check. */
  count: number;
}

export interface KnownPlatesSyncOptions {
  frigateUrl: string;
  fetch: FrigateFetch;
  register: () => Register;
  intervalMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

/**
 * Keeps Frigate's `lpr.known_plates` equal to the household register (since 0.35.0). Writes only when something
 * differs, through Frigate's config API without a restart (`update_topic: config/lpr`); Frigate validates the new
 * config and puts the old file back on an error. Only `lpr.known_plates` is ever written. Needs the admin role.
 */
export class KnownPlatesSync {
  private readonly opts: Required<KnownPlatesSyncOptions>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private soon: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private busy = false;
  private state: KnownPlatesStatus = { checkedAt: null, changedAt: null, error: null, count: 0 };

  constructor(options: KnownPlatesSyncOptions) {
    this.opts = { intervalMs: 10 * 60_000, now: () => Date.now() / 1000, log: () => {}, ...options, frigateUrl: options.frigateUrl.replace(/\/$/, '') };
  }

  start(): void {
    this.running = true;
    const loop = async () => {
      await this.runOnce();
      if (this.running) this.timer = setTimeout(loop, this.opts.intervalMs);
    };
    this.timer = setTimeout(loop, 60_000);
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    clearTimeout(this.soon);
  }

  /** After a change in the register: check within a minute, once. */
  kick(): void {
    clearTimeout(this.soon);
    this.soon = setTimeout(() => void this.runOnce(), 60_000);
  }

  status(): KnownPlatesStatus {
    return { ...this.state };
  }

  /** One check; returns true when Frigate was changed. Never throws. */
  async runOnce(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const desired = knownPlatesFor(this.opts.register());
      const res = await this.opts.fetch(`${this.opts.frigateUrl}/api/config`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`Frigate /api/config HTTP ${res.status}`);
      const current: KnownPlates = ((await res.json()) as { lpr?: { known_plates?: KnownPlates | null } }).lpr?.known_plates ?? {};
      this.state.checkedAt = this.opts.now();
      if (canonical(current) === canonical(desired)) {
        this.state = { ...this.state, error: null, count: Object.keys(desired).length };
        return false;
      }
      // Names no longer in the register are removed (null deletes the key in Frigate's config file).
      const update: Record<string, string[] | null> = { ...desired };
      for (const name of Object.keys(current)) if (!(name in desired)) update[name] = null;
      const put = await this.opts.fetch(`${this.opts.frigateUrl}/api/config/set`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requires_restart: 0, update_topic: 'config/lpr', config_data: { lpr: { known_plates: update } } }),
        signal: AbortSignal.timeout(30_000),
      });
      const answer = (await put.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!put.ok || answer.success === false) throw new Error(`Frigate config/set HTTP ${put.status}: ${answer.message ?? ''}`.trim());
      this.state = { checkedAt: this.state.checkedAt, changedAt: this.opts.now(), error: null, count: Object.keys(desired).length };
      this.opts.log(`known plates: ${Object.keys(desired).length} vehicles written to Frigate`);
      return true;
    } catch (err) {
      this.state.error = (err as Error).message.slice(0, 300);
      this.opts.log(`known plates: ${this.state.error}`);
      return false;
    } finally {
      this.busy = false;
    }
  }
}
