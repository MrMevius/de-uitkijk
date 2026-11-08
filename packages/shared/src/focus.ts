import type { ActiveAlert, FocusEntry } from './types.ts';

/** Default per-camera focus hold after the last alert on that camera ends. */
export const DEFAULT_HOLD_MS = 15_000;

interface CameraFocus {
  alertIds: string[];
  labels: string[];
  /** null while at least one alert is active on the camera. */
  holdUntil: number | null;
}

/** Immutable focus state keyed by camera id. Cameras without focus are absent. */
export type FocusState = Readonly<Record<string, Readonly<CameraFocus>>>;

export const EMPTY_FOCUS: FocusState = Object.freeze({});

/**
 * Reconciles the complete set of currently active alerts at time `now`.
 *
 * - A camera with an active alert is focused and any running hold is cancelled.
 * - A camera whose last alert disappeared starts an independent hold of `holdMs`.
 * - Holds that have expired at `now` are removed.
 *
 * The function is pure: the caller owns the clock and decides when to call it.
 */
export function reconcileAlerts(
  state: FocusState,
  alerts: readonly ActiveAlert[],
  now: number,
  holdMs: number = DEFAULT_HOLD_MS,
): FocusState {
  const byCamera = new Map<string, ActiveAlert[]>();
  for (const alert of alerts) {
    const list = byCamera.get(alert.cameraId) ?? [];
    list.push(alert);
    byCamera.set(alert.cameraId, list);
  }

  const next: Record<string, CameraFocus> = {};
  for (const [cameraId, cameraAlerts] of byCamera) {
    next[cameraId] = {
      alertIds: cameraAlerts.map((a) => a.id).sort(),
      labels: uniqueSorted(cameraAlerts.flatMap((a) => a.labels)),
      holdUntil: null,
    };
  }
  for (const [cameraId, previous] of Object.entries(state)) {
    if (next[cameraId]) continue;
    const holdUntil = previous.holdUntil ?? now + holdMs;
    if (holdUntil > now) next[cameraId] = { alertIds: [], labels: previous.labels, holdUntil };
  }
  return next;
}

/** Removes holds that have expired at `now`. Returns the same object when nothing changed. */
export function expireHolds(state: FocusState, now: number): FocusState {
  let changed = false;
  const next: Record<string, CameraFocus> = {};
  for (const [cameraId, entry] of Object.entries(state)) {
    if (entry.holdUntil !== null && entry.holdUntil <= now) {
      changed = true;
      continue;
    }
    next[cameraId] = entry;
  }
  return changed ? next : state;
}

/** Earliest pending hold expiry, or null when no timer is needed. */
export function nextHoldDeadline(state: FocusState): number | null {
  let earliest: number | null = null;
  for (const entry of Object.values(state)) {
    if (entry.holdUntil !== null && (earliest === null || entry.holdUntil < earliest)) {
      earliest = entry.holdUntil;
    }
  }
  return earliest;
}

/** Focus entries in the shared camera order. Cameras missing from `cameraOrder` are dropped. */
export function focusEntries(state: FocusState, cameraOrder: readonly string[]): FocusEntry[] {
  return cameraOrder.flatMap((cameraId) => {
    const entry = state[cameraId];
    if (!entry) return [];
    return [
      {
        cameraId,
        reason: entry.holdUntil === null ? 'alert' : 'hold',
        labels: [...entry.labels],
        holdUntil: entry.holdUntil,
      } satisfies FocusEntry,
    ];
  });
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
