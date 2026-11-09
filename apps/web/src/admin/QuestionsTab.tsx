import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { highlightTime } from '../highlights.tsx';

interface Question {
  id: number;
  kind: 'person' | 'vehicle' | 'highlight' | 'noise' | 'system';
  title: string;
  body: string;
  data: { vehicle?: string; faces?: string[]; guess?: string };
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
  vehicle: 'Auto',
  highlight: 'Highlight',
  noise: 'Suggestie',
  system: 'Melding',
};

const PERSON_BUTTONS = [
  ['bewoner', 'Bewoner'],
  ['bezoeker', 'Bezoeker'],
  ['bezorger', 'Bezorger / dienst'],
  ['onbekend', 'Onbekend'],
] as const;

function Media({ highlight }: { highlight: Question['highlight'] }) {
  const [play, setPlay] = useState(false);
  if (!highlight) return null;
  const id = encodeURIComponent(highlight.id);
  return (
    <div className="admin__qmedia">
      {play ? (
        <video src={`/api/highlights/${id}/clip.mp4`} controls autoPlay playsInline />
      ) : (
        <button className="archive__thumb" onClick={() => setPlay(true)} aria-label="Clip afspelen">
          {highlight.hasThumbnail ? <img src={`/api/highlights/${id}/thumb.webp`} alt="" /> : <span>▶</span>}
        </button>
      )}
    </div>
  );
}

/** Face crops Frigate kept but could not recognise; a name plus Bewoner/Bezoeker stores them in Frigate. */
function Faces({ files }: { files: string[] }) {
  if (!files.length) return null;
  return (
    <div className="admin__faces">
      {files.map((f) => (
        <img key={f} src={`/api/admin/faces/train/${encodeURIComponent(f)}`} alt="Gezicht" />
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

  const level = q.kind === 'system' ? 'bad' : q.kind === 'noise' ? 'warn' : 'ok';
  return (
    <section className={`admin__card admin__card--${level} admin__question`}>
      <Media highlight={q.highlight} />
      <div className="admin__qbody">
        <p className="admin__muted">
          {KIND_LABEL[q.kind]} · {highlightTime(q.createdAt)}
        </p>
        <h3>{q.title}</h3>
        <p>{q.body}</p>

        {q.kind === 'person' && (
          <>
            <Faces files={q.data.faces ?? []} />
            <input
              placeholder="Naam (optioneel), bijv. Oma of PostNL"
              maxLength={60}
              list="known-faces"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <datalist id="known-faces">
              {names.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
            {(q.data.faces?.length ?? 0) > 0 && (
              <p className="admin__muted">Met een naam en Bewoner of Bezoeker leert Frigate dit gezicht herkennen.</p>
            )}
            <div className="admin__row">
              {PERSON_BUTTONS.map(([category, label]) => (
                <button key={category} onClick={() => void send('answer', { category, name })}>
                  {label}
                </button>
              ))}
            </div>
          </>
        )}

        {q.kind === 'vehicle' && (
          <>
            <label className="admin__field">
              Omschrijving
              <input maxLength={120} value={vehicle} onChange={(e) => setVehicle(e.target.value)} />
            </label>
            <label className="admin__field">
              Van wie?
              <input placeholder="bijv. Tini" maxLength={60} value={owner} onChange={(e) => setOwner(e.target.value)} />
            </label>
            <div className="admin__row">
              <button onClick={() => void send('answer', { owner, vehicle })}>Opslaan als feit voor de AI</button>
              <button onClick={() => void send('answer', { category: 'onbekend' })}>Onbekende auto</button>
            </div>
          </>
        )}

        {q.kind === 'highlight' && (
          <div className="admin__row">
            <button onClick={() => void send('answer', { value: 1 })}>👍 Goed</button>
            <button onClick={() => void send('answer', { value: -1 })}>👎 Niet goed</button>
          </div>
        )}

        <div className="admin__row">
          <button className="admin__subtle" onClick={() => void send('dismiss')}>
            {q.kind === 'noise' || q.kind === 'system' ? 'Gezien' : 'Overslaan'}
          </button>
        </div>
        {error && <p className="account__error">{error}</p>}
      </div>
    </section>
  );
}

/** Questions and suggestions from the system; answers improve highlights and the AI. */
export function QuestionsTab({ onCountChange }: { onCountChange?: (open: number) => void }) {
  const [open, setOpen] = useState<Question[] | null>(null);
  const [history, setHistory] = useState<Question[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [names, setNames] = useState<string[]>([]);

  const load = () =>
    api<Question[]>('GET', '/api/admin/questions').then((qs) => {
      setOpen(qs);
      onCountChange?.(qs.length);
    }, () => setOpen([]));

  useEffect(() => {
    void load();
    void api<{ names: string[] }>('GET', '/api/admin/faces').then((r) => setNames(r.names), () => {});
  }, []);

  useEffect(() => {
    if (showHistory) void api<Question[]>('GET', '/api/admin/questions?status=all').then((qs) => setHistory(qs.filter((q) => q.status !== 'open')), () => {});
  }, [showHistory, open]);

  if (!open) return <p className="admin__muted">Laden…</p>;

  return (
    <div className="admin__stack">
      <p className="admin__muted">
        Het systeem stelt hier vragen over wat het nog niet weet, en doet suggesties. Uit je antwoorden bouwt het zelf de
        feiten voor de AI op (zie het tabblad AI) en leert Frigate gezichten van bewoners en bezoekers herkennen. Je antwoord
        komt bij de highlight te staan, de AI beschrijft hem opnieuw, en bekende mensen en auto's tellen daarna laag mee. Een
        oordeel over een highlight stuurt de selectie bij. Nieuwe vragen verschijnen vanzelf, hooguit een paar tegelijk.
      </p>
      {open.length === 0 && <p>Geen open vragen. 🎉</p>}
      {open.map((q) => (
        <QuestionCard key={q.id} q={q} names={names} onDone={() => void load()} />
      ))}
      <button className="admin__subtle" onClick={() => setShowHistory((v) => !v)}>
        {showHistory ? 'Verberg afgehandelde vragen' : 'Toon afgehandelde vragen'}
      </button>
      {showHistory && history && (
        <table className="account__table">
          <tbody>
            {history.map((q) => (
              <tr key={q.id}>
                <td className="admin__muted">{q.answeredAt ? highlightTime(q.answeredAt) : ''}</td>
                <td>{q.title}</td>
                <td>{q.status === 'answered' ? q.answer : <span className="admin__muted">overgeslagen</span>}</td>
                <td className="admin__muted">
                  {q.factStatus === 'done' ? `Feit: ${q.fact}` : q.factStatus === 'pending' ? 'AI schrijft een feit…' : q.factStatus === 'failed' ? 'Feit mislukt' : ''}
                  {q.faceStatus === 'done' && <div>{q.faceResult}</div>}
                  {q.faceStatus === 'pending' && <div>Gezicht wordt aan Frigate geleerd…</div>}
                  {q.faceStatus === 'failed' && <div>Gezicht leren mislukt</div>}
                </td>
                <td className="admin__muted">{q.answeredBy}</td>
              </tr>
            ))}
            {history.length === 0 && (
              <tr>
                <td className="admin__muted">Nog niets afgehandeld.</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
