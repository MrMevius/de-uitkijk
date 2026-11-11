import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { FactStore } from '../src/ai/facts.ts';
import { hashPassword } from '../src/auth/passwords.ts';
import { AuthStore } from '../src/auth/store.ts';
import { acceptProposal, Bundler, parseBundle, personProposals, rejectProposal, supported, vehicleProposals, type PersonAnswer } from '../src/household/bundle.ts';
import { BundleScheduler, parseSchedule, slots } from '../src/household/schedule.ts';
import { HouseholdStore } from '../src/household/store.ts';
import { StateHub } from '../src/hub.ts';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

const NOW = Date.UTC(2026, 10, 11, 20, 0) / 1000;

// The production facts of 2026-11-10: duplicates, a contradiction and a vague and a precise description of one car.
const FACT_TEXTS = [
  'Lichtblauwe hatchback onder de carport Volkswagen E-UP is van Tini',
  'Witte Mercedes-Benz Sprinter-bestelbus is van Bert Hemmer',
  'Tineke Mevius is de bewoner.',
  'Rode auto, grotendeels verborgen is een Tesla Model 3 is van Jasper Mevius',
  'Rode auto onder de carport is een Tesla model 3 is van Jasper Mevius',
  'Donkerblauwe stationwagen Toyota Corolla is van Johan Mevius',
  'Zwarte compacte hatchback is van Noëlle Snippe',
  'Witte Ford Fiesta hatchback is van Gideon Snippe',
  'Witte Ford Focus hatchback is van Gideon Snippe',
  'Donkere Volkswagen up! is van Noëlle Snippe',
];

const ANSWERS: PersonAnswer[] = [
  { questionId: 1, name: 'Tineke Mevius', category: 'bewoner', at: NOW - 900 },
  { questionId: 27, name: 'Vera Snippe', category: 'buren', at: NOW - 800 },
  { questionId: 29, name: 'Noëlle Snippe', category: 'bezoeker', at: NOW - 700 },
  { questionId: 31, name: 'Noëlle Snippe', category: 'buren', at: NOW - 600 },
  { questionId: 30, name: 'Jasper Mevius', category: 'bewoner', at: NOW - 500 },
  { questionId: 45, name: 'Iemand', category: 'voorbijganger', at: NOW - 400 },
];

// What a well-behaved model answers for these facts; one item adds a make the facts do not mention.
const AI_ANSWER = {
  vehicles: [
    { target: 0, merge: [], kind: 'auto', make: 'Tesla', model: 'Model 3', colour: 'rood', plate: '', features: '', owner: 'Jasper Mevius', place: 'carport', facts: [4, 5], reason: 'Twee feiten over dezelfde rode Tesla.' },
    { target: 0, merge: [], kind: 'auto', make: 'Volkswagen', model: 'up!', colour: 'donker', plate: '', features: '', owner: 'Noëlle Snippe', place: '', facts: [7, 10], reason: 'Waarschijnlijk dezelfde auto.' },
    { target: 0, merge: [], kind: 'auto', make: 'Volkswagen', model: 'e-up!', colour: 'lichtblauw', plate: 'AB-123-C', features: '', owner: 'Tini', place: 'carport', facts: [1], reason: '' },
    { target: 0, merge: [], kind: 'bestelbus', make: 'Mercedes-Benz', model: 'Sprinter', colour: 'wit', plate: '', features: '', owner: 'Bert Hemmer', place: '', facts: [2], reason: '' },
    { target: 0, merge: [], kind: 'auto', make: 'Toyota', model: 'Corolla', colour: 'donkerblauw', plate: '', features: 'trekhaak', owner: 'Johan Mevius', place: '', facts: [6], reason: '' },
    { target: 0, merge: [], kind: 'auto', make: 'Opel', model: '', colour: '', plate: '', features: '', owner: 'Gideon Snippe', place: '', facts: [], reason: 'zonder feit' },
  ],
  questions: [
    { text: 'Is de witte Ford van Gideon een Fiesta of een Focus, of heeft hij er twee?', facts: [8, 9] },
    { text: 'Is Tini dezelfde als Tineke Mevius?', facts: [1] },
    { text: 'Vraag zonder bron die niet mag', facts: [99] },
  ],
};

function setup(answer: unknown = AI_ANSWER) {
  const store = new HouseholdStore(':memory:');
  const facts = new FactStore(':memory:');
  cleanup.push(() => store.close(), () => facts.close());
  FACT_TEXTS.forEach((t, i) => facts.add(t, `mark (vraag ${i})`, NOW - 1000 + i));
  const prompts: string[] = [];
  const bundler = new Bundler(store, {
    call: async (jpeg, prompt, _schema, effort) => {
      expect(jpeg).toBeNull();
      expect(effort).toBe('medium');
      prompts.push(prompt);
      return JSON.stringify(answer);
    },
    input: () => ({ facts: facts.list(), answers: ANSWERS, faceNames: ['Tineke Mevius', 'Mark Mevius', 'Jasper Mevius'] }),
    now: () => NOW,
  });
  return { store, facts, bundler, prompts };
}

describe('household register', () => {
  it('takes people and roles from the answers without AI: newest answer wins, face names without a role', () => {
    const store = new HouseholdStore(':memory:');
    cleanup.push(() => store.close());
    const out = personProposals([], { facts: [], answers: ANSWERS, faceNames: ['Mark Mevius', 'tineke mevius'] });
    expect(out.map((p) => p.summary)).toEqual([
      'Nieuwe persoon: Tineke Mevius (bewoner)',
      'Nieuwe persoon: Vera Snippe (buren)',
      'Nieuwe persoon: Noëlle Snippe (buren)',
      'Nieuwe persoon: Jasper Mevius (bewoner)',
      'Nieuwe persoon: Iemand',
      'Nieuwe persoon: Mark Mevius',
    ]);
    expect(out.find((p) => p.data.name === 'Noëlle Snippe')!.sources).toEqual(['vraag 29', 'vraag 31']);
    // A changed role is an update; a role an administrator set is left alone.
    const noelle = store.addPerson({ name: 'Noëlle Snippe', role: 'bezoeker' }, [], [], NOW);
    expect(personProposals([noelle], { facts: [], answers: ANSWERS, faceNames: [] }).find((p) => p.targetId === noelle.id)).toMatchObject({ action: 'update', data: { role: 'buren' } });
    const locked = store.updatePerson(noelle.id, { role: 'familie' }, { lock: true, at: NOW })!;
    expect(personProposals([locked], { facts: [], answers: ANSWERS, faceNames: [] }).some((p) => p.targetId === noelle.id)).toBe(false);
  });

  it('compares Dutch adjective forms and spellings when checking AI fields against the facts', () => {
    expect(supported('rood', 'Rode auto')).toBe(true);
    expect(supported('wit', 'Witte Ford')).toBe(true);
    expect(supported('grijs', 'grijze Yaris')).toBe(true);
    expect(supported('e-up!', 'Volkswagen E-UP')).toBe(true);
    expect(supported('Noëlle Snippe', 'is van Noelle Snippe')).toBe(true);
    expect(supported('Opel', 'Witte Ford Fiesta')).toBe(false);
  });

  it('keeps only what the facts support: unknown facts, invented plates and features are dropped', () => {
    const { facts } = setup();
    const out = vehicleProposals(parseBundle(JSON.stringify(AI_ANSWER)), { facts: facts.list(), vehicles: [], people: [], extraNames: ['Tineke Mevius'] });
    const summaries = out.map((p) => p.summary);
    expect(summaries).toEqual([
      'Nieuw voertuig: rood Tesla Model 3 van Jasper Mevius',
      'Nieuw voertuig: donker Volkswagen up! van Noëlle Snippe',
      'Nieuw voertuig: lichtblauw Volkswagen e-up! van Tini',
      'Nieuw voertuig: wit Mercedes-Benz Sprinter van Bert Hemmer',
      'Nieuw voertuig: donkerblauw Toyota Corolla van Johan Mevius',
      'Is de witte Ford van Gideon een Fiesta of een Focus, of heeft hij er twee?',
      'Is Tini dezelfde als Tineke Mevius?',
    ]);
    // The plate is not in the fact and the tow bar is not either.
    expect(out[2]!.data.plate).toBeUndefined();
    expect(out[4]!.data.features).toBeUndefined();
    expect(out[0]).toMatchObject({ sources: ['feit 4', 'feit 5'], data: { place: 'carport', owner: 'Jasper Mevius' } });
  });

  it('bundles, applies accepted proposals, creates unknown owners and does not repeat rejected ones', async () => {
    const { store, bundler, prompts } = setup();
    expect(await bundler.runOnce('mark')).toBeGreaterThan(0);
    expect(prompts[0]).toContain('- 7: Zwarte compacte hatchback is van Noëlle Snippe');
    expect(prompts[0]).toContain('Noëlle Snippe (buren)');
    expect(store.lastRun()).toMatchObject({ status: 'done', by: 'mark' });

    const open = store.proposals('pending');
    for (const p of open.filter((p) => p.kind === 'person')) expect(acceptProposal(store, p.id, 'mark', NOW)).toBe(true);
    const tesla = open.find((p) => p.summary.includes('Tesla'))!;
    const tini = open.find((p) => p.summary.includes('van Tini'))!;
    const question = open.find((p) => p.kind === 'question')!;
    expect(acceptProposal(store, tesla.id, 'mark', NOW)).toBe(true);
    expect(acceptProposal(store, tini.id, 'mark', NOW)).toBe(true);
    expect(rejectProposal(store, open.find((p) => p.summary.includes('Sprinter'))!.id, 'mark', NOW)).toBe(true);
    expect(acceptProposal(store, question.id, 'mark', NOW)).toBe(true);

    const jasper = store.people().find((p) => p.name === 'Jasper Mevius')!;
    expect(store.vehicles()).toMatchObject([
      { kind: 'auto', make: 'Tesla', model: 'Model 3', colour: 'rood', place: 'carport', ownerId: jasper.id, sources: ['feit 4', 'feit 5'] },
      { make: 'Volkswagen', model: 'e-up!' },
    ]);
    // "Tini" was not a known person: created without a role, for an administrator to merge with Tineke.
    expect(store.people().find((p) => p.name === 'Tini')).toMatchObject({ role: '' });
    expect(store.history().map((h) => h.text)).toContain('Voorstel afgewezen: Nieuw voertuig: wit Mercedes-Benz Sprinter van Bert Hemmer');

    // A second run replaces undecided proposals and does not suggest the rejected van or the seen question again.
    await bundler.runOnce('mark');
    expect(store.proposals('stale').length).toBeGreaterThan(0);
    const again = store.proposals('pending').map((p) => p.summary);
    expect(again.some((s) => s.includes('Sprinter'))).toBe(false);
    expect(again).not.toContain(question.summary);
    expect(prompts[1]).toContain('Nieuw voertuig: wit Mercedes-Benz Sprinter van Bert Hemmer');
  });

  it('merges vehicles and people, keeping what each knew', () => {
    const store = new HouseholdStore(':memory:');
    cleanup.push(() => store.close());
    const tineke = store.addPerson({ name: 'Tineke Mevius', role: 'bewoner' }, ['vraag 1'], [], NOW);
    const tini = store.addPerson({ name: 'Tini' }, ['feit 1'], [], NOW);
    const a = store.addVehicle({ kind: 'auto', colour: 'zwart', ownerId: tini.id, place: 'carport' }, ['feit 7'], [], NOW);
    const b = store.addVehicle({ kind: 'auto', make: 'Volkswagen', model: 'up!' }, ['feit 10'], [], NOW);
    const p = store.addProposal({ runId: 1, kind: 'vehicle', action: 'update', targetId: b.id, mergeIds: [a.id], data: { colour: 'donker' }, sources: ['feit 10'], summary: 's', reason: '', createdAt: NOW });
    expect(acceptProposal(store, p.id, 'mark', NOW)).toBe(true);
    expect(store.vehicles()).toMatchObject([{ id: b.id, make: 'Volkswagen', colour: 'donker', place: 'carport', ownerId: tini.id, sources: ['feit 10', 'feit 7'] }]);
    expect(store.mergePeople(tineke.id, tini.id, NOW)).toMatchObject({ name: 'Tineke Mevius', aliases: ['Tini'], sources: ['vraag 1', 'feit 1'] });
    expect(store.vehicles()[0]!.ownerId).toBe(tineke.id);
    // A proposal for a vehicle that no longer exists becomes stale.
    const gone = store.addProposal({ runId: 1, kind: 'vehicle', action: 'update', targetId: a.id, mergeIds: [], data: { colour: 'wit' }, sources: [], summary: 's', reason: '', createdAt: NOW });
    expect(acceptProposal(store, gone.id, 'mark', NOW)).toBe(false);
    expect(store.proposal(gone.id)!.status).toBe('stale');
  });

  it('records a failed run and bundles only people without AI', async () => {
    const { store } = setup();
    const broken = new Bundler(store, { call: async () => 'geen json', input: () => ({ facts: [], answers: ANSWERS, faceNames: [] }), now: () => NOW });
    // No facts: the AI is not called, people are still bundled.
    expect(await broken.runOnce('mark')).toBe(5);
    const failing = new Bundler(store, { call: async () => 'geen json', input: () => ({ facts: [{ id: 1, text: 'x', createdBy: 'm', createdAt: 1 }], answers: [], faceNames: [] }), now: () => NOW });
    expect(await failing.runOnce('mark')).toBe(0);
    expect(store.lastRun()).toMatchObject({ status: 'failed' });
    const noAi = new Bundler(store, { input: () => ({ facts: [{ id: 1, text: 'x', createdBy: 'm', createdAt: 1 }], answers: ANSWERS, faceNames: [] }), now: () => NOW });
    expect(noAi.aiEnabled).toBe(false);
    expect(await noAi.runOnce('mark')).toBe(5);
  });
});

describe('household API', () => {
  async function api() {
    const { store, facts, bundler } = setup();
    const auth = new AuthStore(':memory:');
    cleanup.push(() => auth.close());
    const admin = auth.createUser('mark', 'admin');
    auth.redeemLink(auth.createLink(admin.id, 'activate'), await hashPassword('correct horse battery'));
    const viewer = auth.createUser('tv', 'viewer');
    auth.redeemLink(auth.createLink(viewer.id, 'activate'), await hashPassword('correct horse battery'));
    const app = buildApp({ hub: new StateHub('mock', [], 15000), auth: { store: auth, publicUrl: 'https://u.example' }, household: { store, bundler, facts, now: () => NOW } });
    cleanup.push(() => app.close());
    const headers = { cookie: `uitkijk_session=${auth.createSession(admin.id)}`, origin: 'https://u.example' };
    const viewerHeaders = { cookie: `uitkijk_session=${auth.createSession(viewer.id)}`, origin: 'https://u.example' };
    return { app, store, headers, viewerHeaders };
  }

  it('shows the register, lets administrators edit it and locks what they set', async () => {
    const { app, store, headers, viewerHeaders } = await api();
    expect((await app.inject({ url: '/api/admin/household', headers: viewerHeaders })).statusCode).toBe(403);
    const person = (await app.inject({ method: 'POST', url: '/api/admin/household/people', headers, payload: { name: 'Noëlle Snippe', role: 'buren' } })).json<{ id: number }>();
    expect((await app.inject({ method: 'POST', url: '/api/admin/household/people', headers, payload: { name: 'noëlle snippe' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PATCH', url: `/api/admin/household/people/${person.id}`, headers, payload: { relation: 'vriendin van <b>Jasper</b>' } })).json()).toMatchObject({
      relation: 'vriendin van Jasper',
      locked: ['name', 'role', 'relation'],
    });
    expect((await app.inject({ method: 'PATCH', url: `/api/admin/household/people/${person.id}`, headers, payload: { role: 'baas' } })).statusCode).toBe(400);
    const car = (await app.inject({ method: 'POST', url: '/api/admin/household/vehicles', headers, payload: { kind: 'auto', make: 'Volkswagen', model: 'up!', plate: 'ab-123-c', ownerId: person.id } })).json();
    expect(car).toMatchObject({ plate: 'AB-123-C', ownerId: person.id });
    expect((await app.inject({ method: 'POST', url: '/api/admin/household/vehicles', headers, payload: { kind: 'auto' } })).statusCode).toBe(400);

    const view = (await app.inject({ url: '/api/admin/household', headers })).json<{ people: unknown[]; vehicles: { label: string; owner: string }[]; facts: { processed: boolean }[]; ai: boolean }>();
    expect(view.vehicles[0]).toMatchObject({ label: 'Volkswagen up!, kenteken AB-123-C', owner: 'Noëlle Snippe' });
    expect(view.facts).toHaveLength(10);
    expect(view.facts.every((f) => !f.processed)).toBe(true);
    expect(view.ai).toBe(true);

    expect((await app.inject({ method: 'DELETE', url: `/api/admin/household/people/${person.id}`, headers })).statusCode).toBe(200);
    expect(store.vehicles()[0]!.ownerId).toBeNull();
    expect(store.history().map((h) => h.text)[0]).toBe('Persoon verwijderd: Noëlle Snippe');
  });

  it('starts a bundling and accepts or rejects proposals', async () => {
    const { app, store, headers } = await api();
    expect((await app.inject({ method: 'POST', url: '/api/admin/household/bundle', headers })).json()).toMatchObject({ runId: 1 });
    await expect.poll(() => store.lastRun()?.status).toBe('done');
    const [first, second] = store.proposals('pending');
    expect((await app.inject({ method: 'POST', url: `/api/admin/household/proposals/${first!.id}/accept`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/admin/household/proposals/${first!.id}/accept`, headers })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/admin/household/proposals/${second!.id}/reject`, headers })).statusCode).toBe(200);
    expect(store.people()).toHaveLength(1);
  });
});

describe('bundling schedule (0.28.0)', () => {
  const ams = (iso: string) => Date.parse(iso); // ISO strings below are UTC
  it('computes the moments in Amsterdam time, also across the end of summer time', () => {
    // Sunday 2026-11-15 05:00 CET = 04:00 UTC.
    expect(slots({ frequency: 'weekly', weekday: 7, time: '05:00' }, ams('2026-11-12T12:00:00Z'))).toEqual({
      last: ams('2026-11-08T04:00:00Z'),
      next: ams('2026-11-15T04:00:00Z'),
    });
    // Daily 02:30 around 2026-10-25 (CEST → CET).
    expect(slots({ frequency: 'daily', weekday: 1, time: '02:30' }, ams('2026-10-25T12:00:00Z'))).toEqual({
      last: ams('2026-10-25T01:30:00Z'),
      next: ams('2026-10-26T01:30:00Z'),
    });
    expect(slots({ frequency: 'off', weekday: 1, time: '02:30' }, 0)).toBeNull();
    expect(parseSchedule({ frequency: 'weekly', weekday: 8, time: '05:00' })).toBe('Kies een dag van de week');
    expect(parseSchedule({ frequency: 'daily', time: '24:00' })).toBe('Kies een tijd (uu:mm)');
  });

  it('runs once per scheduled moment, not right after a deployment or a change, and catches up a short outage', () => {
    const store = new HouseholdStore(':memory:');
    cleanup.push(() => store.close());
    const runs: string[] = [];
    let busy = false;
    const bundler = { start: (by: string) => (runs.push(by), runs.length), get busy() { return busy; } };
    let now = ams('2026-11-15T04:30:00Z'); // half an hour after Sunday 05:00
    const s = new BundleScheduler(store, bundler, { now: () => now });
    s.start();
    s.stop();
    expect(s.tick()).toBeNull();
    expect(s.next()).toBe(ams('2026-11-22T04:00:00Z') / 1000);
    now = ams('2026-11-22T04:00:30Z');
    busy = true;
    expect(s.tick()).toBeNull();
    busy = false;
    expect(s.tick()).toBe(1);
    expect(s.tick()).toBeNull();
    expect(runs).toEqual(['systeem']);
    // A new daily time that already passed today waits for tomorrow.
    s.setSchedule({ frequency: 'daily', weekday: 7, time: '04:00' });
    expect(s.tick()).toBeNull();
    // Down from Sunday night until Monday 07:00: the 04:00 run is made up; a whole day later it is not.
    now = ams('2026-11-23T06:00:00Z');
    expect(s.tick()).toBe(2);
    now = ams('2026-11-25T02:00:00Z'); // 03:00 on Wednesday: Tuesday's 04:00 is more than 6 h ago
    expect(s.tick()).toBeNull();
    expect(runs).toHaveLength(2);
  });

  it('lets administrators choose the schedule', async () => {
    const store = new HouseholdStore(':memory:');
    const auth = new AuthStore(':memory:');
    const hub = new StateHub('live', [], 15_000);
    const bundler = new Bundler(store, { input: async () => ({ facts: [], answers: [], faceNames: [] }) });
    const scheduler = new BundleScheduler(store, bundler, { now: () => ams('2026-11-12T12:00:00Z') });
    const app = buildApp({ hub, auth: { store: auth, publicUrl: 'https://u.example' }, household: { store, bundler, scheduler } });
    cleanup.push(() => app.close(), () => hub.stop(), () => auth.close(), () => store.close());
    const user = auth.createUser('mevius', 'admin');
    auth.redeemLink(auth.createLink(user.id, 'activate'), await hashPassword('correct horse battery'));
    const headers = { cookie: `uitkijk_session=${auth.createSession(user.id)}`, origin: 'https://u.example' };
    expect((await app.inject({ url: '/api/admin/household', headers })).json().schedule).toEqual({ frequency: 'weekly', weekday: 7, time: '05:00', next: ams('2026-11-15T04:00:00Z') / 1000 });
    const put = (payload: object) => app.inject({ method: 'PUT', url: '/api/admin/household/schedule', headers, payload });
    expect((await put({ frequency: 'sometimes' })).statusCode).toBe(400);
    expect((await put({ frequency: 'weekly', weekday: 3, time: '21:15' })).json()).toEqual({ frequency: 'weekly', weekday: 3, time: '21:15', next: ams('2026-11-18T20:15:00Z') / 1000 });
    expect((await put({ frequency: 'off', weekday: 3, time: '21:15' })).json().next).toBeNull();
    expect(scheduler.schedule().frequency).toBe('off');
  });
});
