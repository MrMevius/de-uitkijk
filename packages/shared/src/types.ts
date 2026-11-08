/** Hard product limit: the dashboard supports at most nine cameras. */
export const MAX_CAMERAS = 9;

/** go2rtc stream names for one camera. The browser only ever sees these names, never source URLs. */
export interface CameraStreams {
  main: string;
  sub: string;
}

/** One camera entry as written in a camera configuration file. Array position defines the shared order. */
export interface CameraConfig {
  /** Stable identifier, lower-case `[a-z0-9_]`. Never derived from the display name. */
  id: string;
  /** Dutch display name shown on every client. */
  name: string;
  /** Frigate camera name used to map alerts and status. Optional in mock mode. */
  frigateCamera?: string;
  streams: CameraStreams;
}

export type CameraAvailability = 'online' | 'offline' | 'unknown';

export interface Camera extends CameraConfig {
  /** Zero-based position in the shared camera order. */
  order: number;
  /** Source-side availability as reported by Frigate or the mock source. Playback state is tracked per client. */
  availability: CameraAvailability;
}

/** An alert that is currently in progress, normalised from Frigate review items or mock events. */
export interface ActiveAlert {
  id: string;
  cameraId: string;
  /** Object labels as reported by Frigate, for example `person` or `car`. */
  labels: string[];
}

export type FocusReason = 'alert' | 'hold';

export interface FocusEntry {
  cameraId: string;
  reason: FocusReason;
  labels: string[];
  /** Epoch milliseconds at which the hold ends; null while an alert is active. */
  holdUntil: number | null;
}

export type ServiceStatus = 'ok' | 'down' | 'unknown' | 'mock';

export interface ServiceHealth {
  status: ServiceStatus;
  /** Short Dutch explanation suitable for an on-screen status line. */
  detail?: string;
  /** Epoch milliseconds of the last successful contact. */
  lastOk?: number;
}

export interface SystemHealth {
  /** Alert source: Frigate in live mode, the scenario runner in mock mode. */
  alerts: ServiceHealth;
  /** Streaming service (go2rtc) as seen from the backend. */
  streaming: ServiceHealth;
}

export type SourceMode = 'mock' | 'live';

/** Complete state pushed from the backend to dashboard clients. */
export interface DashboardState {
  mode: SourceMode;
  cameras: Camera[];
  focus: FocusEntry[];
  health: SystemHealth;
  /** Active mock scenario, if any. */
  scenario?: string;
  /** Backend clock in epoch milliseconds when this state was produced. */
  serverTime: number;
}

/** A selected highlight as the dashboard and archive see it. Times in epoch seconds (Frigate's unit). */
export interface HighlightSummary {
  id: string;
  /** Representative camera (De Uitkijk id) whose clip is shown. */
  cameraId: string;
  /** All cameras that saw the event, in order of appearance. */
  cameras: string[];
  startTime: number;
  endTime: number;
  /** Seconds. */
  clipDuration: number;
  /** Short Dutch description: the AI description when available, otherwise the rule-based one. */
  description: string;
  ruleDescription: string;
  aiDescribed: boolean;
  /** The AI judged the still to show no real event; such highlights leave the rotation. */
  aiNoise: boolean;
  /** Administrator's answer about who or what is shown (questions tab). */
  annotation: string | null;
  score: number;
  reasons: string[];
  /** Administrator feedback: 1 good selection, -1 bad selection. */
  feedback: -1 | 1 | null;
  hasThumbnail: boolean;
}
