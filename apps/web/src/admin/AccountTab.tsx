import { useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import type { Me } from './AdminPage.tsx';

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
    <div className="admin__stack">
      <section className="admin__card admin__card--ok">
        <h3>Ingelogd als {me.username}</h3>
        <p className="admin__muted">Rol: {me.role === 'admin' ? 'beheerder' : 'kijker'}. Je blijft ingelogd tot je uitlogt.</p>
        <button onClick={() => void logout()}>Uitloggen</button>
      </section>
      <section className="admin__card admin__card--ok">
        <h3>Wachtwoord wijzigen</h3>
        <form className="account__form" onSubmit={(e) => void change(e)}>
          <input type="text" autoComplete="username" value={me.username} readOnly hidden />
          <label>
            Huidig wachtwoord
            <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </label>
          <label>
            Nieuw wachtwoord (minimaal 10 tekens)
            <input type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} required />
          </label>
          <label>
            Herhaal nieuw wachtwoord
            <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
          </label>
          <button>Wijzigen</button>
          {message && <p className={message.ok ? 'admin__ok' : 'account__error'}>{message.text}</p>}
        </form>
      </section>
    </div>
  );
}
