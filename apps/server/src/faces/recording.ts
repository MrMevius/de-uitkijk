import { spawn } from 'node:child_process';

/**
 * Person crops from Frigate's full-resolution (4K) recording, for face learning when Frigate kept no face crop of
 * its own: Frigate looks for faces in the 640x360 detection stream, where a face is rarely the 500 px² it needs,
 * while the recording of the same moment shows the face clearly (checked 2026-11-09).
 */

/** Normalised rectangle (0..1) of a frame. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PersonTrack {
  id: string;
  camera: string;
  start: number;
  end: number;
  /** Box at the best detection ([x, y, w, h], normalised). */
  box: [number, number, number, number];
  /** Bottom centre of the person over time. */
  path: { x: number; y: number; t: number }[];
}

export type Cropper = (jpeg: Uint8Array, rect: Rect) => Promise<Uint8Array>;

/** JPEG crop with ffmpeg through pipes (no files). */
export const ffmpegCrop: Cropper = (jpeg, r) =>
  new Promise((resolve, reject) => {
    const crop = `crop=iw*${r.w.toFixed(4)}:ih*${r.h.toFixed(4)}:iw*${r.x.toFixed(4)}:ih*${r.y.toFixed(4)}`;
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vf', crop, '-f', 'mjpeg', '-q:v', '2', 'pipe:1']);
    const out: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}`))));
    proc.stdin.end(Buffer.from(jpeg));
  });

/** The part of the frame around a person standing at `point`: their full height (as at the best detection) and some room beside. */
export function personRect(box: PersonTrack['box'], point: { x: number; y: number }): Rect {
  const w = Math.min(1, box[2] * 1.6);
  const h = Math.min(1, box[3] * 1.1);
  const clamp = (v: number, size: number) => Math.min(Math.max(0, v), 1 - size);
  return { x: clamp(point.x - w / 2, w), y: clamp(point.y - h, h), w, h };
}

/**
 * People worth looking at: tall enough in the frame to show a face, and alone on their camera at that time
 * (with two people in view, the answer cannot say whose face is whose).
 */
export function singlePeople(tracks: PersonTrack[], minHeight: number): PersonTrack[] {
  const overlaps = (a: PersonTrack, b: PersonTrack) => a !== b && a.camera === b.camera && a.start < b.end && b.start < a.end;
  return tracks.filter((t) => t.box[3] >= minHeight && t.path.length > 0 && !tracks.some((o) => overlaps(t, o)));
}

/** Moments to look at: those where the person stands closest to where they were seen best, spread over the track. */
export function moments(track: PersonTrack, n: number): PersonTrack['path'] {
  const bottom = track.box[1] + track.box[3];
  const nearest = [...track.path].sort((a, b) => Math.abs(a.y - bottom) - Math.abs(b.y - bottom)).slice(0, n * 2);
  nearest.sort((a, b) => a.t - b.t);
  const step = Math.max(1, nearest.length / n);
  return Array.from({ length: Math.min(n, nearest.length) }, (_, i) => nearest[Math.floor(i * step)]!);
}

export interface RecordingFacesOptions {
  frigateUrl: string;
  fetch?: typeof fetch;
  crop?: Cropper;
  /** Frames looked at per person. */
  perPerson?: number;
  /** Minimum height of the person (fraction of the frame) at the best detection. */
  minHeight?: number;
}

export class RecordingFaces {
  private readonly url: string;
  private readonly fetch: typeof fetch;
  private readonly crop: Cropper;
  private readonly perPerson: number;
  private readonly minHeight: number;

  constructor({ frigateUrl, fetch: f = globalThis.fetch, crop = ffmpegCrop, perPerson = 8, minHeight = 0.25 }: RecordingFacesOptions) {
    this.url = frigateUrl.replace(/\/$/, '');
    this.fetch = f;
    this.crop = crop;
    this.perPerson = perPerson;
    this.minHeight = minHeight;
  }

  /** Crops of each single, large enough person among these Frigate detections (JPEG). */
  async crops(eventIds: string[]): Promise<Uint8Array[]> {
    const tracks: PersonTrack[] = [];
    for (const id of eventIds) {
      const t = await this.track(id);
      if (t) tracks.push(t);
    }
    const out: Uint8Array[] = [];
    for (const t of singlePeople(tracks, this.minHeight)) {
      for (const p of moments(t, this.perPerson)) {
        const frame = await this.frame(t.camera, p.t);
        if (frame) out.push(await this.crop(frame, personRect(t.box, p)));
      }
    }
    return out;
  }

  private async track(id: string): Promise<PersonTrack | undefined> {
    const res = await this.fetch(`${this.url}/api/events/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return (await res.body?.cancel(), undefined);
    if (!res.ok) throw new Error(`Frigate event HTTP ${res.status}`);
    const e = (await res.json()) as {
      label?: string;
      camera?: string;
      start_time?: number;
      end_time?: number | null;
      data?: { box?: number[]; path_data?: [[number, number], number][] };
    };
    const box = e.data?.box;
    if (e.label !== 'person' || !e.camera || !e.start_time || box?.length !== 4) return undefined;
    return {
      id,
      camera: e.camera,
      start: e.start_time,
      end: e.end_time ?? e.start_time,
      box: box as PersonTrack['box'],
      path: (e.data?.path_data ?? []).map(([[x, y], t]) => ({ x, y, t })),
    };
  }

  private async frame(camera: string, time: number): Promise<Uint8Array | undefined> {
    const res = await this.fetch(`${this.url}/api/${encodeURIComponent(camera)}/recordings/${time.toFixed(2)}/snapshot.jpg`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return (await res.body?.cancel(), undefined);
    const jpeg = new Uint8Array(await res.arrayBuffer());
    return jpeg[0] === 0xff && jpeg[1] === 0xd8 ? jpeg : undefined;
  }
}
