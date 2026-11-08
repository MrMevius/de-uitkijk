import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from './api.ts';

/** Login and account activation (one-time links). */

/** Only same-site paths, so the login page cannot be used to redirect elsewhere. */
function nextPath(): string {
  const next = new URLSearchParams(location.search).get('next') ?? '/';
  return next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="account">
      <h1>De Uitkijk</h1>
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/auth/login', { username, password });
      location.replace(nextPath());
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Page title="Inloggen">
      <form className="account__form" onSubmit={(e) => void submit(e)}>
        <label>
          Gebruikersnaam
          <input
            autoComplete="username"
            autoCapitalize="none"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>
        <label>
          Wachtwoord
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <p className="account__error">{error}</p>}
        <button disabled={busy}>Inloggen</button>
      </form>
    </Page>
  );
}

export function ActivatePage() {
  const token = location.hash.slice(1);
  const [info, setInfo] = useState<{ username: string; purpose: 'activate' | 'reset' } | null>(null);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ username: string; purpose: 'activate' | 'reset' }>('POST', '/api/auth/link', { token }).then(setInfo, (err) =>
      setError((err as Error).message),
    );
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== repeat) return setError('De wachtwoorden zijn niet gelijk');
    try {
      await api('POST', '/api/auth/activate', { token, password });
      // Drop the token from the address bar and history.
      location.replace('/');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Page title={info?.purpose === 'reset' ? 'Nieuw wachtwoord' : 'Account activeren'}>
      {info && (
        <form className="account__form" onSubmit={(e) => void submit(e)}>
          <input type="text" autoComplete="username" value={info.username} readOnly hidden />
          <p>
            Gebruiker: <strong>{info.username}</strong>
          </p>
          <label>
            Wachtwoord (minimaal 10 tekens)
            <input
              type="password"
              autoComplete="new-password"
              minLength={10}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <label>
            Herhaal wachtwoord
            <input
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              required
            />
          </label>
          {error && <p className="account__error">{error}</p>}
          <button>Opslaan</button>
        </form>
      )}
      {!info && error && <p className="account__error">{error}</p>}
    </Page>
  );
}
