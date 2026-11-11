import type { FastifyInstance } from 'fastify';
import type { FactStore } from '../ai/facts.ts';
import type { FaceLibrary } from '../faces/library.ts';
import type { HighlightStore } from '../highlights/store.ts';
import { acceptProposal, rejectProposal, type Bundler } from './bundle.ts';
import { parseSchedule, type BundleScheduler } from './schedule.ts';
import {
  cleanText,
  findPerson,
  PERSON_ROLES,
  plateKey,
  VEHICLE_KINDS,
  vehicleLabel,
  type HouseholdStore,
  type Person,
  type PersonFields,
  type PersonRole,
  type VehicleFields,
  type VehicleKind,
} from './store.ts';

export interface HouseholdRouteOptions {
  store: HouseholdStore;
  bundler: Bundler;
  facts?: FactStore;
  highlights?: HighlightStore;
  faces?: FaceLibrary;
  /** Automatic bundling at a time an administrator chooses (since 0.28.0). */
  scheduler?: BundleScheduler;
  now?: () => number;
}

/** How far back "laatst gezien" and the count look. */
const SIGHTING_WINDOW_S = 180 * 86400;

function personFields(body: Record<string, unknown>): Partial<PersonFields> | string {
  const out: Partial<PersonFields> = {};
  if ('name' in body) {
    out.name = cleanText(body.name, 60);
    if (!out.name) return 'Vul een naam in';
  }
  if ('role' in body) {
    if (!(PERSON_ROLES as readonly string[]).includes(String(body.role))) return 'Onbekende rol';
    out.role = body.role as PersonRole;
  }
  if ('relation' in body) out.relation = cleanText(body.relation, 80);
  if ('aliases' in body) {
    if (!Array.isArray(body.aliases)) return 'Ongeldige andere namen';
    out.aliases = [...new Set(body.aliases.map((a) => cleanText(a, 60)).filter(Boolean))].slice(0, 10);
  }
  return out;
}

function vehicleFields(body: Record<string, unknown>, people: Person[]): Partial<VehicleFields> | string {
  const out: Partial<VehicleFields> = {};
  if ('kind' in body) {
    if (!(VEHICLE_KINDS as readonly string[]).includes(String(body.kind))) return 'Onbekende soort';
    out.kind = body.kind as VehicleKind;
  }
  for (const [f, max] of [['make', 40], ['model', 40], ['colour', 30], ['features', 80], ['place', 40]] as const) {
    if (f in body) out[f] = cleanText(body[f], max);
  }
  if ('plate' in body) out.plate = cleanText(body.plate, 12).toUpperCase();
  if ('ownerId' in body) {
    if (body.ownerId === null || body.ownerId === '') out.ownerId = null;
    else if (people.some((p) => p.id === Number(body.ownerId))) out.ownerId = Number(body.ownerId);
    else return 'Onbekende eigenaar';
  }
  return out;
}

/** The household register on the admin page (`/api/admin/`, admin role; since 0.22.0). */
export function registerHousehold(app: FastifyInstance, { store, bundler, facts, highlights, faces, scheduler, now = () => Date.now() / 1000 }: HouseholdRouteOptions): void {
  const by = (request: { user?: { username: string } }) => request.user?.username ?? 'beheerder';

  app.get('/api/admin/household', async () => {
    const people = store.people();
    const vehicles = store.vehicles();
    // Sightings: highlights where Frigate recognised the face or an administrator named the person, or where a
    // plate Frigate read matches the vehicle.
    const recent = highlights ? highlights.candidatesSince(now() - SIGHTING_WINDOW_S).filter((h) => !h.deleted) : [];
    const seen = (match: (h: (typeof recent)[number]) => boolean) => {
      const hits = recent.filter(match);
      return { sightings: hits.length, lastSeen: hits.reduce((m, h) => Math.max(m, h.startTime), 0) || null };
    };
    if (faces) await faces.refresh().catch(() => undefined);
    const library = faces?.ready ? faces.libraryImages() : [];
    const used = new Set(people.flatMap((p) => p.sources).concat(vehicles.flatMap((v) => v.sources)));
    return {
      ai: bundler.aiEnabled,
      busy: bundler.busy,
      lastRun: store.lastRun() ?? null,
      schedule: scheduler ? { ...scheduler.schedule(), next: scheduler.next() } : null,
      people: people.map((p) => {
        const names = [p.name, ...p.aliases].map((n) => n.toLowerCase());
        const face = library.find((l) => names.includes(l.name.toLowerCase()));
        return {
          ...p,
          face: face?.images[0] ? { name: face.name, file: face.images[0].file } : null,
          ...seen((h) => h.subLabels.some((s) => names.includes(s.toLowerCase())) || names.some((n) => { const a = (h.annotation ?? '').toLowerCase(); return a === n || a.startsWith(`${n} (`); })),
        };
      }),
      vehicles: vehicles.map((v) => ({
        ...v,
        label: vehicleLabel(v),
        owner: people.find((p) => p.id === v.ownerId)?.name ?? null,
        ...(v.plate ? seen((h) => h.plates.some((pl) => plateKey(pl) === plateKey(v.plate))) : { sightings: 0, lastSeen: null }),
      })),
      proposals: store.proposals('pending'),
      history: store.history(30),
      facts: (facts?.list() ?? []).map((f) => ({ ...f, processed: used.has(`feit ${f.id}`) })),
    };
  });

  app.put<{ Body: unknown }>('/api/admin/household/schedule', async (request, reply) => {
    if (!scheduler) return reply.code(404).send({ error: 'Automatisch bundelen is niet beschikbaar' });
    const parsed = parseSchedule(request.body);
    if (typeof parsed === 'string') return reply.code(400).send({ error: parsed });
    scheduler.setSchedule(parsed);
    request.log.info({ by: by(request), ...parsed }, 'household bundling schedule changed');
    return { ...parsed, next: scheduler.next() };
  });

  app.post('/api/admin/household/bundle', async (_request, reply) => {
    const id = bundler.start(by(_request));
    if (id === null) return reply.code(409).send({ error: 'Er loopt al een bundeling' });
    return { runId: id };
  });

  app.post<{ Params: { id: string } }>('/api/admin/household/proposals/:id/accept', async (request, reply) => {
    const ok = acceptProposal(store, Number(request.params.id), by(request), now());
    if (!ok) return reply.code(409).send({ error: 'Dit voorstel past niet meer bij het register of is al afgehandeld' });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/admin/household/proposals/:id/reject', async (request, reply) => {
    if (!rejectProposal(store, Number(request.params.id), by(request), now())) return reply.code(404).send({ error: 'Voorstel niet gevonden of al afgehandeld' });
    return { ok: true };
  });

  app.post<{ Body: Record<string, unknown> }>('/api/admin/household/people', async (request, reply) => {
    const f = personFields(request.body ?? {});
    if (typeof f === 'string') return reply.code(400).send({ error: f });
    if (!f.name) return reply.code(400).send({ error: 'Vul een naam in' });
    if (findPerson(store.people(), f.name)) return reply.code(409).send({ error: 'Deze persoon staat er al' });
    const p = store.addPerson({ ...f, name: f.name }, [`toegevoegd door ${by(request)}`], Object.keys(f), now());
    store.log(`Persoon toegevoegd: ${p.name}`, by(request), now());
    return p;
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/admin/household/people/:id', async (request, reply) => {
    const f = personFields(request.body ?? {});
    if (typeof f === 'string') return reply.code(400).send({ error: f });
    const id = Number(request.params.id);
    if (f.name && store.people().some((p) => p.id !== id && p.name.toLowerCase() === f.name!.toLowerCase())) return reply.code(409).send({ error: 'Deze naam bestaat al' });
    // An administrator's correction always wins: the fields become locked for the bundling.
    const p = store.updatePerson(id, f, { lock: true, at: now() });
    if (!p) return reply.code(404).send({ error: 'Persoon niet gevonden' });
    store.log(`Persoon bijgewerkt: ${p.name}`, by(request), now());
    return p;
  });

  app.post<{ Params: { id: string }; Body: { into?: unknown } }>('/api/admin/household/people/:id/merge', async (request, reply) => {
    const from = store.person(Number(request.params.id));
    const into = store.mergePeople(Number(request.body?.into), Number(request.params.id), now());
    if (!from || !into) return reply.code(400).send({ error: 'Kies twee verschillende personen' });
    store.log(`${from.name} samengevoegd met ${into.name}`, by(request), now());
    return into;
  });

  app.delete<{ Params: { id: string } }>('/api/admin/household/people/:id', async (request, reply) => {
    const p = store.person(Number(request.params.id));
    if (!p || !store.removePerson(p.id)) return reply.code(404).send({ error: 'Persoon niet gevonden' });
    store.log(`Persoon verwijderd: ${p.name}`, by(request), now());
    return { ok: true };
  });

  app.post<{ Body: Record<string, unknown> }>('/api/admin/household/vehicles', async (request, reply) => {
    const f = vehicleFields(request.body ?? {}, store.people());
    if (typeof f === 'string') return reply.code(400).send({ error: f });
    if (!f.make && !f.model && !f.plate && !f.colour) return reply.code(400).send({ error: 'Vul ten minste merk, model, kleur of kenteken in' });
    const v = store.addVehicle(f, [`toegevoegd door ${by(request)}`], Object.keys(f), now());
    store.log(`Voertuig toegevoegd: ${vehicleLabel(v)}`, by(request), now());
    return v;
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/admin/household/vehicles/:id', async (request, reply) => {
    const f = vehicleFields(request.body ?? {}, store.people());
    if (typeof f === 'string') return reply.code(400).send({ error: f });
    const v = store.updateVehicle(Number(request.params.id), f, { lock: true, at: now() });
    if (!v) return reply.code(404).send({ error: 'Voertuig niet gevonden' });
    store.log(`Voertuig bijgewerkt: ${vehicleLabel(v)}`, by(request), now());
    return v;
  });

  app.delete<{ Params: { id: string } }>('/api/admin/household/vehicles/:id', async (request, reply) => {
    const v = store.vehicle(Number(request.params.id));
    if (!v || !store.removeVehicle(v.id)) return reply.code(404).send({ error: 'Voertuig niet gevonden' });
    store.log(`Voertuig verwijderd: ${vehicleLabel(v)}`, by(request), now());
    return { ok: true };
  });
}
