import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminPage } from '../src/admin/AdminPage.tsx';
import { FacesTab } from '../src/admin/FacesTab.tsx';
import { ArchiveView } from '../src/Archive.tsx';
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
          backup: { lastAt: Date.now() / 1000 - 3600, lastFile: 'uitkijk-2026-11-12.db.gz', lastBytes: 5_200_000, count: 3, lastError: null },
        });
      if (url === '/api/admin/displays')
        return json([
          { id: 'a1', profile: 'shop', username: 'winkel', version: '0.8.0', device: 'Windows · Chrome', firstSeen: 0, lastSeen: Date.now() / 1000 - 30, camerasLive: 4, camerasTotal: 4 },
          { id: 'b2', profile: 'bedroom', username: 'slaapkamer', version: '0.9.0', device: 'Linux · Chrome', firstSeen: 0, lastSeen: Date.now() / 1000 - 7200, camerasLive: 4, camerasTotal: 4 },
        ]);
      if (url === '/api/admin/highlights/stats') return json({ last24h: 7, last7d: 40, rotation: 7 });
      if (url === '/api/admin/questions/count') return json({ open: 2 });
      if (url === '/api/admin/questions')
        return json([
          {
            id: 1, kind: 'person', title: 'Wie is dit?', body: 'Persoon bij Voordeur.', data: {}, status: 'open', answer: null, answeredBy: null, createdAt: Date.now() / 1000, answeredAt: null,
            highlight: { id: 'h1', hasThumbnail: true, feedback: null },
            sameVisit: [
              { id: 'h3', camera: 'oprit', startTime: Date.now() / 1000 - 120, description: 'Iemand loopt over de oprit.' },
              { id: 'h4', camera: 'achter_1', startTime: Date.now() / 1000 - 60, description: 'Iemand bij de schuur.' },
            ],
          },
          {
            id: 3, kind: 'household', title: 'Heeft Gideon een Fiesta of een Focus?', body: 'Het huishouden twijfelt.', status: 'open', answer: null, answeredBy: null, createdAt: Date.now() / 1000, answeredAt: null, highlight: null,
            data: {
              type: 'doubt',
              facts: [{ id: 8, text: 'Witte Ford Fiesta hatchback is van Gideon Snippe' }, { id: 9, text: 'Witte Ford Focus hatchback is van Gideon Snippe' }],
              options: [
                { label: 'Een Fiesta', fact: 'Gideon Snippe heeft een witte Ford Fiesta.', retire: [8, 9] },
                { label: 'Een Focus', fact: 'Gideon Snippe heeft een witte Ford Focus.', retire: [8, 9] },
              ],
            },
          },
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
          schedule: { frequency: 'weekly', weekday: 7, time: '05:00', next: Date.UTC(2026, 10, 15, 4) / 1000 },
        });
      if (url === '/api/admin/questions/3/answer') return json({ answer: 'Een Focus: Gideon Snippe heeft een witte Ford Focus.', fact: 'Gideon Snippe heeft een witte Ford Focus.' });
      if (url === '/api/admin/questions/1/answer') return json({ answer: 'Tineke Mevius (bewoner)', fact: 'pending', face: 'pending', also: 1 });
      if (url === '/api/admin/highlights/h1/feedback') return new Response(null, { status: 204 });
      if (url === '/api/admin/household/schedule') return json({ frequency: 'daily', weekday: 7, time: '06:30', next: null });
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
    await waitFor(() => expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overzicht', 'Vragen2', 'Gebruikers', 'Highlights', 'Huishouden', 'AI', 'AI-log', 'Gezichten', 'Mijn account']));
    expect(await screen.findByText(/De Uitkijk 0\.9\.0/)).toBeTruthy();
    // The change log sits at the bottom of the sidebar, right above the dashboard link.
    const foot = screen.getByText('Naar dashboard').closest('.admin__sidefoot')!;
    expect([...foot.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Change log', 'Naar dashboard', expect.stringContaining('mark')]);
    expect(screen.getByText(/geen beeld/)).toBeTruthy();
    expect(screen.getByText(/7 in 24 uur/)).toBeTruthy();
    // Nightly database copy and the screens that show the dashboard (0.27.0).
    expect(screen.getByText('Back-up database')).toBeTruthy();
    expect(screen.getByText(/3 bewaard/)).toBeTruthy();
    expect(await screen.findByText('Winkel-tv · Windows · Chrome')).toBeTruthy();
    expect(screen.getByText(/oude versie/)).toBeTruthy();
    expect(screen.getByText(/laatst gezien 2 uur geleden/)).toBeTruthy();
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

  it('answers a person for the ticked highlights of the same visit and rates the highlight (0.27.0)', async () => {
    stubApi('admin');
    location.hash = '#vragen';
    render(<AdminPage />);
    expect(await screen.findByText(/Zelfde bezoek/)).toBeTruthy();
    fireEvent.click(screen.getByText('Iemand bij de schuur.'));
    // A same-visit clip plays under the list (0.28.2); playing it does not change the tick.
    const visit = document.querySelector('.ui-visit')!;
    fireEvent.click(visit.querySelectorAll('button')[0]!);
    expect(visit.querySelector('video')!.getAttribute('src')).toBe('/api/highlights/h3/clip.mp4');
    expect((visit.querySelectorAll('input[type=checkbox]')[0] as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getAllByTitle('Goede highlight')[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Bewoner' }));
    const calls = (fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls;
    await waitFor(() => expect(calls.some(([url]) => url === '/api/admin/questions/1/answer')).toBe(true));
    const body = (url: string) => JSON.parse(String(calls.find(([u]) => u === url)![1]!.body));
    expect(body('/api/admin/questions/1/answer')).toEqual({ category: 'bewoner', name: '', also: ['h3'] });
    expect(body('/api/admin/highlights/h1/feedback')).toEqual({ value: 1 });
    // The card stays with the answer, so the highlight can still be rated (0.28.1); the rating given stays on.
    expect(await screen.findByText('Beantwoord: Tineke Mevius (bewoner) (ook voor 1 andere highlight)')).toBeTruthy();
    expect(screen.getAllByTitle('Goede highlight')[0]!.className).toContain('ui-btn--on');
    fireEvent.click(screen.getByRole('button', { name: 'Sluiten' }));
    expect(screen.queryByText(/Beantwoord:/)).toBeNull();
  });

  it('answers a doubt of the household register with one click (0.29.0)', async () => {
    stubApi('admin');
    location.hash = '#vragen';
    render(<AdminPage />);
    expect(await screen.findByText('Heeft Gideon een Fiesta of een Focus?')).toBeTruthy();
    expect(screen.getByText('Witte Ford Focus hatchback is van Gideon Snippe')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Weet ik niet' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Een Focus' }));
    expect(await screen.findByText('Beantwoord: Een Focus: Gideon Snippe heeft een witte Ford Focus.')).toBeTruthy();
    const calls = (fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls;
    expect(JSON.parse(String(calls.find(([u]) => u === '/api/admin/questions/3/answer')![1]!.body))).toEqual({ option: 1 });
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
    // Automatic bundling at a chosen moment (0.28.0).
    expect(screen.getByText(/Volgende keer: .*15 nov/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Hoe vaak'), { target: { value: 'daily' } });
    expect(screen.queryByLabelText('Dag')).toBeNull();
    fireEvent.change(screen.getByLabelText('Tijd'), { target: { value: '06:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Opslaan' }));
    const calls = (fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls;
    await waitFor(() => expect(calls.some(([u]) => u === '/api/admin/household/schedule')).toBe(true));
    expect(JSON.parse(String(calls.find(([u]) => u === '/api/admin/household/schedule')![1]!.body))).toEqual({ frequency: 'daily', weekday: 7, time: '06:30' });
  });
});

describe('archive search (0.27.0)', () => {
  it('searches after typing stops, with a period and only unrated highlights', async () => {
    stubApi('admin');
    render(<ArchiveView embedded />);
    const calls = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls;
    const lastSearch = () => new URLSearchParams(calls.map(([u]) => u).filter((u) => u.startsWith('/api/highlights?')).at(-1)!.split('?')[1]);
    await screen.findByText('Nog niet beoordeeld');
    fireEvent.change(screen.getByLabelText('Zoeken'), { target: { value: ' tineke pakket ' } });
    fireEvent.change(screen.getByLabelText('Vanaf datum'), { target: { value: '2026-11-10' } });
    fireEvent.click(screen.getByText('Nog niet beoordeeld'));
    await waitFor(() => expect(lastSearch().get('q')).toBe('tineke pakket'), { timeout: 2000 });
    const q = lastSearch();
    expect(q.get('unrated')).toBe('1');
    // One date: that whole day (Amsterdam), from midnight to midnight.
    expect(Number(q.get('to')) - Number(q.get('from'))).toBe(86400);
    expect(await screen.findByText('Niets gevonden voor "tineke pakket".')).toBeTruthy();
  });
});
