import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { highlightTime } from '../highlights.tsx';
import { Card, Empty, Icon, Notice, PageHeader, Pill } from './ui.tsx';

const ROLES = [
  ['', 'onbekend'],
  ['bewoner', 'Bewoner'],
  ['familie', 'Familie'],
  ['bezoeker', 'Bezoeker'],
  ['buren', 'Buren'],
  ['vaste hulp', 'Vaste hulp'],
  ['bezorger of dienstverlener', 'Bezorger / dienst'],
] as const;
const KINDS = ['auto', 'bestelbus', 'motor', 'scooter', 'fiets'] as const;

interface Person {
  id: number;
  name: string;
  role: string;
  relation: string;
  aliases: string[];
  sources: string[];
  locked: string[];
  face: { name: string; file: string } | null;
  sightings: number;
  lastSeen: number | null;
}

interface Vehicle {
  id: number;
  kind: string;
  make: string;
  model: string;
  colour: string;
  plate: string;
  features: string;
  ownerId: number | null;
  place: string;
  sources: string[];
  label: string;
  owner: string | null;
  sightings: number;
  lastSeen: number | null;
}

interface Proposal {
  id: number;
  kind: 'person' | 'vehicle' | 'question';
  summary: string;
  reason: string;
  sources: string[];
}

interface Household {
  ai: boolean;
  busy: boolean;
  lastRun: { status: 'running' | 'done' | 'failed'; startedAt: number; finishedAt: number | null; error: string | null; proposals: number; by?: string } | null;
  people: Person[];
  vehicles: Vehicle[];
  proposals: Proposal[];
  history: { id: number; at: number; by: string; text: string }[];
  facts: { id: number; text: string; createdBy: string; processed: boolean }[];
  /** Automatic bundling (since 0.28.0); `next` in epoch seconds, null when off. */
  schedule: (Schedule & { next: number | null }) | null;
}

interface Schedule {
  frequency: 'off' | 'daily' | 'weekly';
  weekday: number;
  time: string;
}

const WEEKDAYS = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'];

/** When the bundling runs by itself: off, daily or weekly at a chosen time (since 0.28.0). */
function ScheduleCard({ schedule, onSaved }: { schedule: NonNullable<Household['schedule']>; onSaved: () => void }) {
  const [draft, setDraft] = useState<Schedule>({ frequency: schedule.frequency, weekday: schedule.weekday, time: schedule.time });
  const [message, setMessage] = useState<string | null>(null);
  const changed = draft.frequency !== schedule.frequency || draft.weekday !== schedule.weekday || draft.time !== schedule.time;
  const save = async () => {
    setMessage(null);
    try {
      await api('PUT', '/api/admin/household/schedule', draft);
      setMessage('Opgeslagen.');
      onSaved();
    } catch (err) {
      setMessage((err as Error).message);
    }
  };
  return (
    <Card title="Automatisch bundelen" icon="history">
      <div className="ui-toolbar ui-toolbar--plain">
        <select value={draft.frequency} onChange={(e) => setDraft({ ...draft, frequency: e.target.value as Schedule['frequency'] })} aria-label="Hoe vaak">
          <option value="off">Uit (alleen met de knop)</option>
          <option value="daily">Elke dag</option>
          <option value="weekly">Elke week</option>
        </select>
        {draft.frequency === 'weekly' && (
          <select value={draft.weekday} onChange={(e) => setDraft({ ...draft, weekday: Number(e.target.value) })} aria-label="Dag">
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i + 1}>
                op {d}
              </option>
            ))}
          </select>
        )}
        {draft.frequency !== 'off' && (
          <label className="ui-toolbar__date">
            om <input type="time" value={draft.time} onChange={(e) => setDraft({ ...draft, time: e.target.value })} aria-label="Tijd" required />
          </label>
        )}
        <button className="ui-btn ui-btn--primary" disabled={!changed || (draft.frequency !== 'off' && !draft.time)} onClick={() => void save()}>
          Opslaan
        </button>
      </div>
      <p className="ui-muted ui-small">
        {schedule.next ? `Volgende keer: ${highlightTime(schedule.next)}.` : 'Bundelen gebeurt alleen als je op "Nu bundelen" klikt.'} Met AI kost een run één
        AI-aanroep en duurt hij een minuut of twee; nieuwe voorstellen verschijnen hier om te controleren, er verandert niets vanzelf.
        {message && <> {message}</>}
      </p>
    </Card>
  );
}

const roleLabel = (role: string) => ROLES.find(([r]) => r === role)?.[1] ?? role;
const faceUrl = (f: { name: string; file: string }) => `/api/admin/faces/library/${encodeURIComponent(f.name)}/${encodeURIComponent(f.file)}`;
const seenText = (x: { sightings: number; lastSeen: number | null }) =>
  x.lastSeen ? `laatst gezien ${highlightTime(x.lastSeen)} · ${x.sightings}× in een half jaar` : 'nog niet gezien in highlights';

/**
 * The household register (since 0.22.0): who is who and whose vehicle is which. Built from the raw facts and
 * answers by the bundling (with AI) and corrected by administrators; a correction always wins.
 */
export function HouseholdTab() {
  const [data, setData] = useState<Household | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const load = () => api<Household>('GET', '/api/admin/household').then(setData, (err: Error) => setError(err.message));
  useEffect(() => void load(), []);
  // While a bundling runs (a minute or two with AI), check back.
  useEffect(() => {
    if (!data?.busy && data?.lastRun?.status !== 'running') return;
    const timer = setTimeout(() => void load(), 3000);
    return () => clearTimeout(timer);
  }, [data]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };

  if (!data) {
    return (
      <>
        <PageHeader title="Huishouden" />
        {error ? <Notice>{error}</Notice> : <p className="ui-muted">Laden…</p>}
      </>
    );
  }

  const running = data.busy || data.lastRun?.status === 'running';
  return (
    <>
      <PageHeader
        title="Huishouden"
        description="Wie is wie en welk voertuig van wie is. Gebundeld uit je antwoorden op Vragen en de losse feiten; wat je hier zelf aanpast, verandert het bundelen nooit meer."
        actions={
          <button className="ui-btn ui-btn--primary" disabled={running} onClick={() => void run(() => api('POST', '/api/admin/household/bundle'))}>
            {running ? 'Bezig met bundelen…' : 'Nu bundelen'}
          </button>
        }
      />
      <div className="ui-stack">
        {error && <Notice>{error}</Notice>}
        <RunStatus data={data} />
        {data.schedule && <ScheduleCard key={JSON.stringify(data.schedule)} schedule={data.schedule} onSaved={() => void load()} />}

        {data.proposals.length > 0 && (
          <Card title={`Voorstellen (${data.proposals.length})`} icon="ai" className="ui-card--accent">
            <p className="ui-muted">Controleer elk voorstel. Geaccepteerd komt het in het register; afgewezen voorstellen komen niet terug.</p>
            <ul className="ui-list">
              {data.proposals.map((p) => (
                <li key={p.id}>
                  <div className="ui-grow">
                    <div>
                      {p.kind === 'question' && <Pill level="warn">Vraag</Pill>} {p.summary}
                    </div>
                    {p.reason && <div className="ui-muted ui-small">{p.reason}</div>}
                    <div className="ui-muted ui-small">Bron: {p.sources.join(', ')}</div>
                  </div>
                  <div className="ui-row-actions">
                    {p.kind === 'question' ? (
                      <>
                        <a className="ui-btn ui-btn--small ui-btn--primary" href="#vragen" title="Deze twijfel staat als vraag met antwoordknoppen op Vragen (hooguit drie tegelijk)">
                          Beantwoorden
                        </a>
                        <button className="ui-btn ui-btn--small" onClick={() => void run(() => api('POST', `/api/admin/household/proposals/${p.id}/accept`))}>
                          Gezien
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="ui-btn ui-btn--small ui-btn--primary" onClick={() => void run(() => api('POST', `/api/admin/household/proposals/${p.id}/accept`))}>
                          <Icon name="check" size={14} />
                          Accepteren
                        </button>
                        <button className="ui-btn ui-btn--small ui-btn--ghost" onClick={() => void run(() => api('POST', `/api/admin/household/proposals/${p.id}/reject`))}>
                          Afwijzen
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card
          title={`Personen (${data.people.length})`}
          icon="users"
          actions={
            <button className="ui-btn ui-btn--small" onClick={() => setEditing('person:new')}>
              <Icon name="plus" size={14} />
              Persoon
            </button>
          }
        >
          {editing === 'person:new' && <PersonForm onDone={() => setEditing(null)} save={(body) => run(() => api('POST', '/api/admin/household/people', body))} />}
          {data.people.length === 0 ? (
            <Empty>Nog niemand. Klik op "Nu bundelen" om personen uit je antwoorden over te nemen.</Empty>
          ) : (
            <div className="hh-grid">
              {data.people.map((p) =>
                editing === `person:${p.id}` ? (
                  <PersonForm
                    key={p.id}
                    person={p}
                    others={data.people.filter((o) => o.id !== p.id)}
                    onDone={() => setEditing(null)}
                    save={(body) => run(() => api('PATCH', `/api/admin/household/people/${p.id}`, body))}
                    merge={(into) => run(() => api('POST', `/api/admin/household/people/${p.id}/merge`, { into }))}
                    remove={() => run(() => api('DELETE', `/api/admin/household/people/${p.id}`))}
                  />
                ) : (
                  <article key={p.id} className="hh-card">
                    {p.face ? <img className="hh-avatar" src={faceUrl(p.face)} alt="" loading="lazy" /> : <span className="hh-avatar hh-avatar--empty">{p.name.charAt(0)}</span>}
                    <div className="ui-grow">
                      <div className="hh-title">
                        {p.name} {p.role && <Pill level="info">{roleLabel(p.role)}</Pill>}
                      </div>
                      {p.relation && <div>{p.relation}</div>}
                      {p.aliases.length > 0 && <div className="ui-muted ui-small">ook: {p.aliases.join(', ')}</div>}
                      {data.vehicles
                        .filter((v) => v.ownerId === p.id)
                        .map((v) => (
                          <div key={v.id} className="ui-small">
                            {v.kind}: {v.label}
                          </div>
                        ))}
                      <div className="ui-muted ui-small">{seenText(p)}</div>
                    </div>
                    <button className="ui-btn ui-btn--small ui-btn--ghost" onClick={() => setEditing(`person:${p.id}`)}>
                      Aanpassen
                    </button>
                  </article>
                ),
              )}
            </div>
          )}
        </Card>

        <Card
          title={`Voertuigen (${data.vehicles.length})`}
          icon="camera"
          actions={
            <button className="ui-btn ui-btn--small" onClick={() => setEditing('vehicle:new')}>
              <Icon name="plus" size={14} />
              Voertuig
            </button>
          }
        >
          {editing === 'vehicle:new' && (
            <VehicleForm people={data.people} onDone={() => setEditing(null)} save={(body) => run(() => api('POST', '/api/admin/household/vehicles', body))} />
          )}
          {data.vehicles.length === 0 ? (
            <Empty>Nog geen voertuigen. "Nu bundelen" maakt ze uit de losse feiten.</Empty>
          ) : (
            <div className="hh-grid">
              {data.vehicles.map((v) =>
                editing === `vehicle:${v.id}` ? (
                  <VehicleForm
                    key={v.id}
                    vehicle={v}
                    people={data.people}
                    onDone={() => setEditing(null)}
                    save={(body) => run(() => api('PATCH', `/api/admin/household/vehicles/${v.id}`, body))}
                    remove={() => run(() => api('DELETE', `/api/admin/household/vehicles/${v.id}`))}
                  />
                ) : (
                  <article key={v.id} className="hh-card">
                    <div className="ui-grow">
                      <div className="hh-title">
                        {v.label} <Pill level="off">{v.kind}</Pill>
                      </div>
                      <div>{v.owner ? `van ${v.owner}` : <span className="ui-muted">eigenaar onbekend</span>}</div>
                      {(v.features || v.place) && <div className="ui-muted ui-small">{[v.features, v.place && `staat meestal: ${v.place}`].filter(Boolean).join(' · ')}</div>}
                      {v.plate && <div className="ui-muted ui-small">{seenText(v)}</div>}
                    </div>
                    <button className="ui-btn ui-btn--small ui-btn--ghost" onClick={() => setEditing(`vehicle:${v.id}`)}>
                      Aanpassen
                    </button>
                  </article>
                ),
              )}
            </div>
          )}
        </Card>

        <Card title={`Losse feiten (${data.facts.length})`} icon="ai">
          <details>
            <summary className="ui-link">
              {data.facts.filter((f) => !f.processed).length} nog niet verwerkt in het register · tonen
            </summary>
            <p className="ui-muted">
              Feiten ontstaan vanzelf uit je antwoorden op <a className="ui-link" href="#vragen">Vragen</a> en gaan bij elke beschrijving naar OpenAI (Codex).
              Klopt een feit niet, verwijder het dan.
            </p>
            <ul className="ui-list">
              {data.facts.map((f) => (
                <li key={f.id}>
                  <div className="ui-grow">
                    <div>
                      <span className="ui-muted">{f.id}.</span> {f.text}
                    </div>
                    <div className="ui-muted ui-small">{f.createdBy}</div>
                  </div>
                  {f.processed && <Pill level="ok">verwerkt</Pill>}
                  <button className="ui-btn ui-btn--small ui-btn--danger" onClick={() => void run(() => api('DELETE', `/api/admin/facts/${f.id}`))}>
                    <Icon name="trash" size={14} />
                    Verwijderen
                  </button>
                </li>
              ))}
            </ul>
          </details>
        </Card>

        {data.history.length > 0 && (
          <Card title="Geschiedenis" icon="overview">
            <ul className="ui-list">
              {data.history.map((h) => (
                <li key={h.id}>
                  <div className="ui-grow">{h.text}</div>
                  <span className="ui-muted ui-small ui-nowrap">
                    {h.by} · {highlightTime(h.at)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}

function RunStatus({ data }: { data: Household }) {
  const r = data.lastRun;
  if (!data.ai) return <Notice level="info">AI staat uit: bundelen neemt alleen personen en rollen uit je antwoorden over, geen voertuigen.</Notice>;
  if (!r) return <Notice level="info">Nog niet gebundeld. Klik op "Nu bundelen" of wacht op de automatische run hieronder; dat duurt met AI een minuut of twee.</Notice>;
  if (r.status === 'running') return <Notice level="info">Bezig met bundelen sinds {highlightTime(r.startedAt)}…</Notice>;
  if (r.status === 'failed') return <Notice level="warn">Bundelen mislukt ({highlightTime(r.startedAt)}): {r.error}</Notice>;
  return (
    <p className="ui-muted ui-small">
      Laatst gebundeld {highlightTime(r.finishedAt ?? r.startedAt)}{r.by === 'systeem' ? ' (automatisch)' : ''}: {r.proposals === 0 ? 'niets nieuws' : `${r.proposals} ${r.proposals === 1 ? 'voorstel' : 'voorstellen'}`}.
    </p>
  );
}

function PersonForm({
  person,
  others = [],
  save,
  merge,
  remove,
  onDone,
}: {
  person?: Person;
  others?: Person[];
  save: (body: object) => Promise<boolean>;
  merge?: (into: number) => Promise<boolean>;
  remove?: () => Promise<boolean>;
  onDone: () => void;
}) {
  const [name, setName] = useState(person?.name ?? '');
  const [role, setRole] = useState(person?.role ?? '');
  const [relation, setRelation] = useState(person?.relation ?? '');
  const [aliases, setAliases] = useState(person?.aliases.join(', ') ?? '');
  const [into, setInto] = useState('');
  const done = (ok: boolean) => ok && onDone();
  return (
    <form
      className="hh-card hh-form"
      onSubmit={(e) => {
        e.preventDefault();
        const body = { name, role, relation, aliases: aliases.split(',').map((a) => a.trim()).filter(Boolean) };
        void save(body).then(done);
      }}
    >
      <div className="ui-form-grid">
        <label className="ui-field">
          <span className="ui-field__label">Naam</span>
          <input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="ui-field">
          <span className="ui-field__label">Rol</span>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map(([r, label]) => (
              <option key={r} value={r}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="ui-field">
          <span className="ui-field__label">Relatie</span>
          <input placeholder="bijv. vriendin van Jasper" maxLength={80} value={relation} onChange={(e) => setRelation(e.target.value)} />
        </label>
        <label className="ui-field">
          <span className="ui-field__label">Ook bekend als</span>
          <input placeholder="bijv. Tini, Oma" value={aliases} onChange={(e) => setAliases(e.target.value)} />
        </label>
      </div>
      <div className="ui-actions">
        <button className="ui-btn ui-btn--primary" type="submit">
          Opslaan
        </button>
        <button className="ui-btn ui-btn--ghost" type="button" onClick={onDone}>
          Annuleren
        </button>
        {merge && others.length > 0 && (
          <span className="ui-inline">
            <select aria-label="Samenvoegen met" value={into} onChange={(e) => setInto(e.target.value)}>
              <option value="">Samenvoegen met…</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <button className="ui-btn" type="button" disabled={!into} onClick={() => void merge(Number(into)).then(done)}>
              Samenvoegen
            </button>
          </span>
        )}
        {remove && (
          <button className="ui-btn ui-btn--danger" type="button" onClick={() => confirm(`${person?.name} verwijderen?`) && void remove().then(done)}>
            <Icon name="trash" size={14} />
            Verwijderen
          </button>
        )}
      </div>
    </form>
  );
}

function VehicleForm({
  vehicle,
  people,
  save,
  remove,
  onDone,
}: {
  vehicle?: Vehicle;
  people: Person[];
  save: (body: object) => Promise<boolean>;
  remove?: () => Promise<boolean>;
  onDone: () => void;
}) {
  const [f, setF] = useState({
    kind: vehicle?.kind ?? 'auto',
    make: vehicle?.make ?? '',
    model: vehicle?.model ?? '',
    colour: vehicle?.colour ?? '',
    plate: vehicle?.plate ?? '',
    features: vehicle?.features ?? '',
    place: vehicle?.place ?? '',
    ownerId: vehicle?.ownerId ? String(vehicle.ownerId) : '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const done = (ok: boolean) => ok && onDone();
  return (
    <form
      className="hh-card hh-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save({ ...f, ownerId: f.ownerId ? Number(f.ownerId) : null }).then(done);
      }}
    >
      <div className="ui-form-grid">
        <label className="ui-field">
          <span className="ui-field__label">Soort</span>
          <select value={f.kind} onChange={set('kind')}>
            {KINDS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <label className="ui-field">
          <span className="ui-field__label">Merk</span>
          <input maxLength={40} value={f.make} onChange={set('make')} />
        </label>
        <label className="ui-field">
          <span className="ui-field__label">Model</span>
          <input maxLength={40} value={f.model} onChange={set('model')} />
        </label>
        <label className="ui-field">
          <span className="ui-field__label">Kleur</span>
          <input maxLength={30} value={f.colour} onChange={set('colour')} />
        </label>
        <label className="ui-field">
          <span className="ui-field__label">Kenteken</span>
          <input maxLength={12} value={f.plate} onChange={set('plate')} />
        </label>
        <label className="ui-field">
          <span className="ui-field__label">Eigenaar</span>
          <select value={f.ownerId} onChange={set('ownerId')}>
            <option value="">onbekend</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="ui-field">
          <span className="ui-field__label">Vaste kenmerken</span>
          <input placeholder="bijv. kinderzitje, bedrijfslogo" maxLength={80} value={f.features} onChange={set('features')} />
        </label>
        <label className="ui-field">
          <span className="ui-field__label">Staat meestal</span>
          <input placeholder="bijv. carport" maxLength={40} value={f.place} onChange={set('place')} />
        </label>
      </div>
      <div className="ui-actions">
        <button className="ui-btn ui-btn--primary" type="submit">
          Opslaan
        </button>
        <button className="ui-btn ui-btn--ghost" type="button" onClick={onDone}>
          Annuleren
        </button>
        {remove && (
          <button className="ui-btn ui-btn--danger" type="button" onClick={() => confirm(`${vehicle?.label} verwijderen?`) && void remove().then(done)}>
            <Icon name="trash" size={14} />
            Verwijderen
          </button>
        )}
      </div>
    </form>
  );
}
