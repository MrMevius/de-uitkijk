import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { displayProfile } from '@uitkijk/shared';
import { ActivatePage, AdminPage, LoginPage } from './Account.tsx';
import { ArchivePage } from './Archive.tsx';
import { Dashboard } from './Dashboard.tsx';
import { DevPanel } from './DevPanel.tsx';
import { useDashboardState } from './use-dashboard-state.ts';
import './styles.css';

/** Renews the login cookie on load and daily, so a TV that is never touched stays logged in. */
function useSessionRenewal() {
  useEffect(() => {
    const renew = () => void fetch('/api/auth/me').catch(() => {});
    renew();
    const timer = setInterval(renew, 24 * 3600_000);
    return () => clearInterval(timer);
  }, []);
}

function DashboardPage() {
  useSessionRenewal();
  const { state, connected } = useDashboardState();
  const profile = displayProfile(new URLSearchParams(location.search).get('profile'));
  return <Dashboard state={state} connected={connected} profile={profile} />;
}

function page() {
  const path = location.pathname;
  if (path.startsWith('/dev')) return <DevPanel />;
  if (path === '/login') return <LoginPage />;
  if (path === '/activeer') return <ActivatePage />;
  if (path === '/beheer') return <AdminPage />;
  if (path === '/archief') return <ArchivePage />;
  return <DashboardPage />;
}

createRoot(document.getElementById('root')!).render(<StrictMode>{page()}</StrictMode>);
