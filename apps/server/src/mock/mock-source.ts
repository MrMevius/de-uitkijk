import type { ActiveAlert } from '@uitkijk/shared';
import type { StateHub } from '../hub.ts';
import { SCENARIOS, type Scenario, type ScenarioStep } from './scenarios.ts';

/** Plays deterministic scenario timelines into the hub. Replaces Frigate in mock mode. */
export class MockSource {
  private timers: NodeJS.Timeout[] = [];
  private active = new Map<string, ActiveAlert>();
  private alertsDown = false;
  private streamingDown = false;
  private current: string | undefined;
  private readonly hub: StateHub;
  private readonly cameraIds: string[];
  private readonly scenarios: Record<string, Scenario>;

  constructor(hub: StateHub, cameraIds: string[], scenarios: Record<string, Scenario> = SCENARIOS) {
    this.hub = hub;
    this.cameraIds = cameraIds;
    this.scenarios = scenarios;
  }

  get scenario(): string | undefined {
    return this.current;
  }

  /** True while a scenario simulates a streaming outage; the real go2rtc probe is paused meanwhile. */
  get streamingSimulated(): boolean {
    return this.streamingDown;
  }

  list(): { name: string; description: string }[] {
    return Object.entries(this.scenarios).map(([name, s]) => ({ name, description: s.description }));
  }

  start(name: string): void {
    const scenario = this.scenarios[name];
    if (!scenario) throw new Error(`unknown scenario "${name}"`);
    this.stop();
    this.current = name;
    this.hub.reset();
    this.hub.setScenario(name);
    this.runIteration(scenario);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private runIteration(scenario: Scenario): void {
    this.stop();
    this.active.clear();
    this.alertsDown = false;
    this.streamingDown = false;
    this.hub.setHealth('alerts', { status: 'mock' });
    for (const id of this.cameraIds) this.hub.setAvailability(id, 'online');
    this.hub.setActiveAlerts([]);
    for (const step of scenario.steps) {
      this.timers.push(setTimeout(() => this.apply(step), step.at));
    }
    if (scenario.loopMs) {
      this.timers.push(setTimeout(() => this.runIteration(scenario), scenario.loopMs));
    }
  }

  private apply(step: ScenarioStep): void {
    switch (step.do) {
      case 'alert-start':
        this.active.set(step.id, { id: step.id, cameraId: step.camera, labels: step.labels ?? ['person'] });
        break;
      case 'alert-end':
        this.active.delete(step.id);
        break;
      case 'camera':
        this.hub.setAvailability(step.camera, step.availability);
        return;
      case 'alerts-service':
        this.alertsDown = step.status === 'down';
        this.hub.setHealth('alerts', step.status === 'down' ? { status: 'down', detail: 'Gesimuleerde storing' } : { status: 'mock' });
        break;
      case 'streaming-service':
        this.streamingDown = step.status === 'down';
        this.hub.setHealth('streaming', step.status === 'down' ? { status: 'down', detail: 'Gesimuleerde storing' } : { status: 'ok' });
        return;
    }
    // Like the live source: while the alert source is down no alert is considered active.
    this.hub.setActiveAlerts(this.alertsDown ? [] : [...this.active.values()]);
  }
}
