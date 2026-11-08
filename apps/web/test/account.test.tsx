import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from '../src/Account.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubLocation(search: string) {
  const replace = vi.fn();
  vi.stubGlobal('location', { search, hash: '', pathname: '/login', replace });
  return replace;
}

function fill(username: string, password: string) {
  fireEvent.change(screen.getByLabelText('Gebruikersnaam'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('Wachtwoord'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Inloggen' }));
}

describe('LoginPage', () => {
  it('logs in and returns to the requested same-site page', async () => {
    const replace = stubLocation('?next=%2F%3Fprofile%3Dshop');
    const fetch = vi.fn(async () => new Response(JSON.stringify({ username: 'mark' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    render(<LoginPage />);
    fill('mark', 'correct horse battery');
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/?profile=shop'));
    expect(fetch).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({ method: 'POST' }));
  });

  it('never redirects to another site', async () => {
    const replace = stubLocation('?next=%2F%2Fevil.example');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    render(<LoginPage />);
    fill('mark', 'correct horse battery');
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
  });

  it('shows the server message on failure', async () => {
    stubLocation('');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Onjuiste gebruikersnaam of wachtwoord' }), { status: 401 })),
    );
    render(<LoginPage />);
    fill('mark', 'wrong password!');
    expect(await screen.findByText('Onjuiste gebruikersnaam of wachtwoord')).toBeTruthy();
  });
});
