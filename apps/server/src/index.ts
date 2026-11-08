import { join } from 'node:path';
import { buildApp } from './app.ts';
import { AuthStore } from './auth/store.ts';
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
const store = config.dataDir ? new AuthStore(join(config.dataDir, 'uitkijk.db')) : undefined;
store?.purgeExpired();
const purge = setInterval(() => store?.purgeExpired(), 3600_000);
const app = buildApp({
  hub,
  ...(config.devApi && mock ? { mock } : {}),
  ...(store ? { auth: { store, publicUrl: config.publicUrl } } : {}),
  logger: true,
});

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
  { mode: config.mode, cameras: config.cameras.map((c) => c.id), go2rtcProbe: Boolean(probe), login: Boolean(store) },
  'De Uitkijk server starting',
);

const shutdown = async () => {
  mock?.stop();
  frigate?.stop();
  probe?.stop();
  hub.stop();
  clearInterval(purge);
  await app.close();
  store?.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: config.host, port: config.port });
