import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { highlightTime } from '../highlights.tsx';
import { Card, Notice, PageHeader, Stat } from './ui.tsx';

interface AiStatus {
  enabled: boolean;
  model?: string;
  callsToday?: number;
  dailyCap?: number;
  lastSuccessAt?: number | null;
  lastError?: string | null;
  pending?: number;
}

interface Fact {
  id: number;
  text: string;
  createdBy: string;
  createdAt: number;
}

interface LearningPeriod {
  start: string;
  highlights: number;
  persons: { total: number; self: number; answered: number; unknown: number };
  vehicles: { total: number; known: number };
  questions: { asked: number; answered: number };
}

interface LearningStats {
  days: LearningPeriod[];
  weeks: LearningPeriod[];
}

const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '–');

const periodLabel = (start: string, per: 'days' | 'weeks') => {
  const d = new Date(`${start}T12:00:00Z`);
  const text = d.toLocaleDateString('nl-NL', { weekday: per === 'days' ? 'short' : undefined, day: 'numeric', month: 'short', timeZone: 'UTC' });
  return per === 'weeks' ? `week van ${text}` : text;
};

/** Sum of the last `n` periods. */
function total(periods: LearningPeriod[], n: number): LearningPeriod {
  const out: LearningPeriod = { start: '', highlights: 0, persons: { total: 0, self: 0, answered: 0, unknown: 0 }, vehicles: { total: 0, known: 0 }, questions: { asked: 0, answered: 0 } };
  for (const p of periods.slice(0, n)) {
    out.highlights += p.highlights;
    for (const k of ['total', 'self', 'answered', 'unknown'] as const) out.persons[k] += p.persons[k];
    out.vehicles.total += p.vehicles.total;
    out.vehicles.known += p.vehicles.known;
    out.questions.asked += p.questions.asked;
    out.questions.answered += p.questions.answered;
  }
  return out;
}

/** Learning meter (since 0.30.0): what the system recognises without an answer, and how many questions it still needs. */
function Learning() {
  const [stats, setStats] = useState<LearningStats | null>(null);
  const [per, setPer] = useState<'days' | 'weeks'>('days');
  useEffect(() => {
    api<LearningStats>('GET', '/api/admin/learning').then(setStats, () => setStats(null));
  }, []);
  if (!stats) return null;
  const week = total(stats.days, 7);
  const rows = stats[per].filter((p) => p.highlights || p.questions.asked);
  return (
    <Card title="Leert het systeem?" icon="ai">
      <p className="ui-muted">
        Zelf herkend: Frigate herkende het gezicht of de AI noemde iemand uit het register, zonder jouw antwoord. Stijgt dat en daalt het aantal vragen per
        highlight, dan lonen je antwoorden.
      </p>
      <div className="ui-stats">
        <Stat label="Personen zelf herkend" value={pct(week.persons.self, week.persons.total)} hint={`${week.persons.self} van ${week.persons.total}, laatste 7 dagen`} />
        <Stat label="Voertuigen herkend" value={pct(week.vehicles.known, week.vehicles.total)} hint={`${week.vehicles.known} van ${week.vehicles.total}, laatste 7 dagen`} />
        <Stat
          label="Vragen per highlight"
          value={week.highlights ? (week.questions.asked / week.highlights).toFixed(1) : '–'}
          hint={`${week.questions.asked} vragen bij ${week.highlights} highlights`}
        />
      </div>
      <div className="ui-segment" role="group" aria-label="Periode">
        <button className={`ui-btn${per === 'days' ? '' : ' ui-btn--ghost'}`} onClick={() => setPer('days')}>
          Per dag
        </button>
        <button className={`ui-btn${per === 'weeks' ? '' : ' ui-btn--ghost'}`} onClick={() => setPer('weeks')}>
          Per week
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="ui-muted">Nog geen gegevens.</p>
      ) : (
        <table className="ui-table">
          <thead>
            <tr>
              <th>Periode</th>
              <th className="ui-right">Highlights</th>
              <th className="ui-right">Personen zelf / via jou / onbekend</th>
              <th className="ui-right">Voertuigen herkend</th>
              <th className="ui-right">Vragen (beantwoord)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.start}>
                <td>{periodLabel(p.start, per)}</td>
                <td className="ui-right">{p.highlights}</td>
                <td className="ui-right">
                  {p.persons.self} / {p.persons.answered} / {p.persons.unknown} ({pct(p.persons.self, p.persons.total)})
                </td>
                <td className="ui-right">
                  {p.vehicles.known} van {p.vehicles.total} ({pct(p.vehicles.known, p.vehicles.total)})
                </td>
                <td className="ui-right">
                  {p.questions.asked} ({p.questions.answered})
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/** AI status and the household facts the AI may use. */
export function AiTab() {
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [facts, setFacts] = useState<Fact[] | null>(null);

  const loadFacts = () => api<Fact[]>('GET', '/api/admin/facts').then(setFacts, () => setFacts(null));
  useEffect(() => {
    api<AiStatus>('GET', '/api/admin/ai').then(setAi, () => {});
    void loadFacts();
  }, []);

  return (
    <>
      <PageHeader title="AI" description="Beschrijvingen van highlights door Codex, en de feiten die de AI daarbij mag gebruiken." />
      <div className="ui-stack">
        {!ai ? (
          <p className="ui-muted">Laden…</p>
        ) : ai.enabled ? (
          <div className="ui-stats">
            <Stat label="Vandaag" value={`${ai.callsToday} / ${ai.dailyCap}`} hint="beschrijvingen van het dagmaximum" />
            <Stat label="Wachtend" value={ai.pending ?? 0} hint="highlights in de wachtrij" />
            <Stat label="Laatste gelukt" value={ai.lastSuccessAt ? highlightTime(ai.lastSuccessAt) : 'nog niet'} level={ai.lastError ? 'warn' : 'ok'} hint={ai.lastError ? 'met een fout daarna' : 'zonder fouten'} />
            <Stat label="Model" value={ai.model} hint="Codex met je ChatGPT-login" />
          </div>
        ) : (
          <Card title="AI-beschrijvingen" icon="ai" level={{ level: 'off', text: 'Uit' }}>
            <p>Uit. Beschrijvingen zijn op regels gebaseerd.</p>
          </Card>
        )}
        {ai?.lastError && <Notice level="warn">Laatste fout: {ai.lastError}</Notice>}
        {ai?.enabled && (
          <p className="ui-muted">
            Wat de AI precies kreeg en antwoordde, staat per aanroep in de <a className="ui-link" href="#ai-log">AI-log</a>.
          </p>
        )}

        <Learning />

        {facts && (
          <Card title={`Feiten voor de AI (${facts.length})`} icon="ai">
            <p className="ui-muted">
              De feiten ontstaan uit je antwoorden op <a className="ui-link" href="#vragen">Vragen</a> en worden gebundeld in{' '}
              <a className="ui-link" href="#huishouden">Huishouden</a>: wie is wie en welk voertuig van wie is. Daar zie, verbeter en verwijder je ze.
              De AI krijgt het register, plus de feiten die nog niet in het register staan; feiten over een auto zonder merk of kenteken laat hij weg.
            </p>
          </Card>
        )}
      </div>
    </>
  );
}
