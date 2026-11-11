import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FactStore } from '../ai/facts.ts';
import { REPLAY_MINUTES, SELECTION, selectHighlights, THRESHOLD_RANGE } from './selection.ts';
import { sendFileWithRanges, type ClipCache } from './clips.ts';
import { toSummary, type HighlightStore } from './store.ts';

export interface HighlightRouteOptions {
  store: HighlightStore;
  clips: ClipCache;
  frigateUrl: string;
  /** Epoch seconds. */
  now?: () => number;
  /** AI description status for administrators, when AI is enabled. */
  aiStatus?: () => unknown;
  /** Household facts for the AI (administrators only). */
  facts?: FactStore;
}

const num = (v: unknown) => (typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

/**
 * Highlight API. Viewing needs a session (auth hook); feedback and deletion need the admin role
 * (`/api/admin/`). Video is fetched from Frigate on demand; nothing is copied permanently.
 */
export function registerHighlights(app: FastifyInstance, { store, clips, frigateUrl, now = () => Date.now() / 1000, aiStatus, facts }: HighlightRouteOptions): void {
  const frigate = frigateUrl.replace(/\/$/, '');

  app.get('/api/highlights/rotation', async () =>
    store.rotation(now() - SELECTION.rotationWindowS, SELECTION.maxRotation).map(toSummary),
  );

  // Playback settings for the dashboard.
  app.get('/api/highlights/settings', async () => ({ replayMinutes: store.replayMinutes() }));

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
        // The window is part of the key: a corrected clip window must not serve the old cached file.
        file = await clips.get(`${h.id.replace(/[^A-Za-z0-9._-]/g, '_')}-${kind}-${Math.round(start)}`, source);
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

  app.get('/api/admin/ai', async () => (aiStatus ? aiStatus() : { enabled: false }));

  app.get('/api/admin/highlights/stats', async () => {
    const t = now();
    const day = store.archive({ from: t - 86400, limit: 1, offset: 0 }).total;
    const week = store.archive({ from: t - 7 * 86400, limit: 1, offset: 0 }).total;
    return { last24h: day, last7d: week, rotation: store.rotation(t - SELECTION.rotationWindowS, SELECTION.maxRotation).length };
  });

  // Selection threshold (administrators). The importer applies it to the last two days within a minute.
  const preview = (threshold: number) => {
    const t = now();
    const recent = store.candidatesSince(t - 7 * 86400);
    const picked = selectHighlights(recent, threshold);
    // Like the rotation: AI noise and highlights marked "not good" are not shown.
    const shown = recent.filter((c) => picked.has(c.id) && c.aiRealEvent !== false && c.feedback !== -1);
    return { last24h: shown.filter((c) => c.startTime >= t - 86400).length, perDay7d: Math.round((shown.length / 7) * 10) / 10 };
  };
  app.get<{ Querystring: { threshold?: string } }>('/api/admin/highlights/settings', async (request) => {
    const current = store.threshold();
    const asked = num(request.query.threshold);
    const probe = asked !== undefined && asked >= THRESHOLD_RANGE.min && asked <= THRESHOLD_RANGE.max ? asked : current;
    return {
      threshold: current,
      default: SELECTION.threshold,
      ...THRESHOLD_RANGE,
      preview: { threshold: probe, ...preview(probe) },
      replayMinutes: store.replayMinutes(),
      replay: REPLAY_MINUTES,
    };
  });
  app.put<{ Body: { threshold?: unknown; replayMinutes?: unknown } }>('/api/admin/highlights/settings', async (request, reply) => {
    const { threshold, replayMinutes } = request.body ?? {};
    if (threshold === undefined && replayMinutes === undefined) return reply.code(400).send({ error: 'Niets om op te slaan' });
    if (threshold !== undefined && (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < THRESHOLD_RANGE.min || threshold > THRESHOLD_RANGE.max)) {
      return reply.code(400).send({ error: `Drempel moet tussen ${THRESHOLD_RANGE.min} en ${THRESHOLD_RANGE.max} liggen` });
    }
    if (replayMinutes !== undefined && (!Number.isInteger(replayMinutes) || (replayMinutes as number) < REPLAY_MINUTES.min || (replayMinutes as number) > REPLAY_MINUTES.max)) {
      return reply.code(400).send({ error: `Opnieuw afspelen: hele minuten van ${REPLAY_MINUTES.min} tot ${REPLAY_MINUTES.max}` });
    }
    if (typeof threshold === 'number') store.setThreshold(threshold);
    if (typeof replayMinutes === 'number') store.setReplayMinutes(replayMinutes);
    request.log.info({ by: request.user?.username, threshold: store.threshold(), replayMinutes: store.replayMinutes() }, 'highlight settings changed');
    return { threshold: store.threshold(), replayMinutes: store.replayMinutes() };
  });

  if (facts) {
    app.get('/api/admin/facts', async () => facts.list());
    app.delete<{ Params: { id: string } }>('/api/admin/facts/:id', async (request, reply) => {
      if (!facts.remove(Number(request.params.id))) return reply.code(404).send({ error: 'Feit niet gevonden' });
      request.log.info({ by: request.user?.username, id: request.params.id }, 'AI fact removed');
      return reply.code(204).send();
    });
  }

  app.post<{ Params: { id: string }; Body: { value?: unknown } }>('/api/admin/highlights/:id/feedback', async (request, reply) => {
    const value = request.body?.value;
    if (value !== 1 && value !== -1 && value !== null) return reply.code(400).send({ error: 'Ongeldige waarde' });
    const h = store.get(request.params.id);
    if (!h || h.deleted) return reply.code(404).send({ error: 'Highlight niet gevonden' });
    store.setFeedback(h.id, value, now());
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
