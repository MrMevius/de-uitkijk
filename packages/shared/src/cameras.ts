import { MAX_CAMERAS, type Camera, type CameraConfig } from './types.ts';

const ID_PATTERN = /^[a-z0-9_]{1,32}$/;
const STREAM_PATTERN = /^[a-z0-9_]{1,64}$/;

export class CameraConfigError extends Error {}

/**
 * Validates a camera configuration and returns cameras in their shared order.
 * The order is the array order; it is the single ordering used by every client.
 */
export function parseCameraConfig(input: unknown): Camera[] {
  const list = (input as { cameras?: unknown } | null)?.cameras;
  if (!Array.isArray(list)) throw new CameraConfigError('camera config must contain a "cameras" array');
  if (list.length === 0) throw new CameraConfigError('at least one camera is required');
  if (list.length > MAX_CAMERAS) {
    throw new CameraConfigError(`at most ${MAX_CAMERAS} cameras are supported, got ${list.length}`);
  }

  const ids = new Set<string>();
  const frigateNames = new Set<string>();
  return list.map((raw: Partial<CameraConfig>, order): Camera => {
    const where = `camera #${order + 1}`;
    if (typeof raw?.id !== 'string' || !ID_PATTERN.test(raw.id)) {
      throw new CameraConfigError(`${where}: id must match ${ID_PATTERN}`);
    }
    if (ids.has(raw.id)) throw new CameraConfigError(`${where}: duplicate id "${raw.id}"`);
    ids.add(raw.id);
    if (typeof raw.name !== 'string' || raw.name.trim() === '') {
      throw new CameraConfigError(`${where}: name is required`);
    }
    for (const kind of ['main', 'sub'] as const) {
      const name = raw.streams?.[kind];
      if (typeof name !== 'string' || !STREAM_PATTERN.test(name)) {
        throw new CameraConfigError(`${where}: streams.${kind} must match ${STREAM_PATTERN}`);
      }
    }
    if (raw.frigateCamera !== undefined) {
      if (typeof raw.frigateCamera !== 'string' || raw.frigateCamera === '') {
        throw new CameraConfigError(`${where}: frigateCamera must be a non-empty string`);
      }
      if (frigateNames.has(raw.frigateCamera)) {
        throw new CameraConfigError(`${where}: frigateCamera "${raw.frigateCamera}" is mapped twice`);
      }
      frigateNames.add(raw.frigateCamera);
    }
    return {
      id: raw.id,
      name: raw.name.trim(),
      ...(raw.frigateCamera ? { frigateCamera: raw.frigateCamera } : {}),
      streams: { main: raw.streams!.main, sub: raw.streams!.sub },
      order,
      availability: 'unknown',
    };
  });
}
