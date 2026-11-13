import { afterEach, describe, expect, it } from 'vitest';
import { FactStore } from '../src/ai/facts.ts';
import { personProposals } from '../src/household/bundle.ts';
import { HouseholdStore } from '../src/household/store.ts';
import { answerHousehold, householdQuestions, registerVehicleAnswer, sameVehicles } from '../src/questions/household.ts';
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
