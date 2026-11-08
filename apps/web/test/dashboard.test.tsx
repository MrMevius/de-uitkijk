import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { displayProfile, parseCameraConfig, type DashboardState } from '@uitkijk/shared';
import cameraConfig from '../../../config/cameras.json';
import nineConfig from '../../../config/cameras-9.mock.json';
import { Dashboard } from '../src/Dashboard.tsx';

afterEach(cleanup);

const state = (config: unknown, focus: DashboardState['focus'] = []): DashboardState => ({
  mode: 'mock',
  cameras: parseCameraConfig(config).map((c) => ({ ...c, availability: 'online' })),
  focus,
  health: { alerts: { status: 'mock' }, streaming: { status: 'ok' } },
  serverTime: 0,
});

const tile = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-camera="${id}"]`)!;

describe('Dashboard', () => {
  it('shows all four cameras with names in the shared order and no controls', () => {
    const { container } = render(<Dashboard state={state(cameraConfig)} connected profile={displayProfile('default')} />);
    const names = [...container.querySelectorAll('.tile__name')].map((n) => n.textContent);
    expect(names).toEqual(['Oprit / Pad', 'Voordeur', 'Achter het huis 1', 'Achter het huis 2 / Schuur']);
    expect(container.querySelectorAll('button, input, select, a')).toHaveLength(0);
    for (const v of container.querySelectorAll('video')) expect(v.muted).toBe(true);
  });

  it('renders nine cameras', () => {
    const { container } = render(<Dashboard state={state(nineConfig)} connected profile={displayProfile('default')} />);
    expect(container.querySelectorAll('.tile')).toHaveLength(9);
  });

  it('enlarges a focused tile without recreating its video element', () => {
    const profile = displayProfile('default');
    const { container, rerender } = render(<Dashboard state={state(cameraConfig)} connected profile={profile} />);
    const videoBefore = tile(container, 'voordeur').querySelector('video');
    const widthBefore = parseFloat(tile(container, 'voordeur').style.width);

    act(() =>
      rerender(
        <Dashboard
          state={state(cameraConfig, [{ cameraId: 'voordeur', reason: 'alert', labels: ['person'], holdUntil: null }])}
          connected
          profile={profile}
        />,
      ),
    );
    expect(tile(container, 'voordeur').querySelector('video')).toBe(videoBefore);
    expect(parseFloat(tile(container, 'voordeur').style.width)).toBeGreaterThan(widthBefore);
    expect(tile(container, 'voordeur').className).toContain('tile--alert');
    expect(tile(container, 'voordeur').textContent).toContain('Persoon');
    // DOM order stays the shared camera order regardless of focus.
    expect([...container.querySelectorAll('.tile')].map((t) => t.getAttribute('data-camera'))).toEqual([
      'oprit',
      'voordeur',
      'achter_1',
      'achter_2',
    ]);
  });

  it('shows a subtle health message when the backend is unreachable or a camera is offline', () => {
    const s = state(cameraConfig);
    s.cameras[2] = { ...s.cameras[2]!, availability: 'offline' };
    const { container } = render(<Dashboard state={s} connected={false} profile={displayProfile('default')} />);
    expect(container.querySelector('.status__message')!.textContent).toBe('Server niet bereikbaar · 1 camera offline');
    expect(container.querySelector('.status__dot--warning')).not.toBeNull();
    expect(tile(container, 'achter_1').textContent).toContain('Camera offline');
  });

  it('never shows video before a stream is live', () => {
    const { container } = render(<Dashboard state={state(cameraConfig)} connected profile={displayProfile('default')} />);
    for (const v of container.querySelectorAll('video')) expect(v.className).toContain('tile__video--hidden');
  });
});
