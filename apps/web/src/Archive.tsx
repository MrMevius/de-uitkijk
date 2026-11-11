import { useCallback, useEffect, useState } from 'react';
import type { Camera, DashboardState, HighlightSummary } from '@uitkijk/shared';
import { highlightTime } from './highlights.tsx';
import { Empty, Icon, Notice, PageHeader, Pill } from './admin/ui.tsx';

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
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [camera, setCamera] = useState('');
  const [high, setHigh] = useState(false);
  const [unrated, setUnrated] = useState(false);
  const [text, setText] = useState('');
  // Searched a moment after typing stops, not on every key.
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearch(text.trim()), 350);
    return () => clearTimeout(timer);
  }, [text]);
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
      // A period of whole days; one date alone is that day (from) or everything until that day (to).
      if (from) p.set('from', String(dayRange(from)[0]));
      if (to || from) p.set('to', String(dayRange(to || from)[1]));
      if (camera) p.set('camera', camera);
      if (high) p.set('minScore', String(HIGH_RELEVANCE));
      if (unrated) p.set('unrated', '1');
      if (search) p.set('q', search);
      return fetch(`/api/highlights?${p}`).then(async (r) => {
        if (!r.ok) throw new Error(`Fout ${r.status}`);
        return (await r.json()) as { items: HighlightSummary[]; total: number };
      });
    },
    [from, to, camera, high, unrated, search],
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
      // Under "Nog niet beoordeeld" the item stays until the next search, so a mis-tap can be undone.
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
    <div className={embedded ? 'archive' : 'archive archive--page'}>
      {embedded ? (
        <PageHeader title="Highlights" description="Alle highlights van de afgelopen tijd, ook die niet meer op de tv staan." />
      ) : (
        <PageHeader
          title="Highlights"
          description={
            <>
              <a className="ui-link" href="/">Dashboard</a> · <a className="ui-link" href="/beheer">{role === 'admin' ? 'Beheer' : 'Mijn account'}</a>
            </>
          }
        />
      )}
      <div className="ui-toolbar">
        <input
          type="search"
          className="ui-toolbar__search"
          placeholder="Zoek op wie of wat, bijv. Tineke, pakket, Peugeot of G-929-VD"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Zoeken"
        />
        <label className="ui-toolbar__date">
          van <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Vanaf datum" />
        </label>
        <label className="ui-toolbar__date">
          tot en met <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="Tot en met datum" />
        </label>
        <select value={camera} onChange={(e) => setCamera(e.target.value)} aria-label="Camera">
          <option value="">Alle camera's</option>
          {cameras.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <label className="ui-check">
          <input type="checkbox" checked={high} onChange={(e) => setHigh(e.target.checked)} /> Alleen hoge relevantie
        </label>
        {role === 'admin' && (
          <label className="ui-check" title="Highlights zonder 👍 of 👎: elk oordeel leert de selectie wat je wilt zien">
            <input type="checkbox" checked={unrated} onChange={(e) => setUnrated(e.target.checked)} /> Nog niet beoordeeld
          </label>
        )}
        <span className="ui-toolbar__count">{total === 0 ? '' : `${total} highlight${total === 1 ? '' : 's'}`}</span>
      </div>
      {error && <Notice>{error}</Notice>}
      {total === 0 && items.length === 0 && (
        <div className="ui-card">
          <Empty>{search ? `Niets gevonden voor "${search}".` : 'Geen highlights gevonden.'}</Empty>
        </div>
      )}
      <ul className="archive__list">
        {items.map((h) => (
          <li key={h.id} className="ui-card archive__item">
            {open === h.id ? (
              <video className="archive__video" src={`/api/highlights/${encodeURIComponent(h.id)}/clip.mp4`} controls autoPlay playsInline />
            ) : (
              <button className="ui-thumb" onClick={() => setOpen(h.id)} aria-label="Afspelen">
                {h.hasThumbnail && <img src={`/api/highlights/${encodeURIComponent(h.id)}/thumb.webp`} alt="" loading="lazy" />}
                <span className="ui-thumb__play">
                  <Icon name="play" size={16} />
                </span>
              </button>
            )}
            <div className="archive__meta">
              <div className="archive__title">
                <strong>{h.description}</strong>
              </div>
              <div className="archive__sub">
                {highlightTime(h.startTime)} · {h.cameras.map(nameOf).join(', ')}
              </div>
              <div className="archive__tags">
                <Pill level={h.score >= HIGH_RELEVANCE ? 'info' : 'off'}>relevantie {h.score.toFixed(1)}</Pill>
                {h.aiDescribed && <Pill level="info">AI</Pill>}
                {h.annotation && <Pill level="ok">Volgens beheer: {h.annotation}</Pill>}
                {h.aiNoise && <Pill level="warn">Volgens de AI geen echte gebeurtenis; niet op de tv</Pill>}
              </div>
              <div className="archive__actions">
                <a className="ui-btn ui-btn--small" href={`/api/highlights/${encodeURIComponent(h.id)}/clip.mp4?download=1`}>
                  <Icon name="download" size={14} />
                  Clip downloaden
                </a>
                <a className="ui-btn ui-btn--small" href={`/api/highlights/${encodeURIComponent(h.id)}/event.mp4?download=1`}>
                  <Icon name="download" size={14} />
                  Hele gebeurtenis
                </a>
                {role === 'admin' && (
                  <>
                    <span className="archive__sep" />
                    <button className={h.feedback === 1 ? 'ui-btn ui-btn--small ui-btn--on' : 'ui-btn ui-btn--small'} onClick={() => feedback(h, 1)} title="Goede keuze">
                      👍
                    </button>
                    <button className={h.feedback === -1 ? 'ui-btn ui-btn--small ui-btn--on' : 'ui-btn ui-btn--small'} onClick={() => feedback(h, -1)} title="Geen goede keuze">
                      👎
                    </button>
                    <button className="ui-btn ui-btn--small ui-btn--danger" onClick={() => remove(h)}>
                      <Icon name="trash" size={14} />
                      Verwijderen
                    </button>
                  </>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {items.length < total && (
        <div className="ui-center">
          <button className="ui-btn" onClick={() => void more()}>
            Meer laden
          </button>
        </div>
      )}
    </div>
  );
}
