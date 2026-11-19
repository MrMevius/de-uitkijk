import type { FactStore } from '../ai/facts.ts';
import type { DoubtOption } from '../household/bundle.ts';
import { cleanText, findPerson, PERSON_ROLES, plateKey, vehicleLabel, type HouseholdStore, type PersonRole, type Vehicle } from '../household/store.ts';
import { stable } from '../ai/knowledge.ts';
import type { StoredCandidate } from '../highlights/store.ts';
import { makeModel, platesClose, platesIn, realPlates, vehicleParts } from './vehicles.ts';
import type { Question, QuestionStore } from './store.ts';

/**
 * Questions from the household register (since 0.29.0), to make the facts as complete and correct as possible:
 *
 * - doubt: a contradiction the bundling found, with one-click answers (the fact that then holds and the facts it
 *   replaces) or an own answer;
 * - vehicle: make and model of a vague vehicle ("zwarte hatchback van Noëlle"), or the plate of a known one;
 * - role: who a person without a role is;
 * - same: whether two entries are one vehicle (same plate, or same owner, make and model; since 0.32.0);
 * - plate: whose car it is when Frigate keeps reading a plate the register does not have (since 0.45.0);
 * - gone: whether a vehicle still exists after an answer took away every fact it rested on (since 0.45.0).
 *
 * Every answer goes into the register at once and becomes a fact for the AI; "Overslaan" means "weet ik niet" and
 * is not asked again (each question has a key that is used once).
 */
export type HouseholdQuestionData =
  | { type: 'doubt'; summary: string; options: DoubtOption[]; facts: { id: number; text: string }[] }
  | { type: 'vehicle'; vehicleId: number; fields: ('make' | 'model' | 'plate')[]; make: string; model: string; plate: string }
  | { type: 'role'; personId: number }
  | { type: 'same'; vehicleIds: [number, number]; labels: [string, string]; plates?: [string, string] }
  | { type: 'plate'; plate: string; reads: number; vehicle: string; facts: { id: number; text: string }[] }
  | { type: 'gone'; vehicleId: number; label: string; owner: string };

interface NewQuestion {
  key: string;
  /** The newest sighting, shown with the question (plate questions). */
  highlightId?: string;
  title: string;
  body: string;
  data: HouseholdQuestionData;
}

type Register = Pick<HouseholdStore, 'people' | 'vehicles' | 'proposals'>;

/** Vehicle kinds that have a plate. */
const PLATED = new Set(['auto', 'bestelbus', 'motor', 'scooter']);

const ownerOf = (register: Register, v: Vehicle) => register.people().find((p) => p.id === v.ownerId)?.name ?? '';
const the = (v: Vehicle, owner: string) => `de ${vehicleLabel(v)}${owner ? ` van ${owner}` : ''}`;

/** Which of two entries of one vehicle stays when at most one has a plate: the one with a plate, else the oldest. */
const mergeOrder = (a: Vehicle, b: Vehicle): [Vehicle, Vehicle] => (!a.plate && b.plate ? [b, a] : [a, b]);

/**
 * Two register entries that are probably one vehicle: the same plate, or the same owner, kind, make and model (Noëlle's
 * "zwart Volkswagen Up" and "donker Volkswagen Up", Johan's Corolla twice), or make only when one has no model. The colour is not compared: the AI calls the
 * same car black or dark depending on the light.
 */
export function sameVehicles(vehicles: Vehicle[]): [Vehicle, Vehicle][] {
  const type = (v: Vehicle) => (v.make ? makeModel(`${v.make} ${v.model}`) : null);
  const brand = (v: Vehicle) => (v.make ? makeModel(v.make) : null);
  // Since 0.38.0 also the same make when one has no model: Johan's "donker Toyota" next to his Corolla was never asked.
  const sameType = (a: Vehicle, b: Vehicle) =>
    (type(a) !== null && type(a) === type(b)) || (brand(a) !== null && brand(a) === brand(b) && (!a.model || !b.model));
  const pairs: [Vehicle, Vehicle][] = [];
  for (const [i, a] of vehicles.entries()) {
    for (const b of vehicles.slice(i + 1)) {
      const plate = a.plate && b.plate && plateKey(a.plate) === plateKey(b.plate);
      // Since 0.43.0 also with two plates when make and model are the same: Roel's Hyundai H-1 was in the register as
      // V-363-LN and V-636-LN. Only the administrator can say whether that is one van; "Nee" is remembered.
      const alike = !a.plate || !b.plate || (Boolean(a.model && b.model) && type(a) !== null && type(a) === type(b));
      const owner = a.ownerId !== null && a.ownerId === b.ownerId && a.kind === b.kind && sameType(a, b) && alike;
      if (plate || owner) pairs.push([a, b]);
    }
  }
  return pairs;
}

/** Frigate read a plate in at least this many events of two weeks: worth asking whose it is (since 0.45.0). */
export const PLATE_READS = 3;

/**
 * Plates Frigate keeps reading that are not (one character from) a register plate, with their reads; plates one
 * character apart count as one (the most read spelling). 96-NBF-1 was read in 9 events of 2026-11-05..19, more than
 * any register plate, while its proposal had been rejected on 2026-11-11 and could never come back.
 */
export function unknownPlates(candidates: Pick<StoredCandidate, 'id' | 'startTime' | 'plates' | 'hasThumbnail'>[], register: Register) {
  const known = register.vehicles().filter((v) => v.plate).map((v) => plateKey(v.plate));
  const reads = new Map<string, Pick<StoredCandidate, 'id' | 'startTime' | 'hasThumbnail'>[]>();
  for (const c of candidates) for (const p of realPlates(c.plates)) reads.set(p, [...(reads.get(p) ?? []), c]);
  const groups: { plate: string; events: Pick<StoredCandidate, 'id' | 'startTime' | 'hasThumbnail'>[] }[] = [];
  for (const [plate, events] of [...reads].sort((a, b) => b[1].length - a[1].length)) {
    if (known.some((k) => platesClose(k, plate))) continue;
    const group = groups.find((g) => platesClose(g.plate, plate));
    if (group) group.events.push(...events.filter((e) => !group.events.includes(e)));
    else groups.push({ plate, events: [...events] });
  }
  return groups.filter((g) => g.events.length >= PLATE_READS).map((g) => ({ ...g, events: g.events.sort((a, b) => b.startTime - a.startTime) }));
}

/** The plate as an answer wrote it ("96-NBF-1"), else as Frigate read it. */
const dashed = (plate: string, texts: string[]) =>
  texts.flatMap((t) => t.match(/\b[A-Z0-9]{1,3}-[A-Z0-9]{1,3}-[A-Z0-9]{1,3}\b/gi) ?? []).find((p) => platesClose(plateKey(p), plate))?.toUpperCase() ?? plate;

/** A vehicle all of whose sources were facts that no longer exist (an answer retired them; since 0.45.0). */
const sourceless = (v: Vehicle, factIds: Set<number>) =>
  v.sources.length > 0 && v.sources.every((s) => /^feit \d+$/.test(s) && !factIds.has(Number(s.slice(5))));

/** Candidate questions, most useful first: doubts, unknown plates, vehicles without facts, vague vehicles, people without a role, missing plates. */
export function householdQuestions(register: Register, facts: Pick<FactStore, 'list'> | undefined, candidates: StoredCandidate[] = []): NewQuestion[] {
  const factText = new Map((facts?.list() ?? []).map((f) => [f.id, f.text]));
  const out: NewQuestion[] = [];
  for (const p of register.proposals('pending').filter((x) => x.kind === 'question')) {
    const cited = p.sources.map((s) => Number(/^feit (\d+)$/.exec(s)?.[1])).filter((id) => factText.has(id));
    let options: DoubtOption[] = [];
    try {
      options = p.data.options ? (JSON.parse(p.data.options) as DoubtOption[]) : [];
    } catch {
      options = [];
    }
    out.push({
      key: `household:doubt:${p.summary.toLowerCase()}`,
      title: p.summary,
      body: 'Het huishouden twijfelt over deze feiten. Kies wat klopt of schrijf het zelf op; het antwoord wordt een feit voor de AI en vervangt wat niet meer klopt.',
      data: { type: 'doubt', summary: p.summary, options, facts: cited.map((id) => ({ id, text: factText.get(id)! })) },
    });
  }
  const vehicles = register.vehicles();
  for (const g of unknownPlates(candidates, register)) {
    // An earlier answer that names the plate is shown, not taken for granted: the owner no longer knew (2026-11-19).
    const cited = [...factText].filter(([, text]) => platesIn(text).some((p) => platesClose(p, g.plate)));
    const plate = dashed(g.plate, cited.map(([, text]) => text));
    const vehicle = cited.length ? stable(cited[0]![1].replace(/,?\s*(?:met\s+)?kenteken\s+\S+/i, '').replace(/\s+is van .*$/i, '').trim()) : '';
    out.push({
      key: `household:plate:${g.plate}`,
      ...(g.events.find((e) => e.hasThumbnail) ? { highlightId: g.events.find((e) => e.hasThumbnail)!.id } : {}),
      title: `Van wie is de auto met kenteken ${plate}?`,
      body: `Frigate las dit kenteken de afgelopen twee weken bij ${g.events.length} gebeurtenissen, maar het staat niet in het register. Met de eigenaar erbij herkent het systeem deze auto voortaan zeker. Weet je het niet, kies dan Weet ik niet.`,
      data: { type: 'plate', plate, reads: g.events.length, vehicle, facts: cited.map(([id, text]) => ({ id, text })) },
    });
  }
  for (const v of vehicles.filter((x) => sourceless(x, new Set(factText.keys())))) {
    const owner = ownerOf(register, v);
    out.push({
      key: `household:gone:${v.id}`,
      title: `Klopt ${the(v, owner)} nog?`,
      body: 'Een eerder antwoord heeft alle feiten weggehaald waarop dit voertuig in het register steunt. Nee: het voertuig gaat uit het register (en uit de bekende kentekens van Frigate).',
      data: { type: 'gone', vehicleId: v.id, label: vehicleLabel(v), owner },
    });
  }
  for (const [a, b] of sameVehicles(vehicles)) {
    const owner = ownerOf(register, a) || ownerOf(register, b);
    out.push({
      key: `household:same:${a.id}:${b.id}`,
      title: `Zijn dit dezelfde ${a.kind === 'auto' ? 'auto' : a.kind}${owner ? ` van ${owner}` : ''}?`,
      body: `Het register heeft ${the(a, ownerOf(register, a))} en ${the(b, ownerOf(register, b))}. Ja: ze worden samengevoegd${a.plate && b.plate ? '; kies welk kenteken klopt' : ''}. Nee: ze blijven apart en dit wordt niet meer gevraagd.`,
      // Two plates (since 0.43.1): the administrator says which one is right; both came from answers for Roel's van.
      data: { type: 'same', vehicleIds: [a.id, b.id], labels: [vehicleLabel(a), vehicleLabel(b)], ...(a.plate && b.plate ? { plates: [a.plate, b.plate] as [string, string] } : {}) },
    });
  }
  for (const v of vehicles) {
    if (v.kind === 'fiets' || (v.make && v.model) || (v.locked.includes('make') && v.locked.includes('model'))) continue;
    const owner = ownerOf(register, v);
    out.push({
      key: `household:vehicle:${v.id}:make`,
      title: `Welk merk en model is ${the(v, owner)}?`,
      body: 'Met merk en model herkent de AI het voertuig op de beelden en weet ze van wie het is. Een kenteken helpt nog meer: Frigate leest kentekens.',
      data: { type: 'vehicle', vehicleId: v.id, fields: ['make', 'model', 'plate'], make: v.make, model: v.model, plate: v.plate },
    });
  }
  for (const person of register.people()) {
    if (person.role || person.locked.includes('role')) continue;
    out.push({
      key: `household:role:${person.id}`,
      title: `Wie is ${person.name}?`,
      body: 'Bewoners en vaste bezoekers tellen minder zwaar mee voor de highlights; de AI gebruikt de rol in haar beschrijvingen.',
      data: { type: 'role', personId: person.id },
    });
  }
  for (const v of vehicles) {
    if (!PLATED.has(v.kind) || v.plate || v.locked.includes('plate') || !(v.make && v.model)) continue;
    const owner = ownerOf(register, v);
    out.push({
      key: `household:vehicle:${v.id}:plate`,
      title: `Wat is het kenteken van ${the(v, owner)}?`,
      body: 'Frigate leest kentekens; met het kenteken in het register herkent het systeem dit voertuig zeker, ook als de AI de kleur of het model anders ziet.',
      data: { type: 'vehicle', vehicleId: v.id, fields: ['plate'], make: v.make, model: v.model, plate: v.plate },
    });
  }
  return out;
}

/** Whether an open household question still applies (the proposal is still pending, the field still empty, …). */
export function householdQuestionApplies(q: Question, register: Register): boolean {
  const d = q.data as HouseholdQuestionData;
  if (d.type === 'doubt') return register.proposals('pending').some((p) => p.kind === 'question' && p.summary === d.summary);
  if (d.type === 'role') return register.people().some((p) => p.id === d.personId && !p.role);
  if (d.type === 'same') return d.vehicleIds.every((id) => register.vehicles().some((v) => v.id === id));
  if (d.type === 'plate') {
    const key = plateKey(d.plate);
    return !register.vehicles().some((v) => v.plate && platesClose(plateKey(v.plate), key));
  }
  if (d.type === 'gone') return register.vehicles().some((v) => v.id === d.vehicleId && v.sources.every((s) => /^feit \d+$/.test(s)));
  const v = register.vehicles().find((x) => x.id === d.vehicleId);
  if (!v) return false;
  return d.fields.includes('make') ? !(v.make && v.model) : !v.plate;
}

const ROLE_TEXT: Record<Exclude<PersonRole, ''>, string> = {
  bewoner: 'een bewoner',
  familie: 'familie',
  bezoeker: 'een vaste bezoeker',
  buren: 'een buur',
  'vaste hulp': 'vaste hulp',
  'bezorger of dienstverlener': 'een bezorger of dienstverlener',
};

export interface HouseholdAnswerContext {
  register: HouseholdStore;
  facts?: FactStore;
  questions: QuestionStore;
  by: string;
  now: number;
}

/** Applies an answer; returns the answer text for the question, or an error in Dutch. */
export function answerHousehold(q: Question, body: Record<string, unknown>, ctx: HouseholdAnswerContext): { answer: string; fact: string | null } | { error: string } {
  const { register, facts, by, now } = ctx;
  const d = q.data as HouseholdQuestionData;
  const createdBy = `${by} (vraag ${q.id})`;
  const addFact = (text: string) => facts?.add(text, createdBy, now)?.text ?? null;

  if (d.type === 'doubt') {
    const option = Number.isInteger(body.option) ? d.options[Number(body.option)] : undefined;
    const own = cleanText(body.text, 200);
    if (!option && own.length < 5) return { error: 'Kies een antwoord of schrijf op wat klopt' };
    const text = option ? option.fact : `${own.charAt(0).toUpperCase()}${own.slice(1)}`;
    const fact = addFact(text);
    // Facts this answer makes wrong or superfluous go; only facts the question itself is about.
    const cited = new Set(d.facts.map((f) => f.id));
    for (const id of option?.retire ?? []) {
      const old = d.facts.find((f) => f.id === id);
      if (cited.has(id) && facts?.remove(id, now)) register.log(`Feit ${id} vervallen door vraag ${q.id}: ${old?.text ?? ''}`, by, now);
    }
    const proposal = register.proposals('pending').find((p) => p.kind === 'question' && p.summary === d.summary);
    if (proposal) register.decide(proposal.id, 'accepted', by, now);
    register.log(`Twijfel beantwoord: ${d.summary} → ${text}`, by, now);
    return { answer: option ? `${option.label}: ${text}` : text, fact };
  }

  if (d.type === 'role') {
    const role = String(body.role ?? '') as PersonRole;
    if (!role || !(PERSON_ROLES as readonly string[]).includes(role)) return { error: 'Kies wie het is' };
    const person = register.updatePerson(d.personId, { role }, { sources: [`vraag ${q.id}`], lock: true, at: now });
    if (!person) return { error: 'Deze persoon staat niet meer in het register' };
    register.log(`Rol van ${person.name}: ${role} (vraag ${q.id})`, by, now);
    const fact = addFact(`${person.name} is ${ROLE_TEXT[role as Exclude<PersonRole, ''>]}.`);
    return { answer: role, fact };
  }

  if (d.type === 'same') {
    if (body.same !== true && body.same !== false) return { error: 'Kies ja of nee' };
    const [a, b] = d.vehicleIds.map((id) => register.vehicle(id));
    if (!a || !b) return { error: 'Dit voertuig staat niet meer in het register' };
    if (!body.same) {
      register.log(`Niet hetzelfde voertuig: ${vehicleLabel(a)} en ${vehicleLabel(b)} (vraag ${q.id})`, by, now);
      return { answer: 'Nee, twee voertuigen', fact: null };
    }
    // With two plates the administrator chose the right one (`keep`: the id of that entry).
    if (d.plates && body.keep !== a.id && body.keep !== b.id) return { error: 'Kies welk kenteken klopt' };
    const [keep, other] = d.plates ? (body.keep === b.id ? [b, a] : [a, b]) : mergeOrder(a, b);
    const merged = register.mergeVehicles(keep.id, other.id, now)!;
    register.updateVehicle(merged.id, {}, { sources: [`vraag ${q.id}`], at: now });
    register.log(`Samengevoegd: ${vehicleLabel(other)} in ${vehicleLabel(merged)} (vraag ${q.id})`, by, now);
    return { answer: `Ja, samengevoegd tot ${vehicleLabel(merged)}`, fact: null };
  }

  if (d.type === 'plate') {
    const owner = cleanText(body.owner, 60);
    if (owner.length < 2) return { error: 'Vul in van wie de auto is' };
    const vehicle = cleanText(body.vehicle, 80);
    const description = `${vehicle || 'auto'}, kenteken ${d.plate}`;
    // The fact store keeps one fact per plate: an earlier answer about this plate is replaced in place.
    const fact = facts?.add(`${description.charAt(0).toUpperCase()}${description.slice(1)} is van ${owner}.`, `${by} (vraag ${q.id})`, now) ?? null;
    const done = registerVehicleAnswer(register, description, owner, { questionId: q.id, factId: fact?.id ?? null, by, now });
    if (!done) return { error: 'Dit kenteken staat al bij iemand anders in het register' };
    for (const f of d.facts) {
      if (f.id !== fact?.id && facts?.remove(f.id, now)) register.log(`Feit ${f.id} vervallen door vraag ${q.id}: ${f.text}`, by, now);
    }
    return { answer: `${vehicle ? `${vehicle} ` : ''}van ${owner}`, fact: fact?.text ?? null };
  }

  if (d.type === 'gone') {
    const v = register.vehicle(d.vehicleId);
    if (!v) return { error: 'Dit voertuig staat niet meer in het register' };
    if (body.keep !== true && body.keep !== false) return { error: 'Kies ja of nee' };
    if (body.keep) {
      register.updateVehicle(v.id, {}, { sources: [`vraag ${q.id}`], at: now });
      register.log(`Voertuig klopt nog: ${vehicleLabel(v)} (vraag ${q.id})`, by, now);
      return { answer: 'Ja, klopt nog', fact: null };
    }
    register.removeVehicle(v.id, now);
    register.log(`Voertuig verwijderd: ${vehicleLabel(v)}${d.owner ? ` van ${d.owner}` : ''} (vraag ${q.id})`, by, now);
    return { answer: 'Nee, verwijderd', fact: null };
  }

  const v = register.vehicles().find((x) => x.id === d.vehicleId);
  if (!v) return { error: 'Dit voertuig staat niet meer in het register' };
  const make = d.fields.includes('make') ? cleanText(body.make, 40) : '';
  const model = d.fields.includes('model') ? cleanText(body.model, 40) : '';
  const plate = cleanText(body.plate, 12).toUpperCase();
  if (plate && !/^[A-Z0-9]{1,3}-?[A-Z0-9]{2,3}-?[A-Z0-9]{1,3}$/.test(plate)) return { error: 'Dat lijkt geen kenteken (bijvoorbeeld G-929-VD)' };
  if (!make && !model && !plate) return { error: d.fields.includes('make') ? 'Vul merk, model of kenteken in' : 'Vul het kenteken in' };
  const before = the(v, ownerOf(register, v));
  const fields = { ...(make ? { make } : {}), ...(model ? { model } : {}), ...(plate ? { plate } : {}) };
  const updated = register.updateVehicle(v.id, fields, { sources: [`vraag ${q.id}`], lock: true, at: now })!;
  register.log(`Voertuig bijgewerkt: ${vehicleLabel(updated)} (vraag ${q.id})`, by, now);
  const kind = [make, model].filter(Boolean).join(' ');
  const what = kind ? `is een ${kind}${plate ? ` met kenteken ${plate}` : ''}` : `heeft kenteken ${plate}`;
  const fact = addFact(`${before.charAt(0).toUpperCase()}${before.slice(1)} ${what}.`);
  return { answer: [make, model, plate].filter(Boolean).join(' '), fact };
}

/**
 * A "Van wie is deze auto?" answer goes into the register at once, without AI (since 0.32.0; before, it waited for the
 * next bundling and an administrator's ok). Only clear cases:
 * - a plate in the description that is in the register: that vehicle (its owner is set when it has none);
 * - the same owner, kind, make and model as a register vehicle: that vehicle;
 * - otherwise, with a make or a plate, a new vehicle; an owner not in the register is added without a role.
 * Anything else (another owner for a known plate, a vehicle without make or plate) is left to the bundling.
 * Returns what happened, for the history and the answer, or null.
 */
export function registerVehicleAnswer(
  register: HouseholdStore,
  description: string,
  ownerName: string,
  ctx: { questionId: number; factId: number | null; by: string; now: number },
): string | null {
  const { by, now } = ctx;
  const sources = [`vraag ${ctx.questionId}`, ...(ctx.factId !== null ? [`feit ${ctx.factId}`] : [])];
  const parts = vehicleParts(description);
  // "met ladders" is a feature, "met open motorkap" a moment.
  const features = stable(/\smet\s+([^,]+)/i.exec(description)?.[1]?.trim() ?? '');
  const vehicles = register.vehicles();
  const known = findPerson(register.people(), ownerName);
  const type = (v: { make: string; model: string }) => (v.make ? makeModel(`${v.make} ${v.model}`) : null);

  const byPlate = parts.plate ? vehicles.find((v) => v.plate && platesClose(plateKey(v.plate), plateKey(parts.plate))) : undefined;
  if (byPlate) {
    if (byPlate.ownerId !== null && byPlate.ownerId !== known?.id) return null;
    const owner = known ?? register.addPerson({ name: ownerName }, sources, [], now);
    register.updateVehicle(byPlate.id, byPlate.ownerId === null ? { ownerId: owner.id } : {}, { sources, at: now });
    const text = `Antwoord bij ${vehicleLabel(byPlate)} van ${owner.name} gezet (vraag ${ctx.questionId})`;
    register.log(text, by, now);
    return text;
  }
  const sameType = known && type(parts) !== null ? vehicles.find((v) => v.ownerId === known.id && v.kind === parts.kind && type(v) === type(parts)) : undefined;
  if (sameType) {
    register.updateVehicle(sameType.id, {}, { sources, at: now });
    const text = `Antwoord bij ${vehicleLabel(sameType)} van ${known!.name} gezet (vraag ${ctx.questionId})`;
    register.log(text, by, now);
    return text;
  }
  if (!parts.make && !parts.plate) return null;
  const owner = known ?? register.addPerson({ name: ownerName }, sources, [], now);
  if (!known) register.log(`Nieuwe persoon: ${owner.name} (vraag ${ctx.questionId})`, by, now);
  const added = register.addVehicle({ ...parts, features, ownerId: owner.id }, sources, [], now);
  const text = `Nieuw voertuig: ${vehicleLabel(added)} van ${owner.name} (vraag ${ctx.questionId})`;
  register.log(text, by, now);
  return text;
}
