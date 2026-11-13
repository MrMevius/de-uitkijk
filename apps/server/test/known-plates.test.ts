import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCameraConfig } from '@uitkijk/shared';
import { KnownPlatesSync, knownPlatesFor } from '../src/frigate/known-plates.ts';
import { HighlightImporter } from '../src/highlights/importer.ts';
import { HighlightStore } from '../src/highlights/store.ts';
import { HouseholdStore } from '../src/household/store.ts';

const cameras = parseCameraConfig(JSON.parse(readFileSync(new URL('../../../config/cameras.json', import.meta.url), 'utf8')));
const cleanup: (() => unknown)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function register() {
  const household = new HouseholdStore(':memory:');
  cleanup.push(() => household.close());
  const mark = household.addPerson({ name: 'Mark Mevius', role: 'familie' }, [], [], 1);
  household.addVehicle({ make: 'Tesla', model: 'Model 3', colour: 'rood', plate: 'G-929-VD', ownerId: mark.id }, [], [], 1);
  household.addVehicle({ kind: 'bestelbus', plate: 'VX-123-B' }, [], [], 1);
  household.addVehicle({ make: 'Volkswagen', model: 'up!', colour: 'zwart' }, [], [], 1);
  return { household, get: () => ({ people: household.people(), vehicles: household.vehicles() }) };
}

describe('known plates in Frigate (0.35.0)', () => {
  it('names every register vehicle with a plate, with the owner first name', () => {
    expect(knownPlatesFor(register().get())).toEqual({ 'Tesla Model 3 van Mark': ['G929VD'], bestelbus: ['VX123B'] });
  });

  it('writes to Frigate only when something differs, and removes names no longer in the register', async () => {
    const r = register();
    let frigate: Record<string, string[]> = { 'Oude auto': ['AB123C'] };
    const puts: unknown[] = [];
    const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
      if (String(input).endsWith('/api/config')) return Response.json({ lpr: { known_plates: frigate } });
      const body = JSON.parse(String(init.body)) as { config_data: { lpr: { known_plates: Record<string, string[] | null> } } };
      puts.push(body);
      frigate = Object.fromEntries(Object.entries(body.config_data.lpr.known_plates).filter((e): e is [string, string[]] => e[1] !== null));
      return Response.json({ success: true });
    }) as typeof fetch;
    const sync = new KnownPlatesSync({ frigateUrl: 'https://frigate:8971/', fetch: fetchImpl, register: r.get, now: () => 100 });
    expect(await sync.runOnce()).toBe(true);
    expect(puts[0]).toEqual({
      requires_restart: 0,
      update_topic: 'config/lpr',
      config_data: { lpr: { known_plates: { 'Tesla Model 3 van Mark': ['G929VD'], bestelbus: ['VX123B'], 'Oude auto': null } } },
    });
    expect(await sync.runOnce()).toBe(false);
    expect(puts).toHaveLength(1);
    expect(sync.status()).toMatchObject({ changedAt: 100, error: null, count: 2 });
  });

  it('reports a refused write without throwing', async () => {
    const r = register();
    const fetchImpl = (async (input: string | URL) =>
      String(input).endsWith('/api/config') ? Response.json({ lpr: {} }) : Response.json({ success: false, message: 'Error saving config' }, { status: 400 })) as typeof fetch;
    const sync = new KnownPlatesSync({ frigateUrl: 'https://frigate:8971', fetch: fetchImpl, register: r.get });
    expect(await sync.runOnce()).toBe(false);
    expect(sync.status().error).toContain('Error saving config');
  });

  it('does not take the name Frigate put on a known car for a recognised face', async () => {
    const store = new HighlightStore(':memory:');
    cleanup.push(() => store.close());
    const t = Date.UTC(2026, 10, 13, 12, 0) / 1000;
    const reviews = [
      {
        id: 'a', camera: 'Vriezenveen_oprit', start_time: t, end_time: t + 20, severity: 'alert',
        data: { objects: ['car-verified', 'person'], sub_labels: ['Tesla Model 3 van Mark'], detections: ['car-1', 'p-1'] },
      },
    ];
    const events: Record<string, object> = {
      'car-1': { id: 'car-1', label: 'car', camera: 'Vriezenveen_oprit', sub_label: ['Tesla Model 3 van Mark', 0.95], data: { top_score: 0.9, recognized_license_plate: 'G929VD' } },
      'p-1': { id: 'p-1', label: 'person', camera: 'Vriezenveen_oprit', data: { top_score: 0.8 } },
    };
    const fetchImpl = (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/review') return Response.json(reviews);
      const id = /^\/api\/events\/([^/]+)$/.exec(url.pathname)?.[1];
      if (id) return Response.json(events[decodeURIComponent(id)]);
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    store.setMeta('activated_at', String(t - 60));
    const importer = new HighlightImporter(store, { frigateUrl: 'http://frigate:5000', cameras, fetch: fetchImpl, now: () => t + 300 });
    await importer.runOnce();
    expect(store.get('a')).toMatchObject({ subLabels: [], plates: ['G929VD'] });
    expect(store.get('a')!.reasons).not.toContain('bekende persoon');
  });
});
