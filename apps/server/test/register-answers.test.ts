import { afterEach, describe, expect, it } from 'vitest';
import { FactStore } from '../src/ai/facts.ts';
import { personProposals } from '../src/household/bundle.ts';
import { HouseholdStore } from '../src/household/store.ts';
import { redundantFact } from '../src/ai/knowledge.ts';
import type { StoredCandidate } from '../src/highlights/store.ts';
import { answerHousehold, householdQuestionApplies, householdQuestions, registerVehicleAnswer, sameVehicles } from '../src/questions/household.ts';
import { QuestionStore, type Question } from '../src/questions/store.ts';
import { vehicleParts } from '../src/questions/vehicles.ts';

const NOW = 1_794_500_000;
const cleanup: (() => unknown)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function register() {
  const store = new HouseholdStore(':memory:');
  cleanup.push(() => store.close());
  const noelle = store.addPerson({ name: 'Noëlle Snippe', role: 'buren' }, [], [], NOW);
  const johan = store.addPerson({ name: 'Johan Mevius', role: 'bewoner' }, [], [], NOW);
  return { store, noelle, johan };
}
const ctx = (questionId: number, factId: number | null = null) => ({ questionId, factId, by: 'mevius', now: NOW });

describe('vehicle answers go into the register at once (0.32.0)', () => {
  it('reads kind, make, model, colour and plate from a description', () => {
    expect(vehicleParts('zwarte Volkswagen up!, kenteken G-929-VD')).toEqual({ kind: 'auto', make: 'Volkswagen', model: 'up!', colour: 'zwart', plate: 'G-929-VD' });
    expect(vehicleParts('Witte Mercedes-Benz Sprinter-bestelbus met ladders')).toEqual({ kind: 'bestelbus', make: 'Mercedes-Benz', model: 'Sprinter', colour: 'wit', plate: '' });
    expect(vehicleParts('zwarte Gazelle e-bike met fietstassen')).toMatchObject({ kind: 'fiets', make: 'Gazelle', model: '' });
  });

  it('adds a new vehicle, and a new owner without a role', () => {
    const { store } = register();
    expect(registerVehicleAnswer(store, 'Witte Mercedes-Benz Sprinter-bestelbus met ladders', 'Bert Hemmer', ctx(40, 12))).toBe('Nieuw voertuig: wit Mercedes-Benz Sprinter van Bert Hemmer (vraag 40)');
    const bert = store.people().find((p) => p.name === 'Bert Hemmer')!;
    expect(bert.role).toBe('');
    expect(store.vehicles()).toEqual([expect.objectContaining({ kind: 'bestelbus', features: 'ladders', ownerId: bert.id, sources: ['vraag 40', 'feit 12'] })]);
    expect(store.history(5).map((h) => h.text)).toContain('Nieuwe persoon: Bert Hemmer (vraag 40)');
  });

  it('puts the answer with a vehicle of the same plate or the same owner, make and model', () => {
    const { store, noelle } = register();
    const up = store.addVehicle({ make: 'Volkswagen', model: 'up!', colour: 'donker', ownerId: noelle.id }, ['feit 10'], [], NOW);
    const peugeot = store.addVehicle({ make: 'Peugeot', model: '108', plate: 'TV-666-R' }, ['feit 4'], [], NOW);
    expect(registerVehicleAnswer(store, 'zwarte Volkswagen up!', 'noëlle', ctx(41))).toBe('Antwoord bij donker Volkswagen up! van Noëlle Snippe gezet (vraag 41)');
    // A plate read one character off still finds the vehicle; it had no owner yet.
    registerVehicleAnswer(store, 'grijze Peugeot 108, kenteken TV-668-R', 'Noëlle Snippe', ctx(42));
    expect(store.vehicle(peugeot.id)).toMatchObject({ ownerId: noelle.id, sources: ['feit 4', 'vraag 42'] });
    expect(store.vehicle(up.id)!.sources).toEqual(['feit 10', 'vraag 41']);
    expect(store.vehicles()).toHaveLength(2);
  });

  it('leaves unclear answers to the bundling', () => {
    const { store, noelle } = register();
    store.addVehicle({ make: 'Peugeot', model: '108', plate: 'TV-666-R', ownerId: noelle.id }, [], [], NOW);
    // A known plate with another owner, and a car without make or plate.
    expect(registerVehicleAnswer(store, 'grijze Peugeot 108, kenteken TV-666-R', 'Johan Mevius', ctx(43))).toBeNull();
    expect(registerVehicleAnswer(store, 'witte bestelbus met opschrift', 'Johan Mevius', ctx(44))).toBeNull();
    expect(store.vehicles()).toHaveLength(1);
  });
});

describe('the register asks about duplicates (0.32.0)', () => {
  it('asks whether two entries are one vehicle and merges them on yes', () => {
    const { store, noelle, johan } = register();
    const black = store.addVehicle({ make: 'Volkswagen', model: 'Up', colour: 'zwart', ownerId: noelle.id }, ['feit 7'], [], NOW);
    const dark = store.addVehicle({ make: 'Volkswagen', model: 'Up', colour: 'donker', plate: 'G-929-VD', ownerId: noelle.id }, ['feit 10'], ['plate'], NOW);
    const c1 = store.addVehicle({ make: 'Toyota', model: 'Corolla', plate: '96-NBF-1', ownerId: johan.id }, [], [], NOW);
    const c2 = store.addVehicle({ make: 'Toyota', model: 'Corolla', plate: '96NBF1', place: 'carport', ownerId: johan.id }, [], [], NOW);
    // Another make of the same owner is no duplicate.
    store.addVehicle({ make: 'Ford', model: 'Fiesta', ownerId: johan.id }, [], [], NOW);
    expect(sameVehicles(store.vehicles()).map(([a, b]) => [a.id, b.id])).toEqual([[black.id, dark.id], [c1.id, c2.id]]);

    const questions = new QuestionStore(':memory:');
    const facts = new FactStore(':memory:');
    cleanup.push(() => questions.close(), () => facts.close());
    const asked = householdQuestions(store, facts).filter((q) => q.data.type === 'same');
    expect(asked.map((q) => q.title)).toEqual(['Zijn dit dezelfde auto van Noëlle Snippe?', 'Zijn dit dezelfde auto van Johan Mevius?']);
    const q = (i: number) => ({ id: 50 + i, kind: 'household', data: asked[i]!.data }) as unknown as Question;
    const answerCtx = { register: store, facts, questions, by: 'mevius', now: NOW + 10 };

    expect(answerHousehold(q(0), {}, answerCtx)).toEqual({ error: 'Kies ja of nee' });
    // Yes: the one with a plate stays and keeps what only the other knew.
    expect(answerHousehold(q(0), { same: true }, answerCtx)).toEqual({ answer: 'Ja, samengevoegd tot donker Volkswagen Up, kenteken G-929-VD', fact: null });
    expect(store.vehicle(black.id)).toBeUndefined();
    expect(store.vehicle(dark.id)).toMatchObject({ sources: ['feit 10', 'feit 7', 'vraag 50'], locked: ['plate'] });
    // No: both stay.
    expect(answerHousehold(q(1), { same: false }, answerCtx)).toEqual({ answer: 'Nee, twee voertuigen', fact: null });
    expect(store.vehicle(c1.id) && store.vehicle(c2.id)).toBeTruthy();
    expect(store.lastChange()).toBe(NOW + 10);
  });

  it('also asks when one entry of the same make has no model (0.38.0)', () => {
    const { store, noelle, johan } = register();
    const corolla = store.addVehicle({ make: 'Toyota', model: 'Corolla', colour: 'donkerblauw', plate: 'N-890-KP', ownerId: johan.id }, [], [], NOW);
    const toyota = store.addVehicle({ make: 'Toyota', colour: 'donker', ownerId: johan.id }, [], [], NOW);
    // Two models of one make with the same owner stay apart, and so does the same make of another owner.
    store.addVehicle({ make: 'Toyota', model: 'Yaris', ownerId: johan.id }, [], [], NOW);
    store.addVehicle({ make: 'Toyota', ownerId: noelle.id }, [], [], NOW);
    expect(sameVehicles(store.vehicles()).map(([a, b]) => [a.id, b.id])).toEqual([[corolla.id, toyota.id], [toyota.id, toyota.id + 1]]);
  });
});

describe('look-alike plates (0.43.0)', () => {
  it('asks about two plates of one owner with the same make and model; the administrator chooses the plate', () => {
    const { store, johan } = register();
    // Roel's Hyundai H-1 as V-363-LN (from an answer, locked) and V-636-LN.
    const set = store.addVehicle({ kind: 'bestelbus', make: 'Hyundai', model: 'H-1', plate: 'V-363-LN', ownerId: johan.id }, ['vraag 1'], ['plate'], NOW);
    const read = store.addVehicle({ kind: 'bestelbus', make: 'Hyundai', model: 'H-1', plate: 'V-636-LN', ownerId: johan.id }, ['feit 2', 'feit 3'], [], NOW);
    // Another model, or the make only: not asked.
    store.addVehicle({ kind: 'bestelbus', make: 'Hyundai', model: 'Staria', plate: 'X-111-YZ', ownerId: johan.id }, [], [], NOW);
    store.addVehicle({ kind: 'bestelbus', make: 'Hyundai', plate: 'X-222-YZ', ownerId: johan.id }, [], [], NOW);
    expect(sameVehicles(store.vehicles()).map(([a, b]) => [a.id, b.id])).toEqual([[set.id, read.id]]);
    const facts = new FactStore(':memory:');
    const questions = new QuestionStore(':memory:');
    cleanup.push(() => questions.close(), () => facts.close());
    const [asked] = householdQuestions(store, facts).filter((q) => q.data.type === 'same');
    // Both plates came from answers: the administrator chooses (0.43.1).
    expect(asked!.body).toContain('Ja: ze worden samengevoegd; kies welk kenteken klopt.');
    expect(asked!.data).toMatchObject({ plates: ['V-363-LN', 'V-636-LN'] });
    const q = { id: 60, kind: 'household', data: asked!.data } as unknown as Question;
    const answerCtx = { register: store, facts, questions, by: 'mevius', now: NOW };
    expect(answerHousehold(q, { same: true }, answerCtx)).toEqual({ error: 'Kies welk kenteken klopt' });
    answerHousehold(q, { same: true, keep: set.id }, answerCtx);
    expect(store.vehicle(read.id)).toBeUndefined();
    expect(store.vehicle(set.id)).toMatchObject({ plate: 'V-363-LN' });
  });
});

describe('roles from answers (0.32.0)', () => {
  it('takes the role given most often, not the newest answer', () => {
    const johan = { name: 'Johan Mevius', at: 0 };
    const answers = [
      ...Array.from({ length: 3 }, (_, i) => ({ questionId: i + 1, ...johan, category: 'bewoner', at: NOW + i })),
      { questionId: 9, ...johan, category: 'bezoeker', at: NOW + 100 },
    ];
    const out = personProposals([], { facts: [], answers, faceNames: [] });
    expect(out[0]!.data.role).toBe('bewoner');
    // A tie goes to the newest.
    const tie = personProposals([], { facts: [], answers: [answers[0]!, answers[3]!], faceNames: [] });
    expect(tie[0]!.data.role).toBe('bezoeker');
  });
});

describe('register upkeep (0.45.0)', () => {
  const sighting = (id: string, plates: string[], startTime = NOW - 3600) => ({ id, startTime, plates, hasThumbnail: true }) as unknown as StoredCandidate;

  it('asks whose car a plate is that Frigate keeps reading, and puts the answer in the register', () => {
    const { store, noelle } = register();
    store.addVehicle({ make: 'Tesla', model: 'Model 3', plate: 'Z-034-LV' }, ['vraag 1'], [], NOW);
    const facts = new FactStore(':memory:');
    const questions = new QuestionStore(':memory:');
    cleanup.push(() => questions.close(), () => facts.close());
    const old = facts.add('Grijze Hyundai i10, kenteken 96-NBF-1 is van Noëlle Snippe', 'mark (vraag 86)', NOW);
    // Three reads, one of them one character off; a register plate read wrongly and a plate read twice are not asked.
    const seen = [
      sighting('a', ['96NBF1'], NOW - 300), sighting('b', ['96NBF1', 'Z034LY']), sighting('c', ['96NBFI1']),
      sighting('d', ['Z034LY']), sighting('e', ['Z034LV']), sighting('f', ['KBN97Z']), sighting('g', ['KBN97Z']),
    ];
    const asked = householdQuestions(store, facts, seen).filter((q) => q.data.type === 'plate');
    expect(asked.map((q) => q.title)).toEqual(['Van wie is de auto met kenteken 96-NBF-1?']);
    expect(asked[0]).toMatchObject({ highlightId: 'a', data: { reads: 3, vehicle: 'Grijze Hyundai i10', facts: [{ id: old.id }] } });
    const q = { id: 70, kind: 'household', data: asked[0]!.data } as unknown as Question;
    const answerCtx = { register: store, facts, questions, by: 'mevius', now: NOW };
    expect(answerHousehold(q, { owner: '' }, answerCtx)).toEqual({ error: 'Vul in van wie de auto is' });
    expect(answerHousehold(q, { owner: 'Noëlle', vehicle: 'grijze Hyundai i10' }, answerCtx)).toMatchObject({ answer: 'grijze Hyundai i10 van Noëlle' });
    expect(store.vehicles().find((v) => v.plate === '96-NBF-1')).toMatchObject({ make: 'Hyundai', model: 'i10', ownerId: noelle.id });
    // The old answer about this plate is replaced in place, not kept next to the new one.
    expect(facts.list().map((f) => f.text)).toEqual(['Grijze Hyundai i10, kenteken 96-NBF-1 is van Noëlle.']);
    expect(householdQuestions(store, facts, seen).some((x) => x.data.type === 'plate')).toBe(false);
    expect(householdQuestionApplies({ ...q, data: asked[0]!.data } as unknown as Question, store)).toBe(false);
  });

  it('asks whether a vehicle still exists when no fact it rested on is left', () => {
    const { store, johan } = register();
    const transit = store.addVehicle({ kind: 'bestelbus', make: 'Ford', model: 'Transit', plate: '20-WLJ-7', ownerId: johan.id }, ['feit 34'], [], NOW);
    store.addVehicle({ make: 'Toyota', model: 'Corolla', plate: 'N-890-KP', ownerId: johan.id }, ['feit 6'], [], NOW);
    const facts = new FactStore(':memory:');
    const questions = new QuestionStore(':memory:');
    cleanup.push(() => questions.close(), () => facts.close());
    // Only fact 1 exists: both vehicles rest on removed facts, the Corolla too.
    facts.add('Donkerblauwe stationwagen Toyota Corolla is van Johan Mevius', 'mark (vraag 25)', NOW);
    const asked = householdQuestions(store, facts).filter((q) => q.data.type === 'gone');
    expect(asked.map((q) => q.title)).toEqual(['Klopt de Ford Transit, kenteken 20-WLJ-7 van Johan Mevius nog?', 'Klopt de Toyota Corolla, kenteken N-890-KP van Johan Mevius nog?']);
    const answerCtx = { register: store, facts, questions, by: 'mevius', now: NOW };
    const [gone, corolla] = asked.map((a, i) => ({ id: 80 + i, kind: 'household', data: a.data }) as unknown as Question);
    answerHousehold(corolla!, { keep: true }, answerCtx);
    expect(householdQuestionApplies(corolla!, store)).toBe(false);
    answerHousehold(gone!, { keep: false }, answerCtx);
    expect(store.vehicle(transit.id)).toBeUndefined();
    expect(store.history(5).map((h) => h.text)).toContain('Voertuig verwijderd: Ford Transit, kenteken 20-WLJ-7 van Johan Mevius (vraag 80)');
  });

  it('gives the AI no raw fact that says nothing the register does not', () => {
    const { store } = register();
    const bert = store.addPerson({ name: 'Bert Hemmer', role: 'buren' }, [], [], NOW);
    const gideon = store.addPerson({ name: 'Gideon Snippe', role: 'buren' }, [], [], NOW);
    store.addVehicle({ kind: 'bestelbus', make: 'Mercedes-Benz', model: 'Sprinter', colour: 'wit', plate: 'KBP-02-B', ownerId: bert.id }, [], [], NOW);
    store.addVehicle({ make: 'Ford', model: 'Fiesta', colour: 'wit', plate: 'L-146-FK', features: 'hatchback', ownerId: gideon.id }, [], [], NOW);
    const reg = { people: store.people(), vehicles: store.vehicles() };
    expect(redundantFact('Bert Hemmer (buur) rijdt in een witte Mercedes-Benz Sprinter.', reg)).toBe(true);
    expect(redundantFact('Gideon Snippe heeft een witte Ford Fiesta hatchback.', reg)).toBe(true);
    expect(redundantFact('Johan Mevius is een bewoner.', reg)).toBe(true);
    // Something new: another car, a feature, another owner.
    expect(redundantFact('Grijze Peugeot 108, kenteken TV-666-R is van Noëlle Snippe', reg)).toBe(false);
    expect(redundantFact('De witte Ford Fiesta van Gideon Snippe heeft een trekhaak.', reg)).toBe(false);
    expect(redundantFact('Witte Mercedes-Benz Sprinter is van Gideon Snippe', reg)).toBe(false);
  });
});
