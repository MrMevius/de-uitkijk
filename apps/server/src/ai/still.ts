import type { StoredCandidate } from '../highlights/store.ts';

/**
 * Full-resolution (4K) frame from Frigate's recording at the highlight's AI moment (operator decision): plates and
 * vehicles are far more legible than in the 640x360 detection snapshot. Undefined when Frigate has no such frame.
 */
export const recordingStill =
  (frigateUrl: string, fetcher: typeof fetch) =>
  async (c: StoredCandidate): Promise<Uint8Array | undefined> => {
    if (!c.frameTime) return undefined;
    const res = await fetcher(`${frigateUrl}/api/${encodeURIComponent(c.frigateCamera)}/recordings/${c.frameTime.toFixed(2)}/snapshot.jpg`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return undefined;
    const jpeg = new Uint8Array(await res.arrayBuffer());
    return jpeg[0] === 0xff && jpeg[1] === 0xd8 ? jpeg : undefined;
  };
