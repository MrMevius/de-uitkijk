/**
 * Frigate's face library (face recognition, Frigate 0.17): known names, and the "train" attempts Frigate keeps
 * for faces it saw but did not recognise. An attempt is named `<event id>-<time>-<best guess>-<score>.webp`,
 * so it can be linked to a highlight through the highlight's detections.
 */

export interface FaceAttempt {
  /** File name in Frigate's train folder. */
  file: string;
  /** Frigate tracked-object id the face belongs to. */
  eventId: string;
  time: number;
  /** Frigate's best guess (a library name), or null for "unknown". */
  guess: string | null;
  score: number;
}

const ATTEMPT = /^(\d+\.\d+-[a-z0-9]+)-(\d+\.\d+)-(.+)-(\d+(?:\.\d+)?)\.webp$/;
/** Same shape as an attempt file name; used to validate file names from requests before proxying them. */
export const ATTEMPT_FILE = /^\d+\.\d+-[a-z0-9]+-\d+\.\d+-[\p{L}\p{N} _.'-]+-\d+(?:\.\d+)?\.webp$/u;

export function parseAttempt(file: string): FaceAttempt | null {
  const m = ATTEMPT.exec(file);
  if (!m) return null;
  return { file, eventId: m[1]!, time: Number(m[2]), guess: m[3] === 'unknown' ? null : m[3]!, score: Number(m[4]) };
}

/**
 * The library name an administrator meant: an exact (case-insensitive) match, else a unique first-name
 * match ("Tineke" → "Tineke Mevius"), else the typed name itself (a new person).
 */
export function matchFaceName(input: string, names: string[]): string {
  const typed = input.trim().replace(/\s+/g, ' ');
  const lower = typed.toLowerCase();
  const exact = names.find((n) => n.toLowerCase() === lower);
  if (exact) return exact;
  const byFirst = names.filter((n) => n.toLowerCase().split(' ')[0] === lower);
  return byFirst.length === 1 ? byFirst[0]! : typed;
}

export interface FaceLibraryOptions {
  frigateUrl: string;
  fetch?: typeof fetch;
}

/** Cached view of the face library plus the two write actions De Uitkijk needs (admin role in Frigate). */
export class FaceLibrary {
  private readonly url: string;
  private readonly fetch: typeof fetch;
  private names: string[] = [];
  private attempts: FaceAttempt[] = [];
  /** False until the library was read once; callers must not draw conclusions from an empty cache. */
  ready = false;
  lastError: string | null = null;

  constructor({ frigateUrl, fetch: f = globalThis.fetch }: FaceLibraryOptions) {
    this.url = frigateUrl.replace(/\/$/, '');
    this.fetch = f;
  }

  async refresh(): Promise<void> {
    try {
      const res = await this.fetch(`${this.url}/api/faces`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`Frigate /api/faces HTTP ${res.status}`);
      const body = (await res.json()) as Record<string, string[]>;
      this.names = Object.keys(body)
        .filter((n) => n !== 'train')
        .sort();
      this.attempts = (body.train ?? []).map(parseAttempt).filter((a): a is FaceAttempt => a !== null);
      this.ready = true;
      this.lastError = null;
    } catch (err) {
      this.lastError = (err as Error).message;
      throw err;
    }
  }

  knownNames(): string[] {
    return [...this.names];
  }

  /** Unrecognised faces of these tracked objects, best guess first. */
  attemptsFor(eventIds: string[]): FaceAttempt[] {
    const ids = new Set(eventIds);
    return this.attempts.filter((a) => ids.has(a.eventId)).sort((a, b) => b.score - a.score || a.time - b.time);
  }

  /** Moves a train attempt into the library under `name` (Frigate creates the person when new). */
  async classify(name: string, file: string): Promise<void> {
    const res = await this.fetch(`${this.url}/api/faces/train/${encodeURIComponent(name)}/classify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': '1' },
      body: JSON.stringify({ training_file: file }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`Frigate face training HTTP ${res.status}${text ? `: ${text}` : ''}`);
    }
    await res.body?.cancel();
    this.attempts = this.attempts.filter((a) => a.file !== file);
    if (!this.names.includes(name)) this.names = [...this.names, name].sort();
  }

  /**
   * Frigate's guess for the face in an image (name null for "unknown"), null when it finds no face, or undefined
   * when Frigate could not process it now (HTTP 500 "Could not process request", e.g. while its detector restarts).
   */
  async recognize(jpeg: Uint8Array): Promise<{ name: string | null; score: number } | null | undefined> {
    const res = await this.upload(`${this.url}/api/faces/recognize`, jpeg);
    const body = (await res.json().catch(() => ({}))) as { success?: boolean; face_name?: string; score?: number };
    if (res.status >= 500) return undefined;
    if (res.status === 400) return null;
    if (!res.ok) throw new Error(`Frigate face recognition HTTP ${res.status}`);
    if (!body.success) return null;
    return { name: !body.face_name || body.face_name === 'unknown' ? null : body.face_name, score: body.score ?? 0 };
  }

  /** Adds the face Frigate finds in an image to the library under `name` (Frigate creates the person when new). */
  async register(name: string, jpeg: Uint8Array): Promise<void> {
    const res = await this.upload(`${this.url}/api/faces/${encodeURIComponent(name)}/register`, jpeg);
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`Frigate face registration HTTP ${res.status}${text ? `: ${text}` : ''}`);
    }
    await res.body?.cancel();
    if (!this.names.includes(name)) this.names = [...this.names, name].sort();
  }

  /** Multipart upload of one JPEG as `file`, built by hand: the pinned-certificate fetch sends only bytes. */
  private upload(url: string, jpeg: Uint8Array): Promise<Response> {
    const boundary = `uitkijk${Math.random().toString(36).slice(2)}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="face.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      jpeg,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return this.fetch(url, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-csrf-token': '1' },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  }

  /** The face crop of a train attempt (WebP), for the questions tab. */
  async image(file: string): Promise<Uint8Array | undefined> {
    if (!ATTEMPT_FILE.test(file)) return undefined;
    const res = await this.fetch(`${this.url}/clips/faces/train/${encodeURIComponent(file)}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      await res.body?.cancel();
      return undefined;
    }
    return new Uint8Array(await res.arrayBuffer());
  }
}
