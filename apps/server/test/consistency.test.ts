import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCameraConfig } from '@uitkijk/shared';
import { FactStore } from '../src/ai/facts.ts';
import { AiLog } from '../src/ai/log.ts';
import { AiWorker } from '../src/ai/worker.ts';
import { HighlightStore } from '../src/highlights/store.ts';
import { platesOf } from '../src/highlights/importer.ts';
import { HouseholdStore } from '../src/household/store.ts';
import { realPlates } from '../src/questions/vehicles.ts';

const cameras = parseCameraConfig(JSON.parse(readFileSync(new URL('../../../config/cameras.json', import.meta.url), 'utf8')));
// Thursday 2026-11-12 12:00 Europe/Amsterdam.
const NOON = Date.parse('2026-11-12T11:00:00Z') / 1000;

const cleanup: (() => unknown)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const logCall = (log: AiLog, at: number, purpose: 'beschrijving' | 'feit' | 'huishouden') =>
  log.add({ at, purpose, model: null, effort: 'low', prompt: 'p', schema: '{}', answer: '{}', error: null, durationMs: 1, jpeg: null });

describe('daily AI cap survives a restart (0.31.0)', () => {
  it('counts the calls of the Amsterdam day from the AI log', async () => {
    const log = new AiLog(':memory:', { now: () => NOON });
    cleanup.push(() => log.close());
    await logCall(log, NOON - 13 * 3600, 'beschrijving'); // 23:00 the day before
    await logCall(log, NOON - 11.5 * 3600, 'beschrijving'); // 00:30 today
    await logCall(log, NOON - 3600, 'feit');
    await logCall(log, NOON - 60, 'huishouden');
    expect(log.callsToday()).toEqual({ beschrijving: 1, feit: 1, huishouden: 1 });
  });

  it('starts the description count at what was already used today', async () => {
    const store = new HighlightStore(':memory:');
    cleanup.push(() => store.close());
    store.insert(
      {
        id: 'a', startTime: NOON - 600, endTime: NOON - 590, cameras: ['voordeur'], camera: 'voordeur', frigateCamera: 'Vriezenveen_voordeur',
        repEvent: 'e', clipStart: 0, clipEnd: 10, eventStart: 0, eventEnd: 10, labels: ['person'], subLabels: [], score: 3, reasons: [], description: 'Persoon',
      },
      ['a'],
    );
    store.setSelected('a', true);
    store.setThumbnail('a', new Uint8Array([1]));
    let calls = 0;
    const worker = new AiWorker(
      store,
      async () => {
        calls++;
        return { description: 'Iemand bij de deur.', realEvent: true };
      },
      { cameras, dailyCap: 60, now: () => NOON, toJpeg: async (b) => b, callsToday: () => ({ beschrijving: 60, feit: 4, huishouden: 1 }) },
    );
    expect(await worker.runOnce()).toBe(false);
    expect(calls).toBe(0);
    expect(worker.status()).toMatchObject({ callsToday: 60, otherCallsToday: { feit: 4, huishouden: 1 } });
  });
});

describe('one plate rule (0.31.0)', () => {
  it('keeps only plates with four characters or more and a digit, everywhere', () => {
    expect(realPlates(['g-929-vd', 'SCHUUR', 'AB1', 'G929VD', '96 NBF 1'])).toEqual(['G929VD', '96NBF1']);
    expect(platesOf([{ id: 'a', data: { recognized_license_plate: 'SCHUUR' } }, { id: 'b', data: { recognized_license_plate: 'XX-123-Y' } }])).toEqual(['XX123Y']);
  });
});

describe('removals make descriptions out of date (0.31.0)', () => {
  it('counts a removed fact as a change', () => {
    const facts = new FactStore(':memory:');
    cleanup.push(() => facts.close());
    const f = facts.add('Rode Tesla Model 3 is van Jasper', 'mark', NOON - 3600);
    expect(facts.lastChange()).toBe(NOON - 3600);
    facts.remove(f.id, NOON);
    expect(facts.lastChange()).toBe(NOON);
  });

  it('counts a removed vehicle or person as a change of the register', () => {
    const household = new HouseholdStore(':memory:');
    cleanup.push(() => household.close());
    const p = household.addPerson({ name: 'Bert Hemmer' }, [], [], NOON - 7200);
    const v = household.addVehicle({ kind: 'bestelbus', ownerId: p.id }, [], [], NOON - 7200);
    household.removeVehicle(v.id, NOON - 3600);
    expect(household.lastChange()).toBe(NOON - 3600);
    household.removePerson(p.id, NOON);
    expect(household.lastChange()).toBe(NOON);
  });
});
