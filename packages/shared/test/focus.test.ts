import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOLD_MS,
  EMPTY_FOCUS,
  expireHolds,
  focusEntries,
  nextHoldDeadline,
  reconcileAlerts,
  type ActiveAlert,
  type FocusState,
} from '../src/index.ts';

const ORDER = ['oprit', 'voordeur', 'achter_1', 'achter_2'];
const alert = (id: string, cameraId: string, labels = ['person']): ActiveAlert => ({ id, cameraId, labels });
const focused = (s: FocusState) => focusEntries(s, ORDER).map((e) => `${e.cameraId}:${e.reason}`);

describe('focus state machine', () => {
  it('has no focus without alerts', () => {
    const s = reconcileAlerts(EMPTY_FOCUS, [], 0);
    expect(focused(s)).toEqual([]);
    expect(nextHoldDeadline(s)).toBeNull();
  });

  it('focuses a camera while its alert is active', () => {
    const s = reconcileAlerts(EMPTY_FOCUS, [alert('a1', 'voordeur', ['person', 'car'])], 1_000);
    expect(focusEntries(s, ORDER)).toEqual([
      { cameraId: 'voordeur', reason: 'alert', labels: ['car', 'person'], holdUntil: null },
    ]);
  });

  it('holds exactly 15 seconds after the last alert ends', () => {
    let s = reconcileAlerts(EMPTY_FOCUS, [alert('a1', 'oprit')], 0);
    s = reconcileAlerts(s, [], 10_000);
    expect(DEFAULT_HOLD_MS).toBe(15_000);
    expect(focusEntries(s, ORDER)).toEqual([
      { cameraId: 'oprit', reason: 'hold', labels: ['person'], holdUntil: 25_000 },
    ]);
    expect(nextHoldDeadline(s)).toBe(25_000);
    expect(focused(expireHolds(s, 24_999))).toEqual(['oprit:hold']);
    expect(focused(expireHolds(s, 25_000))).toEqual([]);
  });

  it('does not restart a running hold on repeated empty reconciliations', () => {
    let s = reconcileAlerts(EMPTY_FOCUS, [alert('a1', 'oprit')], 0);
    s = reconcileAlerts(s, [], 1_000);
    s = reconcileAlerts(s, [], 9_000);
    expect(nextHoldDeadline(s)).toBe(16_000);
    expect(focused(reconcileAlerts(s, [], 16_000))).toEqual([]);
  });

  it('cancels the hold when a new alert starts on the same camera (reactivation)', () => {
    let s = reconcileAlerts(EMPTY_FOCUS, [alert('a1', 'oprit')], 0);
    s = reconcileAlerts(s, [], 5_000);
    s = reconcileAlerts(s, [alert('a2', 'oprit')], 12_000);
    expect(focusEntries(s, ORDER)[0]).toMatchObject({ reason: 'alert', holdUntil: null });
    expect(nextHoldDeadline(s)).toBeNull();
    s = reconcileAlerts(s, [], 30_000);
    expect(nextHoldDeadline(s)).toBe(45_000);
  });

  it('keeps one hold per camera, independently', () => {
    let s = reconcileAlerts(EMPTY_FOCUS, [alert('a1', 'oprit'), alert('b1', 'achter_2')], 0);
    s = reconcileAlerts(s, [alert('b1', 'achter_2')], 2_000); // oprit ends first
    s = reconcileAlerts(s, [], 8_000); // achter_2 ends later
    expect(focusEntries(s, ORDER).map((e) => [e.cameraId, e.holdUntil])).toEqual([
      ['oprit', 17_000],
      ['achter_2', 23_000],
    ]);
    s = expireHolds(s, 17_000);
    expect(focused(s)).toEqual(['achter_2:hold']);
    expect(nextHoldDeadline(s)).toBe(23_000);
    s = expireHolds(s, 23_000);
    expect(focused(s)).toEqual([]);
  });

  it('stays focused while any of several alerts on one camera is active', () => {
    let s = reconcileAlerts(EMPTY_FOCUS, [alert('a1', 'oprit'), alert('a2', 'oprit', ['car'])], 0);
    s = reconcileAlerts(s, [alert('a2', 'oprit', ['car'])], 3_000);
    expect(focusEntries(s, ORDER)).toEqual([{ cameraId: 'oprit', reason: 'alert', labels: ['car'], holdUntil: null }]);
  });

  it('reports focus in the shared camera order, not alert order', () => {
    const s = reconcileAlerts(EMPTY_FOCUS, [alert('x', 'achter_2'), alert('y', 'oprit'), alert('z', 'achter_1')], 0);
    expect(focused(s)).toEqual(['oprit:alert', 'achter_1:alert', 'achter_2:alert']);
  });

  it('honours a custom hold duration', () => {
    let s = reconcileAlerts(EMPTY_FOCUS, [alert('a', 'oprit')], 0, 5_000);
    s = reconcileAlerts(s, [], 1_000, 5_000);
    expect(nextHoldDeadline(s)).toBe(6_000);
  });

  it('expireHolds returns the same object when nothing expires', () => {
    const s = reconcileAlerts(EMPTY_FOCUS, [alert('a', 'oprit')], 0);
    expect(expireHolds(s, 1_000_000)).toBe(s);
  });
});
