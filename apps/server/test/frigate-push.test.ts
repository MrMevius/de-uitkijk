import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrameReader, FrigatePush, clientFrame } from '../src/frigate/push.ts';
import { FrigateSource } from '../src/frigate/frigate-source.ts';
import { StateHub } from '../src/hub.ts';
import { parseCameraConfig } from '@uitkijk/shared';

/** An unmasked server frame. */
const serverFrame = (opcode: number, data: Buffer, fin = true) => {
  const len = data.length;
  const header =
    len < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, len]) : len < 65536 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 126, len >> 8, len & 0xff]) : (() => {
      const h = Buffer.alloc(10);
      h[0] = (fin ? 0x80 : 0) | opcode;
      h[1] = 127;
      h.writeBigUInt64BE(BigInt(len), 2);
      return h;
    })();
  return Buffer.concat([header, data]);
};
const text = (o: unknown) => Buffer.from(JSON.stringify(o));

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

describe('Frigate push (websocket)', () => {
  it('reassembles split, long, fragmented and masked frames', () => {
    const got: [number, string][] = [];
    const reader = new FrameReader((op, d) => got.push([op, op === 1 ? (JSON.parse(d.toString()) as { topic: string }).topic : d.toString()]));
    const long = serverFrame(1, text({ topic: 'stats', payload: 'x'.repeat(70_000) }));
    const both = Buffer.concat([serverFrame(1, text({ topic: 'events', payload: '{}' })), long]);
    // Delivered in awkward pieces.
    for (let i = 0; i < both.length; i += 7_001) reader.push(both.subarray(i, i + 7_001));
    const msg = text({ topic: 'reviews', payload: '{}' });
    reader.push(serverFrame(1, msg.subarray(0, 5), false));
    reader.push(serverFrame(0x9, Buffer.from('p')));
    reader.push(serverFrame(0, msg.subarray(5)));
    // A masked frame (what a client sends) decodes too.
    reader.push(clientFrame(0x1, text({ topic: 'masked' })));
    expect(got).toEqual([
      [1, 'events'],
      [1, 'stats'],
      [9, 'p'],
      [1, 'reviews'],
      [1, 'masked'],
    ]);
  });

  it('connects with the session cookie, reports topics and answers pings', async () => {
    const seen: { cookie?: string; pong?: Buffer } = {};
    server = createServer((_req, res) => res.writeHead(400).end());
    server.on('upgrade', (req, socket) => {
      seen.cookie = req.headers.cookie;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      socket.write(Buffer.concat([serverFrame(1, text({ topic: 'events', payload: '{}' })), serverFrame(9, Buffer.from('hi'))]));
      socket.on('data', (d: Buffer) => {
        new FrameReader((op, data) => op === 0xa && (seen.pong = data)).push(d);
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const topics: string[] = [];
    const session = vi.fn(async () => 'frigate_token=abc');
    const push = new FrigatePush({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, session, onTopic: (t) => topics.push(t) });
    push.start();
    await vi.waitFor(() => expect(topics).toEqual(['events']));
    await vi.waitFor(() => expect(seen.pong?.toString()).toBe('hi'));
    expect(seen.cookie).toBe('frigate_token=abc');
    expect(push.connected).toBe(true);
    push.stop();
  });

  it('polls Frigate at once on a push, at most every 500 ms', async () => {
    const cameras = parseCameraConfig({ cameras: [{ id: 'oprit', name: 'Oprit', order: 1, frigateCamera: 'oprit', streams: { main: 'm', sub: 's' } }] });
    let reviews = 0;
    const fetchStub = (async (url: string) => {
      if (url.includes('/api/review')) reviews++;
      return Response.json(url.includes('/api/config') ? { cameras: { oprit: {} } } : url.includes('/api/stats') ? { cameras: {} } : []);
    }) as typeof fetch;
    const hub = new StateHub('live', cameras, 15_000);
    const source = new FrigateSource(hub, cameras, { url: 'http://f', pollMs: 60_000, maxAlertAgeMs: 600_000, fetch: fetchStub });
    source.start();
    await vi.waitFor(() => expect(reviews).toBe(1));
    source.wake();
    await vi.waitFor(() => expect(reviews).toBe(2));
    source.wake();
    await new Promise((r) => setTimeout(r, 50));
    expect(reviews).toBe(2);
    source.stop();
    hub.stop();
  });
});
