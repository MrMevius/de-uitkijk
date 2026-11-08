import { useEffect, useState } from 'react';
import { api } from '../api.ts';

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

const when = (epochS: number | null | undefined) =>
  epochS ? new Date(epochS * 1000).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam', dateStyle: 'short', timeStyle: 'short' }) : 'nog niet';

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
    <div className="admin__stack">
      <section className={`admin__card admin__card--${!ai?.enabled ? 'off' : ai.lastError ? 'warn' : 'ok'}`}>
        <h3>AI-beschrijvingen</h3>
        {!ai ? (
          <p className="admin__muted">Laden…</p>
        ) : ai.enabled ? (
          <dl className="admin__facts">
            <dt>Aanbieder</dt>
            <dd>Codex met je ChatGPT-login</dd>
            <dt>Model</dt>
            <dd>{ai.model}</dd>
            <dt>Vandaag</dt>
            <dd>
              {ai.callsToday} van max. {ai.dailyCap} beschrijvingen
            </dd>
            <dt>Wachtend</dt>
            <dd>{ai.pending}</dd>
            <dt>Laatste gelukt</dt>
            <dd>{when(ai.lastSuccessAt)}</dd>
            {ai.lastError && (
              <>
                <dt>Laatste fout</dt>
                <dd className="account__error">{ai.lastError}</dd>
              </>
            )}
          </dl>
        ) : (
          <p>Uit. Beschrijvingen zijn op regels gebaseerd.</p>
        )}
      </section>

      {facts && (
        <section className="admin__card admin__card--ok">
          <h3>Feiten voor de AI ({facts.length})</h3>
          <p className="admin__muted">
            De feiten ontstaan vanzelf uit je antwoorden op het tabblad <a href="#vragen">Vragen</a>: een antwoord over een
            auto wordt direct een feit; bij een antwoord over een persoon schrijft de AI een feit op basis van zichtbare, vaste
            kenmerken (auto, bus, logo, uniform), of niets als er niets bruikbaars te zien is. De AI noemt een naam alleen als
            het beeld zo'n feit duidelijk laat zien. Feiten gaan bij elke beschrijving naar OpenAI (Codex). Klopt een feit
            niet, verwijder het dan.
          </p>
          <ul className="admin__factlist">
            {facts.map((f) => (
              <li key={f.id}>
                <span className="admin__grow">{f.text}</span>
                <span className="admin__muted">{f.createdBy}</span>
                <button onClick={() => void remove(f)}>Verwijderen</button>
              </li>
            ))}
            {facts.length === 0 && <li className="admin__muted">Nog geen feiten. Beantwoord vragen om ze op te bouwen.</li>}
          </ul>
        </section>
      )}
      {error && <p className="account__error">{error}</p>}
    </div>
  );
}
