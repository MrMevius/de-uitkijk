import type { FastifyInstance } from 'fastify';
import type { FactStore } from '../ai/facts.ts';
import { ATTEMPT_FILE, matchFaceName, type FaceLibrary } from '../faces/library.ts';
import type { HighlightStore } from '../highlights/store.ts';
import type { QuestionStore } from './store.ts';
import { normalizeVehicle, vehicleNoun } from './vehicles.ts';

export interface QuestionRouteOptions {
  questions: QuestionStore;
  highlights: HighlightStore;
  facts?: FactStore;
  /** When true (AI enabled), answers about people are queued for a fact and answered highlights are described again. */
  autoFacts?: boolean;
  /** Frigate's face library: answers naming a resident or visitor teach Frigate that face. */
  faces?: FaceLibrary;
  /** Called after an answer queued face learning, to process it right away. */
  onFaceQueued?: () => void;
  /** Epoch seconds. */
  now?: () => number;
}

export const PERSON_CATEGORIES = { bewoner: 'bewoner', bezoeker: 'bezoeker', bezorger: 'bezorger of dienstverlener', onbekend: 'onbekend' } as const;

/** Residents and visitors with a name count as known and their faces are learned; couriers are not (different people, same company). */
const KNOWN_CATEGORIES = new Set(['bewoner', 'bezoeker']);

/** Splits a stored person answer "Tineke (bewoner)" into name and category. */
export function parsePersonAnswer(answer: string): { name: string; category: string } {
  const m = /^(.*) \(([^()]+)\)$/.exec(answer);
  if (m) return { name: m[1]!, category: m[2]! };
  return { name: '', category: answer };
}

/**
 * What an answer about a person does besides closing the question: annotate the highlight (known when it
 * names a resident or visitor), describe it again, queue a fact and queue face learning.
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
  // The AI writes a fact from the still and this answer (nothing to learn from "onbekend" without a name).
  const fact = autoFacts && h && (name || category !== 'onbekend') ? 'pending' : 'none';
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

const clean = (v: unknown, max: number) =>
  typeof v === 'string' ? v.replace(/<[^>]*>/g, ' ').replace(/[\r\n\t<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Questions for administrators (`/api/admin/`, admin role). Answers feed back into highlights and facts. */
export function registerQuestions(app: FastifyInstance, options: QuestionRouteOptions): void {
  const { questions, highlights, facts, autoFacts = false, faces, onFaceQueued, now = () => Date.now() / 1000 } = options;
  // One spelling per person across faces, vehicles and highlights ("Jasper" → "Jasper Mevius"), so the AI can tell who is who.
  const person = (typed: string) => (typed && faces?.ready ? matchFaceName(typed, faces.knownNames()) : typed);
  app.get<{ Querystring: { status?: string } }>('/api/admin/questions', async (request) => {
    const status = request.query.status === 'all' ? 'all' : 'open';
    return questions.list(status, status === 'all' ? 200 : 100).map((q) => {
      const h = q.highlightId ? highlights.get(q.highlightId) : undefined;
      return { ...q, highlight: h && !h.deleted ? { id: h.id, hasThumbnail: h.hasThumbnail, camera: h.camera, startTime: h.startTime } : null };
    });
  });

  // Frigate's face library: names for the answer form and the unrecognised face crops of a question.
  app.get('/api/admin/faces', async () => ({ available: Boolean(faces?.ready), names: faces?.knownNames() ?? [] }));

  app.get<{ Params: { file: string } }>('/api/admin/faces/train/:file', async (request, reply) => {
    const file = request.params.file;
    if (!faces || !ATTEMPT_FILE.test(file)) return reply.code(404).send({ error: 'Niet gevonden' });
    const image = await faces.image(file).catch(() => undefined);
    if (!image) return reply.code(404).send({ error: 'Niet gevonden' });
    return reply.header('content-type', 'image/webp').header('cache-control', 'private, max-age=3600').send(Buffer.from(image));
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
      if (result.face === 'pending') onFaceQueued?.();
      return { answer: label, ...result };
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
