import { afterEach, describe, expect, it } from 'vitest';
import { HighlightStore } from '../src/highlights/store.ts';
import { HouseholdStore } from '../src/household/store.ts';
import { personSuggestions } from '../src/questions/routes.ts';

// Monday 2026-11-09 23:26 Europe/Amsterdam.
const T = Date.parse('2026-11-09T22:26:00Z') / 1000;
const cleanup: (() => unknown)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function setup() {
  const highlights = new HighlightStore(':memory:');
  const household = new HouseholdStore(':memory:');
  cleanup.push(() => highlights.close(), () => household.close());
  const johan = household.addPerson({ name: 'Johan Mevius', role: 'bewoner' }, [], [], T);
  const mark = household.addPerson({ name: 'Mark Mevius', role: 'familie' }, [], [], T);
  const tineke = household.addPerson({ name: 'Tineke Mevius', role: 'bewoner' }, [], [], T);
  household.addVehicle({ make: 'Tesla', model: 'Model 3', colour: 'zwart', plate: 'G-929-VD', ownerId: mark.id }, [], [], T);
  household.addVehicle({ make: 'Volkswagen', model: 'E-UP', colour: 'lichtblauw', ownerId: tineke.id }, [], [], T);
  void johan;
  const add = (id: string, at: number, camera: string, extra: { subLabels?: string[]; plates?: string[] } = {}) => {
    highlights.insert(
      {
        id, startTime: at, endTime: at + 10, cameras: [camera], camera, frigateCamera: camera, repEvent: 'e', clipStart: 0, clipEnd: 10, eventStart: 0, eventEnd: 10,
        labels: ['person'], subLabels: extra.subLabels ?? [], plates: extra.plates ?? [], score: 3, reasons: [], description: 'Persoon',
      },
      [id],
    );
    return highlights.get(id)!;
  };
  const ctx = () => ({ highlights, people: household.people(), vehicles: household.vehicles(), cameraName: (id: string) => ({ voordeur: 'Voordeur', oprit: 'Oprit / Pad' })[id] ?? id });
  return { highlights, add, ctx };
}

describe('who a person question is probably about (0.33.0)', () => {
  it('names someone answered, recognised or driving a known vehicle in the same visit, strongest first', () => {
    const t = setup();
    const h = t.add('q', T, 'oprit');
    t.add('answered', T - 60, 'voordeur');
    t.highlights.setAnnotation('answered', 'Johan Mevius (bewoner)', true);
    t.add('plate', T + 120, 'oprit', { plates: ['G929VD'] });
    t.add('face', T - 300, 'voordeur', { subLabels: ['Tineke Mevius'] });
    // The AI recognised Tineke's e-up in this highlight itself; she is suggested once, from the stronger face.
    t.highlights.setAiResult('q', 'Een persoon staat op het pad.', true, T, null, false, null, [{ description: 'lichtblauwe Volkswagen e-Up', known: true }]);
    // Too long before: another visit.
    t.add('old', T - 20 * 60, 'voordeur', { subLabels: ['Mark Mevius'] });
    expect(personSuggestions(h, t.ctx())).toEqual([
      { name: 'Johan Mevius', category: 'bewoner', text: 'Om 23:25 bij Voordeur: Johan Mevius (bewoner), jouw antwoord.' },
      { name: 'Tineke Mevius', category: 'bewoner', text: 'Om 23:21 bij Voordeur: Frigate herkende het gezicht van Tineke Mevius.' },
      { name: 'Mark Mevius', category: 'familie', text: 'Om 23:28 bij Oprit / Pad: Frigate las het kenteken G-929-VD van de zwart Tesla Model 3 van Mark Mevius.' },
    ]);
  });

  it('uses a vehicle answer and a vehicle the AI recognised in this highlight', () => {
    const t = setup();
    const h = t.add('q', T, 'oprit');
    t.highlights.setAiResult('q', 'Een persoon stapt in een auto.', true, T, 'lichtblauwe Volkswagen E-UP', true, true, []);
    t.add('car', T - 120, 'oprit');
    t.highlights.setAnnotation('car', 'auto van Mark Mevius', true);
    // An answer without a name says nothing about who it is.
    t.add('nameless', T - 30, 'voordeur');
    t.highlights.setAnnotation('nameless', 'onbekend', false);
    expect(personSuggestions(h, t.ctx())).toEqual([
      { name: 'Mark Mevius', category: 'familie', text: 'Om 23:24 bij Oprit / Pad: auto van Mark Mevius, jouw antwoord.' },
      { name: 'Tineke Mevius', category: 'bewoner', text: 'In deze highlight: de lichtblauw Volkswagen E-UP van Tineke Mevius (herkend door de AI).' },
    ]);
  });
});
