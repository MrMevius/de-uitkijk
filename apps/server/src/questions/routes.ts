import type { FastifyInstance } from 'fastify';
import type { FactStore } from '../ai/facts.ts';
import type { HighlightStore } from '../highlights/store.ts';
import type { QuestionStore } from './store.ts';

export interface QuestionRouteOptions {
  questions: QuestionStore;
  highlights: HighlightStore;
  facts?: FactStore;
  /** Epoch seconds. */
  now?: () => number;
}

export const PERSON_CATEGORIES = { bewoner: 'bewoner', bezoeker: 'bezoeker', bezorger: 'bezorger of dienstverlener', onbekend: 'onbekend' } as const;

const clean = (v: unknown, max: number) =>
  typeof v === 'string' ? v.replace(/<[^>]*>/g, ' ').replace(/[\r\n\t<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Questions for administrators (`/api/admin/`, admin role). Answers feed back into highlights and facts. */
export function registerQuestions(app: FastifyInstance, { questions, highlights, facts, now = () => Date.now() / 1000 }: QuestionRouteOptions): void {
  app.get<{ Querystring: { status?: string } }>('/api/admin/questions', async (request) => {
    const status = request.query.status === 'all' ? 'all' : 'open';
    return questions.list(status, status === 'all' ? 200 : 100).map((q) => {
      const h = q.highlightId ? highlights.get(q.highlightId) : undefined;
      return { ...q, highlight: h && !h.deleted ? { id: h.id, hasThumbnail: h.hasThumbnail, camera: h.camera, startTime: h.startTime } : null };
    });
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
      const name = clean(body.name, 60);
      const label = name ? `${name} (${PERSON_CATEGORIES[category]})` : PERSON_CATEGORIES[category];
      if (h) highlights.setAnnotation(h.id, label);
      questions.resolve(q.id, 'answered', label, by, now());
      return { answer: label };
    }

    if (q.kind === 'vehicle') {
      if (body.category === 'onbekend') {
        questions.resolve(q.id, 'answered', 'onbekende auto', by, now());
        if (h) highlights.setAnnotation(h.id, 'onbekende auto');
        return { answer: 'onbekende auto' };
      }
      const owner = clean(body.owner, 60);
      const vehicle = clean(body.vehicle, 120) || clean(q.data.vehicle, 120);
      if (owner.length < 2 || vehicle.length < 3) return reply.code(400).send({ error: 'Vul de eigenaar en de omschrijving in' });
      const text = `${vehicle.charAt(0).toUpperCase()}${vehicle.slice(1)} is van ${owner}`.slice(0, 200);
      if (facts) {
        try {
          facts.add(text, by, now());
        } catch (err) {
          return reply.code(400).send({ error: (err as Error).message });
        }
      }
      if (h) highlights.setAnnotation(h.id, `auto van ${owner}`);
      questions.resolve(q.id, 'answered', text, by, now());
      return { answer: text, fact: Boolean(facts) };
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
