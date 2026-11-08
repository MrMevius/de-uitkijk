import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import type { Me } from './AdminPage.tsx';

interface User {
  id: number;
  username: string;
  role: 'admin' | 'viewer';
  active: boolean;
}

/** Users, roles and one-time links. */
export function UsersTab({ me }: { me: Me }) {
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ username: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<'viewer' | 'admin'>('viewer');

  const load = () => api<User[]>('GET', '/api/admin/users').then(setUsers, (err) => setError((err as Error).message));
  useEffect(() => {
    void load();
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const showLink = (name: string, url: string) => {
    setLink({ username: name, url });
    setCopied(false);
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await api<{ user: User; link: string }>('POST', '/api/admin/users', { username, role });
      showLink(res.user.username, res.link);
      setUsername('');
      await load();
    });
  };

  const newLink = (u: User) =>
    run(async () => showLink(u.username, (await api<{ link: string }>('POST', `/api/admin/users/${u.id}/link`)).link));

  const remove = (u: User) => {
    if (!confirm(`${u.username} verwijderen? Alle sessies van deze gebruiker stoppen.`)) return;
    void run(async () => {
      await api('DELETE', `/api/admin/users/${u.id}`);
      await load();
    });
  };

  return (
    <div className="admin__stack">
      {error && <p className="account__error">{error}</p>}
      {link && (
        <section className="admin__card admin__card--ok">
          <h3>Eenmalige link voor {link.username}</h3>
          <p className="admin__muted">72 uur geldig, werkt één keer. Stuur hem zelf door.</p>
          <div className="admin__row">
            <input className="admin__grow" readOnly value={link.url} onFocus={(e) => e.target.select()} />
            <button
              onClick={() =>
                void navigator.clipboard?.writeText(link.url).then(() => setCopied(true), () => setCopied(false))
              }
            >
              {copied ? 'Gekopieerd' : 'Kopiëren'}
            </button>
            <button onClick={() => setLink(null)}>Sluiten</button>
          </div>
        </section>
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
              <td>
                {u.username}
                {u.id === me.id && <span className="admin__muted"> (jij)</span>}
              </td>
              <td>{u.role === 'admin' ? 'beheerder' : 'kijker'}</td>
              <td>{u.active ? 'actief' : 'nog niet geactiveerd'}</td>
              <td className="admin__actions">
                <button onClick={() => void newLink(u)}>{u.active ? 'Wachtwoordlink' : 'Nieuwe link'}</button>
                {u.id !== me.id && <button onClick={() => remove(u)}>Verwijderen</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="admin__row" onSubmit={create}>
        <input placeholder="nieuwe gebruikersnaam" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} required />
        <select value={role} onChange={(e) => setRole(e.target.value as 'viewer' | 'admin')}>
          <option value="viewer">kijker</option>
          <option value="admin">beheerder</option>
        </select>
        <button>Gebruiker toevoegen</button>
      </form>
      <p className="admin__muted">
        Tip: geef elke tv een eigen kijkersaccount, dan kun je er later één los uitzetten. Kijkers zien het dashboard,
        de highlights en hun eigen account; beheerders ook deze pagina.
      </p>
    </div>
  );
}
