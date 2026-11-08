import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from './app.ts';
import { CameraVideoProbe } from './camera-probe.ts';
import { AuthStore } from './auth/store.ts';
import { codexDescriber } from './ai/codex.ts';
import { FactStore } from './ai/facts.ts';
import { AiWorker } from './ai/worker.ts';
import { ClipCache } from './highlights/clips.ts';
import { HighlightImporter } from './highlights/importer.ts';
import { HighlightStore } from './highlights/store.ts';
import { loadConfig } from './config.ts';
import { frigateFetch, readFrigateAuth } from './frigate/client.ts';
import { FrigateSource } from './frigate/frigate-source.ts';
import { StateHub } from './hub.ts';
import { MockSource } from './mock/mock-source.ts';
import { StreamingProbe } from './streaming-probe.ts';

const config = loadConfig();
const hub = new StateHub(config.mode, config.cameras, config.holdMs);
const mock =
  config.mode === 'mock'
    ? new MockSource(
        hub,
        config.cameras.map((c) => c.id),
      )
    : undefined;
// Live mode always requires login: real camera images are never served without a session.
const store = config.login ? new AuthStore(join(config.dataDir, 'uitkijk.db')) : undefined;
store?.purgeExpired();
const purge = setInterval(() => store?.purgeExpired(), 3600_000);
// One Frigate client for alerts, highlights and clips: the authenticated API when credentials are configured.
const frigateAuth = config.frigate ? readFrigateAuth(config.frigate.authFile) : undefined;
const frigateHttp = config.frigate ? frigateFetch(config.frigate.url, frigateAuth) : undefined;
// Highlights need Frigate (live mode) and a login (they show recorded video).
const highlightStore = config.frigate && store ? new HighlightStore(join(config.dataDir, 'uitkijk.db')) : undefined;
const clips = highlightStore ? new ClipCache(join(config.dataDir, 'clip-cache'), config.clipCacheBytes, undefined, frigateHttp) : undefined;
// Codex keeps its ChatGPT login here; created up front so an administrator can sign in before enabling AI.
if (highlightStore) mkdirSync(join(config.dataDir, 'codex'), { recursive: true, mode: 0o700 });
const facts = highlightStore ? new FactStore(join(config.dataDir, 'uitkijk.db')) : undefined;
// AI descriptions (AI-4: only when the owner enabled them; AI-7: isolated, failures never affect the rest).
const ai =
  highlightStore && config.ai === 'codex'
    ? new AiWorker(highlightStore, codexDescriber({ codexHome: join(config.dataDir, 'codex'), model: config.aiModel }), {
        cameras: config.cameras,
        model: config.aiModel,
        facts: () => facts?.list().map((f) => f.text) ?? [],
        // Full-resolution frame from Frigate's recording (1080p): plates and vehicles are far more legible
        // than in the 640x360 detection snapshot.
        still: async (c) => {
          if (!frigateHttp || !config.frigate || !c.frameTime) return undefined;
          const res = await frigateHttp(
            `${config.frigate.url}/api/${encodeURIComponent(c.frigateCamera)}/recordings/${c.frameTime.toFixed(2)}/snapshot.jpg?height=1080`,
            { signal: AbortSignal.timeout(20_000) },
          );
          if (!res.ok) return undefined;
          const jpeg = new Uint8Array(await res.arrayBuffer());
          return jpeg[0] === 0xff && jpeg[1] === 0xd8 ? jpeg : undefined;
        },
        // `app` exists by the time the worker logs (it starts after the app is built).
        log: (msg) => app.log.warn(msg),
      })
    : undefined;
// Per-camera picture check for monitoring (live mode only; mock streams are synthetic).
const cameraProbe = config.mode === 'live' && config.go2rtcUrl ? new CameraVideoProbe(config.cameras, config.go2rtcUrl) : undefined;
let importer: HighlightImporter | undefined;
const version = (() => {
  try {
    return readFileSync('VERSION', 'utf8').trim();
  } catch {
    return undefined;
  }
})();
const app = buildApp({
  hub,
  ...(version ? { version } : {}),
  detail: () => ({
    cameras: cameraProbe?.snapshot() ?? [],
    highlights: importer ? { enabled: true, lastOkAt: importer.lastOkAt, lastError: importer.lastError } : { enabled: false },
    ai: ai ? ai.status() : { enabled: false },
  }),
  ...(config.devApi && mock ? { mock } : {}),
  ...(store ? { auth: { store, publicUrl: config.publicUrl } } : {}),
  ...(highlightStore && clips && config.frigate ? { highlights: { store: highlightStore, clips, frigateUrl: config.frigate.url, ...(ai ? { aiStatus: () => ai.status() } : {}), ...(facts ? { facts } : {}) } } : {}),
  logger: true,
});
importer =
  highlightStore && config.frigate
    ? new HighlightImporter(highlightStore, {
        frigateUrl: config.frigate.url,
        cameras: config.cameras,
        ...(frigateHttp ? { fetch: frigateHttp } : {}),
        log: (msg) => app.log.warn(msg),
      })
    : undefined;
importer?.start();
cameraProbe?.start();
ai?.start();

mock?.start(config.mockScenario);
const frigate = config.frigate
  ? new FrigateSource(hub, config.cameras, {
      url: config.frigate.url,
      pollMs: config.frigate.pollMs,
      maxAlertAgeMs: config.frigate.maxAlertAgeMs,
      ...(frigateHttp ? { fetch: frigateHttp } : {}),
      log: (msg) => app.log.warn(msg),
    })
  : undefined;
frigate?.start();

const probe = config.go2rtcUrl
  ? new StreamingProbe(hub, config.go2rtcUrl, { suppressed: () => mock?.streamingSimulated ?? false })
  : undefined;
probe?.start();

app.log.info(
  { mode: config.mode, cameras: config.cameras.map((c) => c.id), go2rtcProbe: Boolean(probe), login: Boolean(store), frigateAuth: Boolean(frigateAuth), highlights: Boolean(importer), ai: config.ai, aiModel: config.ai === 'codex' ? config.aiModel : undefined },
  'De Uitkijk server starting',
);

const shutdown = async () => {
  mock?.stop();
  frigate?.stop();
  probe?.stop();
  importer?.stop();
  cameraProbe?.stop();
  ai?.stop();
  hub.stop();
  clearInterval(purge);
  await app.close();
  store?.close();
  highlightStore?.close();
  facts?.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: config.host, port: config.port });
