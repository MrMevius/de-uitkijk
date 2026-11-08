import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api.ts';
import { ArchiveView } from '../Archive.tsx';
import { AccountTab } from './AccountTab.tsx';
import { AiTab } from './AiTab.tsx';
import { OverviewTab } from './OverviewTab.tsx';
import { QuestionsTab } from './QuestionsTab.tsx';
import { UsersTab } from './UsersTab.tsx';

export interface Me {
  id: number;
  username: string;
  role: 'admin' | 'viewer';
}

interface TabContext {
  me: Me;
  setQuestionCount: (n: number) => void;
}

interface Tab {
  id: string;
  label: string;
  adminOnly: boolean;
  render: (ctx: TabContext) => ReactNode;
}

const TABS: Tab[] = [
  { id: 'overzicht', label: 'Overzicht', adminOnly: true, render: () => <OverviewTab /> },
  { id: 'vragen', label: 'Vragen', adminOnly: true, render: ({ setQuestionCount }) => <QuestionsTab onCountChange={setQuestionCount} /> },
  { id: 'gebruikers', label: 'Gebruikers', adminOnly: true, render: ({ me }) => <UsersTab me={me} /> },
  { id: 'highlights', label: 'Highlights', adminOnly: false, render: () => <ArchiveView embedded /> },
  { id: 'ai', label: 'AI', adminOnly: true, render: () => <AiTab /> },
  { id: 'account', label: 'Mijn account', adminOnly: false, render: ({ me }) => <AccountTab me={me} /> },
];

const tabFromHash = (tabs: Tab[]) => tabs.find((t) => `#${t.id}` === location.hash)?.id ?? tabs[0]!.id;

/**
 * /beheer: administration with tabs. Administrators see everything; viewers see the highlights and their
 * own account. The active tab lives in the URL fragment, so reloads and links keep it.
 */
export function AdminPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tabs = me ? TABS.filter((t) => !t.adminOnly || me.role === 'admin') : [];
  const [active, setActive] = useState<string>('');
  const [questionCount, setQuestionCount] = useState(0);

  useEffect(() => {
    api<Me>('GET', '/api/auth/me').then(setMe, (err) => {
      if (err instanceof ApiError && err.status === 401) location.replace('/login?next=/beheer');
      else setError((err as Error).message);
    });
  }, []);

  useEffect(() => {
    if (me?.role !== 'admin') return;
    const load = () => api<{ open: number }>('GET', '/api/admin/questions/count').then((c) => setQuestionCount(c.open), () => {});
    void load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [me]);

  useEffect(() => {
    if (!me) return;
    const visible = TABS.filter((t) => !t.adminOnly || me.role === 'admin');
    const sync = () => setActive(tabFromHash(visible));
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [me]);

  const current = tabs.find((t) => t.id === active);

  return (
    <div className="admin">
      <header className="admin__header">
        <div className="admin__brand">
          De Uitkijk <span>{me?.role === 'admin' ? 'Beheer' : 'Account'}</span>
        </div>
        <nav className="admin__links">
          <a href="/">Dashboard</a>
          {me && <span className="admin__user">{me.username}</span>}
        </nav>
      </header>
      {error && <p className="account__error admin__body">{error}</p>}
      {me && (
        <>
          <nav className="admin__tabs" role="tablist">
            {tabs.map((t) => (
              <a
                key={t.id}
                href={`#${t.id}`}
                role="tab"
                aria-selected={t.id === active}
                className={t.id === active ? 'admin__tab admin__tab--active' : 'admin__tab'}
              >
                {t.label}
                {t.id === 'vragen' && questionCount > 0 && <span className="admin__badge">{questionCount}</span>}
              </a>
            ))}
          </nav>
          <main className="admin__body" role="tabpanel">
            {current?.render({ me, setQuestionCount })}
          </main>
        </>
      )}
    </div>
  );
}
