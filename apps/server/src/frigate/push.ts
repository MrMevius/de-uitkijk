import { randomBytes } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import { backoffDelay } from '@uitkijk/shared';

/**
 * Frigate's websocket (`/ws`) as a wake-up signal: Frigate publishes every tracked-object change (`events`) and
 * review change (`reviews`) there, so De Uitkijk polls the review API right away instead of within 2 s. Polling
 * stays the source of truth; without the websocket everything keeps working, only slightly later.
 *
 * A small client on node:http(s), because Node's built-in WebSocket can neither send Frigate's session cookie
 * nor trust only the pinned certificate. Verified against Frigate 0.17.2 (2026-11-09): text frames with
 * `{"topic": "...", "payload": "..."}`.
 */
export interface FrigatePushOptions {
  /** Frigate base URL (http or https). */
  url: string;
  /** Session cookie for the authenticated API; `renew` after a refused upgrade. */
  session?: (renew?: boolean) => Promise<string>;
  /** Pinned certificate (PEM) of the authenticated API. */
  certificate?: string;
  /** Called for every message with its topic. */
  onTopic: (topic: string) => void;
  log?: (msg: string) => void;
}

export class FrigatePush {
  private readonly opts: FrigatePushOptions;
  private socket: Duplex | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private stopped = true;
  connected = false;

  constructor(options: FrigatePushOptions) {
    this.opts = options;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.destroy();
  }

  private async connect(renew = false): Promise<void> {
    let cookie: string | undefined;
    try {
      cookie = await this.opts.session?.(renew);
    } catch (err) {
      return this.retry(`login: ${(err as Error).message}`);
    }
    const url = new URL('/ws', this.opts.url);
    const secure = url.protocol === 'https:';
    const req = (secure ? httpsRequest : httpRequest)(url, {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        ...(cookie ? { cookie } : {}),
      },
      ...(secure && this.opts.certificate ? { ca: this.opts.certificate, checkServerIdentity: () => undefined } : {}),
    });
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
    req.on('upgrade', (_res: IncomingMessage, socket: Duplex, head: Buffer) => this.attach(socket, head));
    req.on('response', (res: IncomingMessage) => {
      res.resume();
      // 401: the session expired; log in again on the next attempt.
      this.retry(`HTTP ${res.statusCode}`, res.statusCode === 401);
    });
    req.on('error', (err) => this.retry(err.message));
    req.end();
  }

  private attach(socket: Duplex, head: Buffer): void {
    this.socket = socket;
    this.connected = true;
    this.failures = 0;
    const frames = new FrameReader((opcode, data) => {
      if (opcode === 0x1) {
        try {
          const topic = (JSON.parse(data.toString('utf8')) as { topic?: unknown }).topic;
          if (typeof topic === 'string') this.opts.onTopic(topic);
        } catch {
          // Not JSON: ignore.
        }
      } else if (opcode === 0x9) {
        socket.write(clientFrame(0xa, data));
      } else if (opcode === 0x8) {
        socket.end(clientFrame(0x8, Buffer.alloc(0)));
      }
    });
    socket.on('data', (chunk: Buffer) => frames.push(chunk));
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      this.connected = false;
      this.socket = undefined;
      this.retry('closed');
    });
    if (head.length) frames.push(head);
  }

  private retry(reason: string, renew = false): void {
    this.connected = false;
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.failures++;
    // Only repeated failures are worth a log line (Frigate restarts close the socket now and then).
    if (this.failures === 3) this.opts.log?.(`frigate push unavailable (${reason}); polling continues`);
    this.timer = setTimeout(() => void this.connect(renew), backoffDelay(this.failures - 1, { baseMs: 2_000, maxMs: 60_000 }));
  }
}

/** Reassembles server frames (unmasked, possibly fragmented) into messages. */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);
  private parts: Buffer[] = [];
  private partOpcode = 0;
  private readonly onMessage: (opcode: number, data: Buffer) => void;

  constructor(onMessage: (opcode: number, data: Buffer) => void) {
    this.onMessage = onMessage;
  }

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.buffer.length < 2) return;
      const fin = (this.buffer[0]! & 0x80) !== 0;
      const opcode = this.buffer[0]! & 0x0f;
      const masked = (this.buffer[1]! & 0x80) !== 0;
      let length = this.buffer[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      let data = this.buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = this.buffer.subarray(maskOffset, maskOffset + 4);
        data = Buffer.from(data.map((b, i) => b ^ mask[i % 4]!));
      }
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode >= 0x8) {
        this.onMessage(opcode, Buffer.from(data));
      } else {
        if (opcode !== 0) this.partOpcode = opcode;
        this.parts.push(Buffer.from(data));
        if (fin) {
          this.onMessage(this.partOpcode, Buffer.concat(this.parts));
          this.parts = [];
        }
      }
    }
  }
}

/** A masked client frame (RFC 6455: clients must mask). */
export function clientFrame(opcode: number, data: Buffer): Buffer {
  const mask = randomBytes(4);
  const header = data.length < 126 ? Buffer.from([0x80 | opcode, 0x80 | data.length]) : Buffer.from([0x80 | opcode, 0x80 | 126, data.length >> 8, data.length & 0xff]);
  return Buffer.concat([header, mask, Buffer.from(data.map((b, i) => b ^ mask[i % 4]!))]);
}
