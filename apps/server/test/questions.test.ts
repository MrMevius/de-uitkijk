import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCameraConfig } from '@uitkijk/shared';
import { buildApp } from '../src/app.ts';
import { FactStore } from '../src/ai/facts.ts';
import { hashPassword } from '../src/auth/passwords.ts';
import { AuthStore } from '../src/auth/store.ts';
import { HighlightStore, type CandidateRecord } from '../src/highlights/store.ts';
import { StateHub } from '../src/hub.ts';
import { OPEN_LIMITS, QuestionGenerator } from '../src/questions/generator.ts';
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
  const add = (over: Partial<CandidateRecord> & { ai?: { real: boolean; vehicle?: string; known?: boolean }; selected?: boolean } = {}) => {
    const id = `h${++n}`;
    const start = over.startTime ?? NOW - n * 3600;
    const rec: CandidateRecord = {
      id, startTime: start, endTime: start + 20, cameras: ['voordeur'], camera: 'voordeur', frigateCamera: 'Vriezenveen_voordeur',
      repEvent: 'e', clipStart: start - 2, clipEnd: start + 22, eventStart: start - 5, eventEnd: start + 25, labels: ['person'],
      subLabels: [], score: 3, reasons: [], description: 'Persoon bij Voordeur', ...over,
    };
    highlights.insert(rec, [id]);
    if (over.selected !== false) highlights.setSelected(id, true);
    highlights.setThumbnail(id, new Uint8Array([1]));
    if (over.ai) highlights.setAiResult(id, 'Iemand bij de deur', over.ai.real, start + 60, over.ai.vehicle ?? null, over.ai.known ?? false);
    return id;
  };
  const generator = (extra: Partial<ConstructorParameters<typeof QuestionGenerator>[2]> = {}) =>
    new QuestionGenerator(highlights, questions, { cameras, now: () => NOW, ...extra });
  return { highlights, questions, add, generator };
}

describe('question generator', () => {
  it('asks about unknown people, best first, within the open limit and only once', () => {
    const t = setup();
    for (let i = 0; i < 5; i++) t.add({ ai: { real: true }, score: 2 + i });
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
    const id = t.add({ ai: { real: true } });
    const g = t.generator();
    g.runOnce();
    t.highlights.tombstone(id);
    g.runOnce();
    expect(t.questions.list('open')).toHaveLength(0);
  });
});

describe('answering questions', () => {
  async function api() {
    const t = setup();
    const facts = new FactStore(':memory:');
    const auth = new AuthStore(':memory:');
    const hub = new StateHub('live', cameras, 15_000);
    const app = buildApp({ hub, auth: { store: auth, publicUrl: 'https://u.example' }, questions: { questions: t.questions, highlights: t.highlights, facts, autoFacts: true, now: () => NOW } });
    cleanup.push(() => app.close(), () => hub.stop(), () => auth.close(), () => facts.close());
    const user = auth.createUser('mark', 'admin');
    auth.redeemLink(auth.createLink(user.id, 'activate'), await hashPassword('correct horse battery'));
    const headers = { cookie: `uitkijk_session=${auth.createSession(user.id)}`, origin: 'https://u.example' };
    const answer = (id: number, payload: object) => app.inject({ method: 'POST', url: `/api/admin/questions/${id}/answer`, headers, payload });
    return { ...t, facts, app, headers, answer };
  }

  it('labels a person and a vehicle; the vehicle answer becomes a fact for the AI', async () => {
    const t = await api();
    const p = t.add({ ai: { real: true } });
    const v = t.add({ labels: ['car'], ai: { real: true, vehicle: 'zwarte Volkswagen up!, kenteken XX-123-Y' } });
    t.generator().runOnce();
    const qs = (await t.app.inject({ url: '/api/admin/questions', headers: t.headers })).json<{ id: number; kind: string; highlight: { id: string } }[]>();
    const person = qs.find((q) => q.kind === 'person' && q.highlight.id === p)!;
    const vehicle = qs.find((q) => q.kind === 'vehicle')!;

    expect((await t.answer(person.id, { category: 'iets' })).statusCode).toBe(400);
    expect((await t.answer(person.id, { category: 'bezorger', name: 'PostNL\n<b>' })).json()).toEqual({ answer: 'PostNL (bezorger of dienstverlener)', fact: 'pending' });
    expect(t.questions.get(person.id)!.factStatus).toBe('pending');
    expect(t.highlights.get(p)!.annotation).toBe('PostNL (bezorger of dienstverlener)');
    expect((await t.answer(person.id, { category: 'bewoner' })).statusCode).toBe(404);

    const res = await t.answer(vehicle.id, { owner: 'Tini', vehicle: 'zwarte Volkswagen up!, kenteken XX-123-Y' });
    expect(res.json()).toMatchObject({ answer: 'Zwarte Volkswagen up!, kenteken XX-123-Y is van Tini', fact: 'done' });
    expect(t.facts.list()).toMatchObject([{ text: 'Zwarte Volkswagen up!, kenteken XX-123-Y is van Tini', createdBy: `mark (vraag ${vehicle.id})` }]);
    expect(t.questions.get(vehicle.id)).toMatchObject({ factStatus: 'done', fact: 'Zwarte Volkswagen up!, kenteken XX-123-Y is van Tini' });
    expect(t.highlights.get(v)!.annotation).toBe('auto van Tini');
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
    for (let i = 0; i < 3; i++) t.add({ ai: { real: true } });
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
    expect(parseFact('{"fact":""}')).toBeNull();
    expect(parseFact('{"fact":"Oma komt met een <i>grijze</i> Toyota Yaris.\\n"}')).toBe('Oma komt met een grijze Toyota Yaris.');
  });
});
