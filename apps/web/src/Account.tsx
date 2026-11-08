import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

/** Login, activation and user administration. Only reachable through the public (SWAG) address. */

interface User {
  id: number;
  username: string;
  role: 'admin' | 'viewer';
  active: boolean;
}

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Fout ${res.status}`);
  return data as T;
}

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

export function AdminPage() {
  const [me, setMe] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ username: string; url: string } | null>(null);
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<'viewer' | 'admin'>('viewer');

  const handle = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) location.replace('/login?next=/beheer');
    else setError((err as Error).message);
  };
  const load = () => api<User[]>('GET', '/api/admin/users').then(setUsers, handle);

  useEffect(() => {
    api<User>('GET', '/api/auth/me').then((u) => {
      setMe(u);
      if (u.role === 'admin') void load();
    }, handle);
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await api<{ user: User; link: string }>('POST', '/api/admin/users', { username, role });
      setLink({ username: res.user.username, url: res.link });
      setUsername('');
      await load();
    } catch (err) {
      handle(err);
    }
  };

  const newLink = async (u: User) => {
    setError(null);
    try {
      const res = await api<{ link: string }>('POST', `/api/admin/users/${u.id}/link`);
      setLink({ username: u.username, url: res.link });
    } catch (err) {
      handle(err);
    }
  };

  const remove = async (u: User) => {
    if (!confirm(`${u.username} verwijderen?`)) return;
    setError(null);
    try {
      await api('DELETE', `/api/admin/users/${u.id}`);
      await load();
    } catch (err) {
      handle(err);
    }
  };

  const logout = async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    location.replace('/login');
  };

  return (
    <Page title="Beheer">
      <p>
        {me && (
          <>
            Ingelogd als <strong>{me.username}</strong> ·{' '}
          </>
        )}
        <a href="/">Dashboard</a> · <button onClick={() => void logout()}>Uitloggen</button>
      </p>
      {error && <p className="account__error">{error}</p>}
      {me?.role === 'admin' && (
        <>
          {link && (
            <div className="account__link">
              <p>
                Eenmalige link voor <strong>{link.username}</strong> (72 uur geldig). Stuur hem zelf door:
              </p>
              <input readOnly value={link.url} onFocus={(e) => e.target.select()} />
              <button onClick={() => void navigator.clipboard?.writeText(link.url)}>Kopiëren</button>
            </div>
          )}
          <table className="account__table">
            <thead>
              <tr>
                <th>Gebruiker</th>
                <th>Rol</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.username}</td>
                  <td>{u.role === 'admin' ? 'beheerder' : 'kijker'}</td>
                  <td>{u.active ? 'actief' : 'nog niet geactiveerd'}</td>
                  <td>
                    <button onClick={() => void newLink(u)}>{u.active ? 'Wachtwoordlink' : 'Nieuwe link'}</button>{' '}
                    {u.id !== me.id && <button onClick={() => void remove(u)}>Verwijderen</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <form className="account__form account__form--inline" onSubmit={(e) => void create(e)}>
            <input
              placeholder="nieuwe gebruikersnaam"
              autoCapitalize="none"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
            <select value={role} onChange={(e) => setRole(e.target.value as 'viewer' | 'admin')}>
              <option value="viewer">kijker</option>
              <option value="admin">beheerder</option>
            </select>
            <button>Toevoegen</button>
          </form>
        </>
      )}
    </Page>
  );
}
