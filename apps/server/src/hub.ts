import {
  EMPTY_FOCUS,
  expireHolds,
  focusEntries,
  nextHoldDeadline,
  reconcileAlerts,
  type ActiveAlert,
  type Camera,
  type CameraAvailability,
  type DashboardState,
  type FocusState,
  type ServiceHealth,
  type SourceMode,
  type SystemHealth,
} from '@uitkijk/shared';

type Listener = (state: DashboardState) => void;

/**
 * Single owner of dashboard state: cameras, availability, health and the focus state machine.
 * Sources (mock scenarios, Frigate) push facts in; clients subscribe to complete snapshots.
 * Hold expiry is driven by one timer for the earliest deadline.
 */
export class StateHub {
  private cameras: Camera[];
  private focus: FocusState = EMPTY_FOCUS;
  private alerts: ActiveAlert[] = [];
  private health: SystemHealth;
  private scenario: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private listeners = new Set<Listener>();
  private lastEmitted = '';
  private readonly cameraIds: string[];
  private readonly mode: SourceMode;
  private readonly holdMs: number;

  constructor(mode: SourceMode, cameras: Camera[], holdMs: number) {
    this.mode = mode;
    this.holdMs = holdMs;
    this.cameras = cameras.map((c) => ({ ...c }));
    this.cameraIds = cameras.map((c) => c.id);
    const initial: ServiceHealth = { status: mode === 'mock' ? 'mock' : 'unknown' };
    this.health = { alerts: { ...initial }, streaming: { status: 'unknown' } };
  }

  /** Replaces the complete set of active alerts. Alerts for unknown cameras are ignored. */
  setActiveAlerts(alerts: ActiveAlert[]): void {
    const known = new Set(this.cameraIds);
    this.alerts = alerts.filter((a) => known.has(a.cameraId));
    this.focus = reconcileAlerts(this.focus, this.alerts, Date.now(), this.holdMs);
    this.scheduleExpiry();
    this.emit();
  }

  setAvailability(cameraId: string, availability: CameraAvailability): void {
    this.cameras = this.cameras.map((c) => (c.id === cameraId ? { ...c, availability } : c));
    this.emit();
  }

  setHealth(service: keyof SystemHealth, health: ServiceHealth): void {
    this.health = { ...this.health, [service]: health };
    this.emit();
  }

  setScenario(name: string | undefined): void {
    this.scenario = name;
    this.emit();
  }

  /** Clears alerts, focus and availability, for example when switching mock scenarios. */
  reset(): void {
    this.alerts = [];
    this.focus = EMPTY_FOCUS;
    this.cameras = this.cameras.map((c) => ({ ...c, availability: 'unknown' }));
    this.health = { ...this.health, alerts: { status: this.mode === 'mock' ? 'mock' : 'unknown' } };
    this.scheduleExpiry();
    this.emit();
  }

  snapshot(): DashboardState {
    return {
      mode: this.mode,
      cameras: this.cameras,
      focus: focusEntries(this.focus, this.cameraIds),
      health: this.health,
      ...(this.scenario ? { scenario: this.scenario } : {}),
      serverTime: Date.now(),
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    clearTimeout(this.timer);
    this.listeners.clear();
  }

  private scheduleExpiry(): void {
    clearTimeout(this.timer);
    const deadline = nextHoldDeadline(this.focus);
    if (deadline === null) return;
    this.timer = setTimeout(() => {
      this.focus = expireHolds(this.focus, Date.now());
      this.scheduleExpiry();
      this.emit();
    }, Math.max(0, deadline - Date.now()));
  }

  private emit(): void {
    const state = this.snapshot();
    // serverTime and lastOk change constantly; only meaningful changes are pushed.
    const key = JSON.stringify({ ...state, serverTime: 0, health: stripLastOk(state.health) });
    if (key === this.lastEmitted) return;
    this.lastEmitted = key;
    for (const listener of this.listeners) listener(state);
  }
}

function stripLastOk(health: SystemHealth) {
  return { alerts: { ...health.alerts, lastOk: 0 }, streaming: { ...health.streaming, lastOk: 0 } };
}
