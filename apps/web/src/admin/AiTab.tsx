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

        {facts && (
          <Card title={`Feiten voor de AI (${facts.length})`} icon="ai">
            <p className="ui-muted">
              De feiten ontstaan uit je antwoorden op <a className="ui-link" href="#vragen">Vragen</a> en worden gebundeld in{' '}
              <a className="ui-link" href="#huishouden">Huishouden</a>: wie is wie en welk voertuig van wie is. Daar zie, verbeter en verwijder je ze.
            </p>
          </Card>
        )}
      </div>
    </>
  );
}
