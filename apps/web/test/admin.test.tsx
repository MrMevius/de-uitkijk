import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminPage } from '../src/admin/AdminPage.tsx';
import { FacesTab } from '../src/admin/FacesTab.tsx';
import { fireEvent } from '@testing-library/react';

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
      if (url === '/api/admin/questions/count') return json({ open: 2 });
      if (url === '/api/admin/questions')
        return json([
          { id: 1, kind: 'person', title: 'Wie is dit?', body: 'Persoon bij Voordeur.', data: {}, status: 'open', answer: null, answeredBy: null, createdAt: Date.now() / 1000, answeredAt: null, highlight: { id: 'h1', hasThumbnail: true } },
          { id: 2, kind: 'vehicle', title: 'Van wie is deze auto?', body: 'De AI ziet: zwarte Volkswagen up!.', data: { vehicle: 'zwarte Volkswagen up!' }, status: 'open', answer: null, answeredBy: null, createdAt: Date.now() / 1000, answeredAt: null, highlight: { id: 'h2', hasThumbnail: true } },
        ]);
      if (url === '/api/admin/household')
        return json({
          ai: true,
          busy: false,
          lastRun: { status: 'done', startedAt: Date.now() / 1000 - 600, finishedAt: Date.now() / 1000 - 540, error: null, proposals: 2 },
          people: [{ id: 1, name: 'Noëlle Snippe', role: 'buren', relation: 'vriendin van Jasper', aliases: [], sources: ['vraag 29'], locked: [], face: null, sightings: 4, lastSeen: Date.now() / 1000 - 3600 }],
          vehicles: [{ id: 1, kind: 'auto', make: 'Volkswagen', model: 'up!', colour: 'donker', plate: '', features: '', ownerId: 1, place: '', sources: ['feit 7', 'feit 10'], label: 'donker Volkswagen up!', owner: 'Noëlle Snippe', sightings: 0, lastSeen: null }],
          proposals: [
            { id: 5, kind: 'vehicle', summary: 'Nieuw voertuig: rood Tesla Model 3 van Jasper Mevius', reason: 'Twee feiten over dezelfde auto.', sources: ['feit 4', 'feit 5'] },
            { id: 6, kind: 'question', summary: 'Is de witte Ford van Gideon een Fiesta of een Focus?', reason: '', sources: ['feit 8', 'feit 9'] },
          ],
          history: [],
          facts: [{ id: 7, text: 'Zwarte compacte hatchback is van Noëlle Snippe', createdBy: 'mark (vraag 24)', processed: true }],
        });
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
    await waitFor(() => expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overzicht', 'Vragen2', 'Gebruikers', 'Highlights', 'Huishouden', 'AI', 'Gezichten', 'Mijn account']));
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
    await waitFor(() => expect(screen.getByRole('tab', { name: /^Gebruikers/ }).getAttribute('aria-selected')).toBe('true'));
  });

  it('shows open questions with answer controls; a vehicle answer is prefilled from the AI', async () => {
    stubApi('admin');
    location.hash = '#vragen';
    render(<AdminPage />);
    expect(await screen.findByText('Wie is dit?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Bezorger / dienst' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Voorbijganger' })).toBeTruthy();
    expect((screen.getByDisplayValue('zwarte Volkswagen up!') as HTMLInputElement).value).toBe('zwarte Volkswagen up!');
    expect(screen.getByRole('button', { name: 'Opslaan als feit voor de AI' })).toBeTruthy();
  });

  it('shows viewers only the highlights and their own account', async () => {
    stubApi('viewer');
    location.hash = '#gebruikers';
    render(<AdminPage />);
    await waitFor(() => expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Highlights', 'Mijn account']));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Highlights' }).getAttribute('aria-selected')).toBe('true'));
    expect(screen.queryByText('Gebruiker toevoegen')).toBeNull();
  });
});

describe('face library tab', () => {
  it('removes the photos an administrator picked', async () => {
    const posts: { url: string; body: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return (posts.push({ url, body: String(init.body) }), new Response('{"deleted":1}', { status: 200 }));
        return new Response(
          JSON.stringify({ available: true, people: [{ name: 'Tineke Mevius', images: [{ file: 'a.webp', time: 1794244419 }, { file: 'b.webp', time: null }] }] }),
          { status: 200 },
        );
      }),
    );
    render(<FacesTab />);
    fireEvent.click(await screen.findByText("Foto's bekijken"));
    const photos = screen.getAllByRole('button', { pressed: false }).filter((b) => b.className.includes('ui-face'));
    expect(photos).toHaveLength(2);
    fireEvent.click(photos[1]!);
    fireEvent.click(screen.getByText('1 foto verwijderen'));
    await waitFor(() => expect(posts).toEqual([{ url: '/api/admin/faces/library/Tineke%20Mevius/delete', body: JSON.stringify({ files: ['b.webp'] }) }]));
  });

  it('shows the household register with proposals to accept and questions to acknowledge', async () => {
    stubApi('admin');
    location.hash = '#huishouden';
    render(<AdminPage />);
    expect(await screen.findByText(/Nieuw voertuig: rood Tesla Model 3/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Accepteren/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Gezien' })).toBeTruthy();
    expect(screen.getByText('vriendin van Jasper')).toBeTruthy();
    expect(screen.getByText('van Noëlle Snippe')).toBeTruthy();
    expect(screen.getByText(/2 voorstellen/)).toBeTruthy();
  });
});
