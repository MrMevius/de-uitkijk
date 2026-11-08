import type { ServiceStatus } from '@uitkijk/shared';

/** One deterministic step, `at` milliseconds after the scenario (or loop iteration) starts. */
export type ScenarioStep =
  | { at: number; do: 'alert-start'; id: string; camera: string; labels?: string[] }
  | { at: number; do: 'alert-end'; id: string }
  | { at: number; do: 'camera'; camera: string; availability: 'online' | 'offline' }
  | { at: number; do: 'alerts-service'; status: Extract<ServiceStatus, 'down' | 'mock'> }
  | { at: number; do: 'streaming-service'; status: Extract<ServiceStatus, 'down' | 'ok'> };

export interface Scenario {
  description: string;
  /** Restart the timeline after this many milliseconds. Omit for a one-shot scenario. */
  loopMs?: number;
  steps: ScenarioStep[];
}

const start = (at: number, id: string, camera: string, labels = ['person']): ScenarioStep => ({
  at,
  do: 'alert-start',
  id,
  camera,
  labels,
});
const end = (at: number, id: string): ScenarioStep => ({ at, do: 'alert-end', id });

/**
 * Fixtures for development and tests. Camera ids refer to config/cameras.json; the nine-camera
 * fixture shares the first four ids. Steps for cameras that are not configured are ignored.
 */
export const SCENARIOS: Record<string, Scenario> = {
  idle: {
    description: 'Alle camera\'s online, geen meldingen.',
    steps: [],
  },
  'single-alert': {
    description: 'Eén persoon bij de voordeur: 10 s melding, daarna 15 s hold.',
    loopMs: 40_000,
    steps: [start(2_000, 's1', 'voordeur'), end(12_000, 's1')],
  },
  'multi-alert': {
    description: 'Drie gelijktijdige meldingen die na elkaar eindigen.',
    loopMs: 50_000,
    steps: [
      start(2_000, 'm1', 'oprit'),
      start(4_000, 'm2', 'achter_1', ['car']),
      start(6_000, 'm3', 'achter_2'),
      end(12_000, 'm1'),
      end(16_000, 'm2'),
      end(20_000, 'm3'),
    ],
  },
  'expire-reactivate': {
    description: 'Melding eindigt, nieuwe melding binnen de hold annuleert de timer, daarna verloopt de hold.',
    loopMs: 60_000,
    steps: [
      start(2_000, 'r1', 'voordeur'),
      end(6_000, 'r1'),
      start(14_000, 'r2', 'voordeur'),
      end(18_000, 'r2'),
      start(40_000, 'r3', 'voordeur'),
      end(44_000, 'r3'),
    ],
  },
  'camera-disconnect': {
    description: 'Achter het huis 1 valt weg en komt na 15 s terug.',
    loopMs: 30_000,
    steps: [
      { at: 5_000, do: 'camera', camera: 'achter_1', availability: 'offline' },
      { at: 20_000, do: 'camera', camera: 'achter_1', availability: 'online' },
    ],
  },
  'frigate-unavailable': {
    description: 'Meldingenbron valt uit tijdens een melding en komt na 24 s terug.',
    loopMs: 40_000,
    steps: [
      start(2_000, 'f1', 'oprit'),
      { at: 6_000, do: 'alerts-service', status: 'down' },
      { at: 30_000, do: 'alerts-service', status: 'mock' },
    ],
  },
  'streaming-unavailable': {
    description: 'Backend meldt streamingdienst onbereikbaar (gesimuleerde health; video zelf blijft).',
    loopMs: 35_000,
    steps: [
      { at: 3_000, do: 'streaming-service', status: 'down' },
      { at: 25_000, do: 'streaming-service', status: 'ok' },
    ],
  },
  'nine-cameras': {
    description: 'Meldingen op drie van negen camera\'s (gebruik cameras-9.mock.json).',
    loopMs: 45_000,
    steps: [
      start(2_000, 'n1', 'mock_5'),
      start(3_000, 'n2', 'voordeur'),
      start(4_000, 'n3', 'mock_9', ['car']),
      end(10_000, 'n2'),
      end(14_000, 'n1'),
      end(16_000, 'n3'),
    ],
  },
  demo: {
    description: 'Doorlopende demo: één, meerdere en heractiverende meldingen.',
    loopMs: 120_000,
    steps: [
      start(3_000, 'd1', 'voordeur'),
      end(10_000, 'd1'),
      start(35_000, 'd2', 'oprit', ['car']),
      start(37_000, 'd3', 'achter_2'),
      end(45_000, 'd2'),
      end(47_000, 'd3'),
      start(70_000, 'd4', 'achter_1'),
      end(74_000, 'd4'),
      start(80_000, 'd5', 'achter_1'),
      end(86_000, 'd5'),
    ],
  },
};
