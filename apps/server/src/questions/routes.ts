import type { FastifyInstance } from 'fastify';
import type { FactStore } from '../ai/facts.ts';
import { ATTEMPT_FILE, matchFaceName, type FaceLibrary } from '../faces/library.ts';
import type { HighlightStore, StoredCandidate } from '../highlights/store.ts';
import { findPerson, type HouseholdStore } from '../household/store.ts';
import { MIN_PERSON_SIZE } from './generator.ts';
import { answerHousehold } from './household.ts';
import type { QuestionStore } from './store.ts';
import { normalizeVehicle, vehicleNoun } from './vehicles.ts';

export interface QuestionRouteOptions {
  questions: QuestionStore;
  highlights: HighlightStore;
  facts?: FactStore;
  /** When true (AI enabled), answers about people are queued for a fact and answered highlights are described again. */
  autoFacts?: boolean;
  /** Frigate's face library: answers naming a person who comes back (resident, family, visitor, ...) teach Frigate that face. */
  faces?: FaceLibrary;
  /** Household register: its people get a button, and their aliases ("Tini") resolve to the full name (since 0.24.2). */
  household?: Pick<HouseholdStore, 'people'>;
  /** The household register itself: answers to its questions change it (since 0.29.0). */
  register?: HouseholdStore;
  /** Called after an answer changed the register or the facts, so the bundling can run again. */
  onRegisterChanged?: () => void;
  /** Called after an answer queued face learning, to process it right away. */
  onFaceQueued?: () => void;
  /** Epoch seconds. */
  now?: () => number;
}

export const PERSON_CATEGORIES = {
  bewoner: 'bewoner',
  familie: 'familie',
  bezoeker: 'bezoeker',
  buren: 'buren',
  hulp: 'vaste hulp',
  bezorger: 'bezorger of dienstverlener',
  voorbijganger: 'voorbijganger',
  onbekend: 'onbekend',
} as const;

/**
 * People who come back count as known with a name and their faces are learned; couriers are not (different people,
 * same company), nor are passers-by.
 */
const KNOWN_CATEGORIES = new Set(['bewoner', 'familie', 'bezoeker', 'buren', 'vaste hulp']);

/** Answers without a name that tell the AI nothing to write a fact from. */
const NO_FACT_CATEGORIES = new Set(['onbekend', 'voorbijganger']);

/** Splits a stored person answer "Tineke (bewoner)" into name and category. */
export function parsePersonAnswer(answer: string): { name: string; category: string } {
  const m = /^(.*) \(([^()]+)\)$/.exec(answer);
  if (m) return { name: m[1]!, category: m[2]! };
  return { name: '', category: answer };
}

/** The person an answered question names: someone who comes back ("Roel Snippe (buren)") or a vehicle owner. */
export function answeredName(q: { kind: string; answer: string | null }): string | null {
  const answer = q.answer ?? '';
  if (q.kind === 'person') {
    const { name, category } = parsePersonAnswer(answer);
    return name && KNOWN_CATEGORIES.has(category) ? name : null;
  }
  const owner = q.kind === 'vehicle' ? answer.split(' is van ').at(-1) : undefined;
  return owner && owner !== answer ? owner : null;
}

/**
 * What an answer about a person does besides closing the question: annotate the highlight (known when it
 * names someone who comes back), describe it again, queue a fact and queue face learning.
 * Also used once at startup for answers given before these steps existed.
 */
export function applyPersonAnswer(
  q: { id: number; highlightId: string | null },
  answer: string,
  { questions, highlights, autoFacts = false, faces }: Pick<QuestionRouteOptions, 'questions' | 'highlights' | 'autoFacts' | 'faces'>,
): { fact: 'pending' | 'none'; face: 'pending' | 'none' } {
  const { name, category } = parsePersonAnswer(answer);
  const h = q.highlightId ? highlights.get(q.highlightId) : undefined;
  const known = Boolean(name) && KNOWN_CATEGORIES.has(category);
  if (h) {
    highlights.setAnnotation(h.id, answer, known);
    if (autoFacts) highlights.requestRedescribe(h.id);
  }
  // The AI writes a fact from the still and this answer (nothing to learn from "onbekend" or a passer-by without a name).
  const fact = autoFacts && h && (name || !NO_FACT_CATEGORIES.has(category)) ? 'pending' : 'none';
  questions.setFact(q.id, fact);
  const face = faces && h && known ? 'pending' : 'none';
  questions.setFace(q.id, face, face === 'pending' ? name : null);
  return { fact, face };
}

/**
 * Whether a vehicle question is about the vehicle the event is about (the AI's `vehicle`), and nobody has said
 * who the person in it is: then the answer may label the highlight and make it count as known.
 */
export function vehicleIsSubject(h: { aiVehicle: string | null; annotation: string | null }, vehicle: unknown): boolean {
  if (typeof vehicle !== 'string' || !h.aiVehicle || normalizeVehicle(h.aiVehicle) !== normalizeVehicle(vehicle)) return false;
  return !h.annotation || VEHICLE_ANNOTATION.test(h.annotation);
}

/** Labels written by vehicle answers ("auto van Mark", "onbekende fiets"). */
export const VEHICLE_ANNOTATION = /^(auto|fiets|scooter|motor) van |^onbekende (auto|fiets|scooter|motor)$/;

/** One visit: other highlights this close in time may show the same person (since 0.27.0). */
export const VISIT_S = 15 * 60;

/**
 * Other highlights of the same visit that an answer about a person can also apply to: within a quarter of an hour,
 * any camera, with a person nobody named and Frigate did not recognise, not noise, not too small. Closest first.
 */
export function sameVisit(h: StoredCandidate, { highlights, questions }: Pick<QuestionRouteOptions, 'highlights' | 'questions'>): StoredCandidate[] {
  return highlights
    .candidatesSince(h.startTime - VISIT_S)
    .filter((c) => c.id !== h.id && c.startTime <= h.startTime + VISIT_S && c.hasThumbnail && c.labels.some((l) => l.startsWith('person')))
    .filter((c) => c.subLabels.length === 0 && !c.annotation && c.aiRealEvent !== false)
    .filter((c) => c.personSize === null || c.personSize === undefined || c.personSize >= MIN_PERSON_SIZE)
    // Never over an earlier answer; an open question about it is answered along.
    .filter((c) => !questions.hasForHighlight(c.id, 'person') || questions.openFor(c.id, 'person'))
    .sort((a, b) => Math.abs(a.startTime - h.startTime) - Math.abs(b.startTime - h.startTime))
    .slice(0, 6);
}

const clean = (v: unknown, max: number) =>
  typeof v === 'string' ? v.replace(/<[^>]*>/g, ' ').replace(/[\r\n\t<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Questions for administrators (`/api/admin/`, admin role). Answers feed back into highlights and facts. */
export function registerQuestions(app: FastifyInstance, options: QuestionRouteOptions): void {
  const { questions, highlights, facts, autoFacts = false, faces, household, register, onRegisterChanged, onFaceQueued, now = () => Date.now() / 1000 } = options;
  // Names for the answer form: Frigate's face library first, then people named in earlier answers whose face Frigate
  // could not learn (neighbours seen from the side, vehicle owners), so they get a one-click button too (since 0.22.5).
  // A nickname from the household register counts as that person ("Tini" → "Tineke Mevius"), not as someone new.
  const knownNames = () => {
    const library = faces?.ready ? faces.knownNames() : [];
    const people = household?.people() ?? [];
    const seen = new Set(library.map((n) => n.toLowerCase()));
    const named: string[] = [];
    const answered = questions.list('answered', 10_000).map(answeredName);
    for (const raw of [...people.map((p) => p.name), ...answered]) {
      const name = raw && (people.find((p) => p.aliases.some((a) => a.toLowerCase() === raw.toLowerCase()))?.name ?? raw);
      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        named.push(name);
      }
    }
    return [...library, ...named.sort((a, b) => a.localeCompare(b, 'nl'))];
  };
  // One spelling per person across faces, vehicles and highlights ("Jasper" → "Jasper Mevius"), so the AI can tell who is who.
  const person = (typed: string) => (typed ? (household && findPerson(household.people(), typed)?.name) || matchFaceName(typed, knownNames()) : typed);
  app.get<{ Querystring: { status?: string } }>('/api/admin/questions', async (request) => {
    const status = request.query.status === 'all' ? 'all' : 'open';
    return questions.list(status, status === 'all' ? 200 : 100).map((q) => {
      const h = q.highlightId ? highlights.get(q.highlightId) : undefined;
      const visible = h && !h.deleted ? h : undefined;
      return {
        ...q,
        highlight: visible ? { id: visible.id, hasThumbnail: visible.hasThumbnail, camera: visible.camera, startTime: visible.startTime, feedback: visible.feedback } : null,
        // Same visit, so one answer can name the person on all of them.
        ...(visible && q.kind === 'person' && q.status === 'open'
          ? { sameVisit: sameVisit(visible, options).map((c) => ({ id: c.id, camera: c.camera, startTime: c.startTime, description: c.aiDescription ?? c.description })) }
          : {}),
      };
    });
  });

  // Frigate's face library: names for the answer form and the unrecognised face crops of a question.
  app.get('/api/admin/faces', async () => ({ available: Boolean(faces?.ready), names: knownNames() }));

  app.get<{ Params: { file: string } }>('/api/admin/faces/train/:file', async (request, reply) => {
    const file = request.params.file;
    if (!faces || !ATTEMPT_FILE.test(file)) return reply.code(404).send({ error: 'Niet gevonden' });
    const image = await faces.image(file).catch(() => undefined);
    if (!image) return reply.code(404).send({ error: 'Niet gevonden' });
    return reply.header('content-type', 'image/webp').header('cache-control', 'private, max-age=3600').send(Buffer.from(image));
  });

  // The face library itself (since 0.20.0): administrators remove images of the wrong person.
  app.get('/api/admin/faces/library', async (_request, reply) => {
    if (!faces) return reply.code(404).send({ error: 'Gezichtsherkenning is niet beschikbaar' });
    await faces.refresh().catch(() => undefined);
    return { available: faces.ready, people: faces.ready ? faces.libraryImages() : [] };
  });

  app.get<{ Params: { name: string; file: string } }>('/api/admin/faces/library/:name/:file', async (request, reply) => {
    const image = await faces?.libraryImage(request.params.name, request.params.file).catch(() => undefined);
    if (!image) return reply.code(404).send({ error: 'Niet gevonden' });
    return reply.header('content-type', 'image/webp').header('cache-control', 'private, max-age=86400').send(Buffer.from(image));
  });

  app.post<{ Params: { name: string }; Body: { files?: unknown } }>('/api/admin/faces/library/:name/delete', async (request, reply) => {
    const files = Array.isArray(request.body?.files) ? request.body.files.filter((f): f is string => typeof f === 'string').slice(0, 200) : [];
    if (!faces || !files.length) return reply.code(400).send({ error: "Kies een of meer foto's" });
    try {
      return { deleted: await faces.deleteImages(request.params.name, files) };
    } catch (err) {
      request.log.warn(`faces: delete for ${request.params.name}: ${(err as Error).message}`);
      return reply.code(502).send({ error: "Frigate kon de foto's niet verwijderen" });
    }
  });

  app.get('/api/admin/questions/count', async () => ({ open: questions.list('open', 1000).length }));

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/admin/questions/:id/answer', async (request, reply) => {
    const q = questions.get(Number(request.params.id));
    if (!q || q.status !== 'open') return reply.code(404).send({ error: 'Vraag niet gevonden of al beantwoord' });
    const by = request.user?.username ?? 'onbekend';
    const body = request.body ?? {};
    const h = q.highlightId ? highlights.get(q.highlightId) : undefined;

    if (q.kind === 'person') {
      const category = body.category as keyof typeof PERSON_CATEGORIES;
      if (!(category in PERSON_CATEGORIES)) return reply.code(400).send({ error: 'Kies wie het is' });
      const name = person(clean(body.name, 60));
      const label = name ? `${name} (${PERSON_CATEGORIES[category]})` : PERSON_CATEGORIES[category];
      questions.resolve(q.id, 'answered', label, by, now());
      const result = applyPersonAnswer(q, label, options);
      // The same answer for other highlights of the visit the administrator ticked. Each gets an answered question
      // of its own, so its face is learned too; only the first answer becomes a fact (the same fact once).
      const also = Array.isArray(body.also) ? body.also.filter((id): id is string => typeof id === 'string') : [];
      const allowed = new Set(h ? sameVisit(h, options).map((c) => c.id) : []);
      let applied = 0;
      for (const id of also.filter((id) => allowed.has(id))) {
        const other = questions.openFor(id, 'person') ?? (questions.add({ kind: 'person', key: `person:${id}`, highlightId: id, title: 'Wie is dit?', body: `Zelfde bezoek als vraag ${q.id}.` }, now()) ? questions.getByKey(`person:${id}`) : undefined);
        if (!other) continue;
        questions.resolve(other.id, 'answered', label, by, now());
        const extra = applyPersonAnswer(other, label, { ...options, autoFacts: false });
        if (options.autoFacts) highlights.requestRedescribe(id);
        if (extra.face === 'pending') result.face = 'pending';
        applied++;
      }
      if (result.face === 'pending') onFaceQueued?.();
      return { answer: label, ...result, also: applied };
    }

    if (q.kind === 'vehicle') {
      const noun = vehicleNoun(clean(q.data.vehicle, 120));
      // Only the vehicle the event is about labels the highlight; one parked in the background only goes into
      // the vehicle database ("De auto van Bert loopt over het erf" came from Bert's parked van behind a passer-by).
      const subject = h && vehicleIsSubject(h, q.data.vehicle) ? h : undefined;
      if (body.category === 'onbekend') {
        const label = noun === 'auto' ? 'onbekende auto' : `onbekende ${noun}`;
        questions.resolve(q.id, 'answered', label, by, now());
        questions.setFact(q.id, 'none');
        if (subject) highlights.setAnnotation(subject.id, label, false);
        return { answer: label };
      }
      const owner = person(clean(body.owner, 60));
      const vehicle = clean(body.vehicle, 120) || clean(q.data.vehicle, 120);
      if (owner.length < 2 || vehicle.length < 3) return reply.code(400).send({ error: 'Vul de eigenaar en de omschrijving in' });
      const text = `${vehicle.charAt(0).toUpperCase()}${vehicle.slice(1)} is van ${owner}`.slice(0, 200);
      // The owner's own words are the most reliable fact: stored directly, no AI step.
      const stored = facts?.add(text, `${by} (vraag ${q.id})`, now());
      if (subject) highlights.setAnnotation(subject.id, `${vehicleNoun(vehicle)} van ${owner}`, true);
      // Described again in any case: the new fact lets the AI name the owner of a vehicle it mentions.
      if (h && autoFacts) highlights.requestRedescribe(h.id);
      questions.resolve(q.id, 'answered', text, by, now());
      questions.setFact(q.id, stored ? 'done' : 'none', stored?.text ?? null);
      return { answer: text, fact: stored ? 'done' : 'none' };
    }

    if (q.kind === 'household') {
      if (!register) return reply.code(400).send({ error: 'Het huishoudregister is niet beschikbaar' });
      const result = answerHousehold(q, body, { register, ...(facts ? { facts } : {}), questions, by, now: now() });
      if ('error' in result) return reply.code(400).send({ error: result.error });
      questions.resolve(q.id, 'answered', result.answer, by, now());
      questions.setFact(q.id, result.fact ? 'done' : 'none', result.fact);
      onRegisterChanged?.();
      return result;
    }

    if (q.kind === 'highlight') {
      const value = body.value;
      if (value !== 1 && value !== -1) return reply.code(400).send({ error: 'Kies goed of niet goed' });
      if (h) highlights.setFeedback(h.id, value, now());
      questions.resolve(q.id, 'answered', value === 1 ? 'goede highlight' : 'geen goede highlight', by, now());
      return { answer: value };
    }

    return reply.code(400).send({ error: 'Deze melding heeft geen antwoord; markeer hem als gezien' });
  });

  app.post<{ Params: { id: string } }>('/api/admin/questions/:id/dismiss', async (request, reply) => {
    const q = questions.get(Number(request.params.id));
    if (!q || q.status !== 'open') return reply.code(404).send({ error: 'Vraag niet gevonden of al afgehandeld' });
    questions.resolve(q.id, 'dismissed', null, request.user?.username ?? 'onbekend', now());
    return reply.code(204).send();
  });
}
