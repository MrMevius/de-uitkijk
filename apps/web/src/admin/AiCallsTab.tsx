import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { highlightTime } from '../highlights.tsx';
import { Empty, Notice, PageHeader, Pill } from './ui.tsx';

type Purpose = 'beschrijving' | 'feit' | 'huishouden';

interface AiCall {
  id: number;
  at: number;
  purpose: Purpose;
  model: string | null;
  effort: string;
  prompt: string;
  schema: string;
  answer: string | null;
  error: string | null;
  durationMs: number;
  hasImage: boolean;
}

const PURPOSES: [Purpose | '', string][] = [
  ['', 'Alles'],
  ['beschrijving', 'Beschrijvingen'],
  ['feit', 'Feiten'],
  ['huishouden', 'Huishouden'],
];

const PURPOSE_LABEL: Record<Purpose, string> = { beschrijving: 'Beschrijving', feit: 'Feit', huishouden: 'Huishouden' };

/** The answer as indented JSON when it is JSON, else as it came. */
function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** The answer's main line for the collapsed view. */
function summary(c: AiCall): string {
  if (c.error) return c.error;
  try {
    const json = JSON.parse(c.answer ?? '') as Record<string, unknown>;
    const main = json.description ?? json.fact ?? (Array.isArray(json.questions) ? `${(json.questions as unknown[]).length} vragen, ${(json.vehicles as unknown[] | undefined)?.length ?? 0} voertuigen` : null);
    return typeof main === 'string' ? main : JSON.stringify(json).slice(0, 160);
  } catch {
    return (c.answer ?? '').slice(0, 160);
  }
}

function CallCard({ c }: { c: AiCall }) {
  return (
    <details className="ui-card ui-aicall">
      <summary className="ui-aicall__summary">
        <span className="ui-aicall__meta">
          <Pill level={c.error ? 'bad' : 'info'}>{PURPOSE_LABEL[c.purpose]}</Pill>
          <span className="ui-muted">
            {highlightTime(c.at)} · {(c.durationMs / 1000).toFixed(1)} s
          </span>
        </span>
        <span className="ui-aicall__line">{summary(c)}</span>
      </summary>
      <div className="ui-aicall__body">
        {c.hasImage && <img className="ui-aicall__image" src={`/api/admin/ai/calls/${c.id}/image.webp`} alt="Beeld dat de AI kreeg" loading="lazy" />}
        <p className="ui-muted">
          Model {c.model ?? 'standaard'}, redeneren {c.effort}
          {c.hasImage ? ', met het beeld hierboven (verkleind)' : ', zonder beeld'}.
        </p>
        <h4>Vraag aan de AI</h4>
        <pre className="ui-pre">{c.prompt}</pre>
        <h4>{c.error ? 'Fout' : 'Antwoord van de AI'}</h4>
        <pre className="ui-pre">{c.error ?? pretty(c.answer ?? '')}</pre>
        <details>
          <summary className="ui-muted">Verplicht antwoordformaat (JSON-schema)</summary>
          <pre className="ui-pre">{pretty(c.schema)}</pre>
        </details>
      </div>
    </details>
  );
}

/** Beheer → AI-log: every AI call of the last 14 days with prompt, image and raw answer. */
export function AiCallsTab() {
  const [purpose, setPurpose] = useState<Purpose | ''>('');
  const [calls, setCalls] = useState<AiCall[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = (before?: number) => {
    const query = new URLSearchParams({ ...(purpose ? { purpose } : {}), ...(before ? { before: String(before) } : {}) });
    api<AiCall[]>('GET', `/api/admin/ai/calls?${query}`).then(
      (page) => {
        setCalls((prev) => (before && prev ? [...prev, ...page] : page));
        setMore(page.length === 30);
        setError(null);
      },
      (err: Error) => setError(err.message),
    );
  };

  useEffect(() => {
    setCalls(null);
    load();
  }, [purpose]);

  return (
    <>
      <PageHeader
        title="AI-log"
        description="Gedetailleerd logboek van elke AI-aanroep van de afgelopen 14 dagen: het beeld, de letterlijke prompt en het ruwe antwoord. Klik op een regel voor de details."
      />
      <div className="ui-stack">
        <div className="ui-chips" role="group" aria-label="Soort">
          {PURPOSES.map(([value, label]) => (
            <button key={label} type="button" className={value === purpose ? 'ui-chip ui-chip--on' : 'ui-chip'} onClick={() => setPurpose(value)}>
              {label}
            </button>
          ))}
        </div>
        {error && <Notice>{error}</Notice>}
        {!calls ? (
          <p className="ui-muted">Laden…</p>
        ) : calls.length === 0 ? (
          <div className="ui-card">
            <Empty>Nog geen AI-aanroepen gelogd. Het logboek loopt vanaf versie 0.23.0.</Empty>
          </div>
        ) : (
          calls.map((c) => <CallCard key={c.id} c={c} />)
        )}
        {more && calls && (
          <div>
            <button className="ui-btn ui-btn--ghost" onClick={() => load(calls.at(-1)!.id)}>
              Oudere aanroepen
            </button>
          </div>
        )}
      </div>
    </>
  );
}
