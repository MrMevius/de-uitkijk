import { useEffect, useState } from 'react';
import { api } from '../api.ts';

interface Status {
  mode: string;
  version?: string;
  alerts: { status: string; lastOk?: number; detail?: string };
  streaming: { status: string; lastOk?: number; detail?: string };
  cameraNames: Record<string, string>;
  cameras: { id: string; video: 'ok' | 'failed' | 'unknown'; checkedAt: number | null; detail?: string }[];
  highlights: { enabled: boolean; lastOkAt?: number | null; lastError?: string | null };
  ai: { enabled: boolean; model?: string; callsToday?: number; dailyCap?: number; lastSuccessAt?: number | null; lastError?: string | null; pending?: number };
  users: { total: number; admins: number; inactive: number };
}

interface Stats {
  last24h: number;
  last7d: number;
  rotation: number;
}

type Level = 'ok' | 'warn' | 'bad' | 'off';

const ago = (epochS: number | null | undefined) => {
  if (!epochS) return 'nog niet';
  const s = Math.max(0, Math.round(Date.now() / 1000 - epochS));
  if (s < 90) return `${s} s geleden`;
  if (s < 5400) return `${Math.round(s / 60)} min geleden`;
  if (s < 172800) return `${Math.round(s / 3600)} uur geleden`;
  return `${Math.round(s / 86400)} dagen geleden`;
};

function Card({ title, level, children }: { title: string; level: Level; children: React.ReactNode }) {
  return (
    <section className={`admin__card admin__card--${level}`}>
      <h3>
        <span className={`admin__dot admin__dot--${level}`} />
        {title}
      </h3>
      {children}
    </section>
  );
}

/** System health at a glance; refreshes every 30 seconds. */
export function OverviewTab() {
  const [status, setStatus] = useState<Status | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () => {
      api<Status>('GET', '/api/admin/status').then(
        (s) => {
          setStatus(s);
          setError(null);
        },
        (err) => setError((err as Error).message),
      );
      api<Stats>('GET', '/api/admin/highlights/stats').then(setStats, () => setStats(null));
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, []);

  if (error) return <p className="account__error">{error}</p>;
  if (!status) return <p className="account__note">Laden…</p>;

  const failed = status.cameras.filter((c) => c.video === 'failed');
  const unknown = status.cameras.every((c) => c.video === 'unknown');
  const aiLevel: Level = !status.ai.enabled ? 'off' : status.ai.lastError ? 'warn' : 'ok';
  const hlAge = status.highlights.lastOkAt ? Date.now() / 1000 - status.highlights.lastOkAt : Infinity;

  return (
    <div className="admin__grid">
      <Card title="Live beeld (go2rtc)" level={status.streaming.status === 'ok' ? 'ok' : 'bad'}>
        <p>{status.streaming.status === 'ok' ? 'Bereikbaar' : status.streaming.detail ?? 'Niet bereikbaar'}</p>
      </Card>
      <Card title="Camera's" level={unknown ? 'off' : failed.length ? 'bad' : 'ok'}>
        {status.cameras.length === 0 && <p className="admin__muted">Geen beeldcontrole (alleen in live-modus).</p>}
        <ul className="admin__list">
          {status.cameras.map((c) => (
            <li key={c.id}>
              <span className={`admin__dot admin__dot--${c.video === 'ok' ? 'ok' : c.video === 'failed' ? 'bad' : 'off'}`} />
              {status.cameraNames[c.id] ?? c.id}
              <span className="admin__muted"> · {c.video === 'ok' ? 'beeld' : c.video === 'failed' ? 'geen beeld' : 'nog niet gecontroleerd'} · {ago(c.checkedAt)}</span>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Frigate-alarmen" level={status.alerts.status === 'ok' ? 'ok' : status.alerts.status === 'mock' ? 'off' : 'warn'}>
        <p>{status.alerts.status === 'ok' ? 'Verbonden' : status.alerts.status === 'mock' ? 'Gesimuleerd (ontwikkelmodus)' : status.alerts.detail ?? 'Niet beschikbaar'}</p>
      </Card>
      <Card title="Highlights" level={!status.highlights.enabled ? 'off' : hlAge > 900 ? 'warn' : 'ok'}>
        <p>
          Laatste import: {ago(status.highlights.lastOkAt)}
          {status.highlights.lastError && <span className="account__error"> · {status.highlights.lastError}</span>}
        </p>
        {stats && (
          <p className="admin__muted">
            {stats.last24h} in 24 uur · {stats.last7d} in 7 dagen · {stats.rotation} nu op de tv
          </p>
        )}
      </Card>
      <Card title="AI-beschrijvingen" level={aiLevel}>
        {status.ai.enabled ? (
          <>
            <p>
              {status.ai.model} · vandaag {status.ai.callsToday} van max. {status.ai.dailyCap} · wachtend: {status.ai.pending}
            </p>
            <p className="admin__muted">Laatste gelukt: {ago(status.ai.lastSuccessAt)}</p>
            {status.ai.lastError && <p className="account__error">{status.ai.lastError}</p>}
          </>
        ) : (
          <p>Uit</p>
        )}
      </Card>
      <Card title="Gebruikers" level="ok">
        <p>
          {status.users.total} gebruiker{status.users.total === 1 ? '' : 's'} · {status.users.admins} beheerder{status.users.admins === 1 ? '' : 's'}
          {status.users.inactive > 0 && ` · ${status.users.inactive} nog niet geactiveerd`}
        </p>
      </Card>
      <Card title="Versie" level="ok">
        <p>
          De Uitkijk {status.version ?? 'onbekend'} · {status.mode === 'live' ? 'live' : status.mode}
        </p>
      </Card>
    </div>
  );
}
