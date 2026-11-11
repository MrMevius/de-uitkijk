import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api.ts';
import { ArchiveView } from '../Archive.tsx';
import { AccountTab } from './AccountTab.tsx';
import { AiCallsTab } from './AiCallsTab.tsx';
import { AiTab } from './AiTab.tsx';
import { FacesTab } from './FacesTab.tsx';
import { HouseholdTab } from './HouseholdTab.tsx';
import { OverviewTab } from './OverviewTab.tsx';
import { QuestionsTab } from './QuestionsTab.tsx';
import { Icon, type IconName } from './ui.tsx';
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
  icon: IconName;
  adminOnly: boolean;
  render: (ctx: TabContext) => ReactNode;
}

const TABS: Tab[] = [
  { id: 'overzicht', label: 'Overzicht', icon: 'overview', adminOnly: true, render: () => <OverviewTab /> },
  { id: 'vragen', label: 'Vragen', icon: 'questions', adminOnly: true, render: ({ setQuestionCount }) => <QuestionsTab onCountChange={setQuestionCount} /> },
  { id: 'gebruikers', label: 'Gebruikers', icon: 'users', adminOnly: true, render: ({ me }) => <UsersTab me={me} /> },
  { id: 'highlights', label: 'Highlights', icon: 'highlights', adminOnly: false, render: () => <ArchiveView embedded /> },
  { id: 'huishouden', label: 'Huishouden', icon: 'home', adminOnly: true, render: () => <HouseholdTab /> },
  { id: 'ai', label: 'AI', icon: 'ai', adminOnly: true, render: () => <AiTab /> },
  { id: 'ai-gesprekken', label: 'AI-gesprekken', icon: 'ai', adminOnly: true, render: () => <AiCallsTab /> },
  { id: 'gezichten', label: 'Gezichten', icon: 'account', adminOnly: true, render: () => <FacesTab /> },
  { id: 'account', label: 'Mijn account', icon: 'account', adminOnly: false, render: ({ me }) => <AccountTab me={me} /> },
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
      <aside className="admin__sidebar">
        <div className="admin__brand">
          <span className="admin__logo" aria-hidden="true">
            <Icon name="camera" size={16} />
          </span>
          <span>
            De Uitkijk
            <small>{me?.role === 'admin' ? 'Beheer' : 'Account'}</small>
          </span>
        </div>
        {me && (
          <nav className="admin__tabs" role="tablist" aria-orientation="vertical">
            {tabs.map((t) => (
              <a
                key={t.id}
                href={`#${t.id}`}
                role="tab"
                aria-selected={t.id === active}
                className={t.id === active ? 'admin__tab admin__tab--active' : 'admin__tab'}
              >
                <Icon name={t.icon} />
                <span className="admin__tablabel">{t.label}</span>
                {t.id === 'vragen' && questionCount > 0 && <span className="admin__badge">{questionCount}</span>}
              </a>
            ))}
          </nav>
        )}
        <div className="admin__sidefoot">
          <a className="admin__dashlink" href="/">
            <Icon name="monitor" />
            <span>Naar dashboard</span>
          </a>
          {me && (
            <a className="admin__me" href="#account" title="Mijn account">
              <span className="admin__avatar" aria-hidden="true">{me.username.charAt(0).toUpperCase()}</span>
              <span>
                {me.username}
                <small>{me.role === 'admin' ? 'beheerder' : 'kijker'}</small>
              </span>
            </a>
          )}
        </div>
      </aside>
      <main className="admin__body" role="tabpanel">
        {error && <p className="ui-notice ui-notice--bad">{error}</p>}
        {me && current?.render({ me, setQuestionCount })}
      </main>
    </div>
  );
}
