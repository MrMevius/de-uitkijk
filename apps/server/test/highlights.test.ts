import { mkdtempSync, rmSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCameraConfig, type HighlightSummary } from '@uitkijk/shared';
import { buildApp } from '../src/app.ts';
import { AuthStore } from '../src/auth/store.ts';
import { hashPassword } from '../src/auth/passwords.ts';
import { ClipCache } from '../src/highlights/clips.ts';
import { describe as describeGroup, HighlightImporter, hourInAmsterdam, platesOf } from '../src/highlights/importer.ts';
import { buildBaseline, groupItems, scoreGroup, selectHighlights, type ReviewItem } from '../src/highlights/selection.ts';
import { HighlightStore, toSummary } from '../src/highlights/store.ts';
import { StateHub } from '../src/hub.ts';

const cameras = parseCameraConfig(
  JSON.parse(readFileSync(new URL('../../../config/cameras.json', import.meta.url), 'utf8')),
);
const VOORDEUR = 'Vriezenveen_voordeur';
const OPRIT = 'Vriezenveen_oprit';
const TUIN = 'Vriezenveen_achter_thuis_1';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/** 2026-11-08 in Europe/Amsterdam (CET, UTC+1) at the given local hour, epoch seconds. */
const at = (hour: number, minute = 0) => Date.UTC(2026, 10, 8, hour - 1, minute) / 1000;

const item = (id: string, camera: string, start: number, end: number, extra: Partial<ReviewItem> = {}): ReviewItem => ({
  id,
  camera,
  startTime: start,
  endTime: end,
  objects: ['person'],
  subLabels: [],
  detections: [`${id}-d`],
  ...extra,
});

describe('selection', () => {
  it('groups alerts across cameras that follow within 30 s', () => {
    const groups = groupItems([
      item('c', OPRIT, 1100, 1110),
      item('a', VOORDEUR, 1000, 1020),
      item('b', OPRIT, 1045, 1060),
    ]);
    expect(groups.map((g) => g.map((i) => i.id))).toEqual([['a', 'b'], ['c']]);
  });

  it('scores rarity per camera and hour, night, cars, several cameras, and known people low', () => {
    const busyGarden = Array.from({ length: 70 }, (_, n) => ({ camera: TUIN, startTime: at(14) - (n % 7) * 86400 }));
    const baseline = buildBaseline(busyGarden, hourInAmsterdam);
    const garden = scoreGroup([item('g', TUIN, at(14), at(14) + 20)], baseline, hourInAmsterdam);
    const night = scoreGroup([item('n', TUIN, at(2), at(2) + 20)], baseline, hourInAmsterdam);
    const car = scoreGroup([item('c', OPRIT, at(14), at(14) + 20, { objects: ['car'] })], baseline, hourInAmsterdam);
    const two = scoreGroup([item('a', VOORDEUR, at(14), at(14) + 20), item('b', OPRIT, at(14) + 25, at(14) + 40)], baseline, hourInAmsterdam);
    const known = scoreGroup([item('k', VOORDEUR, at(14), at(14) + 20, { subLabels: ['Mark Mevius'] })], baseline, hourInAmsterdam);
    expect(garden.score).toBeLessThan(2);
    expect(night.score).toBe(4.5);
    expect(night.reasons).toContain("'s nachts");
    expect(car.score).toBe(3.5);
    // Two-wheelers weigh more than cars; someone at a vehicle a little more again (0.20.0).
    const bike = scoreGroup([item('f', OPRIT, at(14), at(14) + 20, { objects: ['bicycle', 'person'] })], baseline, hourInAmsterdam);
    expect(bike.score).toBe(4);
    expect(bike.reasons).toEqual(expect.arrayContaining(['fiets', 'persoon bij voertuig']));
    expect(two.score).toBe(3.75);
    expect(known.score).toBe(1.2);
    expect(known.reasons).toContain('bekende persoon');
  });

  it('collects the plates Frigate read, in one spelling', () => {
    expect(
      platesOf([
        { id: 'a', data: { recognized_license_plate: 'xx-123-y' } },
        { id: 'b', data: { recognized_license_plate: 'XX 123 Y' } },
        { id: 'c', data: { recognized_license_plate: 'AB' } },
        { id: 'd', data: {} },
      ]),
    ).toEqual(['XX123Y']);
  });

  it('keeps only the best highlight per camera within 30 minutes and never adds filler', () => {
    const selected = selectHighlights([
      { id: 'a', startTime: 0, cameras: ['tuin'], score: 3 },
      { id: 'b', startTime: 600, cameras: ['tuin'], score: 4 },
      { id: 'c', startTime: 700, cameras: ['oprit'], score: 2.5 },
      { id: 'd', startTime: 2400, cameras: ['tuin'], score: 2.1 },
      { id: 'e', startTime: 5000, cameras: ['tuin'], score: 1.9 },
    ]);
    expect([...selected].sort()).toEqual(['b', 'c', 'd']);
  });

  it('describes in Dutch', () => {
    const name = (f: string) => cameras.find((c) => c.frigateCamera === f)!.name;
    expect(describeGroup([item('a', VOORDEUR, at(14), at(14) + 9)], name)).toBe('Persoon bij Voordeur');
    expect(describeGroup([item('a', TUIN, at(2), at(2) + 9), item('b', OPRIT, at(2) + 20, at(2) + 30, { objects: ['person', 'car'] })], name)).toBe(
      "Persoon en auto bij Achter het huis 1, daarna Oprit / Pad, 's nachts",
    );
    expect(describeGroup([item('a', VOORDEUR, at(14), at(14) + 9, { subLabels: ['Mark Mevius'] })], name)).toBe('Mark Mevius bij Voordeur');
  });
});

interface FakeReview {
  id: string;
  camera: string;
  start_time: number;
  end_time: number | null;
  severity: 'alert';
  data: { objects: string[]; sub_labels: string[]; detections: string[] };
}

function fakeFrigate(reviews: FakeReview[], scores: Record<string, number> = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname === '/api/review') {
      const after = Number(url.searchParams.get('after'));
      return Response.json(reviews.filter((r) => r.start_time >= after));
    }
    if (url.pathname === '/api/events') {
      const ids = (url.searchParams.get('ids') ?? '').split(',');
      return Response.json(ids.map((id) => ({ id, data: { top_score: scores[id] ?? 0.7 } })));
    }
    if (url.pathname.endsWith('/snapshot-clean.webp')) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const review = (id: string, camera: string, start: number, end: number | null, data: Partial<FakeReview['data']> = {}): FakeReview => ({
  id,
  camera,
  start_time: start,
  end_time: end,
  severity: 'alert',
  data: { objects: ['person'], sub_labels: [], detections: [`${id}-d`], ...data },
});

function setupImporter(reviews: FakeReview[], scores: Record<string, number> = {}) {
  let clock = at(3);
  const store = new HighlightStore(':memory:');
  const frigate = fakeFrigate(reviews, scores);
  const importer = new HighlightImporter(store, { frigateUrl: 'http://frigate:5000', cameras, fetch: frigate.fetchImpl, now: () => clock });
  cleanup.push(() => store.close());
  return { store, importer, frigate, setClock: (t: number) => (clock = t) };
}

describe('importer', () => {
  it('imports nothing from before activation, then settled alerts once, grouped, with a representative camera', async () => {
    const reviews = [review('old', VOORDEUR, at(2), at(2) + 10)];
    const t = setupImporter(reviews, { 'b-d': 0.9, 'a-d': 0.7 });
    expect(await t.importer.runOnce()).toBe(0);
    reviews.push(review('a', VOORDEUR, at(3, 5), at(3, 5) + 20), review('b', OPRIT, at(3, 5) + 30, at(3, 5) + 50));
    reviews.push(review('open', VOORDEUR, at(3, 9), null));
    t.setClock(at(3, 10));
    expect(await t.importer.runOnce()).toBe(1);
    expect(await t.importer.runOnce()).toBe(0);
    const [c] = t.store.candidatesSince(0);
    expect(c).toMatchObject({ id: 'a', cameras: ['voordeur', 'oprit'], camera: 'oprit', repEvent: 'b-d', selected: true, hasThumbnail: true });
    expect(c!.clipStart).toBe(at(3, 5) + 28);
    expect(c!.description).toBe("Persoon bij Voordeur, daarna Oprit / Pad, 's nachts");
    expect(t.store.isProcessed('old')).toBe(false);
  });

  it('catches up after an outage and never re-imports a deleted highlight', async () => {
    const reviews: FakeReview[] = [];
    const t = setupImporter(reviews);
    await t.importer.runOnce();
    reviews.push(review('x', VOORDEUR, at(3, 30), at(3, 30) + 15));
    t.setClock(at(5));
    expect(await t.importer.runOnce()).toBe(1);
    t.store.tombstone('x');
    expect(await t.importer.runOnce()).toBe(0);
    expect(t.store.rotation(0, 15)).toEqual([]);
    expect(t.store.get('x')).toMatchObject({ deleted: true, hasThumbnail: false });
  });
});

describe('highlight API', () => {
  async function setupApi() {
    const dir = mkdtempSync(join(tmpdir(), 'uitkijk-clips-'));
    const clip = join(dir, 'source.mp4');
    const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
    const remuxed: string[] = [];
    const clips = new ClipCache(
      join(dir, 'cache'),
      10_000,
      async (input, output) => {
        remuxed.push(input);
        await copyFile(input, output);
      },
      (async () => new Response(bytes)) as typeof fetch,
    );
    const store = new HighlightStore(':memory:');
    const auth = new AuthStore(':memory:');
    const hub = new StateHub('live', cameras, 15_000);
    const app = buildApp({
      hub,
      auth: { store: auth, publicUrl: 'https://uitkijk.example.nl' },
      highlights: { store, clips, frigateUrl: 'http://frigate:5000', now: () => at(12) },
    });
    cleanup.push(() => app.close(), () => hub.stop(), () => store.close(), () => auth.close(), () => rmSync(dir, { recursive: true, force: true }));
    const login = async (username: string, role: 'admin' | 'viewer') => {
      const user = auth.createUser(username, role);
      auth.redeemLink(auth.createLink(user.id, 'activate'), await hashPassword('correct horse battery'));
      return { cookie: `uitkijk_session=${auth.createSession(user.id)}` };
    };
    const base = {
      endTime: at(10) + 20, cameras: ['voordeur'], camera: 'voordeur', frigateCamera: VOORDEUR, repEvent: 'e',
      clipStart: at(10) - 2, clipEnd: at(10) + 22, eventStart: at(10) - 5, eventEnd: at(10) + 25,
      labels: ['person'], subLabels: [], reasons: [], description: 'Persoon bij Voordeur',
    };
    store.insert({ ...base, id: 'h1', startTime: at(10), score: 3 }, ['h1']);
    store.insert({ ...base, id: 'h2', startTime: at(11), score: 4 }, ['h2']);
    store.insert({ ...base, id: 'old', startTime: at(10) - 2 * 86400, score: 5 }, ['old']);
    for (const id of ['h1', 'h2', 'old']) store.setSelected(id, true);
    store.setThumbnail('h1', new Uint8Array([0xff, 0xd8]));
    return { app, store, login, bytes, remuxed };
  }

  it('lists the rotation (24 h, best first) and the archive only with a session', async () => {
    const t = await setupApi();
    expect((await t.app.inject('/api/highlights/rotation')).statusCode).toBe(401);
    const { cookie } = await t.login('kijker', 'viewer');
    const rotation = (await t.app.inject({ url: '/api/highlights/rotation', headers: { cookie } })).json<HighlightSummary[]>();
    expect(rotation.map((h) => h.id)).toEqual(['h2', 'h1']);
    expect(rotation[1]).toMatchObject({ cameraId: 'voordeur', clipDuration: 24, hasThumbnail: true });
    const archive = (await t.app.inject({ url: '/api/highlights?minScore=3.5', headers: { cookie } })).json();
    expect(archive).toMatchObject({ total: 2 });
    expect((await t.app.inject({ url: '/api/highlights/h1/thumb.webp', headers: { cookie } })).statusCode).toBe(200);
  });

  it('serves clips with byte ranges through the cache and offers downloads', async () => {
    const t = await setupApi();
    const { cookie } = await t.login('kijker', 'viewer');
    const part = await t.app.inject({ url: '/api/highlights/h1/clip.mp4', headers: { cookie, range: 'bytes=100-199' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 100-199/1000');
    expect(part.rawPayload.equals(t.bytes.subarray(100, 200))).toBe(true);
    const full = await t.app.inject({ url: '/api/highlights/h1/clip.mp4?download=1', headers: { cookie } });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-disposition']).toMatch(/^attachment; filename="uitkijk-voordeur-2026-11-08-09-00-00\.mp4"$/);
    expect(t.remuxed).toHaveLength(1);
  });

  it('lets only administrators give feedback and delete (tombstone)', async () => {
    const t = await setupApi();
    const viewer = await t.login('kijker', 'viewer');
    const admin = await t.login('beheer', 'admin');
    const origin = 'https://uitkijk.example.nl';
    const fb = (cookie: string, value: unknown) =>
      t.app.inject({ method: 'POST', url: '/api/admin/highlights/h1/feedback', headers: { cookie, origin }, payload: { value } });
    expect((await fb(viewer.cookie, 1)).statusCode).toBe(403);
    expect((await fb(admin.cookie, 5)).statusCode).toBe(400);
    expect((await fb(admin.cookie, -1)).statusCode).toBe(204);
    expect(t.store.get('h1')!.feedback).toBe(-1);
    const del = await t.app.inject({ method: 'DELETE', url: '/api/admin/highlights/h1', headers: { cookie: admin.cookie, origin } });
    expect(del.statusCode).toBe(204);
    expect((await t.app.inject({ url: '/api/highlights/h1/clip.mp4', headers: { cookie: admin.cookie } })).statusCode).toBe(404);
  });

  it('lets administrators set the selection threshold, with a preview of how many highlights it gives', async () => {
    const t = await setupApi();
    const viewer = await t.login('kijker', 'viewer');
    const admin = await t.login('beheer', 'admin');
    const origin = 'https://uitkijk.example.nl';
    const put = (cookie: string, threshold: unknown) =>
      t.app.inject({ method: 'PUT', url: '/api/admin/highlights/settings', headers: { cookie, origin }, payload: { threshold } });
    const get = async (q = '') => (await t.app.inject({ url: `/api/admin/highlights/settings${q}`, headers: { cookie: admin.cookie } })).json();

    expect(await get()).toMatchObject({ threshold: 2, default: 2, min: 1, max: 5, preview: { threshold: 2 } });
    // h1 (score 3) falls below 3.5; h2 (score 4) stays.
    expect((await get('?threshold=3.5')).preview).toMatchObject({ threshold: 3.5, last24h: 1 });
    expect((await get('?threshold=9')).preview.threshold).toBe(2);
    expect((await put(viewer.cookie, 3)).statusCode).toBe(403);
    expect((await put(admin.cookie, 0.5)).statusCode).toBe(400);
    expect((await put(admin.cookie, '3')).statusCode).toBe(400);
    expect((await put(admin.cookie, 2.54)).json()).toEqual({ threshold: 2.5, replayMinutes: 10 });
    expect(t.store.threshold()).toBe(2.5);

    // How often a highlight plays again on the TV (minutes); the dashboard reads it with a session.
    const setReplay = (cookie: string, replayMinutes: unknown) =>
      t.app.inject({ method: 'PUT', url: '/api/admin/highlights/settings', headers: { cookie, origin }, payload: { replayMinutes } });
    expect((await t.app.inject({ url: '/api/highlights/settings', headers: { cookie: viewer.cookie } })).json()).toEqual({ replayMinutes: 10 });
    expect((await setReplay(admin.cookie, 0)).statusCode).toBe(400);
    expect((await setReplay(admin.cookie, 2.5)).statusCode).toBe(400);
    expect((await setReplay(viewer.cookie, 5)).statusCode).toBe(403);
    expect((await setReplay(admin.cookie, 5)).json()).toEqual({ threshold: 2.5, replayMinutes: 5 });
    expect((await t.app.inject({ url: '/api/highlights/settings', headers: { cookie: viewer.cookie } })).json()).toEqual({ replayMinutes: 5 });
    expect((await get()).replayMinutes).toBe(5);
  });
});

describe('feedback learning', () => {
  it('maps feedback to a capped adjustment per camera and time-of-day period', async () => {
    const { feedbackAdjustment, periodOf } = await import('../src/highlights/selection.ts');
    expect(feedbackAdjustment(0)).toBe(0);
    expect(feedbackAdjustment(2)).toBe(0.8);
    expect(feedbackAdjustment(5)).toBe(1);
    expect(feedbackAdjustment(-2)).toBe(-0.8);
    expect(feedbackAdjustment(-10)).toBe(-1.5);
    expect([periodOf(2), periodOf(23), periodOf(20), periodOf(12)]).toEqual(['nacht', 'nacht', 'avond', 'dag']);
  });

  it('lowers similar highlights after 👎 or deletion and takes a 👎 highlight out of the rotation', async () => {
    const reviews = [
      review('n1', TUIN, at(2, 10), at(2, 10) + 20),
      review('n2', TUIN, at(3, 10), at(3, 10) + 20),
      review('n3', TUIN, at(4, 10), at(4, 10) + 20),
      review('v1', VOORDEUR, at(4, 20), at(4, 20) + 20),
    ];
    const t2 = setupImporter(reviews);
    t2.store.setMeta('activated_at', String(at(1)));
    t2.setClock(at(5));
    await t2.importer.runOnce();
    const before = Object.fromEntries(t2.store.candidatesSince(0).map((c) => [c.id, c.score]));
    expect(before.n3).toBeGreaterThanOrEqual(2);

    t2.store.setFeedback('n1', -1, at(5));
    t2.store.tombstone('n2');
    await t2.importer.runOnce();
    const after = Object.fromEntries(t2.store.candidatesSince(0).map((c) => [c.id, c]));
    expect(after.n3!.feedbackAdj).toBe(-0.8);
    expect(after.n3!.score).toBe(Math.round((before.n3! - 0.8) * 100) / 100);
    expect(after.v1!.feedbackAdj).toBe(0);
    expect(t2.store.rotation(0, 15).map((c) => c.id)).not.toContain('n1');
  });

  it('counts highlights low once they are known from an answer or a vehicle fact, like a recognised face', async () => {
    const t2 = setupImporter([review('v1', VOORDEUR, at(4, 20), at(4, 20) + 20), review('v2', VOORDEUR, at(4, 22), at(4, 22) + 20)]);
    t2.store.setMeta('activated_at', String(at(1)));
    t2.setClock(at(5));
    await t2.importer.runOnce();
    const base = Object.fromEntries(t2.store.candidatesSince(0).map((c) => [c.id, c.baseScore]));
    t2.store.setAnnotation('v1', 'Tineke Mevius (bewoner)', true);
    t2.store.setAiResult('v2', 'Auto op de oprit', true, at(5), 'grijze Toyota Yaris', true);
    await t2.importer.runOnce();
    const after = Object.fromEntries(t2.store.candidatesSince(0).map((c) => [c.id, c]));
    expect(after.v1).toMatchObject({ knownFactor: 0.4, score: Math.round(base.v1! * 0.4 * 100) / 100 });
    expect(after.v2).toMatchObject({ knownFactor: 0.4, score: Math.round(base.v2! * 0.4 * 100) / 100 });
    expect(toSummaryReasons(after.v1!)).toContain('bekend volgens beheer of AI');
  });

  it('selects with the threshold an administrator set', async () => {
    const t2 = setupImporter([review('v1', VOORDEUR, at(4, 20), at(4, 20) + 20)]);
    t2.store.setMeta('activated_at', String(at(1)));
    t2.setClock(at(5));
    await t2.importer.runOnce();
    const score = t2.store.get('v1')!.score;
    expect(score).toBeGreaterThanOrEqual(1);
    expect(score).toBeLessThan(5);
    t2.store.setThreshold(5);
    await t2.importer.runOnce();
    expect(t2.store.get('v1')!.selected).toBe(false);
    t2.store.setThreshold(1);
    await t2.importer.runOnce();
    expect(t2.store.get('v1')!.selected).toBe(true);
  });
});

describe('facts API', () => {
  it('lets only administrators list and remove facts', async () => {
    const { FactStore } = await import('../src/ai/facts.ts');
    const auth = new AuthStore(':memory:');
    const store = new HighlightStore(':memory:');
    const facts = new FactStore(':memory:');
    const hub = new StateHub('live', cameras, 15_000);
    const clips = new ClipCache(join(tmpdir(), 'unused'), 1, async () => {}, (async () => new Response('')) as typeof fetch);
    const app = buildApp({ hub, auth: { store: auth, publicUrl: 'https://u.example' }, highlights: { store, clips, frigateUrl: 'http://f', facts } });
    cleanup.push(() => app.close(), () => hub.stop(), () => store.close(), () => auth.close(), () => facts.close());
    const login = async (username: string, role: 'admin' | 'viewer') => {
      const user = auth.createUser(username, role);
      auth.redeemLink(auth.createLink(user.id, 'activate'), await hashPassword('correct horse battery'));
      return { cookie: `uitkijk_session=${auth.createSession(user.id)}`, origin: 'https://u.example' };
    };
    const adminFresh = await login('beheer', 'admin');
    const viewerFresh = await login('kijker', 'viewer');
    expect((await app.inject({ url: '/api/admin/facts', headers: viewerFresh })).statusCode).toBe(403);
    const fact = facts.add('Blauwe VW up! is van Tini', 'mark (vraag 1)');
    expect((await app.inject({ url: '/api/admin/facts', headers: adminFresh })).json()).toMatchObject([{ text: 'Blauwe VW up! is van Tini', createdBy: 'mark (vraag 1)' }]);
    // Facts come from answered questions only; there is no manual entry any more.
    expect((await app.inject({ method: 'POST', url: '/api/admin/facts', headers: adminFresh, payload: { text: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/facts/${fact.id}`, headers: viewerFresh })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/facts/${fact.id}`, headers: adminFresh })).statusCode).toBe(204);
  });
});

function toSummaryReasons(c: Parameters<typeof toSummary>[0]): string[] {
  return toSummary(c).reasons;
}
