import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Card, Notice, PageHeader, Pill, Stat, type Level } from './ui.tsx';

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
  backup?: { lastAt: number | null; lastFile: string | null; lastBytes: number | null; count: number; lastError: string | null };
}

interface Display {
  id: string;
  profile: string;
  username: string;
  version: string;
  device: string;
  firstSeen: number;
  lastSeen: number;
  camerasLive: number;
  camerasTotal: number;
}

/** A dashboard reports every minute; after three minutes without a report it counts as off. */
const DISPLAY_ONLINE_S = 180;

const PROFILE_NAME: Record<string, string> = { shop: 'Winkel-tv', bedroom: 'Slaapkamer-tv', default: 'Standaardscherm' };

/** Every screen that showed the dashboard in the last 30 days: on or off, version, cameras with a picture (since 0.27.0). */
function Displays({ version }: { version: string | undefined }) {
  const [displays, setDisplays] = useState<Display[] | null>(null);
  const load = () => api<Display[]>('GET', '/api/admin/displays').then(setDisplays, () => setDisplays(null));
  useEffect(() => {
    void load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, []);
  const forget = (d: Display) => {
    if (confirm('Dit scherm uit de lijst halen? Het komt terug zodra het het dashboard weer toont.')) void api('DELETE', `/api/admin/displays/${encodeURIComponent(d.id)}`).then(load, () => {});
  };
  return (
    <Card title="Schermen" icon="monitor" className="ui-span-2">
      {!displays ? (
        <p className="ui-muted">Laden…</p>
      ) : displays.length === 0 ? (
        <p className="ui-muted">Nog geen schermen gemeld. Een dashboard meldt zich binnen een minuut na het openen.</p>
      ) : (
        <ul className="ui-services">
          {displays.map((d) => {
            const online = Date.now() / 1000 - d.lastSeen < DISPLAY_ONLINE_S;
            const outdated = online && version !== undefined && d.version !== version;
            const blind = online && d.camerasTotal > 0 && d.camerasLive < d.camerasTotal;
            return (
              <li key={d.id} className="ui-service">
                <div>
                  <span className="ui-service__name">
                    {PROFILE_NAME[d.profile] ?? d.profile} · {d.device}
                  </span>
                  <span className="ui-service__detail">
                    {d.username || 'onbekend account'} · versie {d.version || '?'}
                    {online ? ` · ${d.camerasLive} / ${d.camerasTotal} camera's met beeld` : ` · laatst gezien ${ago(d.lastSeen)}`}
                    {outdated && <span className="ui-error"> · oude versie, herlaadt na het volgende alert</span>}{' '}
                    <button className="ui-linkbtn" onClick={() => forget(d)}>
                      vergeten
                    </button>
                  </span>
                </div>
                <Pill level={!online ? 'off' : blind || outdated ? 'warn' : 'ok'}>{!online ? 'Uit' : blind ? 'Beeld mist' : 'Aan'}</Pill>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

interface Stats {
  last24h: number;
  last7d: number;
  rotation: number;
}

interface ThresholdSettings {
  threshold: number;
  default: number;
  min: number;
  max: number;
  preview: { threshold: number; last24h: number; perDay7d: number };
  replayMinutes: number;
  replay: { default: number; min: number; max: number };
}

/** The selection threshold (lower gives more highlights) and how often a highlight on the TV plays again. */
function HighlightSettings() {
  const [settings, setSettings] = useState<ThresholdSettings | null>(null);
  const [value, setValue] = useState('');
  const [replay, setReplay] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const load = (probe?: number) =>
    api<ThresholdSettings>('GET', `/api/admin/highlights/settings${probe === undefined ? '' : `?threshold=${probe}`}`).then((s) => {
      setSettings(s);
      if (probe === undefined) {
        setValue(String(s.threshold));
        setReplay(String(s.replayMinutes));
      }
    }, () => {});

  useEffect(() => {
    void load();
  }, []);

  if (!settings) return null;
  const n = Number(value.replace(',', '.'));
  const valid = Number.isFinite(n) && n >= settings.min && n <= settings.max;
  const m = Number(replay);
  const replayValid = Number.isInteger(m) && m >= settings.replay.min && m <= settings.replay.max;
  const changed = n !== settings.threshold || m !== settings.replayMinutes;

  const save = async () => {
    setMessage(null);
    try {
      const res = await api<{ threshold: number; replayMinutes: number }>('PUT', '/api/admin/highlights/settings', {
        threshold: n,
        replayMinutes: m,
      });
      setMessage(`Opgeslagen: drempel ${res.threshold}, opnieuw afspelen elke ${res.replayMinutes} min. De tv past zich binnen twee minuten aan.`);
      void load();
    } catch (err) {
      setMessage((err as Error).message);
    }
  };

  return (
    <Card title="Highlights op de tv" icon="settings" className="ui-span-2">
      <div className="ui-form-grid">
        <label className="ui-field">
          <span className="ui-field__label">Drempel voor een highlight</span>
          <input
            type="number"
            step={0.1}
            min={settings.min}
            max={settings.max}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= settings.min && v <= settings.max) void load(v);
            }}
          />
          <span className="ui-field__help">
            Relevantie {settings.min}–{settings.max}, standaard {settings.default}. Lager geeft meer highlights (ook
            gewone dingen), hoger alleen het meest ongewone.
          </span>
          <span className="ui-field__preview">
            Met {settings.preview.threshold}: <strong>{settings.preview.last24h}</strong> highlights in de afgelopen 24 uur,
            gemiddeld <strong>{settings.preview.perDay7d}</strong> per dag deze week
          </span>
        </label>
        <label className="ui-field">
          <span className="ui-field__label">Opnieuw afspelen elke … minuten</span>
          <input
            type="number"
            step={1}
            min={settings.replay.min}
            max={settings.replay.max}
            value={replay}
            onChange={(e) => setReplay(e.target.value)}
          />
          <span className="ui-field__help">
            {settings.replay.min}–{settings.replay.max} minuten, standaard {settings.replay.default}. Elke highlight speelt één
            keer af en blijft daarna stilstaan op het interessantste moment; na deze tijd speelt het vak opnieuw af, met een highlight die nog niet in
            beeld was als die er is. Een nieuwe highlight verschijnt meteen.
          </span>
        </label>
      </div>
      <div className="ui-actions">
        <button className="ui-btn ui-btn--primary" disabled={!valid || !replayValid || !changed} onClick={() => void save()}>
          Opslaan
        </button>
        {message && <span className="ui-muted">{message}</span>}
      </div>
    </Card>
  );
}

const ago = (epochS: number | null | undefined) => {
  if (!epochS) return 'nog niet';
  const s = Math.max(0, Math.round(Date.now() / 1000 - epochS));
  if (s < 90) return `${s} s geleden`;
  if (s < 5400) return `${Math.round(s / 60)} min geleden`;
  if (s < 172800) return `${Math.round(s / 3600)} uur geleden`;
  return `${Math.round(s / 86400)} dagen geleden`;
};

/** A copy older than a day and a half means the nightly copy failed. */
const backupLevel = (b: Status['backup']): Level => (!b ? 'off' : b.lastError ? 'bad' : b.lastAt && Date.now() / 1000 - b.lastAt < 36 * 3600 ? 'ok' : 'warn');

const cameraLevel = (video: 'ok' | 'failed' | 'unknown'): Level => (video === 'ok' ? 'ok' : video === 'failed' ? 'bad' : 'off');

/** One service in the status list. */
function Service({ name, level, status, detail }: { name: string; level: Level; status: string; detail?: React.ReactNode }) {
  return (
    <li className="ui-service">
      <div>
        <span className="ui-service__name">{name}</span>
        {detail && <span className="ui-service__detail">{detail}</span>}
      </div>
      <Pill level={level}>{status}</Pill>
    </li>
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

  const header = <PageHeader title="Overzicht" description="De gezondheid van De Uitkijk in één oogopslag. Ververst elke 30 seconden." />;
  if (error)
    return (
      <>
        {header}
        <Notice>{error}</Notice>
      </>
    );
  if (!status)
    return (
      <>
        {header}
        <p className="ui-muted">Laden…</p>
      </>
    );

  const failed = status.cameras.filter((c) => c.video === 'failed');
  const unknown = status.cameras.every((c) => c.video === 'unknown');
  const hlAge = status.highlights.lastOkAt ? Date.now() / 1000 - status.highlights.lastOkAt : Infinity;
  const problems =
    (status.streaming.status === 'ok' ? 0 : 1) +
    (status.alerts.status === 'ok' || status.alerts.status === 'mock' ? 0 : 1) +
    failed.length +
    (status.highlights.enabled && hlAge > 900 ? 1 : 0) +
    (status.ai.enabled && status.ai.lastError ? 1 : 0) +
    (backupLevel(status.backup) === 'ok' || backupLevel(status.backup) === 'off' ? 0 : 1);
  const okCameras = status.cameras.filter((c) => c.video === 'ok').length;

  return (
    <>
      {header}
      <div className="ui-stats">
        <Stat
          label="Systeem"
          value={problems === 0 ? 'In orde' : 'Let op'}
          level={problems === 0 ? 'ok' : 'warn'}
          hint={`${problems === 0 ? 'geen aandachtspunten' : `${problems} ${problems === 1 ? 'aandachtspunt' : 'aandachtspunten'}`} · De Uitkijk ${status.version ?? 'onbekend'}`}
        />
        <Stat
          label="Camera's met beeld"
          value={unknown ? '–' : `${okCameras} / ${status.cameras.length}`}
          level={unknown ? undefined : failed.length ? 'bad' : 'ok'}
          hint={failed.length ? `${failed.map((c) => status.cameraNames[c.id] ?? c.id).join(', ')}: geen beeld` : 'alle camera\'s leveren beeld'}
        />
        <Stat
          label="Highlights"
          value={stats ? stats.last24h : '–'}
          hint={stats ? `${stats.last24h} in 24 uur · ${stats.last7d} in 7 dagen · ${stats.rotation} nu op de tv` : undefined}
        />
        <Stat
          label="Gebruikers"
          value={status.users.total}
          hint={`${status.users.admins} beheerder${status.users.admins === 1 ? '' : 's'}${status.users.inactive > 0 ? ` · ${status.users.inactive} niet geactiveerd` : ''}`}
        />
        <Stat
          label="AI vandaag"
          value={status.ai.enabled ? `${status.ai.callsToday} / ${status.ai.dailyCap}` : 'Uit'}
          hint={status.ai.enabled ? `${status.ai.pending} wachtend · ${status.ai.model}` : 'beschrijvingen op regels'}
        />
      </div>

      <div className="ui-grid ui-grid--2">
        <Card title="Diensten" icon="check">
          <ul className="ui-services">
            <Service
              name="Live beeld (go2rtc)"
              level={status.streaming.status === 'ok' ? 'ok' : 'bad'}
              status={status.streaming.status === 'ok' ? 'Bereikbaar' : 'Storing'}
              detail={status.streaming.status === 'ok' ? undefined : status.streaming.detail ?? 'Niet bereikbaar'}
            />
            <Service
              name="Frigate-alarmen"
              level={status.alerts.status === 'ok' ? 'ok' : status.alerts.status === 'mock' ? 'off' : 'warn'}
              status={status.alerts.status === 'ok' ? 'Verbonden' : status.alerts.status === 'mock' ? 'Gesimuleerd' : 'Storing'}
              detail={status.alerts.status === 'ok' || status.alerts.status === 'mock' ? undefined : status.alerts.detail ?? 'Niet beschikbaar'}
            />
            <Service
              name="Highlight-import"
              level={!status.highlights.enabled ? 'off' : hlAge > 900 ? 'warn' : 'ok'}
              status={!status.highlights.enabled ? 'Uit' : hlAge > 900 ? 'Achter' : 'Actief'}
              detail={
                status.highlights.enabled ? (
                  <>
                    Laatste import {ago(status.highlights.lastOkAt)}
                    {status.highlights.lastError && <span className="ui-error"> · {status.highlights.lastError}</span>}
                  </>
                ) : undefined
              }
            />
            <Service
              name="AI-beschrijvingen"
              level={!status.ai.enabled ? 'off' : status.ai.lastError ? 'warn' : 'ok'}
              status={!status.ai.enabled ? 'Uit' : status.ai.lastError ? 'Fout' : 'Actief'}
              detail={
                status.ai.enabled ? (
                  <>
                    Laatste gelukt {ago(status.ai.lastSuccessAt)}
                    {status.ai.lastError && <span className="ui-error"> · {status.ai.lastError}</span>}
                  </>
                ) : undefined
              }
            />
            {status.backup && (
              <Service
                name="Back-up database"
                level={backupLevel(status.backup)}
                status={backupLevel(status.backup) === 'ok' ? 'Actueel' : status.backup.lastError ? 'Fout' : 'Te oud'}
                detail={
                  <>
                    Laatste kopie {ago(status.backup.lastAt)}
                    {status.backup.lastBytes ? ` (${(status.backup.lastBytes / 1e6).toFixed(1)} MB)` : ''} · {status.backup.count} bewaard
                    {status.backup.lastError && <span className="ui-error"> · {status.backup.lastError}</span>}
                  </>
                }
              />
            )}
          </ul>
        </Card>

        <Card title="Camera's" icon="camera">
          {status.cameras.length === 0 ? (
            <p className="ui-muted">Geen beeldcontrole (alleen in live-modus).</p>
          ) : (
            <ul className="ui-services">
              {status.cameras.map((c) => (
                <Service
                  key={c.id}
                  name={status.cameraNames[c.id] ?? c.id}
                  level={cameraLevel(c.video)}
                  status={c.video === 'ok' ? 'Beeld' : c.video === 'failed' ? 'Geen beeld' : 'Onbekend'}
                  detail={`Gecontroleerd ${ago(c.checkedAt)}${c.video === 'failed' && c.detail ? ` · ${c.detail}` : ''}`}
                />
              ))}
            </ul>
          )}
        </Card>

        <Displays version={status.version} />

        {status.highlights.enabled && <HighlightSettings />}

      </div>
    </>
  );
}
