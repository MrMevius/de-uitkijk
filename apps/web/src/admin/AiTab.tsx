import { useEffect, useState, type FormEvent } from 'react';
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
  const [text, setText] = useState('');
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

  const add = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('POST', '/api/admin/facts', { text });
      setText('');
      await loadFacts();
    });
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
          <h3>Feiten voor de AI</h3>
          <p className="admin__muted">
            Korte feiten die de AI mag gebruiken, bijvoorbeeld "Rode Tesla Model 3 met kenteken XX-123-Y is van Jasper". De AI
            noemt een naam alleen als het beeld het feit duidelijk laat zien (leesbaar kenteken, precies dezelfde auto) of als
            Frigate het gezicht herkende. Merk, model en kleur werken het best; kentekens zijn alleen dichtbij leesbaar. Deze
            feiten gaan bij elke beschrijving naar OpenAI (Codex). Ze gelden voor nieuwe beschrijvingen.
          </p>
          <ul className="admin__factlist">
            {facts.map((f) => (
              <li key={f.id}>
                <span className="admin__grow">{f.text}</span>
                <span className="admin__muted">{f.createdBy}</span>
                <button onClick={() => void remove(f)}>Verwijderen</button>
              </li>
            ))}
            {facts.length === 0 && <li className="admin__muted">Nog geen feiten.</li>}
          </ul>
          <form className="admin__row" onSubmit={add}>
            <input
              className="admin__grow"
              placeholder="Nieuw feit, bijv. Blauwe VW up! is van Tini"
              maxLength={200}
              value={text}
              onChange={(e) => setText(e.target.value)}
              required
            />
            <button>Toevoegen</button>
          </form>
          <p className="admin__muted">{facts.length} van max. 50</p>
        </section>
      )}
      {error && <p className="account__error">{error}</p>}
    </div>
  );
}
