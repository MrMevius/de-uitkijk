import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth, type AuthOptions } from './auth/routes.ts';
import { registerHighlights, type HighlightRouteOptions } from './highlights/routes.ts';
import type { StateHub } from './hub.ts';
import type { MockSource } from './mock/mock-source.ts';

export interface AppDeps {
  hub: StateHub;
  /** Present only in mock mode with the dev API enabled. */
  mock?: MockSource;
  /** Login for public access. Without it every route is open (development and tests). */
  auth?: AuthOptions;
  /** Highlights from Frigate (live mode). */
  highlights?: HighlightRouteOptions;
  logger?: boolean;
  heartbeatMs?: number;
  /** Release version, reported by /api/health so dashboards can reload after a deployment. */
  version?: string;
  /** Extra status for the LAN-only monitoring endpoint. */
  detail?: () => Record<string, unknown>;
}

/**
 * HTTP API. Deliberately small: state snapshot, a server-sent event stream for live updates,
 * a health endpoint and, in mock mode only, scenario control for development.
 * No route returns Frigate URLs, camera source URLs or credentials.
 */
export function buildApp({ hub, mock, auth, highlights, logger = false, heartbeatMs = 15_000, version, detail }: AppDeps): FastifyInstance {
  const app = Fastify({ logger });
  if (auth) registerAuth(app, auth);
  if (highlights) registerHighlights(app, highlights);

  app.get('/api/health', async () => {
    const state = hub.snapshot();
    return { status: 'ok', mode: state.mode, ...(version ? { version } : {}), alerts: state.health.alerts, streaming: state.health.streaming };
  });

  // Monitoring detail (Zabbix). Reachable without login on the host's LAN listener only; the edge refuses
  // it on the public listener. Contains states and counts, no images or credentials.
  if (detail) {
    app.get('/api/health/detail', async () => {
      const state = hub.snapshot();
      return { status: 'ok', mode: state.mode, ...(version ? { version } : {}), alerts: state.health.alerts, streaming: state.health.streaming, ...detail() };
    });
  }

  app.get('/api/state', async () => hub.snapshot());

  app.get('/api/events', (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (state: unknown) => res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
    res.write('retry: 3000\n\n');
    send(hub.snapshot());
    const unsubscribe = hub.subscribe(send);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  if (mock) {
    app.get('/api/dev/scenarios', async () => ({ current: mock.scenario, scenarios: mock.list() }));
    app.post<{ Body: { name?: unknown } }>('/api/dev/scenario', async (request, reply) => {
      const name = request.body?.name;
      if (typeof name !== 'string' || !mock.list().some((s) => s.name === name)) {
        return reply.code(400).send({ error: 'unknown scenario' });
      }
      mock.start(name);
      return { current: name };
    });
  }

  return app;
}
