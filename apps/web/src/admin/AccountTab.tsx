import { useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import type { Me } from './AdminPage.tsx';
import { Card, Icon, Notice, PageHeader } from './ui.tsx';

/** The signed-in user's own account: change password, log out. */
export function AccountTab({ me }: { me: Me }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const change = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== repeat) return setMessage({ ok: false, text: 'De nieuwe wachtwoorden zijn niet gelijk' });
    try {
      await api('POST', '/api/auth/password', { current, next });
      setCurrent('');
      setNext('');
      setRepeat('');
      setMessage({ ok: true, text: 'Wachtwoord gewijzigd. Andere apparaten zijn uitgelogd.' });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    }
  };

  const logout = async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    location.replace('/login');
  };

  return (
    <>
      <PageHeader title="Mijn account" description="Je eigen gegevens en wachtwoord." />
      <div className="ui-grid ui-grid--2">
        <Card title={`Ingelogd als ${me.username}`} icon="account">
          <p className="ui-muted">Rol: {me.role === 'admin' ? 'beheerder' : 'kijker'}. Je blijft ingelogd tot je uitlogt.</p>
          <div className="ui-actions">
            <button className="ui-btn" onClick={() => void logout()}>
              <Icon name="logout" size={16} />
              Uitloggen
            </button>
          </div>
        </Card>
        <Card title="Wachtwoord wijzigen" icon="settings">
          <form className="ui-form" onSubmit={(e) => void change(e)}>
            <input type="text" autoComplete="username" value={me.username} readOnly hidden />
            <label className="ui-field">
              <span className="ui-field__label">Huidig wachtwoord</span>
              <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
            </label>
            <label className="ui-field">
              <span className="ui-field__label">Nieuw wachtwoord</span>
              <input type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} required />
              <span className="ui-field__help">Minimaal 10 tekens.</span>
            </label>
            <label className="ui-field">
              <span className="ui-field__label">Herhaal nieuw wachtwoord</span>
              <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
            </label>
            <div className="ui-actions">
              <button className="ui-btn ui-btn--primary">Wijzigen</button>
            </div>
            {message && <Notice level={message.ok ? 'ok' : 'bad'}>{message.text}</Notice>}
          </form>
        </Card>
      </div>
    </>
  );
}
