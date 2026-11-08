import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { displayProfile } from '@uitkijk/shared';
import { ActivatePage, AdminPage, LoginPage } from './Account.tsx';
import { Dashboard } from './Dashboard.tsx';
import { DevPanel } from './DevPanel.tsx';
import { useDashboardState } from './use-dashboard-state.ts';
import './styles.css';

function DashboardPage() {
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
  return <DashboardPage />;
}

createRoot(document.getElementById('root')!).render(<StrictMode>{page()}</StrictMode>);
