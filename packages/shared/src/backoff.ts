export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Relative jitter, for example 0.2 for ±20 %. */
  jitter?: number;
}

/**
 * Bounded exponential backoff: base·2^attempt capped at maxMs, with optional symmetric jitter.
 * Retrying never stops (a kiosk must recover on its own), but the interval never drops below baseMs
 * after a failure, so failures cannot turn into a tight reconnect loop.
 */
export function backoffDelay(attempt: number, options: BackoffOptions = {}, random: () => number = Math.random): number {
  const { baseMs = 1_000, maxMs = 30_000, jitter = 0.2 } = options;
  const raw = Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(attempt, 30)));
  const jittered = raw * (1 + jitter * (random() * 2 - 1));
  return Math.round(Math.min(maxMs, Math.max(baseMs, jittered)));
}
