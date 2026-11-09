import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import type { Me } from './AdminPage.tsx';
import { Card, Icon, Notice, PageHeader, Pill } from './ui.tsx';

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
    <>
      <PageHeader
        title="Gebruikers"
        description="Wie het dashboard en dit beheer mag openen. Kijkers zien het dashboard, de highlights en hun eigen account; beheerders ook deze pagina."
      />
      <div className="ui-stack">
        {error && <Notice>{error}</Notice>}
        {link && (
          <Card title={`Eenmalige link voor ${link.username}`} icon="link" className="ui-card--accent">
            <p className="ui-muted">72 uur geldig en werkt één keer. Stuur hem zelf door.</p>
            <div className="ui-inline">
              <input className="ui-grow ui-mono" readOnly value={link.url} onFocus={(e) => e.target.select()} />
              <button
                className="ui-btn ui-btn--primary"
                onClick={() => void navigator.clipboard?.writeText(link.url).then(() => setCopied(true), () => setCopied(false))}
              >
                {copied ? 'Gekopieerd' : 'Kopiëren'}
              </button>
              <button className="ui-btn ui-btn--ghost" onClick={() => setLink(null)}>
                Sluiten
              </button>
            </div>
          </Card>
        )}
        <div className="ui-card ui-card--flush">
          <table className="ui-table">
            <thead>
              <tr>
                <th>Gebruiker</th>
                <th>Rol</th>
                <th>Status</th>
                <th className="ui-right">Acties</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <span className="ui-user">
                      <span className="admin__avatar" aria-hidden="true">{u.username.charAt(0).toUpperCase()}</span>
                      {u.username}
                      {u.id === me.id && <span className="ui-muted"> (jij)</span>}
                    </span>
                  </td>
                  <td>
                    <Pill level={u.role === 'admin' ? 'info' : 'off'}>{u.role === 'admin' ? 'beheerder' : 'kijker'}</Pill>
                  </td>
                  <td>
                    <Pill level={u.active ? 'ok' : 'warn'}>{u.active ? 'actief' : 'nog niet geactiveerd'}</Pill>
                  </td>
                  <td>
                    <div className="ui-row-actions">
                      <button className="ui-btn ui-btn--small" onClick={() => void newLink(u)}>
                        <Icon name="link" size={14} />
                        {u.active ? 'Wachtwoordlink' : 'Nieuwe link'}
                      </button>
                      {u.id !== me.id && (
                        <button className="ui-btn ui-btn--small ui-btn--danger" onClick={() => remove(u)}>
                          <Icon name="trash" size={14} />
                          Verwijderen
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Card title="Nieuwe gebruiker" icon="plus">
          <form className="ui-inline" onSubmit={create}>
            <input
              className="ui-grow"
              placeholder="gebruikersnaam"
              aria-label="Nieuwe gebruikersnaam"
              autoCapitalize="none"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
            <select value={role} onChange={(e) => setRole(e.target.value as 'viewer' | 'admin')} aria-label="Rol">
              <option value="viewer">kijker</option>
              <option value="admin">beheerder</option>
            </select>
            <button className="ui-btn ui-btn--primary">Gebruiker toevoegen</button>
          </form>
          <p className="ui-field__help">
            Je krijgt een eenmalige link om door te sturen. Tip: geef elke tv een eigen kijkersaccount, dan kun je er later één
            los uitzetten.
          </p>
        </Card>
      </div>
    </>
  );
}
