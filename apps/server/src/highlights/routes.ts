import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SELECTION } from './selection.ts';
import { sendFileWithRanges, type ClipCache } from './clips.ts';
import { toSummary, type HighlightStore } from './store.ts';

export interface HighlightRouteOptions {
  store: HighlightStore;
  clips: ClipCache;
  frigateUrl: string;
  /** Epoch seconds. */
  now?: () => number;
}

const num = (v: unknown) => (typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

/**
 * Highlight API. Viewing needs a session (auth hook); feedback and deletion need the admin role
 * (`/api/admin/`). Video is fetched from Frigate on demand; nothing is copied permanently.
 */
export function registerHighlights(app: FastifyInstance, { store, clips, frigateUrl, now = () => Date.now() / 1000 }: HighlightRouteOptions): void {
  const frigate = frigateUrl.replace(/\/$/, '');

  app.get('/api/highlights/rotation', async () =>
    store.rotation(now() - SELECTION.rotationWindowS, SELECTION.maxRotation).map(toSummary),
  );

  app.get<{ Querystring: Record<string, string> }>('/api/highlights', async (request) => {
    const q = request.query;
    const { items, total } = store.archive({
      ...(num(q.from) !== undefined ? { from: num(q.from)! } : {}),
      ...(num(q.to) !== undefined ? { to: num(q.to)! } : {}),
      ...(q.camera ? { camera: q.camera } : {}),
      ...(num(q.minScore) !== undefined ? { minScore: num(q.minScore)! } : {}),
      limit: Math.min(100, Math.max(1, num(q.limit) ?? 50)),
      offset: Math.max(0, num(q.offset) ?? 0),
    });
    return { items: items.map(toSummary), total };
  });

  app.get<{ Params: { id: string } }>('/api/highlights/:id/thumb.webp', async (request, reply) => {
    const image = store.thumbnail(request.params.id);
    if (!image) return reply.code(404).send({ error: 'Geen afbeelding' });
    return reply.header('content-type', 'image/webp').header('cache-control', 'private, max-age=86400').send(Buffer.from(image));
  });

  type VideoRequest = FastifyRequest<{ Params: { id: string }; Querystring: { download?: string } }>;
  const video = (kind: 'clip' | 'event') =>
    async (request: VideoRequest, reply: FastifyReply) => {
      const h = store.get(request.params.id);
      if (!h || h.deleted) return reply.code(404).send({ error: 'Highlight niet gevonden' });
      const [start, end] = kind === 'clip' ? [h.clipStart, h.clipEnd] : [h.eventStart, h.eventEnd];
      const source = `${frigate}/api/${encodeURIComponent(h.frigateCamera)}/start/${start.toFixed(1)}/end/${end.toFixed(1)}/clip.mp4`;
      let file: string;
      try {
        file = await clips.get(`${h.id.replace(/[^A-Za-z0-9._-]/g, '_')}-${kind}`, source);
      } catch (err) {
        request.log.warn({ id: h.id, err: (err as Error).message }, 'highlight clip unavailable');
        return reply.code(502).send({ error: 'Clip niet beschikbaar (mogelijk al verwijderd uit Frigate)' });
      }
      const stamp = new Date(h.startTime * 1000).toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const name = request.query.download ? `uitkijk-${h.camera}-${stamp}${kind === 'event' ? '-volledig' : ''}.mp4` : undefined;
      return sendFileWithRanges(request, reply, file, 'video/mp4', name);
    };

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>('/api/highlights/:id/clip.mp4', video('clip'));
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>('/api/highlights/:id/event.mp4', video('event'));

  app.post<{ Params: { id: string }; Body: { value?: unknown } }>('/api/admin/highlights/:id/feedback', async (request, reply) => {
    const value = request.body?.value;
    if (value !== 1 && value !== -1 && value !== null) return reply.code(400).send({ error: 'Ongeldige waarde' });
    const h = store.get(request.params.id);
    if (!h || h.deleted) return reply.code(404).send({ error: 'Highlight niet gevonden' });
    store.setFeedback(h.id, value);
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>('/api/admin/highlights/:id', async (request, reply) => {
    const h = store.get(request.params.id);
    if (!h || h.deleted) return reply.code(404).send({ error: 'Highlight niet gevonden' });
    store.tombstone(h.id);
    request.log.info({ by: request.user?.username, id: h.id }, 'highlight deleted');
    return reply.code(204).send();
  });
}
