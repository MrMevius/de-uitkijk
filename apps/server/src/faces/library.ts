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
  /** Quiet time after the last deletion before Frigate's face model is rebuilt once more. */
  rebuildDelayMs?: number;
}

/** Cached view of the face library plus the two write actions De Uitkijk needs (admin role in Frigate). */
export class FaceLibrary {
  private readonly url: string;
  private readonly fetch: typeof fetch;
  private names: string[] = [];
  private attempts: FaceAttempt[] = [];
  private library = new Map<string, string[]>();
  /** False until the library was read once; callers must not draw conclusions from an empty cache. */
  ready = false;
  lastError: string | null = null;

  private readonly rebuildDelayMs: number;

  constructor({ frigateUrl, fetch: f = globalThis.fetch, rebuildDelayMs = 20_000 }: FaceLibraryOptions) {
    this.url = frigateUrl.replace(/\/$/, '');
    this.fetch = f;
    this.rebuildDelayMs = rebuildDelayMs;
  }

  async refresh(): Promise<void> {
    try {
      // Frigate's nginx caches /api/faces for up to a minute; a list right after a change must be current.
      const res = await this.fetch(`${this.url}/api/faces`, { headers: { 'x-cache-bypass': '1' }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`Frigate /api/faces HTTP ${res.status}`);
      const body = (await res.json()) as Record<string, string[]>;
      this.names = Object.keys(body)
        .filter((n) => n !== 'train')
        .sort();
      this.library = new Map(this.names.map((n) => [n, body[n] ?? []]));
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

  /** The images per person in the library, newest first (the time is part of Frigate's file name). */
  libraryImages(): { name: string; images: { file: string; time: number | null }[] }[] {
    return this.names.map((name) => ({
      name,
      images: (this.library.get(name) ?? [])
        .map((file) => ({ file, time: libraryTime(name, file) ?? null }))
        .sort((a, b) => (b.time ?? 0) - (a.time ?? 0)),
    }));
  }

  /** One library image (WebP), only for a known name and a file of that person. */
  async libraryImage(name: string, file: string): Promise<Uint8Array | undefined> {
    if (!this.isLibraryFile(name, file)) return undefined;
    const res = await this.fetch(`${this.url}/clips/faces/${encodeURIComponent(name)}/${encodeURIComponent(file)}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return (await res.body?.cancel(), undefined);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Removes images from a person's library, e.g. a face that is somebody else (since 0.20.0). */
  async deleteImages(name: string, files: string[]): Promise<number> {
    const valid = files.filter((f) => this.isLibraryFile(name, f));
    if (!valid.length) return 0;
    const res = await this.fetch(`${this.url}/api/faces/${encodeURIComponent(name)}/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': '1' },
      body: JSON.stringify({ ids: valid }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`Frigate face deletion HTTP ${res.status}${text ? `: ${text}` : ''}`);
    }
    await res.body?.cancel();
    this.library.set(name, (this.library.get(name) ?? []).filter((f) => !valid.includes(f)));
    this.scheduleRebuild(name);
    return valid.length;
  }

  private rebuildTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Frigate rebuilds its face model in the background after every change. With several deletions in a row a
   * rebuild can start before the last one and keep a removed person (seen 2026-11-09: "Arjan" stayed after his
   * folder was gone, until a restart). So once things are quiet, ask once more: a delete without files only
   * clears the model, which Frigate then rebuilds from the folders as they are.
   */
  private scheduleRebuild(name: string): void {
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      const anyName = this.names.find((n) => (this.library.get(n) ?? []).length > 0) ?? name;
      void this.fetch(`${this.url}/api/faces/${encodeURIComponent(anyName)}/delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': '1' },
        body: JSON.stringify({ ids: [] }),
        signal: AbortSignal.timeout(15_000),
      })
        .then((res) => res.body?.cancel())
        .catch(() => undefined);
    }, this.rebuildDelayMs);
    this.rebuildTimer.unref?.();
  }

  private isLibraryFile(name: string, file: string): boolean {
    return (this.library.get(name) ?? []).includes(file) && libraryTime(name, file) !== undefined;
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

  /**
   * Registers the face Frigate finds in an image, then checks the crop Frigate stored: a side view or a tiny face
   * teaches it nothing and makes it mix people up (Arjan's three crops of 2026-11-09 were a forehead, a blurry
   * side view and an ear: 30x63, 43x65 and 49x83 px). Such a crop is removed again. Returns whether it was kept.
   */
  async registerChecked(name: string, jpeg: Uint8Array): Promise<boolean> {
    await this.refresh();
    const before = new Set(this.library.get(name) ?? []);
    await this.register(name, jpeg);
    await this.refresh();
    const added = (this.library.get(name) ?? []).filter((f) => !before.has(f));
    let kept = false;
    const reject: string[] = [];
    for (const file of added) {
      const size = webpSize((await this.libraryImage(name, file)) ?? new Uint8Array());
      if (size && usableFace(size)) kept = true;
      else reject.push(file);
    }
    if (reject.length) await this.deleteImages(name, reject);
    return kept;
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

/**
 * Seconds since epoch from a library file name ("Tineke Mevius-1771419626.643532.webp"; "_" for images registered
 * through the API); null when the name has no time; undefined when the file is not one of this person's images.
 */
export function libraryTime(name: string, file: string): number | null | undefined {
  if (!file.startsWith(name) || !file.endsWith('.webp') || /[/\\]|\.\./.test(file)) return undefined;
  const m = /^[-_](\d+(?:\.\d+)?)\.webp$/.exec(file.slice(name.length));
  return m ? Number(m[1]) : null;
}

/** A face crop worth learning from: at least 40 px wide and not narrow like a side view (width/height ≥ 0.68). */
export const usableFace = ({ width, height }: { width: number; height: number }) => width >= 40 && width / height >= 0.68;

/** Width and height of a WebP image (lossy, lossless or extended), or undefined. */
export function webpSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length < 30 || String.fromCharCode(...b.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...b.subarray(8, 12)) !== 'WEBP') return undefined;
  const chunk = String.fromCharCode(...b.subarray(12, 16));
  const u16 = (o: number) => b[o]! | (b[o + 1]! << 8);
  const u24 = (o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
  if (chunk === 'VP8 ') return { width: u16(26) & 0x3fff, height: u16(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const v = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { width: u24(24) + 1, height: u24(27) + 1 };
  return undefined;
}
