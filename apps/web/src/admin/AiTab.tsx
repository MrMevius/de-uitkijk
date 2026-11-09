import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { highlightTime } from '../highlights.tsx';
import { Card, Empty, Icon, Notice, PageHeader, Stat } from './ui.tsx';

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
  const [error, setError] = useState<string | null>(null);

  const loadFacts = () => api<Fact[]>('GET', '/api/admin/facts').then(setFacts, () => setFacts(null));
  useEffect(() => {
    api<AiStatus>('GET', '/api/admin/ai').then(setAi, () => {});
    void loadFacts();
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = (f: Fact) =>
    run(async () => {
      await api('DELETE', `/api/admin/facts/${f.id}`);
      await loadFacts();
    });

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

        {facts && (
          <Card title={`Feiten voor de AI (${facts.length})`} icon="ai">
            <p className="ui-muted">
              Feiten ontstaan vanzelf uit je antwoorden op <a className="ui-link" href="#vragen">Vragen</a>: een antwoord over een
              voertuig wordt direct een feit; bij een persoon schrijft de AI een feit op basis van zichtbare, vaste kenmerken, of
              niets. De AI noemt een naam alleen als het beeld zo'n feit duidelijk laat zien. Feiten gaan bij elke beschrijving
              naar OpenAI (Codex). Klopt een feit niet, verwijder het dan.
            </p>
            {facts.length === 0 ? (
              <Empty>Nog geen feiten. Beantwoord vragen om ze op te bouwen.</Empty>
            ) : (
              <ul className="ui-list">
                {facts.map((f) => (
                  <li key={f.id}>
                    <div className="ui-grow">
                      <div>{f.text}</div>
                      <div className="ui-muted ui-small">{f.createdBy}</div>
                    </div>
                    <button className="ui-btn ui-btn--small ui-btn--danger" onClick={() => void remove(f)}>
                      <Icon name="trash" size={14} />
                      Verwijderen
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
        {error && <Notice>{error}</Notice>}
      </div>
    </>
  );
}
