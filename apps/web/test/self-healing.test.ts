import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msUntilNightly, useSelfHealing } from '../src/self-healing.ts';

let reload: ReturnType<typeof vi.fn>;
let serverVersion = '1.0.0';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 8, 20, 0)); // 21:00 in Amsterdam
  sessionStorage.clear();
  reload = vi.fn();
  vi.stubGlobal('location', { reload });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: serverVersion }))));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('self-healing dashboard', () => {
  it('computes the time until 04:00 in Amsterdam', () => {
    expect(msUntilNightly(Date.UTC(2026, 10, 8, 20, 0))).toBe(7 * 3600_000);
    expect(msUntilNightly(Date.UTC(2026, 10, 9, 3, 0))).toBe(24 * 3600_000);
    expect(msUntilNightly(Date.UTC(2026, 6, 1, 1, 30))).toBe(30 * 60_000); // summer time
  });

  it('reloads after a new release goes live, but not during an alert and not in a loop', async () => {
    serverVersion = '1.0.0';
    const { rerender } = renderHook(({ busy }) => useSelfHealing(busy, '1.0.0'), { initialProps: { busy: false } });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(reload).not.toHaveBeenCalled();
    serverVersion = '1.1.0';
    rerender({ busy: true });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(reload).not.toHaveBeenCalled();
    rerender({ busy: false });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(reload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads every night at 04:00, postponed while an alert is active', async () => {
    serverVersion = '1.0.0';
    const { rerender } = renderHook(({ busy }) => useSelfHealing(busy, '1.0.0'), { initialProps: { busy: true } });
    await vi.advanceTimersByTimeAsync(7 * 3600_000);
    expect(reload).not.toHaveBeenCalled();
    rerender({ busy: false });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
