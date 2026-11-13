import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { highlightTime } from '../highlights.tsx';
import { Empty, Icon, Notice, PageHeader, Pill, type Level } from './ui.tsx';

interface Question {
  id: number;
  kind: 'person' | 'vehicle' | 'highlight' | 'noise' | 'system' | 'household';
  title: string;
  body: string;
  data: {
    vehicle?: string;
    noun?: string;
    faces?: string[];
    guess?: string;
    /** Household questions (since 0.29.0). */
    type?: 'doubt' | 'vehicle' | 'role' | 'same';
    /** Two register entries that may be one vehicle (since 0.32.0). */
    labels?: [string, string];
    options?: { label: string; fact: string; retire: number[] }[];
    facts?: { id: number; text: string }[];
    fields?: ('make' | 'model' | 'plate')[];
    make?: string;
    model?: string;
    plate?: string;
  };
  status: 'open' | 'answered' | 'dismissed';
  answer: string | null;
  answeredBy: string | null;
  createdAt: number;
  answeredAt: number | null;
  factStatus: 'pending' | 'done' | 'none' | 'failed' | null;
  fact: string | null;
  faceStatus: 'pending' | 'done' | 'none' | 'failed' | null;
  faceResult: string | null;
  highlight: { id: string; hasThumbnail: boolean; feedback?: -1 | 1 | null; recognized?: string[] } | null;
  /** Other highlights of the same visit that the answer about a person can also apply to (since 0.27.0). */
  sameVisit?: { id: string; camera: string; startTime: number; description: string }[];
  /** Who it probably is, from the same visit: an earlier answer, a recognised face or a known vehicle (since 0.33.0). */
  suggestions?: { name: string; category: string | null; text: string }[];
}

const KIND_LABEL: Record<Question['kind'], string> = {
  person: 'Persoon',
  vehicle: 'Voertuig',
  highlight: 'Highlight',
  noise: 'Suggestie',
  system: 'Melding',
  household: 'Huishouden',
};

const PERSON_BUTTONS = [
  ['bewoner', 'Bewoner'],
  ['familie', 'Familie'],
  ['bezoeker', 'Bezoeker'],
  ['buren', 'Buren'],
  ['hulp', 'Vaste hulp'],
  ['bezorger', 'Bezorger / dienst'],
  ['voorbijganger', 'Voorbijganger'],
  ['onbekend', 'Onbekend'],
] as const;

const KIND_LEVEL: Record<Question['kind'], Level> = { person: 'info', vehicle: 'info', highlight: 'info', noise: 'warn', system: 'bad', household: 'info' };

const ROLE_BUTTONS = [
  ['bewoner', 'Bewoner'],
  ['familie', 'Familie'],
  ['bezoeker', 'Vaste bezoeker'],
  ['buren', 'Buren'],
  ['vaste hulp', 'Vaste hulp'],
  ['bezorger of dienstverlener', 'Bezorger / dienst'],
] as const;

/**
 * Answer form of a household question: a doubt with one-click answers, a vehicle's details or a person's role (since
 * 0.29.0), or whether two entries are one vehicle (since 0.32.0).
 */
function HouseholdAnswer({ q, send }: { q: Question; send: (body: object) => void }) {
  const [text, setText] = useState('');
  const [make, setMake] = useState(q.data.make ?? '');
  const [model, setModel] = useState(q.data.model ?? '');
  const [plate, setPlate] = useState(q.data.plate ?? '');
  if (q.data.type === 'doubt') {
    return (
      <>
        {(q.data.facts?.length ?? 0) > 0 && (
          <ul className="ui-facts">
            {q.data.facts!.map((f) => (
              <li key={f.id}>
                <span className="ui-muted">Feit {f.id}:</span> {f.text}
              </li>
            ))}
          </ul>
        )}
        {(q.data.options?.length ?? 0) > 0 && (
          <div className="ui-segment" role="group" aria-label="Wat klopt?">
            {q.data.options!.map((o, i) => (
              <button key={o.label} className="ui-btn" title={`${o.fact}${o.retire.length ? ` (vervangt feit ${o.retire.join(', ')})` : ''}`} onClick={() => send({ option: i })}>
                {o.label}
              </button>
            ))}
          </div>
        )}
        <div className="ui-inline-form">
          <input placeholder="Of schrijf op wat klopt, bijv. Gideon heeft een witte Ford Focus" maxLength={200} value={text} onChange={(e) => setText(e.target.value)} aria-label="Eigen antwoord" />
          <button className="ui-btn" disabled={text.trim().length < 5} onClick={() => send({ text })}>
            Opslaan
          </button>
        </div>
      </>
    );
  }
  if (q.data.type === 'same') {
    return (
      <>
        {q.data.labels && (
          <ul className="ui-facts">
            {q.data.labels.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        )}
        <div className="ui-segment" role="group" aria-label="Hetzelfde voertuig?">
          <button className="ui-btn" onClick={() => send({ same: true })}>
            Ja, samenvoegen
          </button>
          <button className="ui-btn" onClick={() => send({ same: false })}>
            Nee, twee voertuigen
          </button>
        </div>
      </>
    );
  }
  if (q.data.type === 'role') {
    return (
      <div className="ui-segment" role="group" aria-label="Wie is het?">
        {ROLE_BUTTONS.map(([role, label]) => (
          <button key={role} className="ui-btn" onClick={() => send({ role })}>
            {label}
          </button>
        ))}
      </div>
    );
  }
  const fields = q.data.fields ?? [];
  return (
    <>
      <div className="ui-form-grid">
        {fields.includes('make') && (
          <label className="ui-field">
            <span className="ui-field__label">Merk</span>
            <input placeholder="bijv. Volkswagen" maxLength={40} value={make} onChange={(e) => setMake(e.target.value)} />
          </label>
        )}
        {fields.includes('model') && (
          <label className="ui-field">
            <span className="ui-field__label">Model</span>
            <input placeholder="bijv. up!" maxLength={40} value={model} onChange={(e) => setModel(e.target.value)} />
          </label>
        )}
        <label className="ui-field">
          <span className="ui-field__label">Kenteken{fields.includes('make') ? ' (als je het weet)' : ''}</span>
          <input placeholder="bijv. G-929-VD" maxLength={12} value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} />
        </label>
      </div>
      <div className="ui-actions">
        <button className="ui-btn ui-btn--primary" onClick={() => send(fields.includes('make') ? { make, model, plate } : { plate })}>
          Opslaan
        </button>
      </div>
    </>
  );
}

function Media({ highlight }: { highlight: Question['highlight'] }) {
  const [play, setPlay] = useState(false);
  if (!highlight) return null;
  const id = encodeURIComponent(highlight.id);
  return (
    <div className="ui-question__media">
      {play ? (
        <video src={`/api/highlights/${id}/clip.mp4`} controls autoPlay playsInline />
      ) : (
        <button className="ui-thumb" onClick={() => setPlay(true)} aria-label="Clip afspelen">
          {highlight.hasThumbnail && <img src={`/api/highlights/${id}/thumb.webp`} alt="" />}
          <span className="ui-thumb__play">
            <Icon name="play" size={16} />
          </span>
        </button>
      )}
    </div>
  );
}

/** Highlights of the same visit, ticked by default: one answer names the person on all of them. */
function SameVisit({ items, chosen, onToggle }: { items: NonNullable<Question['sameVisit']>; chosen: Set<string>; onToggle: (id: string) => void }) {
  // One clip at a time plays under the list, large enough to judge (since 0.28.2).
  const [playing, setPlaying] = useState<string | null>(null);
  if (!items.length) return null;
  return (
    <div className="ui-visit">
      <span className="ui-field__label">Zelfde bezoek: geldt het antwoord ook voor deze highlights?</span>
      <ul>
        {items.map((h) => {
          const id = encodeURIComponent(h.id);
          return (
            <li key={h.id} className={`ui-visit__item${chosen.has(h.id) ? ' ui-visit__item--on' : ''}${playing === h.id ? ' ui-visit__item--playing' : ''}`}>
              <input type="checkbox" checked={chosen.has(h.id)} onChange={() => onToggle(h.id)} aria-label={`Ook voor ${highlightTime(h.startTime)}`} />
              <button
                type="button"
                className="ui-thumb ui-visit__thumb"
                onClick={() => setPlaying(playing === h.id ? null : h.id)}
                aria-label={playing === h.id ? 'Clip sluiten' : 'Clip afspelen'}
              >
                <img src={`/api/highlights/${id}/thumb.webp`} alt="" loading="lazy" />
                <span className="ui-thumb__play">
                  <Icon name="play" size={12} />
                </span>
              </button>
              <span className="ui-visit__text" onClick={() => onToggle(h.id)}>
                <strong>{highlightTime(h.startTime)}</strong>
                <span className="ui-muted">{h.description}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {playing && (
        <video key={playing} className="ui-visit__video" src={`/api/highlights/${encodeURIComponent(playing)}/clip.mp4`} controls autoPlay playsInline />
      )}
    </div>
  );
}

/** Face crops Frigate kept but could not recognise; a name plus Bewoner/Bezoeker stores them in Frigate. */
function Faces({ files }: { files: string[] }) {
  if (!files.length) return null;
  return (
    <div className="ui-faces">
      {files.map((f) => (
        <img key={f} src={`/api/admin/faces/train/${encodeURIComponent(f)}`} alt="Gezicht" />
      ))}
    </div>
  );
}

/** Who it probably is and why; a click fills in the name and marks the answer button, the administrator confirms. */
function Suggestions({ items, value, onPick }: { items: NonNullable<Question['suggestions']>; value: string; onPick: (s: NonNullable<Question['suggestions']>[number]) => void }) {
  if (!items.length) return null;
  return (
    <div className="ui-suggest">
      <span className="ui-field__label">Suggestie</span>
      <ul>
        {items.map((s) => (
          <li key={s.name}>
            <button type="button" className={s.name === value ? 'ui-chip ui-chip--on' : 'ui-chip'} onClick={() => onPick(s)}>
              {s.name.split(' ')[0]}
            </button>
            <span className="ui-muted">{s.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One-click names (face library and earlier answers), so the same person always gets the same name. */
function NameChips({ names, value, onPick }: { names: string[]; value: string; onPick: (name: string) => void }) {
  if (!names.length) return null;
  const first = (n: string) => n.split(' ')[0]!;
  // The first name, unless two people share it.
  const label = (n: string) => (names.filter((m) => first(m).toLowerCase() === first(n).toLowerCase()).length > 1 ? n : first(n));
  return (
    <div className="ui-chips">
      {names.map((n) => (
        <button key={n} type="button" className={n === value ? 'ui-chip ui-chip--on' : 'ui-chip'} onClick={() => onPick(n)}>
          {label(n)}
        </button>
      ))}
    </div>
  );
}

/** What an administrator just did with a question. */
interface Handled {
  q: Question;
  text: string;
  /** Position in the list when it was handled. */
  index: number;
}

/**
 * A question answered or skipped in this visit of the tab: a short confirmation in its place, gone by itself after a
 * few seconds. Until 0.33.1 it stayed with 👍/👎 for the highlight; rating is only asked in highlight questions now.
 */
function HandledCard({ handled, onClose }: { handled: Handled; onClose: () => void }) {
  const { q, text } = handled;
  useEffect(() => {
    const timer = setTimeout(onClose, 8000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <section className="ui-card ui-question ui-question--handled ui-question--plain">
      <div className="ui-question__body">
        <div className="ui-question__meta">
          <Pill level="ok">{KIND_LABEL[q.kind]}</Pill>
          <span className="ui-muted">{q.title}</span>
        </div>
        <h3>{text}</h3>
        <div className="ui-question__foot">
          <button className="ui-btn ui-btn--ghost" onClick={onClose}>
            Sluiten
          </button>
        </div>
      </div>
    </section>
  );
}

function QuestionCard({ q, names, onDone }: { q: Question; names: string[]; onDone: (text: string) => void }) {
  const [name, setName] = useState(q.data.guess ?? '');
  const [suggested, setSuggested] = useState<string | null>(null);
  const [owner, setOwner] = useState('');
  const [vehicle, setVehicle] = useState(q.data.vehicle ?? '');
  const [error, setError] = useState<string | null>(null);
  const [also, setAlso] = useState(() => new Set((q.sameVisit ?? []).map((h) => h.id)));
  const toggle = (id: string) =>
    setAlso((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const send = async (path: 'answer' | 'dismiss', body?: object) => {
    setError(null);
    try {
      const res = await api<{ answer?: string | number; also?: number } | undefined>('POST', `/api/admin/questions/${q.id}/${path}`, body);
      const answer = res?.answer;
      const also = res?.also ? ` (ook voor ${res.also} andere ${res.also === 1 ? 'highlight' : 'highlights'})` : '';
      onDone(
        path === 'dismiss'
          ? 'Overgeslagen'
          : typeof answer === 'number'
            ? answer === 1
              ? 'Beantwoord: goede highlight'
              : 'Beantwoord: geen goede highlight'
            : `Beantwoord: ${answer ?? ''}${also}`,
      );
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Frigate's face recognition named the wrong person (since 0.36.0): the name comes off and "Wie is dit?" follows.
  const notRecognised = async (person: string) => {
    if (!q.highlight) return;
    setError(null);
    try {
      await api('POST', `/api/admin/highlights/${encodeURIComponent(q.highlight.id)}/not-recognised`, { name: person });
      onDone(`Gecorrigeerd: niet ${person}. Na een nieuwe beschrijving volgt de vraag "Wie is dit?".`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className={`ui-card ui-question${q.highlight ? '' : ' ui-question--plain'}`}>
      <Media highlight={q.highlight} />
      <div className="ui-question__body">
        <div className="ui-question__meta">
          <Pill level={KIND_LEVEL[q.kind]}>{KIND_LABEL[q.kind]}</Pill>
          <span className="ui-muted">{highlightTime(q.createdAt)}</span>
        </div>
        <h3>{q.title}</h3>
        <p className="ui-question__text">{q.body}</p>

        {q.kind === 'person' && (
          <>
            <Faces files={q.data.faces ?? []} />
            <SameVisit items={q.sameVisit ?? []} chosen={also} onToggle={toggle} />
            <Suggestions
              items={q.suggestions ?? []}
              value={name}
              onPick={(s) => {
                setName(s.name);
                setSuggested(s.category);
              }}
            />
            <label className="ui-field">
              <span className="ui-field__label">Naam (optioneel)</span>
              <input placeholder="bijv. Oma of PostNL" maxLength={60} list="known-faces" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <NameChips names={names} value={name} onPick={setName} />
            {(q.data.faces?.length ?? 0) > 0 && (
              <p className="ui-field__help">Met een naam leert Frigate dit gezicht herkennen, behalve bij Bezorger / dienst, Voorbijganger en Onbekend.</p>
            )}
            <div className="ui-segment" role="group" aria-label="Wie is het?">
              {PERSON_BUTTONS.map(([category, label]) => (
                <button
                  key={category}
                  className={category === suggested && q.suggestions?.some((s) => s.name === name) ? 'ui-btn ui-btn--primary' : 'ui-btn'}
                  onClick={() => void send('answer', { category, name, also: [...also] })}
                >
                  {label}
                </button>
              ))}
            </div>
          </>
        )}

        {q.kind === 'vehicle' && (
          <>
            <div className="ui-form-grid">
              <label className="ui-field">
                <span className="ui-field__label">Omschrijving</span>
                <input maxLength={120} value={vehicle} onChange={(e) => setVehicle(e.target.value)} />
              </label>
              <label className="ui-field">
                <span className="ui-field__label">Van wie?</span>
                <input placeholder="bijv. Tini" maxLength={60} list="known-faces" value={owner} onChange={(e) => setOwner(e.target.value)} />
              </label>
            </div>
            <NameChips names={names} value={owner} onPick={setOwner} />
            <div className="ui-actions">
              <button className="ui-btn ui-btn--primary" onClick={() => void send('answer', { owner, vehicle })}>
                Opslaan als feit voor de AI
              </button>
              <button className="ui-btn" onClick={() => void send('answer', { category: 'onbekend' })}>
                Onbekende {q.data.noun ?? 'auto'}
              </button>
            </div>
          </>
        )}

        {q.kind === 'household' && <HouseholdAnswer q={q} send={(body) => void send('answer', body)} />}

        {q.kind === 'highlight' && (
          <div className="ui-actions">
            <button className="ui-btn" onClick={() => void send('answer', { value: 1 })}>
              👍 Goed
            </button>
            <button className="ui-btn" onClick={() => void send('answer', { value: -1 })}>
              👎 Niet goed
            </button>
          </div>
        )}

        {q.highlight && (q.highlight.recognized ?? []).length > 0 && (
          <p className="ui-muted ui-small">
            Frigate herkende {q.highlight.recognized!.join(' en ')}.{' '}
            {q.highlight.recognized!.map((n) => (
              <button key={n} className="ui-btn ui-btn--small ui-btn--ghost" onClick={() => void notRecognised(n)}>
                Dit is niet {n.split(' ')[0]}
              </button>
            ))}
          </p>
        )}

        <div className="ui-question__foot">
          <button className="ui-btn ui-btn--ghost" onClick={() => void send('dismiss')}>
            {q.kind === 'noise' || q.kind === 'system' ? 'Gezien' : q.kind === 'household' ? 'Weet ik niet' : 'Overslaan'}
          </button>
        </div>
        {error && <Notice>{error}</Notice>}
      </div>
    </section>
  );
}

/** What happened after an answer: fact and face learning. */
function Outcome({ q }: { q: Question }) {
  const parts = [
    q.factStatus === 'done' ? `Feit: ${q.fact}` : q.factStatus === 'pending' ? 'AI schrijft een feit…' : q.factStatus === 'failed' ? 'Feit mislukt' : null,
    q.faceStatus === 'done' ? q.faceResult : q.faceStatus === 'pending' ? 'Gezicht wordt aan Frigate geleerd…' : q.faceStatus === 'failed' ? 'Gezicht leren mislukt' : null,
  ].filter(Boolean);
  return <>{parts.map((p) => <div key={p}>{p}</div>)}</>;
}

/** Questions and suggestions from the system; answers improve highlights and the AI. */
export function QuestionsTab({ onCountChange }: { onCountChange?: (open: number) => void }) {
  const [open, setOpen] = useState<Question[] | null>(null);
  const [handled, setHandled] = useState<Handled[]>([]);
  const [history, setHistory] = useState<Question[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [names, setNames] = useState<string[]>([]);

  // Also after each answer: a newly named person gets a button straight away.
  const load = () => {
    void api<{ names: string[] }>('GET', '/api/admin/faces').then((r) => setNames(r.names), () => {});
    return api<Question[]>('GET', '/api/admin/questions').then((qs) => {
      setOpen(qs);
      onCountChange?.(qs.length);
    }, () => setOpen([]));
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (showHistory) void api<Question[]>('GET', '/api/admin/questions?status=all').then((qs) => setHistory(qs.filter((q) => q.status !== 'open')), () => {});
  }, [showHistory, open]);

  // Handled questions stay where they were (until closed or the tab is left), between the open ones.
  const shown: (Question | { handled: Handled })[] = (open ?? []).filter((q) => !handled.some((h) => h.q.id === q.id));
  for (const h of [...handled].sort((a, b) => a.index - b.index)) shown.splice(Math.min(h.index, shown.length), 0, { handled: h });

  return (
    <>
      <PageHeader
        title="Vragen"
        description={
          <>
            Het systeem vraagt hier wat het nog niet weet. Uit je antwoorden bouwt het de feiten voor de AI op en leert Frigate
            gezichten herkennen. Kies voor een persoon, auto of fiets steeds dezelfde naam (de voornaamknoppen), dan weet het
            systeem wie wie is. Bekende mensen, auto's en fietsen tellen daarna laag mee; een oordeel over een highlight stuurt
            de selectie bij.
          </>
        }
      />
      <datalist id="known-faces">
        {names.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      {!open ? (
        <p className="ui-muted">Laden…</p>
      ) : (
        <div className="ui-stack">
          {shown.length === 0 && (
            <div className="ui-card">
              <Empty>Geen open vragen. Nieuwe vragen verschijnen vanzelf, hooguit een paar tegelijk.</Empty>
            </div>
          )}
          {shown.map((q) => (
            'kind' in q ? (
              <QuestionCard
                key={q.id}
                q={q}
                names={names}
                onDone={(text) => {
                  setHandled((cur) => [...cur, { q, text, index: shown.indexOf(q) }]);
                  void load();
                }}
              />
            ) : (
              <HandledCard key={`handled-${q.handled.q.id}`} handled={q.handled} onClose={() => setHandled((cur) => cur.filter((h) => h !== q.handled))} />
            )
          ))}
          <div>
            <button className="ui-btn ui-btn--ghost" onClick={() => setShowHistory((v) => !v)}>
              {showHistory ? 'Verberg afgehandelde vragen' : 'Toon afgehandelde vragen'}
            </button>
          </div>
          {showHistory && history && (
            <div className="ui-card ui-card--flush">
              <table className="ui-table">
                <thead>
                  <tr>
                    <th>Wanneer</th>
                    <th>Vraag</th>
                    <th>Antwoord</th>
                    <th>Resultaat</th>
                    <th>Door</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((q) => (
                    <tr key={q.id}>
                      <td className="ui-muted ui-nowrap">{q.answeredAt ? highlightTime(q.answeredAt) : ''}</td>
                      <td>{q.title}</td>
                      <td>{q.status === 'answered' ? q.answer : <span className="ui-muted">overgeslagen</span>}</td>
                      <td className="ui-muted">
                        <Outcome q={q} />
                      </td>
                      <td className="ui-muted">{q.answeredBy}</td>
                    </tr>
                  ))}
                  {history.length === 0 && (
                    <tr>
                      <td colSpan={5} className="ui-muted">
                        Nog niets afgehandeld.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </>
  );
}
