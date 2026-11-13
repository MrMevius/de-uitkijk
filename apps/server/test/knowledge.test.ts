import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCameraConfig } from '@uitkijk/shared';
import { buildFactPrompt, parseFact } from '../src/ai/fact-writer.ts';
import { FactStore } from '../src/ai/facts.ts';
import { buildPrompt } from '../src/ai/codex.ts';
import { checkVerdict, knownPlates, looseObjectFact, plateCertainties, plateMatches, promptKnowledge, vagueFact, vehicleKnown, type Register } from '../src/ai/knowledge.ts';
import { AiWorker } from '../src/ai/worker.ts';
import { HighlightStore } from '../src/highlights/store.ts';
import { HouseholdStore } from '../src/household/store.ts';
import { learningStats } from '../src/questions/learning.ts';
import { QuestionStore } from '../src/questions/store.ts';

const cameras = parseCameraConfig(JSON.parse(readFileSync(new URL('../../../config/cameras.json', import.meta.url), 'utf8')));
const NOW = 1_794_400_000;

const cleanup: (() => unknown)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** Tineke with a plated e-up, Noëlle with a vague black car and an up! without plate, Bert with a van. */
function household() {
  const store = new HouseholdStore(':memory:');
  cleanup.push(() => store.close());
  const tineke = store.addPerson({ name: 'Tineke Mevius', role: 'bewoner', aliases: ['Tini'] }, ['vraag 1'], [], NOW);
  const noelle = store.addPerson({ name: 'Noëlle Snippe', role: 'buren' }, ['vraag 2'], [], NOW);
  const bert = store.addPerson({ name: 'Bert Hemmer', role: 'buren' }, [], [], NOW);
  store.addVehicle({ make: 'Volkswagen', model: 'E-UP', colour: 'lichtblauw', plate: 'Z-632-FL', ownerId: tineke.id, place: 'carport' }, ['feit 1'], [], NOW);
  store.addVehicle({ colour: 'zwart', ownerId: noelle.id }, ['feit 7'], [], NOW);
  store.addVehicle({ make: 'Volkswagen', model: 'up!', colour: 'donker', ownerId: noelle.id }, ['feit 10'], [], NOW);
  store.addVehicle({ kind: 'bestelbus', make: 'Mercedes-Benz', model: 'Sprinter', colour: 'wit', ownerId: bert.id }, ['feit 2'], [], NOW);
  return store;
}
const registerOf = (s: HouseholdStore): Register => ({ people: s.people(), vehicles: s.vehicles() });

describe('household knowledge for the AI (0.30.0)', () => {
  it('gives the register and only the facts it does not hold yet, without vague cars', () => {
    const facts = new FactStore(':memory:');
    cleanup.push(() => facts.close());
    for (const t of [
      'Lichtblauwe Volkswagen E-UP is van Tineke Mevius', // 1, in the register
      'Witte Mercedes-Benz Sprinter-bestelbus is van Bert Hemmer', // 2, in the register
      'Donkere auto links in beeld, grotendeels verborgen is van Noëlle Snippe', // 3, vague
      'Grijze Hyundai i10, kenteken 96-NBF-1 is van Noëlle Snippe', // 4, new
      'Gideon Snippe heeft een witte Ford Fiesta.', // 5, new
    ]) facts.add(t, 'mark');
    const lines = promptKnowledge(registerOf(household()), facts.list());
    expect(lines).toEqual([
      'Bert Hemmer: buren.',
      'Noëlle Snippe: buren.',
      'Tineke Mevius: bewoner (ook: Tini).',
      'lichtblauw Volkswagen E-UP, kenteken Z-632-FL, staat meestal: carport is van Tineke Mevius.',
      'donker Volkswagen up! is van Noëlle Snippe.',
      'wit Mercedes-Benz Sprinter (bestelbus) is van Bert Hemmer.',
      'Grijze Hyundai i10, kenteken 96-NBF-1 is van Noëlle Snippe',
      'Gideon Snippe heeft een witte Ford Fiesta.',
    ]);
    // The vague black car of the register is not in it either.
    expect(lines.join('\n')).not.toContain('zwart');
  });

  it('leaves out moments, duplicate cars and facts the register took over from its own questions', () => {
    const store = new HouseholdStore(':memory:');
    cleanup.push(() => store.close());
    const johan = store.addPerson({ name: 'Johan Mevius', role: 'bewoner' }, ['vraag 132'], [], NOW);
    store.addVehicle({ make: 'Toyota', model: 'Corolla', colour: 'donkerblauw', plate: 'N-890-KP', ownerId: johan.id }, ['vraag 139'], [], NOW);
    store.addVehicle({ make: 'Toyota', model: 'Corolla', colour: 'donkerblauw', plate: 'N-890-KP', ownerId: johan.id, place: 'onder de carport' }, ['feit 6'], [], NOW);
    store.addVehicle({ make: 'Volkswagen', model: 'Up', features: 'kinderzitje, grotendeels verborgen', place: 'links in beeld', ownerId: johan.id }, [], [], NOW);
    const facts = new FactStore(':memory:');
    cleanup.push(() => facts.close());
    facts.add('Johan Mevius is een bewoner.', 'mevius (vraag 132)');
    facts.add('De donkerblauw Toyota Corolla van Johan Mevius heeft kenteken N-890-KP.', 'mevius (vraag 139)');
    facts.add('Johan Mevius komt met een grijze Toyota Yaris.', 'AI (vraag 132)');
    expect(promptKnowledge(registerOf(store), facts.list())).toEqual([
      'Johan Mevius: bewoner.',
      'donkerblauw Toyota Corolla, kenteken N-890-KP is van Johan Mevius.',
      'Volkswagen Up, vaste kenmerken: kinderzitje is van Johan Mevius.',
      'Johan Mevius komt met een grijze Toyota Yaris.',
    ]);
  });

  it('knows which raw facts are too vague to match on', () => {
    expect(vagueFact('Zwarte compacte hatchback is van Noëlle Snippe')).toBe(true);
    expect(vagueFact('Donkere hatchback is van Johan Mevius')).toBe(true);
    expect(vagueFact('Donkere Volkswagen up! is van Noëlle Snippe')).toBe(false);
    expect(vagueFact('Witte bestelbus met aanhanger vol ladders is van Roel Snippe')).toBe(false);
    expect(vagueFact('Zwarte Tesla, kenteken G-929-VD is van Mark')).toBe(false);
    expect(vagueFact('Johan Mevius is een bewoner.')).toBe(false);
    expect(vagueFact('Jasper fietst op een zwarte fiets met kinderzitje')).toBe(false);
  });

  it('turns a plate Frigate read into a certainty for the prompt, ignoring words read as plates', () => {
    const reg = registerOf(household());
    expect(plateMatches(['SCHUUR', 'ANNKE'], reg)).toEqual([]);
    const m = plateMatches(['Z632FI'], reg); // one misread character
    expect(m.map((v) => v.plate)).toEqual(['Z-632-FL']);
    const certain = plateCertainties(m, reg);
    expect(certain).toEqual(['Het kenteken Z-632-FL is gelezen: de lichtblauw Volkswagen E-UP van Tineke Mevius is in beeld.']);
    const prompt = buildPrompt({ cameraName: 'Oprit', time: 't', objects: ['car'], certain });
    expect(prompt).toContain('Zeker (kenteken gelezen en gevonden in het register):');
    expect(prompt).toContain(`- ${certain[0]}`);
    expect(buildPrompt({ cameraName: 'Oprit', time: 't', objects: ['car'] })).not.toContain('Zeker (kenteken');
  });

  it('decides vehicle matches it can be sure of', () => {
    const reg = registerOf(household());
    const ctx = { matches: [] as ReturnType<typeof plateMatches>, knownPlates: knownPlates(reg, ['Zwarte Tesla Model 3, kenteken G-929-VD is van Mark']), vehicles: reg.vehicles };
    // A plate in the description settles it.
    expect(vehicleKnown('lichtblauwe Volkswagen e-Up, kenteken Z-632-F', false, ctx)).toBe(true);
    expect(vehicleKnown('zwarte Tesla Model 3, kenteken G-029-VD', false, ctx)).toBe(true);
    // Another plate on the same make and model as a plated register car: another car.
    expect(vehicleKnown('lichtblauwe Volkswagen E-UP, kenteken AB-123-C', true, ctx)).toBe(false);
    // A known plate on a car of another make is not trusted (the AI put Mark's Tesla plate on an up!).
    const marks = { ...ctx, vehicles: [...reg.vehicles, { ...reg.vehicles[0]!, id: 99, make: 'Tesla', model: 'Model 3', plate: 'G-929-VD' }] };
    expect(vehicleKnown('donkergrijze Volkswagen up!, kenteken G-929-VD', false, marks)).toBe(false);
    expect(vehicleKnown('zwarte Tesla Model 3, kenteken G-929-VD', false, marks)).toBe(true);
    // Bert's van has no plate in the register: an unknown plate does not overrule the AI.
    expect(vehicleKnown('witte Mercedes-Benz Sprinter, kenteken V-363-LN', true, ctx)).toBe(true);
    // Vague cars are never known.
    expect(vehicleKnown('zwarte compacte hatchback', true, ctx)).toBe(false);
    expect(vehicleKnown('donkere auto, merk en model niet herkenbaar', true, ctx)).toBe(false);
    // A plate Frigate read makes the vehicle of that make and model known.
    const withPlate = { ...ctx, matches: plateMatches(['Z632FL'], reg) };
    expect(vehicleKnown('lichtblauwe Volkswagen e-Up', false, withPlate)).toBe(true);
    expect(vehicleKnown('grijze Peugeot 108', false, withPlate)).toBe(false);
    // Otherwise the AI's judgement stands.
    expect(vehicleKnown('donkere Volkswagen up!', true, ctx)).toBe(true);
  });

  it('puts the recognised first name in when the AI left it out, only when that is unambiguous', () => {
    const base = { matches: [], knownPlates: [], vehicles: [] };
    const verdict = { description: 'Een persoon loopt naar de camera met een doos.', realEvent: true };
    expect(checkVerdict(verdict, { ...base, recognized: ['Jasper Mevius'], objects: ['person', 'car'] }).description).toBe('Jasper loopt naar de camera met een doos.');
    // Two people: who is who is not clear.
    expect(checkVerdict(verdict, { ...base, recognized: ['Roel Snippe'], objects: ['person', 'person'] }).description).toBe(verdict.description);
    // Already named, or not starting with "Een persoon".
    const named = { description: 'Tineke loopt over de oprit.', realEvent: true };
    expect(checkVerdict(named, { ...base, recognized: ['Tineke Mevius'], objects: ['person'] }).description).toBe(named.description);
    const other = { description: 'Frigate detecteerde een persoon; die is niet te zien.', realEvent: true };
    expect(checkVerdict(other, { ...base, recognized: ['Jasper Mevius'], objects: ['person'] }).description).toBe(other.description);
    // The prompt asks for the name.
    expect(buildPrompt({ cameraName: 'x', time: 't', objects: ['person'], recognized: ['Roel Snippe'] })).toContain('Noem die persoon bij de voornaam (Roel)');
  });

  it('writes no facts about things people carry', () => {
    expect(buildFactPrompt({ question: 'Wie is dit?', answer: 'Roel (buren)', cameraName: 'Oprit' })).toContain('Geen losse voorwerpen');
    expect(looseObjectFact('Roel Snippe (buur) gebruikt een blauwe ANNEKE-koffer.')).toBe(true);
    expect(looseObjectFact('Tineke komt met een tas boodschappen.')).toBe(true);
    expect(looseObjectFact('Jasper fietst op een zwarte Gazelle met fietstassen.')).toBe(false);
    expect(looseObjectFact('De PostNL-bezorger komt met een oranje-witte PostNL-bestelbus.')).toBe(false);
    expect(parseFact('{"fact":"Roel Snippe (buur) gebruikt een blauwe ANNEKE-koffer."}')).toBeNull();
  });
});

describe('AI worker with the register (0.30.0)', () => {
  it('passes the plate certainty and corrects the answer before storing it', async () => {
    const store = new HighlightStore(':memory:');
    cleanup.push(() => store.close());
    const reg = household();
    store.insert(
      {
        id: 'a', startTime: NOW - 600, endTime: NOW - 590, cameras: ['oprit'], camera: 'oprit', frigateCamera: 'Vriezenveen_oprit', repEvent: 'e',
        clipStart: 0, clipEnd: 10, eventStart: 0, eventEnd: 10, labels: ['person', 'car'], subLabels: ['Tineke Mevius'], score: 3, reasons: [],
        description: 'Persoon', plates: ['Z632FL'],
      },
      ['a'],
    );
    store.setSelected('a', true);
    store.setThumbnail('a', new Uint8Array([1]));
    let certain: string[] | undefined;
    const worker = new AiWorker(
      store,
      async (_img, ctx) => {
        certain = ctx.certain;
        return {
          description: 'Een persoon stapt uit een lichtblauwe auto.',
          realEvent: true,
          vehicle: 'lichtblauwe Volkswagen e-Up',
          vehicleKnown: false,
          vehicles: [
            { description: 'lichtblauwe Volkswagen e-Up', known: false },
            { description: 'zwarte compacte hatchback', known: true },
          ],
        };
      },
      { cameras, now: () => NOW, toJpeg: async (b) => b, register: () => registerOf(reg) },
    );
    await worker.runOnce();
    expect(certain).toHaveLength(1);
    const c = store.get('a')!;
    expect(c.aiDescription).toBe('Tineke stapt uit een lichtblauwe auto.');
    expect(c.aiVehicleKnown).toBe(true);
    expect(c.aiVehicles).toEqual([
      { description: 'lichtblauwe Volkswagen e-Up', known: true },
      { description: 'zwarte compacte hatchback', known: false },
    ]);
  });
});

describe('learning meter (0.30.0)', () => {
  it('counts people named without an answer, known vehicles and questions per day and week', () => {
    const store = new HighlightStore(':memory:');
    const questions = new QuestionStore(':memory:');
    cleanup.push(() => store.close(), () => questions.close());
    const reg = household();
    const base = {
      endTime: NOW - 590, cameras: ['oprit'], camera: 'oprit', frigateCamera: 'Vriezenveen_oprit', repEvent: 'e',
      clipStart: 0, clipEnd: 10, eventStart: 0, eventEnd: 10, labels: ['person'], subLabels: [] as string[], score: 3, reasons: [], description: 'Persoon',
    };
    const add = (id: string, extra: Partial<typeof base> = {}) => {
      store.insert({ ...base, ...extra, id, startTime: NOW - 600 }, [id]);
      store.setSelected(id, true);
    };
    add('face', { subLabels: ['Jasper Mevius'] });
    add('ai');
    store.setAiResult('ai', 'Tini loopt naar de deur.', true, NOW, null, false, null, [{ description: 'rode Tesla', known: true }]);
    add('answered');
    store.setAnnotation('answered', 'Roel Snippe (buren)', true);
    add('unknown');
    store.setAiResult('unknown', 'Een persoon loopt over het pad.', true, NOW, null, false, null, [{ description: 'grijze Peugeot 108', known: false }]);
    add('noise');
    store.setAiResult('noise', 'Lege oprit.', false, NOW);
    add('car', { labels: ['car'] });
    // A recognised face counts low and is no highlight, but is what the meter is about.
    store.insert({ ...base, id: 'face-low', subLabels: ['Tineke Mevius'], score: 1, startTime: NOW - 600 }, ['face-low']);
    // An answer without a name does not say who it was.
    add('nameless');
    store.setAnnotation('nameless', 'onbekend', false);
    questions.add({ kind: 'person', key: 'person:x', title: 'Wie is dit?', body: '' }, NOW - 500);
    questions.add({ kind: 'highlight', key: 'hl:x', title: 'Goed?', body: '' }, NOW - 500);

    const stats = learningStats(store.candidatesSince(0), questions.list('all', 100), reg.people(), NOW);
    expect(stats.days).toHaveLength(14);
    expect(stats.weeks).toHaveLength(8);
    const today = stats.days[0]!;
    expect(today).toMatchObject({
      highlights: 6,
      persons: { total: 6, self: 3, answered: 1, unknown: 2 },
      vehicles: { total: 2, known: 1 },
      questions: { asked: 1, answered: 0 },
    });
    expect(stats.weeks[0]).toMatchObject({ highlights: 6, persons: { self: 3 } });
    expect(stats.days[1]!.highlights).toBe(0);
  });
});
