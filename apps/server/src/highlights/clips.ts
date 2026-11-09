import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Re-wraps an MP4 without re-encoding: `hvc1` tag (required by Safari/iOS) and moov atom first. */
export type Remuxer = (input: string, output: string) => Promise<void>;

export const ffmpegRemux: Remuxer = (input, output) =>
  new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map', '0', '-c', 'copy'];
    args.push('-tag:v', 'hvc1', '-movflags', '+faststart', '-f', 'mp4', output);
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.trim()}`))));
  });

/**
 * A bounded, temporary cache of playable clips fetched from Frigate. Recordings stay in Frigate; this cache
 * only exists so browsers get byte ranges and a Safari-compatible container. Least recently used files are
 * removed when the cache exceeds its size.
 */
export class ClipCache {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly remux: Remuxer;
  private readonly fetch: typeof fetch;
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(dir: string, maxBytes: number, remux: Remuxer = ffmpegRemux, fetchImpl: typeof fetch = globalThis.fetch) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.remux = remux;
    this.fetch = fetchImpl;
  }

  /** Path of a playable file for `key`, downloading `sourceUrl` first if needed. */
  async get(key: string, sourceUrl: string): Promise<string> {
    if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new Error('invalid clip key');
    const file = join(this.dir, `${key}.mp4`);
    try {
      await stat(file);
      const now = new Date();
      await utimes(file, now, now);
      return file;
    } catch {
      // Not cached.
    }
    const running = this.inflight.get(key);
    if (running) return running;
    const job = this.download(file, sourceUrl).finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  private async download(file: string, sourceUrl: string): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const raw = `${file}.${process.pid}.${Date.now()}.src`;
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      const res = await this.fetch(sourceUrl, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok || !res.body) throw new Error(`Frigate clip HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(raw));
      await this.remux(raw, tmp);
      await rename(tmp, file);
    } finally {
      await rm(raw, { force: true });
      await rm(tmp, { force: true });
    }
    await this.evict();
    return file;
  }

  private async evict(): Promise<void> {
    const files = await Promise.all(
      (await readdir(this.dir)).filter((f) => f.endsWith('.mp4')).map(async (f) => {
        const s = await stat(join(this.dir, f));
        return { path: join(this.dir, f), size: s.size, used: s.mtimeMs };
      }),
    );
    let total = files.reduce((n, f) => n + f.size, 0);
    for (const f of files.sort((a, b) => a.used - b.used)) {
      if (total <= this.maxBytes) break;
      await rm(f.path, { force: true });
      total -= f.size;
    }
  }
}

/** Sends a file with single-range support (Safari requests ranges for video). */
export async function sendFileWithRanges(
  request: FastifyRequest,
  reply: FastifyReply,
  file: string,
  contentType: string,
  downloadName?: string,
): Promise<FastifyReply> {
  const { size } = await stat(file);
  reply.header('accept-ranges', 'bytes').header('content-type', contentType).header('cache-control', 'private, max-age=3600');
  if (downloadName) reply.header('content-disposition', `attachment; filename="${downloadName}"`);
  const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
  if (match && (match[1] || match[2])) {
    let start = match[1] ? Number(match[1]) : size - Number(match[2]);
    let end = match[1] && match[2] ? Number(match[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end) return reply.code(416).header('content-range', `bytes */${size}`).send();
    reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1);
    return reply.send(createReadStream(file, { start, end }));
  }
  reply.header('content-length', size);
  return reply.send(createReadStream(file));
}

/** A 640-px wide WebP thumbnail from a (4K) JPEG still, with ffmpeg through pipes (no files). */
export const ffmpegThumbnail = (jpeg: Uint8Array): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vf', 'scale=640:-2', '-f', 'webp', '-quality', '80', 'pipe:1']);
    const out: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}`))));
    proc.stdin.end(Buffer.from(jpeg));
  });
