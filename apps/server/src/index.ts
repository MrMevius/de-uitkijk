import { join } from 'node:path';
import { buildApp } from './app.ts';
import { AuthStore } from './auth/store.ts';
import { ClipCache } from './highlights/clips.ts';
import { HighlightImporter } from './highlights/importer.ts';
import { HighlightStore } from './highlights/store.ts';
import { loadConfig } from './config.ts';
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
// Highlights need Frigate (live mode) and a login (they show recorded video).
const highlightStore = config.frigate && store ? new HighlightStore(join(config.dataDir, 'uitkijk.db')) : undefined;
const clips = highlightStore ? new ClipCache(join(config.dataDir, 'clip-cache'), config.clipCacheBytes) : undefined;
const app = buildApp({
  hub,
  ...(config.devApi && mock ? { mock } : {}),
  ...(store ? { auth: { store, publicUrl: config.publicUrl } } : {}),
  ...(highlightStore && clips && config.frigate ? { highlights: { store: highlightStore, clips, frigateUrl: config.frigate.url } } : {}),
  logger: true,
});
const importer =
  highlightStore && config.frigate
    ? new HighlightImporter(highlightStore, {
        frigateUrl: config.frigate.url,
        cameras: config.cameras,
        log: (msg) => app.log.warn(msg),
      })
    : undefined;
importer?.start();

mock?.start(config.mockScenario);
const frigate = config.frigate
  ? new FrigateSource(hub, config.cameras, { ...config.frigate, log: (msg) => app.log.warn(msg) })
  : undefined;
frigate?.start();

const probe = config.go2rtcUrl
  ? new StreamingProbe(hub, config.go2rtcUrl, { suppressed: () => mock?.streamingSimulated ?? false })
  : undefined;
probe?.start();

app.log.info(
  { mode: config.mode, cameras: config.cameras.map((c) => c.id), go2rtcProbe: Boolean(probe), login: Boolean(store), highlights: Boolean(importer) },
  'De Uitkijk server starting',
);

const shutdown = async () => {
  mock?.stop();
  frigate?.stop();
  probe?.stop();
  importer?.stop();
  hub.stop();
  clearInterval(purge);
  await app.close();
  store?.close();
  highlightStore?.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: config.host, port: config.port });
