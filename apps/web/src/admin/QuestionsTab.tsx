import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { highlightTime } from '../highlights.tsx';
import { Empty, Icon, Notice, PageHeader, Pill, type Level } from './ui.tsx';

interface Question {
  id: number;
  kind: 'person' | 'vehicle' | 'highlight' | 'noise' | 'system';
  title: string;
  body: string;
  data: { vehicle?: string; noun?: string; faces?: string[]; guess?: string };
  status: 'open' | 'answered' | 'dismissed';
  answer: string | null;
  answeredBy: string | null;
  createdAt: number;
  answeredAt: number | null;
  factStatus: 'pending' | 'done' | 'none' | 'failed' | null;
  fact: string | null;
  faceStatus: 'pending' | 'done' | 'none' | 'failed' | null;
  faceResult: string | null;
  highlight: { id: string; hasThumbnail: boolean } | null;
}

const KIND_LABEL: Record<Question['kind'], string> = {
  person: 'Persoon',
  vehicle: 'Voertuig',
  highlight: 'Highlight',
  noise: 'Suggestie',
  system: 'Melding',
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

const KIND_LEVEL: Record<Question['kind'], Level> = { person: 'info', vehicle: 'info', highlight: 'info', noise: 'warn', system: 'bad' };

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

function QuestionCard({ q, names, onDone }: { q: Question; names: string[]; onDone: () => void }) {
  const [name, setName] = useState(q.data.guess ?? '');
  const [owner, setOwner] = useState('');
  const [vehicle, setVehicle] = useState(q.data.vehicle ?? '');
  const [error, setError] = useState<string | null>(null);

  const send = async (path: 'answer' | 'dismiss', body?: object) => {
    setError(null);
    try {
      await api('POST', `/api/admin/questions/${q.id}/${path}`, body);
      onDone();
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
                <button key={category} className="ui-btn" onClick={() => void send('answer', { category, name })}>
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

        <div className="ui-question__foot">
          <button className="ui-btn ui-btn--ghost" onClick={() => void send('dismiss')}>
            {q.kind === 'noise' || q.kind === 'system' ? 'Gezien' : 'Overslaan'}
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
          {open.length === 0 && (
            <div className="ui-card">
              <Empty>Geen open vragen. Nieuwe vragen verschijnen vanzelf, hooguit een paar tegelijk.</Empty>
            </div>
          )}
          {open.map((q) => (
            <QuestionCard key={q.id} q={q} names={names} onDone={() => void load()} />
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
