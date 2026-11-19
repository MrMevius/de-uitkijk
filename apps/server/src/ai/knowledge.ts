import type { Fact } from './facts.ts';
import type { AiVerdict, SeenVehicle } from './codex.ts';
import { plateKey, supported, tokens, vehicleLabel, type Person, type Vehicle } from '../household/store.ts';
import { DISTINCT_BODY, makeModel, normalizeVehicle, platesClose, platesIn, realPlates, vehicleNoun } from '../questions/vehicles.ts';

/** What the AI may rely on: the household register plus raw facts the register does not hold yet (since 0.30.0). */
export interface Register {
  people: Person[];
  vehicles: Vehicle[];
}

const CAR_WORD = /\b(auto|wagen|hatchback|sedan|stationwagen|suv|cabrio|coup[eé]|personenauto)\b/i;

/**
 * A car that looks like many others: no make, no plate, no lettering or distinct body ("zwarte compacte hatchback",
 * "donkere auto links in beeld"). Matching on it named the wrong owner and made highlights count as known
 * (2026-11-11: "Zwarte compacte hatchback is van Noëlle" matched 9 times).
 */
export function vagueCar(text: string): boolean {
  if (vehicleNoun(text) !== 'auto') return false;
  if (/(merk|model)[^,.;]*\bniet\b|niet (goed |duidelijk )?(herkenbaar|te herkennen)|onherkenbaar|onduidelijk/i.test(text)) return true;
  return !makeModel(text) && !platesIn(text).length && !DISTINCT_BODY.test(text);
}

/** A raw fact about a car too vague to recognise it by; it is not given to the AI. */
export const vagueFact = (text: string): boolean => CAR_WORD.test(text) && vagueCar(text);

/** A register vehicle that can be recognised: anything but a car without make and plate. */
const recognisable = (v: Vehicle) => v.kind !== 'auto' || Boolean(v.make || v.plate);

/** First name, as the AI uses it in descriptions. */
export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/**
 * The household knowledge for the description prompt: the register's people and recognisable vehicles, then the raw
 * facts that are not in the register yet (new answers between two bundlings), without vague ones. Before 0.30.0 the
 * AI got every raw fact, with duplicates, contradictions and moments such as "met open motorkap".
 */
export function promptKnowledge(register: Register, facts: Fact[]): string[] {
  const owner = new Map(register.people.map((p) => [p.id, p.name]));
  const lines: string[] = [];
  for (const p of register.people) {
    const what = [p.role, p.relation].filter(Boolean).join(', ') || 'rol onbekend';
    lines.push(`${p.name}: ${what}${p.aliases.length ? ` (ook: ${p.aliases.join(', ')})` : ''}.`);
  }
  const plates = new Set<string>();
  for (const v of register.vehicles.filter(recognisable)) {
    // The same car twice in the register (not merged yet) is given once.
    if (v.plate && plates.has(plateKey(v.plate))) continue;
    if (v.plate) plates.add(plateKey(v.plate));
    const parts = [v.kind === 'auto' ? vehicleLabel(v) : `${vehicleLabel(v)} (${v.kind})`];
    const features = stable(v.features);
    const place = stable(v.place);
    if (features) parts.push(`vaste kenmerken: ${features}`);
    if (place) parts.push(`staat meestal: ${place}`);
    const who = v.ownerId !== null ? owner.get(v.ownerId) : undefined;
    lines.push(`${parts.join(', ')}${who ? ` is van ${who}` : ', eigenaar onbekend'}.`);
  }
  for (const f of facts) if (!factInRegister(f, register) && !vagueFact(f.text)) lines.push(f.text);
  return [...new Set(lines)];
}

/**
 * How the moment looked, not the vehicle: "grotendeels verborgen", "links in beeld", "motorkap open". Only an open
 * door, bonnet or boot is a moment (0.45.0): "open aanhanger met ladders" of Roel's van was dropped as one.
 */
const MOMENT =
  /verborgen|in beeld|zichtbaar|links|rechts|voorgrond|achtergrond|geopend|(?:motorkap|deur|portier|kofferbak|achterklep|klep|raam)\S*\s+(?:staat\s+)?open|\bopen\s+(?:motorkap|deur|portier|kofferbak|achterklep|klep|raam)/i;

/** The parts of a register field that are stable ("kinderzitje, grotendeels verborgen" → "kinderzitje"). */
export const stable = (text: string) =>
  text
    .split(/,\s*/)
    .filter((t) => t && !MOMENT.test(t))
    .join(', ');

/**
 * A raw fact the register holds: cited by a bundled entry ("feit 4"), or written by an administrator's answer to a
 * register question that changed an entry ("mevius (vraag 132)" with source "vraag 132"). An AI fact from a "Wie is
 * dit?" answer shares its question with the person's entry but holds more (a vehicle, a uniform): it stays.
 */
function inRegister(f: Fact, used: Set<string>): boolean {
  if (used.has(`feit ${f.id}`)) return true;
  const question = /\(vraag (\d+)\)$/.exec(f.createdBy)?.[1];
  return !f.createdBy.startsWith('AI') && question !== undefined && used.has(`vraag ${question}`);
}

/** Words that link the parts of a fact and say nothing themselves. */
const FILLER = new Set(tokens('is van de het een heeft hebben kenteken rijdt in met en zijn haar ook die dat'));
const ROLE_WORDS: Record<string, string> = { buren: 'buur buren', bewoner: 'bewoner', familie: 'familie', bezoeker: 'bezoeker', 'vaste hulp': 'vaste hulp', 'bezorger of dienstverlener': 'bezorger dienstverlener' };

/**
 * A raw fact that says nothing one register entry does not (since 0.45.0): every word of it is in that vehicle with
 * its owner and the owner's role, or in that person. "Bert Hemmer (buur) rijdt in een witte Mercedes-Benz Sprinter"
 * and "Gideon Snippe heeft een witte Ford Fiesta hatchback" were given to the AI next to the register lines saying the same.
 */
export function redundantFact(text: string, register: Register): boolean {
  const words = tokens(text).filter((t) => !FILLER.has(t));
  if (!words.length) return false;
  const value = words.join(' ');
  const person = (id: number | null) => register.people.find((p) => p.id === id);
  const entries = [
    ...register.vehicles.map((v) => {
      const p = person(v.ownerId);
      return `${v.kind} ${v.colour} ${v.make} ${v.model} ${v.plate} ${v.features} ${v.place} ${p?.name ?? ''} ${ROLE_WORDS[p?.role ?? ''] ?? ''}`;
    }),
    ...register.people.map((p) => `${p.name} ${p.aliases.join(' ')} ${ROLE_WORDS[p.role] ?? ''}`),
  ];
  return entries.some((e) => supported(value, e));
}

/** A raw fact the AI does not need next to the register: cited by it, written by an answer to it, or redundant. */
export function factInRegister(f: Fact, register: Register): boolean {
  const used = new Set([...register.people, ...register.vehicles].flatMap((e) => e.sources));
  return inRegister(f, used) || redundantFact(f.text, register);
}

/** Register vehicles whose plate Frigate read in this event (one misread character allowed). */
export function plateMatches(framePlates: string[], register: Register): Vehicle[] {
  const read = realPlates(framePlates);
  return register.vehicles.filter((v) => v.plate && read.some((p) => platesClose(p, plateKey(v.plate))));
}

/** "Het kenteken Z-632-FL is gelezen: de lichtblauw Volkswagen E-UP van Tineke Mevius is in beeld." */
export function plateCertainties(matches: Vehicle[], register: Register): string[] {
  return matches.map((v) => {
    const who = register.people.find((p) => p.id === v.ownerId)?.name;
    return `Het kenteken ${v.plate} is gelezen: de ${vehicleLabel({ ...v, plate: '' })}${who ? ` van ${who}` : ''} is in beeld.`;
  });
}

/**
 * Whether a vehicle the AI saw is a known one, decided by the server where it can be (since 0.30.0):
 * - a plate in the description that is (one character from) a plate in the register or facts: known;
 * - a plate in the description while every register vehicle of that make and model has another plate: not known
 *   (another car of the same type);
 * - a plate Frigate read in this event that belongs to a register vehicle makes the vehicle of the same make and
 *   model known, whatever the AI said;
 * - a vague car is never known;
 * - otherwise the AI's judgement stands.
 */
export function vehicleKnown(description: string, aiKnown: boolean, ctx: { matches: Vehicle[]; knownPlates: string[]; vehicles: Vehicle[] }): boolean {
  const own = platesIn(description);
  const mm = makeModel(description);
  const typeOf = (v: Vehicle) => makeModel(vehicleLabel({ ...v, plate: '' }));
  const sameType = (v: Vehicle) => mm !== null && typeOf(v) === mm;
  const byPlate = ctx.vehicles.find((v) => v.plate && own.some((p) => platesClose(p, plateKey(v.plate))));
  if (byPlate) {
    // The AI put a known plate on a car of another make or model (2026-11-11: Mark's Tesla plate on a Volkswagen up!).
    const type = typeOf(byPlate);
    if (!mm || !type || type === mm) return true;
  } else if (own.some((p) => ctx.knownPlates.some((k) => platesClose(p, k)))) return true;
  if (own.length) {
    const same = ctx.vehicles.filter(sameType);
    if (same.length && same.every((v) => v.plate)) return false;
  }
  if (ctx.matches.some(sameType)) return true;
  if (vagueCar(description)) return false;
  return aiKnown;
}

/** Plates in the register and in the raw facts, upper case without dashes. */
export const knownPlates = (register: Register, facts: string[]): string[] => [
  ...new Set([...register.vehicles.filter((v) => v.plate).map((v) => plateKey(v.plate)), ...facts.flatMap(platesIn)]),
];

const PERSON_START = /^een persoon\b/i;

/** "Er is niemand zichtbaar", "geen persoon of activiteit zichtbaar"; not "verder niemand" or "niemand anders". */
const NOBODY = /(?<![\p{L}])(niemand|geen (persoon|personen|mens|mensen))(?![\p{L}])/iu;
const SOMEBODY_ELSE = /(?<![\p{L}])(verder|ander|andere|anders|meer)(?![\p{L}])/iu;
/** "Geen persoon duidelijk te zien": the AI hedges, its own person_seen stands. */
const HEDGE = /(?<![\p{L}])(duidelijk|goed|zeker)(?![\p{L}])/iu;

/**
 * The description says plainly that nobody is there (since 0.39.2). The production model at low effort answered
 * person_seen "ja" with "bij de carport is niemand te zien" (2026-11-17), so its own sentence counts.
 */
export const saysNobody = (description: string): boolean => NOBODY.test(description) && !SOMEBODY_ELSE.test(description) && !HEDGE.test(description);

/**
 * The AI's separate vehicle fields (since 0.42.0) completed into the sentence the rest of the server reads: a plate or
 * make the sentence leaves out is added, and a vehicle the AI calls not recognisable gets "niet herkenbaar", so it is
 * never asked about or matched (the same rule as "merk en model niet herkenbaar" in its own words).
 */
export function completeVehicle(v: SeenVehicle): string {
  let text = v.description;
  if (v.make && !makeModel(text)) text += `, ${[v.make, v.model].filter(Boolean).join(' ')}`;
  if (v.plate && /\d/.test(v.plate) && !platesIn(text).length) text += `, kenteken ${v.plate}`;
  if (v.recognisable === false && !/niet (goed |duidelijk )?herkenbaar/i.test(text)) text += ', niet herkenbaar';
  return text.slice(0, 160);
}

/** Completes every vehicle; the event's vehicle follows its list entry, or the entry the AI marked as the subject. */
function completeVehicles(verdict: AiVerdict): Pick<AiVerdict, 'vehicle' | 'vehicles'> {
  const list = verdict.vehicles ?? [];
  const done = list.map((v) => ({ ...v, description: completeVehicle(v) }));
  const own = verdict.vehicle ? list.findIndex((v) => normalizeVehicle(v.description) === normalizeVehicle(verdict.vehicle!)) : -1;
  const subject = list.findIndex((v) => v.subject);
  const vehicle = own >= 0 ? done[own]!.description : verdict.vehicle || (subject >= 0 ? done[subject]!.description : null);
  return { vehicle: vehicle ?? null, vehicles: done };
}

/**
 * Applies what the server knows for sure to the AI's answer: the known flags of vehicles (see `vehicleKnown`), and the
 * name face recognition gave. On 2026-11-10/11 Frigate recognised a face in 12 events, but four of the six
 * descriptions still said "Een persoon …". When Frigate saw one person, recognised one name and the description
 * starts with "Een persoon", that becomes the first name.
 */
export function checkVerdict(
  verdict: AiVerdict,
  ctx: { recognized: string[]; persons: number; matches: Vehicle[]; knownPlates: string[]; vehicles: Vehicle[]; objects?: string[] },
): AiVerdict {
  const known = (d: string, k: boolean) => vehicleKnown(d, k, ctx);
  verdict = { ...verdict, ...completeVehicles(verdict) };
  let description = verdict.description;
  const names = [...new Set(ctx.recognized.map(firstName))];
  // Counted from Frigate's tracked objects (since 0.34.0); the labels say "person" once however many there were.
  const persons = ctx.persons;
  const named = names.some((n) => new RegExp(`(?<![\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'iu').test(description));
  if (names.length === 1 && persons === 1 && !named && PERSON_START.test(description)) description = description.replace(PERSON_START, names[0]!);
  // The description says nobody is there: that is "nee", whatever the field says (since 0.39.2). With only a person
  // reported by Frigate there is then nothing going on.
  const nobody = verdict.personSeen !== 'nee' && persons > 0 && saysNobody(verdict.description);
  // "Ja" with nobody counted (since 0.42.0): the answer contradicts itself; a question is still asked.
  const uncounted = !nobody && verdict.personSeen === 'ja' && verdict.personsVisible === 0;
  const seen = nobody
    ? { personSeen: 'nee' as const, ...(ctx.objects?.every((o) => o === 'person') ? { realEvent: false } : {}) }
    : uncounted
      ? { personSeen: 'onduidelijk' as const }
      : {};
  // Frigate recognised a face: somebody was there, even if the AI does not see them on its still (since 0.39.0).
  const faceSeen = names.length > 0 && (verdict.personSeen === 'nee' || nobody);
  return {
    ...verdict,
    description,
    ...seen,
    ...(faceSeen ? { personSeen: 'onduidelijk' as const, realEvent: true } : {}),
    ...(verdict.vehicle ? { vehicleKnown: known(verdict.vehicle, verdict.vehicleKnown ?? false) } : {}),
    ...(verdict.vehicles ? { vehicles: verdict.vehicles.map((v) => ({ ...v, known: known(v.description, v.known) })) } : {}),
  };
}

/** Things people carry; not a stable feature of a person (2026-11-11: "Roel gebruikt een blauwe ANNEKE-koffer"). */
const LOOSE_OBJECT = /(?<![\p{L}])(koffer|koffers|tas|tassen|handtas|rugzak|doos|dozen|pakket|pakketje|pakje|boodschappen|gereedschap|container|kliko|vuilniszak|paraplu|telefoon)(?![\p{L}])/iu;

/** A fact about something a person carries instead of a vehicle, logo or uniform. */
export const looseObjectFact = (text: string): boolean => LOOSE_OBJECT.test(text);
