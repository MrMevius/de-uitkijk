import { useEffect, useState } from 'react';

interface ScenarioList {
  current?: string;
  scenarios: { name: string; description: string }[];
}

/** Development-only page (/dev) to switch mock scenarios. Not part of the TV dashboard. */
export function DevPanel() {
  const [data, setData] = useState<ScenarioList | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    fetch('/api/dev/scenarios')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status} (alleen in mock-modus)`))))
      .then(setData, (e: Error) => setError(e.message));

  useEffect(() => {
    void load();
  }, []);

  const start = async (name: string) => {
    await fetch('/api/dev/scenario', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    await load();
  };

  return (
    <div className="dev">
      <h1>De Uitkijk — ontwikkelpaneel</h1>
      <p>
        Open het dashboard in een ander venster: <a href="/">standaard</a> · <a href="/?profile=shop">winkel</a> ·{' '}
        <a href="/?profile=bedroom">slaapkamer</a>
      </p>
      {error && <p className="dev__error">{error}</p>}
      <ul>
        {data?.scenarios.map((s) => (
          <li key={s.name}>
            <button onClick={() => void start(s.name)} disabled={s.name === data.current}>
              {s.name}
            </button>{' '}
            {s.description}
          </li>
        ))}
      </ul>
    </div>
  );
}
