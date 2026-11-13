import type { FactStore } from '../ai/facts.ts';
import type { DoubtOption } from '../household/bundle.ts';
import { cleanText, PERSON_ROLES, vehicleLabel, type HouseholdStore, type PersonRole, type Vehicle } from '../household/store.ts';
import type { Question, QuestionStore } from './store.ts';

/**
 * Questions from the household register (since 0.29.0), to make the facts as complete and correct as possible:
 *
 * - doubt: a contradiction the bundling found, with one-click answers (the fact that then holds and the facts it
 *   replaces) or an own answer;
 * - vehicle: make and model of a vague vehicle ("zwarte hatchback van Noëlle"), or the plate of a known one;
 * - role: who a person without a role is.
 *
 * Every answer goes into the register at once and becomes a fact for the AI; "Overslaan" means "weet ik niet" and
 * is not asked again (each question has a key that is used once).
 */
export type HouseholdQuestionData =
  | { type: 'doubt'; summary: string; options: DoubtOption[]; facts: { id: number; text: string }[] }
  | { type: 'vehicle'; vehicleId: number; fields: ('make' | 'model' | 'plate')[]; make: string; model: string; plate: string }
  | { type: 'role'; personId: number };

interface NewQuestion {
  key: string;
  title: string;
  body: string;
  data: HouseholdQuestionData;
}

type Register = Pick<HouseholdStore, 'people' | 'vehicles' | 'proposals'>;

/** Vehicle kinds that have a plate. */
const PLATED = new Set(['auto', 'bestelbus', 'motor', 'scooter']);

const ownerOf = (register: Register, v: Vehicle) => register.people().find((p) => p.id === v.ownerId)?.name ?? '';
const the = (v: Vehicle, owner: string) => `de ${vehicleLabel(v)}${owner ? ` van ${owner}` : ''}`;

/** Candidate questions, most useful first: doubts, then vague vehicles, people without a role, missing plates. */
export function householdQuestions(register: Register, facts: Pick<FactStore, 'list'> | undefined): NewQuestion[] {
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
