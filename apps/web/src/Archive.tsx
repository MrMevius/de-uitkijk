import { useCallback, useEffect, useState } from 'react';
import type { Camera, DashboardState, HighlightSummary } from '@uitkijk/shared';
import { highlightTime } from './highlights.tsx';

const PAGE = 30;
const HIGH_RELEVANCE = 3;

/** Start and end (epoch seconds) of a calendar day in Europe/Amsterdam, from `yyyy-mm-dd`. */
function dayRange(date: string): [number, number] {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  // Find the UTC instant of local midnight by correcting with the zone offset at noon that day.
  const noon = Date.UTC(y, m - 1, d, 12);
  const local = new Date(new Date(noon).toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' })).getTime();
  const offset = local - new Date(new Date(noon).toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
  const start = (Date.UTC(y, m - 1, d) - offset) / 1000;
  return [start, start + 86400];
}

/** The /archief page: the archive with its own header. */
export function ArchivePage() {
  return <ArchiveView />;
}

/**
 * Archive of highlights with filters; administrators give feedback and delete.
 * `embedded` drops the page header so the admin page can show it in a tab.
 */
export function ArchiveView({ embedded = false }: { embedded?: boolean }) {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [role, setRole] = useState<'admin' | 'viewer' | null>(null);
  const [date, setDate] = useState('');
  const [camera, setCamera] = useState('');
  const [high, setHigh] = useState(false);
  const [items, setItems] = useState<HighlightSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/me').then(async (r) => {
      if (r.status === 401) return location.replace('/login?next=/archief');
      if (r.ok) setRole(((await r.json()) as { role: 'admin' | 'viewer' }).role);
    }, () => {});
    fetch('/api/state').then(async (r) => r.ok && setCameras(((await r.json()) as DashboardState).cameras), () => {});
  }, []);

  const query = useCallback(
    (offset: number) => {
      const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (date) {
        const [from, to] = dayRange(date);
        p.set('from', String(from));
        p.set('to', String(to));
      }
      if (camera) p.set('camera', camera);
      if (high) p.set('minScore', String(HIGH_RELEVANCE));
      return fetch(`/api/highlights?${p}`).then(async (r) => {
        if (!r.ok) throw new Error(`Fout ${r.status}`);
        return (await r.json()) as { items: HighlightSummary[]; total: number };
      });
    },
    [date, camera, high],
  );

  useEffect(() => {
    setError(null);
    query(0).then(
      (res) => {
        setItems(res.items);
        setTotal(res.total);
      },
      (err: Error) => setError(err.message),
    );
  }, [query]);

  const more = () => query(items.length).then((res) => setItems((cur) => [...cur, ...res.items]), (err: Error) => setError(err.message));

  const send = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Fout ${res.status}`);
  };

  const feedback = (h: HighlightSummary, value: 1 | -1) => {
    const next = h.feedback === value ? null : value;
    send('POST', `/api/admin/highlights/${encodeURIComponent(h.id)}/feedback`, { value: next }).then(
      () => setItems((cur) => cur.map((i) => (i.id === h.id ? { ...i, feedback: next } : i))),
      (err: Error) => setError(err.message),
    );
  };

  const remove = (h: HighlightSummary) => {
    if (!confirm('Deze highlight verwijderen? Hij komt niet terug.')) return;
    send('DELETE', `/api/admin/highlights/${encodeURIComponent(h.id)}`).then(
      () => {
        setItems((cur) => cur.filter((i) => i.id !== h.id));
        setTotal((t) => t - 1);
      },
      (err: Error) => setError(err.message),
    );
  };

  const nameOf = (id: string) => cameras.find((c) => c.id === id)?.name ?? id;

  return (
    <div className={embedded ? 'archive' : 'account archive'}>
      {!embedded && (
        <>
          <h1>De Uitkijk</h1>
          <h2>Highlights</h2>
          <p>
            <a href="/">Dashboard</a> · <a href="/beheer">{role === 'admin' ? 'Beheer' : 'Mijn account'}</a>
          </p>
        </>
      )}
      <div className="archive__filters">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Datum" />
        <select value={camera} onChange={(e) => setCamera(e.target.value)} aria-label="Camera">
          <option value="">Alle camera's</option>
          {cameras.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <label className="archive__check">
          <input type="checkbox" checked={high} onChange={(e) => setHigh(e.target.checked)} /> Alleen hoge relevantie
        </label>
      </div>
      {error && <p className="account__error">{error}</p>}
      <p className="archive__count">{total === 0 ? 'Geen highlights gevonden.' : `${total} highlight${total === 1 ? '' : 's'}`}</p>
      <ul className="archive__list">
        {items.map((h) => (
          <li key={h.id} className="archive__item">
            {open === h.id ? (
              <video
                className="archive__video"
                src={`/api/highlights/${encodeURIComponent(h.id)}/clip.mp4`}
                controls
                autoPlay
                playsInline
              />
            ) : (
              <button className="archive__thumb" onClick={() => setOpen(h.id)} aria-label="Afspelen">
                {h.hasThumbnail ? <img src={`/api/highlights/${encodeURIComponent(h.id)}/thumb.webp`} alt="" loading="lazy" /> : <span>▶</span>}
              </button>
            )}
            <div className="archive__meta">
              <strong>
                {h.description}
                {h.aiDescribed && <span className="archive__tag">AI</span>}
              </strong>
              {h.annotation && <span className="archive__annotation">Volgens beheer: {h.annotation}</span>}
              {h.aiNoise && <span className="archive__noise">Volgens de AI geen echte gebeurtenis; niet in de rotatie op de tv.</span>}
              <span>
                {highlightTime(h.startTime)} · {h.cameras.map(nameOf).join(', ')} · relevantie {h.score.toFixed(1)}
              </span>
              <span className="archive__actions">
                <a href={`/api/highlights/${encodeURIComponent(h.id)}/clip.mp4?download=1`}>Clip downloaden</a>
                <a href={`/api/highlights/${encodeURIComponent(h.id)}/event.mp4?download=1`}>Hele gebeurtenis</a>
                {role === 'admin' && (
                  <>
                    <button className={h.feedback === 1 ? 'is-on' : ''} onClick={() => feedback(h, 1)} title="Goede keuze">
                      👍
                    </button>
                    <button className={h.feedback === -1 ? 'is-on' : ''} onClick={() => feedback(h, -1)} title="Geen goede keuze">
                      👎
                    </button>
                    <button onClick={() => remove(h)}>Verwijderen</button>
                  </>
                )}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {items.length < total && <button onClick={() => void more()}>Meer laden</button>}
    </div>
  );
}
