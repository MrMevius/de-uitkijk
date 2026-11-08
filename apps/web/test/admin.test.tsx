import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminPage } from '../src/admin/AdminPage.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  location.hash = '';
});

function stubApi(role: 'admin' | 'viewer') {
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/auth/me') return json({ id: 1, username: 'mark', role });
      if (url === '/api/admin/status')
        return json({
          mode: 'live',
          version: '0.9.0',
          alerts: { status: 'ok' },
          streaming: { status: 'ok' },
          cameraNames: { oprit: 'Oprit / Pad' },
          cameras: [{ id: 'oprit', video: 'failed', checkedAt: Date.now() / 1000 - 60 }],
          highlights: { enabled: true, lastOkAt: Date.now() / 1000 - 30, lastError: null },
          ai: { enabled: true, model: 'gpt-6-luna', callsToday: 3, dailyCap: 60, pending: 0, lastSuccessAt: null, lastError: null },
          users: { total: 2, admins: 1, inactive: 0 },
        });
      if (url === '/api/admin/highlights/stats') return json({ last24h: 7, last7d: 40, rotation: 7 });
      if (url === '/api/admin/users') return json([{ id: 1, username: 'mark', role: 'admin', active: true }]);
      if (url.startsWith('/api/highlights')) return json({ items: [], total: 0 });
      if (url === '/api/state') return json({ cameras: [] });
      return new Response('{}', { status: 404 });
    }),
  );
}

describe('admin page', () => {
  it('shows all tabs to administrators, starting with the overview', async () => {
    stubApi('admin');
    render(<AdminPage />);
    await waitFor(() => expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overzicht', 'Gebruikers', 'Highlights', 'AI', 'Mijn account']));
    expect(await screen.findByText(/De Uitkijk 0\.9\.0/)).toBeTruthy();
    expect(screen.getByText(/geen beeld/)).toBeTruthy();
    expect(screen.getByText(/7 in 24 uur/)).toBeTruthy();
  });

  it('follows the URL fragment to switch tabs', async () => {
    stubApi('admin');
    render(<AdminPage />);
    await screen.findAllByRole('tab');
    await act(async () => {
      location.hash = '#gebruikers';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(await screen.findByText('Gebruiker toevoegen')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Gebruikers' }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows viewers only the highlights and their own account', async () => {
    stubApi('viewer');
    location.hash = '#gebruikers';
    render(<AdminPage />);
    await waitFor(() => expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Highlights', 'Mijn account']));
    expect(screen.queryByText('Gebruiker toevoegen')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Highlights' }).getAttribute('aria-selected')).toBe('true');
  });
});
