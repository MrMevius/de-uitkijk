import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { displayProfile } from '@uitkijk/shared';
import { Dashboard } from './Dashboard.tsx';
import { DevPanel } from './DevPanel.tsx';
import { useDashboardState } from './use-dashboard-state.ts';
import './styles.css';

function DashboardPage() {
  const { state, connected } = useDashboardState();
  const profile = displayProfile(new URLSearchParams(location.search).get('profile'));
  return <Dashboard state={state} connected={connected} profile={profile} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>{location.pathname.startsWith('/dev') ? <DevPanel /> : <DashboardPage />}</StrictMode>,
);
