import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCameraConfig } from '@uitkijk/shared';
import { buildApp } from '../src/app.ts';
import { FactStore } from '../src/ai/facts.ts';
import { hashPassword } from '../src/auth/passwords.ts';
import { AuthStore } from '../src/auth/store.ts';
import { FaceLibrary, matchFaceName, parseAttempt, type FaceAttempt } from '../src/faces/library.ts';
import { FaceWorker } from '../src/faces/worker.ts';
import { HighlightStore, type CandidateRecord } from '../src/highlights/store.ts';
import { StateHub } from '../src/hub.ts';
import { OPEN_LIMITS, QuestionGenerator } from '../src/questions/generator.ts';
import { applyPersonAnswer, parsePersonAnswer } from '../src/questions/routes.ts';
import { QuestionStore } from '../src/questions/store.ts';

const cameras = parseCameraConfig(
  JSON.parse(readFileSync(new URL('../../../config/cameras.json', import.meta.url), 'utf8')),
);
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

const NOW = Date.UTC(2026, 10, 8, 20, 0) / 1000;

function setup() {
  const highlights = new HighlightStore(':memory:');
  const questions = new QuestionStore(':memory:');
  cleanup.push(() => highlights.close(), () => questions.close());
  let n = 0;
  const add = (
    over: Partial<CandidateRecord> & { ai?: { real: boolean; vehicle?: string; known?: boolean; marker?: boolean }; selected?: boolean } = {},
  ) => {
    const id = `h${++n}`;
    const start = over.startTime ?? NOW - n * 3600;
    const rec: CandidateRecord = {
      id, startTime: start, endTime: start + 20, cameras: ['voordeur'], camera: 'voordeur', frigateCamera: 'Vriezenveen_voordeur',
      repEvent: 'e', clipStart: start - 2, clipEnd: start + 22, eventStart: start - 5, eventEnd: start + 25, labels: ['person'],
      subLabels: [], score: 3, reasons: [], description: 'Persoon bij Voordeur', detections: [`ev-${id}`], ...over,
    };
    highlights.insert(rec, [id]);
    if (over.selected !== false) highlights.setSelected(id, true);
    highlights.setThumbnail(id, new Uint8Array([1]));
    if (over.ai) highlights.setAiResult(id, 'Iemand bij de deur.', over.ai.real, start + 60, over.ai.vehicle ?? null, over.ai.known ?? false, over.ai.marker ?? null);
    return id;
  };
  /** Face library stand-in: `attempts` lists unrecognised faces per Frigate event id. */
  const faceStub = (attempts: Record<string, Partial<FaceAttempt>> = {}, ready = true) => ({
    ready,
    refresh: async () => {},
    attemptsFor: (ids: string[]) =>
      ids.filter((i) => attempts[i]).map((i) => ({ file: `${i}.webp`, eventId: i, time: 1, guess: null, score: 0.3, ...attempts[i] })),
  });
  const generator = (extra: Partial<ConstructorParameters<typeof QuestionGenerator>[2]> = {}) =>
    new QuestionGenerator(highlights, questions, { cameras, now: () => NOW, faces: faceStub(), ...extra });
  return { highlights, questions, add, generator, faceStub };
}

describe('question generator', () => {
  it('asks about unknown people, best first, within the open limit and only once', () => {
    const t = setup();
    for (let i = 0; i < 5; i++) t.add({ ai: { real: true, marker: true }, score: 2 + i });
    t.add({ ai: { real: true }, subLabels: ['Mark Mevius'] });
    t.add({ ai: { real: false } });
    const g = t.generator();
    g.runOnce();
    const open = t.questions.list('open').filter((q) => q.kind === 'person');
    expect(open).toHaveLength(OPEN_LIMITS.person);
    expect(open.map((q) => q.highlightId).sort()).toEqual(['h3', 'h4', 'h5']);
    t.questions.resolve(open[0]!.id, 'dismissed', null, 'mark', NOW);
    g.runOnce();
    expect(t.questions.list('all').filter((q) => q.kind === 'person')).toHaveLength(4);
    expect(t.questions.list('all').some((q) => q.highlightId === open[0]!.highlightId && q.status === 'open')).toBe(false);
  });

  it('asks once per distinct unknown vehicle and never for known ones', () => {
    const t = setup();
    t.add({ labels: ['car'], ai: { real: true, vehicle: 'zwarte Volkswagen up!, kenteken XX-123-Y' } });
    t.add({ labels: ['car'], ai: { real: true, vehicle: 'Zwarte Volkswagen up! kenteken XX-123-Y' } });
    t.add({ labels: ['car'], ai: { real: true, vehicle: 'rode Tesla Model 3', known: true } });
    t.generator().runOnce();
    const v = t.questions.list('open').filter((q) => q.kind === 'vehicle');
    expect(v).toHaveLength(1);
    expect(v[0]!.data.vehicle).toMatch(/Volkswagen up!/);
  });

  it('suggests a check after recurring false alarms and asks about borderline highlights', () => {
    const t = setup();
    for (let i = 0; i < 5; i++) t.add({ ai: { real: false }, startTime: Date.UTC(2026, 10, 7 - i, 1, 0) / 1000 });
    t.add({ score: 2.1 });
    t.generator().runOnce();
    const open = t.questions.list('open');
    const noise = open.find((q) => q.kind === 'noise')!;
    expect(noise.title).toBe("Veel valse alarmen bij Voordeur 's nachts");
    expect(noise.key).toBe("noise:voordeur|nacht:2026-W45");
    expect(open.some((q) => q.kind === 'highlight')).toBe(true);
  });

  it('warns after a camera has had no picture for an hour and when Codex looks logged out', () => {
    const t = setup();
    let clock = NOW;
    const g = new QuestionGenerator(t.highlights, t.questions, {
      cameras,
      now: () => clock,
      cameraStatus: () => [{ id: 'achter_1', video: 'failed', checkedAt: clock }],
      aiStatus: () => ({ enabled: true, provider: 'codex', model: 'm', callsToday: 1, dailyCap: 60, lastSuccessAt: null, lastError: 'codex exited 1: Not logged in', pending: 2 }),
    });
    g.runOnce();
    expect(t.questions.list('open').map((q) => q.title)).toEqual(['Codex lijkt uitgelogd']);
    clock += 3600;
    g.runOnce();
    expect(t.questions.list('open').map((q) => q.title)).toContain('Achter het huis 1 geeft geen beeld');
  });

  it('closes questions about deleted highlights', () => {
    const t = setup();
    const id = t.add({ ai: { real: true, marker: true } });
    const g = t.generator();
    g.runOnce();
    expect(t.questions.list('open')).toHaveLength(1);
    t.highlights.tombstone(id);
    g.runOnce();
    expect(t.questions.list('open')).toHaveLength(0);
  });
});

describe('answering questions', () => {
  async function api(faces?: FaceLibrary) {
    const t = setup();
    const facts = new FactStore(':memory:');
    const auth = new AuthStore(':memory:');
    const hub = new StateHub('live', cameras, 15_000);
    const app = buildApp({ hub, auth: { store: auth, publicUrl: 'https://u.example' }, questions: { questions: t.questions, highlights: t.highlights, facts, autoFacts: true, faces, now: () => NOW } });
    cleanup.push(() => app.close(), () => hub.stop(), () => auth.close(), () => facts.close());
    const user = auth.createUser('mark', 'admin');
    auth.redeemLink(auth.createLink(user.id, 'activate'), await hashPassword('correct horse battery'));
    const headers = { cookie: `uitkijk_session=${auth.createSession(user.id)}`, origin: 'https://u.example' };
    const answer = (id: number, payload: object) => app.inject({ method: 'POST', url: `/api/admin/questions/${id}/answer`, headers, payload });
    return { ...t, facts, app, headers, answer };
  }

  it('labels a person and a vehicle; the vehicle answer becomes a fact for the AI', async () => {
    const t = await api();
    const p = t.add({ ai: { real: true, marker: true } });
    const v = t.add({ labels: ['car'], ai: { real: true, vehicle: 'zwarte Volkswagen up!, kenteken XX-123-Y' } });
    t.generator().runOnce();
    const qs = (await t.app.inject({ url: '/api/admin/questions', headers: t.headers })).json<{ id: number; kind: string; highlight: { id: string } }[]>();
    const person = qs.find((q) => q.kind === 'person' && q.highlight.id === p)!;
    const vehicle = qs.find((q) => q.kind === 'vehicle')!;

    expect((await t.answer(person.id, { category: 'iets' })).statusCode).toBe(400);
    expect((await t.answer(person.id, { category: 'bezorger', name: 'PostNL\n<b>' })).json()).toEqual({ answer: 'PostNL (bezorger of dienstverlener)', fact: 'pending', face: 'none' });
    expect(t.questions.get(person.id)!.factStatus).toBe('pending');
    // A courier is annotated and described again, but does not count as known and teaches no face.
    expect(t.highlights.get(p)).toMatchObject({ annotation: 'PostNL (bezorger of dienstverlener)', annotationKnown: false, aiRedo: true });
    expect((await t.answer(person.id, { category: 'bewoner' })).statusCode).toBe(404);

    const res = await t.answer(vehicle.id, { owner: 'Tini', vehicle: 'zwarte Volkswagen up!, kenteken XX-123-Y' });
    expect(res.json()).toMatchObject({ answer: 'Zwarte Volkswagen up!, kenteken XX-123-Y is van Tini', fact: 'done' });
    expect(t.facts.list()).toMatchObject([{ text: 'Zwarte Volkswagen up!, kenteken XX-123-Y is van Tini', createdBy: `mark (vraag ${vehicle.id})` }]);
    expect(t.questions.get(vehicle.id)).toMatchObject({ factStatus: 'done', fact: 'Zwarte Volkswagen up!, kenteken XX-123-Y is van Tini' });
    expect(t.highlights.get(v)).toMatchObject({ annotation: 'auto van Tini', annotationKnown: true, aiRedo: true });
  });

  it('asks whose bicycle it is and keeps one spelling per person (0.14)', async () => {
    const library = { ready: true, knownNames: () => ['Jasper Mevius', 'Mark Mevius'] } as unknown as FaceLibrary;
    const t = await api(library);
    const b = t.add({ labels: ['bicycle'], ai: { real: true, vehicle: 'zwarte Gazelle e-bike met fietstassen' } });
    t.generator().runOnce();
    const q = t.questions.list('open').find((x) => x.highlightId === b)!;
    expect(q).toMatchObject({ kind: 'vehicle', title: 'Van wie is deze fiets?', data: { vehicle: 'zwarte Gazelle e-bike met fietstassen', noun: 'fiets' } });

    expect((await t.answer(q.id, { owner: 'jasper', vehicle: 'zwarte Gazelle e-bike met fietstassen' })).json()).toMatchObject({
      answer: 'Zwarte Gazelle e-bike met fietstassen is van Jasper Mevius',
    });
    expect(t.highlights.get(b)).toMatchObject({ annotation: 'fiets van Jasper Mevius', annotationKnown: true, aiRedo: true });
  });

  it('turns a highlight answer into feedback, dismisses suggestions and counts open questions', async () => {
    const t = await api();
    const h = t.add({ score: 2.1 });
    for (let i = 0; i < 5; i++) t.add({ ai: { real: false }, startTime: Date.UTC(2026, 10, 7 - i, 1, 0) / 1000 });
    t.generator().runOnce();
    const qs = t.questions.list('open');
    const hq = qs.find((q) => q.kind === 'highlight' && q.highlightId === h)!;
    const nq = qs.find((q) => q.kind === 'noise')!;
    expect((await t.app.inject({ url: '/api/admin/questions/count', headers: t.headers })).json()).toEqual({ open: qs.length });
    expect((await t.answer(hq.id, { value: -1 })).statusCode).toBe(200);
    expect(t.highlights.get(h)!.feedback).toBe(-1);
    expect((await t.answer(nq.id, {})).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: `/api/admin/questions/${nq.id}/dismiss`, headers: t.headers })).statusCode).toBe(204);
    expect(t.questions.get(nq.id)!.status).toBe('dismissed');
  });
});

describe('facts from answers about people', () => {
  it('lets the AI write a fact from the still and the answer, or none, and retries failures', async () => {
    const { FactWorker } = await import('../src/questions/fact-worker.ts');
    const t = setup();
    const facts = new FactStore(':memory:');
    cleanup.push(() => facts.close());
    for (let i = 0; i < 3; i++) t.add({ ai: { real: true, marker: true } });
    t.generator().runOnce();
    const qs = t.questions.list('open');
    for (const q of qs) {
      t.questions.resolve(q.id, 'answered', 'PostNL (bezorger of dienstverlener)', 'mark', NOW);
      t.questions.setFact(q.id, 'pending');
    }
    const answers = ['De PostNL-bezorger komt met een oranje-witte PostNL-bestelbus.', null, 'fail'];
    const seen: { size: number; answer: string }[] = [];
    const worker = new FactWorker(t.questions, t.highlights, facts, async (img, ctx) => {
      seen.push({ size: img.length, answer: ctx.answer });
      const a = answers.shift();
      if (a === 'fail') throw new Error('codex exited 1');
      return a ?? null;
    }, { cameras, now: () => NOW, toJpeg: async (b) => b, still: async () => new Uint8Array(99), maxAttempts: 1 });
    await worker.runOnce();
    await worker.runOnce();
    await worker.runOnce();
    expect(await worker.runOnce()).toBe(false);
    expect(seen.every((s) => s.size === 99 && s.answer === 'PostNL (bezorger of dienstverlener)')).toBe(true);
    expect(facts.list()).toMatchObject([{ text: 'De PostNL-bezorger komt met een oranje-witte PostNL-bestelbus.', createdBy: expect.stringMatching(/^AI \(vraag \d+\)$/) }]);
    expect(t.questions.list('all').map((q) => q.factStatus).sort()).toEqual(['done', 'failed', 'none']);
  });

  it('asks the AI only for visible, stable features and never for faces or clothing of private people', async () => {
    const { buildFactPrompt, parseFact } = await import('../src/ai/fact-writer.ts');
    const prompt = buildFactPrompt({ question: 'Wie is dit?', answer: 'Oma (bezoeker)', cameraName: 'Voordeur' });
    expect(prompt).toContain('Antwoord van de bewoner: Oma (bezoeker)');
    expect(prompt).toContain('Nooit gebruiken: gezicht, haar, lichaamsbouw, leeftijd of gewone kleding van privépersonen');
    expect(prompt).toContain('Geen momentopname');
    expect(prompt).toContain('Alleen ernaast staan is niet genoeg');
    expect(parseFact('{"fact":""}')).toBeNull();
    expect(parseFact('{"fact":"Oma komt met een <i>grijze</i> Toyota Yaris.\\n"}')).toBe('Oma komt met een grijze Toyota Yaris.');
  });
});

describe('learning from answers (0.13)', () => {
  it('asks "who is this" about every unknown person, best first, once per highlight (0.18)', () => {
    const t = setup();
    const face = t.add({ ai: { real: true }, score: 5 });
    const plain = t.add({ ai: { real: true }, score: 3 }); // no face kept: asked anyway, the answer names the highlight
    t.add({ ai: { real: true }, subLabels: ['Mark Mevius'], score: 6 }); // recognised by Frigate
    t.add({ ai: { real: false }, score: 7 }); // noise
    const bike = t.add({ labels: ['bicycle'], ai: { real: true, vehicle: 'fiets' } });
    const faces = t.faceStub({ [`ev-${face}`]: { guess: 'Tineke Mevius', score: 0.82 } });
    t.generator({ faces }).runOnce();

    const open = t.questions.list('open');
    expect(open.filter((q) => q.kind === 'person').map((q) => q.highlightId).sort()).toEqual([face, plain].sort());
    // "fiets" alone is too vague to recognise later.
    expect(open.some((q) => q.highlightId === bike)).toBe(false);
    const fq = open.find((q) => q.highlightId === face)!;
    expect(fq.data).toEqual({ faces: [`ev-${face}.webp`], guess: 'Tineke Mevius' });
    expect(fq.body).toBe('Iemand bij de deur. Voordeur, zo 8 nov, 20:00. Frigate denkt aan Tineke Mevius (82%), maar weet het niet zeker.'.replace('20:00', fq.body.match(/\d\d:\d\d/)![0]));
    expect(open.find((q) => q.highlightId === plain)!.data).toEqual({ faces: [] });

    // Without a readable face library people are still asked about, just without face crops.
    const later = t.add({ ai: { real: true }, score: 4 });
    t.generator({ faces: t.faceStub({}, false) }).runOnce();
    expect(t.questions.list('open').some((q) => q.highlightId === later)).toBe(true);
  });

  it('asks whose vehicle it is for every unknown vehicle the AI saw, also parked ones (0.18)', () => {
    const t = setup();
    const id = t.add({ labels: ['person'], ai: { real: true } });
    t.highlights.setAiResult(id, 'Een persoon loopt over de oprit.', true, NOW, null, false, false, [
      { description: 'donkerblauwe Volvo V60', known: false },
      { description: 'rode Tesla Model 3', known: true },
      { description: 'zwarte kleine hatchback, merk en model niet duidelijk herkenbaar', known: false },
    ]);
    const parked = t.add({ labels: ['car'], selected: false });
    t.highlights.setAiResult(parked, 'Een auto staat geparkeerd.', true, NOW, null, false, false, [{ description: 'witte Renault Kangoo bestelbus', known: false }]);
    t.generator().runOnce();
    const open = t.questions.list('open');
    // The person question comes first for the first highlight; its vehicle waits until that one is answered.
    expect(open.filter((q) => q.kind === 'vehicle').map((q) => q.data.vehicle)).toEqual(['witte Renault Kangoo bestelbus']);
    const person = open.find((q) => q.highlightId === id)!;
    t.questions.resolve(person.id, 'answered', 'Mark Mevius (bewoner)', 'mark', NOW);
    t.generator().runOnce();
    const vehicles = t.questions.list('open').filter((q) => q.kind === 'vehicle');
    expect(vehicles.map((q) => q.data.vehicle).sort()).toEqual(['donkerblauwe Volvo V60', 'witte Renault Kangoo bestelbus']);
    expect(vehicles.find((q) => q.highlightId === id)!.title).toBe('Van wie is deze auto?');
    // An open question about a vehicle the AI could not tell apart (asked before this rule) is withdrawn.
    t.questions.add({ kind: 'vehicle', key: 'vehicle:x', highlightId: null, title: 'Van wie is deze auto?', body: 'x', data: { vehicle: 'grijze hatchback, merk en model niet duidelijk herkenbaar' } }, NOW);
    t.generator().runOnce();
    expect(t.questions.list('open').some((q) => q.key === 'vehicle:x')).toBe(false);
  });

  it('annotates, describes again, queues a fact and teaches Frigate the face of a named resident or visitor', () => {
    const t = setup();
    const id = t.add({ ai: { real: true } });
    const qid = (n: number) => (t.questions.add({ kind: 'person', key: `person:${n}`, highlightId: id, title: 'Wie is dit?', body: 'x' }, NOW), t.questions.list('all')[0]!.id);
    const faces = new FaceLibrary({ frigateUrl: 'https://f' });
    const opts = { questions: t.questions, highlights: t.highlights, autoFacts: true, faces };

    expect(applyPersonAnswer(t.questions.get(qid(1))!, 'Tineke (bewoner)', opts)).toEqual({ fact: 'pending', face: 'pending' });
    expect(t.highlights.get(id)).toMatchObject({ annotation: 'Tineke (bewoner)', annotationKnown: true, aiRedo: true, aiStatus: null });
    expect(t.questions.list('all')[0]).toMatchObject({ factStatus: 'pending', faceStatus: 'pending', faceName: 'Tineke' });
    expect(applyPersonAnswer(t.questions.get(qid(2))!, 'onbekend', opts)).toEqual({ fact: 'none', face: 'none' });
    expect(t.highlights.get(id)!.annotationKnown).toBe(false);
    expect(parsePersonAnswer('Oma (Tini) (bezoeker)')).toEqual({ name: 'Oma (Tini)', category: 'bezoeker' });
  });

  it('stores the kept face crops under the matching library name in Frigate', async () => {
    const t = setup();
    const ev = '1794150548.746085-gotiou';
    const id = t.add({ ai: { real: true }, detections: [ev] });
    t.questions.add({ kind: 'person', key: 'person:x', highlightId: id, title: 'Wie is dit?', body: 'x' }, NOW);
    const q = t.questions.list('all')[0]!;
    t.questions.resolve(q.id, 'answered', 'tineke (bewoner)', 'mark', NOW);
    t.questions.setFace(q.id, 'pending', 'tineke');
    const train = [`${ev}-1794150563.53-unknown-0.webp`, `${ev}-1794150564.1-Tineke Mevius-0.61.webp`, '1794150000.1-other-1794150001.2-unknown-0.webp'];
    const calls: { url: string; body?: string }[] = [];
    const fetchStub = (async (url: string, init?: RequestInit) => {
      calls.push({ url: decodeURIComponent(url), ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
      if (url.endsWith('/api/faces')) return Response.json({ 'Tineke Mevius': ['a.webp'], 'Mark Mevius': [], train });
      return new Response(null, { status: url.includes('/classify') ? 200 : 404 });
    }) as typeof fetch;
    await new FaceWorker(t.questions, t.highlights, new FaceLibrary({ frigateUrl: 'https://f', fetch: fetchStub })).runOnce();

    expect(calls.filter((c) => c.url.includes('/classify'))).toEqual([
      { url: 'https://f/api/faces/train/Tineke Mevius/classify', body: JSON.stringify({ training_file: train[1] }) },
      { url: 'https://f/api/faces/train/Tineke Mevius/classify', body: JSON.stringify({ training_file: train[0] }) },
    ]);
    expect(t.questions.get(q.id)).toMatchObject({ faceStatus: 'done', faceName: 'Tineke Mevius', faceResult: "2 gezichtsfoto's toegevoegd aan Tineke Mevius" });
  });

  it('marks face learning failed after repeated Frigate errors (e.g. no admin role) and none without a kept face', async () => {
    const t = setup();
    const ev = '1794150548.746085-gotiou';
    const withFace = t.add({ ai: { real: true }, detections: [ev] });
    const without = t.add({ ai: { real: true } });
    for (const [n, h] of [[1, withFace], [2, without]] as const) {
      t.questions.add({ kind: 'person', key: `person:${n}`, highlightId: h, title: 'Wie is dit?', body: 'x' }, NOW + n);
    }
    for (const q of t.questions.list('all')) t.questions.setFace(q.id, 'pending', 'Oma');
    const fetchStub = (async (url: string) =>
      url.endsWith('/api/faces') ? Response.json({ train: [`${ev}-1794150563.53-unknown-0.webp`] }) : new Response('{"detail":"admin required"}', { status: 403 })) as typeof fetch;
    const worker = new FaceWorker(t.questions, t.highlights, new FaceLibrary({ frigateUrl: 'https://f', fetch: fetchStub }), { maxAttempts: 2 });
    await worker.runOnce();
    await worker.runOnce();
    const byHighlight = Object.fromEntries(t.questions.list('all').map((q) => [q.highlightId, q]));
    expect(byHighlight[withFace]).toMatchObject({ faceStatus: 'failed', faceResult: expect.stringContaining('HTTP 403') });
    expect(byHighlight[without]).toMatchObject({ faceStatus: 'none' });
  });

  it('parses Frigate train attempts and matches typed names to the library', () => {
    expect(parseAttempt('1794161576.503101-smfbsb-1794161583.495469-Mark Mevius-0.89.webp')).toEqual({
      file: '1794161576.503101-smfbsb-1794161583.495469-Mark Mevius-0.89.webp',
      eventId: '1794161576.503101-smfbsb',
      time: 1794161583.495469,
      guess: 'Mark Mevius',
      score: 0.89,
    });
    expect(parseAttempt('1794150548.746085-gotiou-1794150563.533809-unknown-0.webp')).toMatchObject({ guess: null, score: 0 });
    expect(parseAttempt('../../etc/passwd')).toBeNull();
    const names = ['Jasper Mevius', 'Mark Mevius', 'Tineke Mevius'];
    expect(matchFaceName('tineke', names)).toBe('Tineke Mevius');
    expect(matchFaceName('MARK MEVIUS', names)).toBe('Mark Mevius');
    expect(matchFaceName(' Oma  Tini ', names)).toBe('Oma Tini');
    expect(matchFaceName('Mevius', names)).toBe('Mevius');
  });

  it('describes answered highlights again (any age, also when no longer selected) and counts known ones low', () => {
    const t = setup();
    const old = t.add({ ai: { real: true }, startTime: NOW - 5 * 86400, selected: false });
    t.highlights.setAnnotation(old, 'auto van Tini', true);
    expect(t.highlights.aiPending(NOW - 86400, 3).map((c) => c.id)).toEqual([]);
    // A redo without an answer (e.g. the 0.18 vehicle backfill) waits behind one with an answer.
    const backfill = t.add({ ai: { real: true }, startTime: NOW - 6 * 86400, selected: false });
    t.highlights.requestRedescribe(backfill);
    t.highlights.requestRedescribe(old);
    expect(t.highlights.aiPending(NOW - 86400, 3).map((c) => c.id)).toEqual([old, backfill]);
    t.highlights.setAiResult(backfill, 'Iemand bij de deur.', true, NOW);
    expect(t.highlights.get(old)!.aiDescription).toBe('Iemand bij de deur.');
    t.highlights.setAiResult(old, 'Tini parkeert haar auto.', true, NOW);
    expect(t.highlights.get(old)).toMatchObject({ aiRedo: false, aiDescription: 'Tini parkeert haar auto.' });

    t.highlights.setScoreParts(old, 0.2, 0.4);
    expect(t.highlights.get(old)).toMatchObject({ score: 1.4, knownFactor: 0.4 });
    // Identified highlights stay in the archive although they count low now.
    expect(t.highlights.archive({ limit: 10, offset: 0 }).items.map((c) => c.id)).toEqual([old]);
  });
});
