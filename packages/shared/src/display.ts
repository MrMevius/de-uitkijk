import type { DashboardState } from './types.ts';

export const TIME_ZONE = 'Europe/Amsterdam';

const dateFormat = new Intl.DateTimeFormat('nl-NL', {
  timeZone: TIME_ZONE,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});
const clockFormat = new Intl.DateTimeFormat('nl-NL', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "zondag 8 november" in Europe/Amsterdam. */
export function formatDutchDate(epochMs: number): string {
  return dateFormat.format(epochMs);
}

/** "07:05" (24-hour) in Europe/Amsterdam. */
export function formatClock(epochMs: number): string {
  return clockFormat.format(epochMs);
}

const OBJECT_LABELS: Record<string, string> = {
  person: 'Persoon',
  car: 'Auto',
  motorcycle: 'Motor',
  bicycle: 'Fiets',
  dog: 'Hond',
  cat: 'Kat',
  bird: 'Vogel',
  package: 'Pakket',
};

export function dutchObjectLabel(label: string): string {
  return OBJECT_LABELS[label] ?? label;
}

/** Per-TV display settings. Selected by the kiosk URL (`?profile=shop`). */
export interface DisplayProfile {
  id: string;
  /** Multiplier for overlay text, chosen for screen size and viewing distance. */
  overlayScale: number;
  /** Which stream each tile plays. Fixed per profile so focus changes never reconnect video. */
  streamQuality: 'sub' | 'main';
  /** Minimum non-focused tile width as a fraction of the viewport width. */
  minOtherWidthFraction: number;
  gapPx: number;
  showObjectType: boolean;
}

export const DISPLAY_PROFILES: Record<string, DisplayProfile> = {
  default: { id: 'default', overlayScale: 1, streamQuality: 'sub', minOtherWidthFraction: 0.18, gapPx: 8, showObjectType: true },
  /** 55-inch Full HD, viewed from 2-5 m. */
  shop: { id: 'shop', overlayScale: 1.35, streamQuality: 'sub', minOtherWidthFraction: 0.2, gapPx: 10, showObjectType: true },
  /** 32-inch Full HD, viewed from 0.5-2 m. */
  bedroom: { id: 'bedroom', overlayScale: 0.9, streamQuality: 'sub', minOtherWidthFraction: 0.18, gapPx: 6, showObjectType: true },
};

export function displayProfile(id: string | null | undefined): DisplayProfile {
  return DISPLAY_PROFILES[id ?? 'default'] ?? DISPLAY_PROFILES.default!;
}

export type HealthLevel = 'ok' | 'warning' | 'error';

export interface HealthSummary {
  level: HealthLevel;
  /** Short Dutch messages; empty when everything is fine. */
  messages: string[];
}

/**
 * Summarises system health for the subtle on-screen indicator.
 * `backendConnected` is the client's own view of the backend event stream.
 */
export function summarizeHealth(state: DashboardState | null, backendConnected: boolean): HealthSummary {
  const messages: string[] = [];
  let level: HealthLevel = 'ok';
  const raise = (to: HealthLevel) => {
    if (to === 'error' || (to === 'warning' && level === 'ok')) level = to;
  };

  if (!backendConnected) {
    raise('warning');
    messages.push('Server niet bereikbaar');
  }
  if (state) {
    if (state.health.streaming.status === 'down') {
      raise('error');
      messages.push('Streamingdienst niet bereikbaar');
    }
    if (state.health.alerts.status === 'down') {
      raise('warning');
      messages.push(state.mode === 'live' ? 'Frigate niet bereikbaar' : 'Meldingen niet beschikbaar');
    }
    const offline = state.cameras.filter((c) => c.availability === 'offline').length;
    if (offline > 0) {
      raise('warning');
      messages.push(offline === 1 ? '1 camera offline' : `${offline} camera's offline`);
    }
  }
  return { level, messages };
}
