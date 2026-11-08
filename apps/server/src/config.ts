import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_HOLD_MS, parseCameraConfig, type Camera, type SourceMode } from '@uitkijk/shared';

export interface ServerConfig {
  mode: SourceMode;
  host: string;
  port: number;
  cameras: Camera[];
  holdMs: number;
  /** Mock mode: scenario started at boot. */
  mockScenario: string;
  /** Mock mode: allow switching scenarios through the dev API. */
  devApi: boolean;
  /** AI descriptions for highlights: 'codex' (ChatGPT sign-in through the Codex CLI) or off. */
  ai: 'codex' | 'off';
  /** Upper bound for the temporary clip cache (bytes). */
  clipCacheBytes: number;
  frigate?: {
    url: string;
    pollMs: number;
    maxAlertAgeMs: number;
  };
  /** Directory for the SQLite database (accounts and sessions). */
  dataDir: string;
  /** Login required: always in live mode; in mock mode only with UITKIJK_LOGIN=on. */
  login: boolean;
  /** External HTTPS base URL for one-time links and the Origin check. */
  publicUrl: string;
  /** Internal go2rtc base URL used only for the backend health probe; never sent to browsers. */
  go2rtcUrl?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const mode = env.UITKIJK_MODE ?? 'mock';
  if (mode !== 'mock' && mode !== 'live') throw new Error(`UITKIJK_MODE must be "mock" or "live", got "${mode}"`);

  const cameraFile = resolve(env.UITKIJK_CAMERA_CONFIG ?? 'config/cameras.json');
  const cameras = parseCameraConfig(JSON.parse(readFileSync(cameraFile, 'utf8')));

  const config: ServerConfig = {
    mode,
    host: env.HOST ?? '0.0.0.0',
    port: int(env.PORT, 3000),
    cameras,
    holdMs: int(env.UITKIJK_HOLD_MS, DEFAULT_HOLD_MS),
    mockScenario: env.UITKIJK_MOCK_SCENARIO ?? 'demo',
    devApi: mode === 'mock' && env.UITKIJK_DEV_API !== 'false',
    dataDir: env.UITKIJK_DATA_DIR || 'data',
    login: mode === 'live' || env.UITKIJK_LOGIN === 'on',
    ai: env.UITKIJK_AI === 'codex' ? 'codex' : 'off',
    clipCacheBytes: int(env.UITKIJK_CLIP_CACHE_MB, 512) * 1024 * 1024,
    publicUrl: new URL(env.UITKIJK_PUBLIC_URL || 'http://127.0.0.1:8080').origin,
    ...(env.GO2RTC_URL ? { go2rtcUrl: env.GO2RTC_URL.replace(/\/$/, '') } : {}),
  };

  if (mode === 'live') {
    if (!env.FRIGATE_URL) throw new Error('FRIGATE_URL is required in live mode');
    if (/\/\/[^/]*@/.test(env.FRIGATE_URL)) throw new Error('FRIGATE_URL must not contain credentials');
    const unmapped = cameras.filter((c) => !c.frigateCamera).map((c) => c.id);
    if (unmapped.length) throw new Error(`live mode requires frigateCamera for: ${unmapped.join(', ')}`);
    config.frigate = {
      url: env.FRIGATE_URL.replace(/\/$/, ''),
      pollMs: Math.max(1_000, int(env.FRIGATE_POLL_MS, 2_000)),
      maxAlertAgeMs: int(env.FRIGATE_MAX_ALERT_AGE_S, 1_800) * 1_000,
    };
  }
  return config;
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid number: ${value}`);
  return n;
}
