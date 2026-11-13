import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from './app.ts';
import { CameraVideoProbe } from './camera-probe.ts';
import { AuthStore } from './auth/store.ts';
import { codexDescriber, codexImageCall } from './ai/codex.ts';
import { codexFactWriter } from './ai/fact-writer.ts';
import { AiLog, loggedCall, type AiPurpose } from './ai/log.ts';
import { FactStore } from './ai/facts.ts';
import { knownPlates, looseObjectFact, plateMatches, promptKnowledge, vehicleKnown, type Register } from './ai/knowledge.ts';
import { AiWorker, ffmpegToJpeg } from './ai/worker.ts';
import { FaceLibrary } from './faces/library.ts';
import { Bundler, type PersonAnswer } from './household/bundle.ts';
import { HouseholdStore, vehicleLabel } from './household/store.ts';
import { BundleScheduler } from './household/schedule.ts';
import { DisplayRegistry } from './displays.ts';
import { DbBackup } from './backup.ts';
import { FaceWorker } from './faces/worker.ts';
import { RecordingFaces } from './faces/recording.ts';
import { ClipCache, ffmpegThumbnail } from './highlights/clips.ts';
import { HighlightImporter, RESELECT_S } from './highlights/importer.ts';
import { selectHighlights } from './highlights/selection.ts';
import { HighlightStore, type StoredCandidate } from './highlights/store.ts';
import { FactWorker } from './questions/fact-worker.ts';
import { QuestionGenerator } from './questions/generator.ts';
import { applyPersonAnswer, parsePersonAnswer, VEHICLE_ANNOTATION, vehicleIsSubject } from './questions/routes.ts';
import { QuestionStore } from './questions/store.ts';
import { loadConfig } from './config.ts';
import { frigateFetch, readFrigateAuth } from './frigate/client.ts';
import { KnownPlatesSync } from './frigate/known-plates.ts';
import { FrigateSource } from './frigate/frigate-source.ts';
import { FrigatePush } from './frigate/push.ts';
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
// Full-resolution (4K) frame from Frigate's recording (operator decision) for the AI: plates and vehicles are far
// more legible than in the 640x360 detection snapshot.
const highlightStill = async (c: StoredCandidate): Promise<Uint8Array | undefined> => {
  if (!frigateHttp || !config.frigate || !c.frameTime) return undefined;
  const res = await frigateHttp(
    `${config.frigate.url}/api/${encodeURIComponent(c.frigateCamera)}/recordings/${c.frameTime.toFixed(2)}/snapshot.jpg`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!res.ok) return undefined;
  const jpeg = new Uint8Array(await res.arrayBuffer());
  return jpeg[0] === 0xff && jpeg[1] === 0xd8 ? jpeg : undefined;
};
const facts = highlightStore ? new FactStore(join(config.dataDir, 'uitkijk.db')) : undefined;
const questionStore = highlightStore ? new QuestionStore(join(config.dataDir, 'uitkijk.db')) : undefined;
// Household register (since 0.22.0): bundles facts and answers into who is who and whose vehicle is which.
const household = highlightStore ? new HouseholdStore(join(config.dataDir, 'uitkijk.db')) : undefined;
const register = (): Register => ({ people: household?.people() ?? [], vehicles: household?.vehicles() ?? [] });
// Frigate's known plates follow the register (since 0.35.0): Frigate names the car and corrects near-miss reads. Needs
// the authenticated API with the admin role (the `uitkijk` account has it for face learning).
const plateSync =
  household && config.frigate && frigateHttp && frigateAuth && config.knownPlates
    ? new KnownPlatesSync({ frigateUrl: config.frigate.url, fetch: frigateHttp, register, log: (msg) => app.log.warn(msg) })
    : undefined;
// AI descriptions (AI-4: only when the owner enabled them; AI-7: isolated, failures never affect the rest).
const codexOptions = { codexHome: join(config.dataDir, 'codex'), model: config.aiModel };
// Every AI call with prompt, image and raw answer, for Beheer → AI-log (since 0.23.0).
const aiLog = highlightStore && config.ai === 'codex' ? new AiLog(join(config.dataDir, 'uitkijk.db'), { shrink: ffmpegThumbnail }) : undefined;
const aiCall = (purpose: AiPurpose) =>
  loggedCall(codexImageCall(codexOptions), aiLog, purpose, config.aiModel ?? null, (err) => app.log.warn(`ai log: ${err.message}`));
const ai =
  highlightStore && config.ai === 'codex'
    ? new AiWorker(highlightStore, codexDescriber(codexOptions, aiCall('beschrijving')), {
        cameras: config.cameras,
        model: config.aiModel,
        // The register plus facts it does not hold yet, instead of every raw fact (since 0.30.0).
        facts: () => promptKnowledge(register(), facts?.list() ?? []),
        register,
        still: highlightStill,
        ...(aiLog ? { callsToday: () => aiLog.callsToday() } : {}),
        // `app` exists by the time the worker logs (it starts after the app is built).
        log: (msg) => app.log.warn(msg),
      })
    : undefined;
// Frigate's face library: answers about people who come back teach Frigate their faces (operator decision 2026-11-09).
const faces = highlightStore && config.frigate ? new FaceLibrary({ frigateUrl: config.frigate.url, ...(frigateHttp ? { fetch: frigateHttp } : {}) }) : undefined;
let faceWorker: FaceWorker | undefined;
// Which dashboards are on and what they show (since 0.27.0); needs a login to know whose screen it is.
const displays = store ? new DisplayRegistry(join(config.dataDir, 'uitkijk.db')) : undefined;
// Daily copy of the database (since 0.27.0): what the system learned is in it, not only accounts.
const backup = store ? new DbBackup(join(config.dataDir, 'uitkijk.db'), join(config.dataDir, 'backups'), { log: (msg) => app.log.warn(msg) }) : undefined;
household?.failInterruptedRuns(Date.now() / 1000);
const bundler = household
  ? new Bundler(household, {
      ...(ai ? { call: aiCall('huishouden') } : {}),
      input: async () => {
        if (faces) await faces.refresh().catch(() => undefined);
        const answers: PersonAnswer[] = (questionStore?.list('all', 5000) ?? [])
          .filter((q) => q.kind === 'person' && q.status === 'answered' && q.answer)
          .map((q) => ({ questionId: q.id, ...parsePersonAnswer(q.answer!), at: q.answeredAt ?? q.createdAt }))
          .filter((a) => a.name);
        return { facts: facts?.list() ?? [], answers, faceNames: faces?.ready ? faces.knownNames() : [] };
      },
      log: (msg) => app.log.warn(msg),
    })
  : undefined;
// Bundling at the time an administrator chose (weekly on Sunday 05:00 by default; since 0.28.0).
const bundleScheduler = household && bundler ? new BundleScheduler(household, bundler) : undefined;
// After answers to household questions the register is bundled again, once the administrator paused for two
// minutes, so new facts become proposals and new doubts become questions (since 0.29.0).
let rebundle: ReturnType<typeof setTimeout> | undefined;
const registerChanged = () => {
  plateSync?.kick();
  // The next household question right away instead of within ten minutes.
  setTimeout(() => questionGenerator?.runOnce(), 0);
  clearTimeout(rebundle);
  rebundle = setTimeout(() => {
    if (bundler && !bundler.busy) bundler.start('systeem');
  }, 120_000);
};
// Doubts from before 0.29.0 have no answer options yet: bundle once more so they get them.
if (household && bundler?.aiEnabled && !household.getMeta('doubt_options')) {
  if (household.proposals('pending').some((p) => p.kind === 'question' && !p.data.options)) setTimeout(() => bundler.start('systeem'), 30_000);
  household.setMeta('doubt_options', '1');
}
// Answers given before facts (0.11) and face learning (0.13) existed go through the same steps once.
if (questionStore && highlightStore) {
  for (const q of questionStore.legacyPersonAnswers()) {
    applyPersonAnswer(q, q.answer ?? '', { questions: questionStore, highlights: highlightStore, autoFacts: Boolean(ai), ...(faces ? { faces } : {}) });
  }
}
// Since 0.18.0 the AI lists every visible vehicle (also parked ones); highlights of the last two days that were
// described before that are described once more, so their vehicles can be asked about.
if (highlightStore && ai && !highlightStore.getMeta('vehicles_backfill')) {
  for (const c of highlightStore.candidatesSince(Date.now() / 1000 - 2 * 86400)) {
    if (c.selected && c.aiStatus === 'done' && c.aiVehicles.length === 0) highlightStore.requestRedescribe(c.id);
  }
  highlightStore.setMeta('vehicles_backfill', '1');
}
// Before 0.22.3 the clip started at the alert, so a person who came later (the moment of the AI still) could be missing
// from it. Such clip windows are moved once so they contain that moment.
// Again in 0.22.4: in 0.22.3 a still after the end of the alert stayed outside the moved clip.
if (highlightStore && highlightStore.getMeta('clip_window_fix') !== '2') {
  highlightStore.moveClipsToFrame();
  highlightStore.setMeta('clip_window_fix', '2');
}
// Before 0.19.2 an answer about any vehicle in view labelled the highlight ("auto van Bert") and made it count as
// known, also for a vehicle parked in the background. Such labels are removed once and the highlight is described again.
if (questionStore && highlightStore && !highlightStore.getMeta('vehicle_labels_fix')) {
  for (const q of questionStore.list('all')) {
    const h = q.kind === 'vehicle' && q.status === 'answered' && q.highlightId ? highlightStore.get(q.highlightId) : undefined;
    if (!h?.annotation || !VEHICLE_ANNOTATION.test(h.annotation) || vehicleIsSubject({ ...h, annotation: null }, q.data.vehicle)) continue;
    highlightStore.setAnnotation(h.id, null, false);
    if (ai) highlightStore.requestRedescribe(h.id);
  }
  highlightStore.setMeta('vehicle_labels_fix', '1');
}
// Since 0.20.3 a person Frigate reported is never noise; highlights of the last two days that the AI called noise
// while a person was there (a car's moment can miss them) are described once more.
if (highlightStore && ai && !highlightStore.getMeta('person_noise_recheck')) {
  for (const c of highlightStore.candidatesSince(Date.now() / 1000 - 2 * 86400)) {
    if (c.selected && c.aiRealEvent === false && c.labels.includes('person')) highlightStore.requestRedescribe(c.id);
  }
  highlightStore.setMeta('person_noise_recheck', '1');
}
// Since 0.30.0 the server decides vehicle matches it can be sure of (plates) and vague cars are never known. The
// vehicles of the last two weeks are checked once with those rules, without new AI calls.
if (highlightStore && !highlightStore.getMeta('vehicle_known_recheck')) {
  const r = register();
  const knowledge = { knownPlates: knownPlates(r, facts?.list().map((f) => f.text) ?? []), vehicles: r.vehicles };
  for (const c of highlightStore.candidatesSince(Date.now() / 1000 - 14 * 86400)) {
    if (c.aiStatus !== 'done' || (!c.aiVehicle && !c.aiVehicles.length)) continue;
    const ctx = { ...knowledge, matches: plateMatches(c.plates, r) };
    const main = c.aiVehicle ? vehicleKnown(c.aiVehicle, c.aiVehicleKnown, ctx) : c.aiVehicleKnown;
    const list = c.aiVehicles.map((v) => ({ ...v, known: vehicleKnown(v.description, v.known, ctx) }));
    if (main !== c.aiVehicleKnown || list.some((v, i) => v.known !== c.aiVehicles[i]!.known)) highlightStore.setAiVehicles(c.id, main, list);
  }
  highlightStore.setMeta('vehicle_known_recheck', '1');
}
// Since 0.30.0 the fact writer leaves out things people carry; such AI facts written before are removed once.
if (highlightStore && facts && !highlightStore.getMeta('loose_object_facts')) {
  for (const f of facts.list()) {
    if (!f.createdBy.startsWith('AI') || !looseObjectFact(f.text)) continue;
    facts.remove(f.id);
    household?.log(`Feit ${f.id} verwijderd (los voorwerp, geen vast kenmerk): ${f.text}`, 'systeem', Date.now() / 1000);
  }
  highlightStore.setMeta('loose_object_facts', '1');
}
// Until 0.30.1 the best highlight of a series leaving the two-day selection window let the next one of the series be
// selected, and so on: series of near-identical clips in the archive, most never described. Older highlights are put
// right once with the same rule; one an administrator answered about or gave 👍 stays.
if (highlightStore && !highlightStore.getMeta('burst_fix')) {
  const old = highlightStore.candidatesSince(0).filter((c) => c.selected && c.startTime < Date.now() / 1000 - RESELECT_S);
  const keep = selectHighlights(old.map((c) => ({ id: c.id, startTime: c.startTime, cameras: c.cameras, score: c.score })), -Infinity);
  let removed = 0;
  for (const c of old) {
    if (keep.has(c.id) || c.annotation || c.feedback === 1) continue;
    highlightStore.setSelected(c.id, false);
    removed++;
  }
  // The ones that stay and never got a description get one now.
  for (const c of old) if (ai && (keep.has(c.id) || c.annotation || c.feedback === 1) && c.aiStatus === null && c.hasThumbnail) highlightStore.requestRedescribe(c.id);
  highlightStore.setMeta('burst_fix', '1');
  // `app` exists by the time this runs.
  setTimeout(() => app.log.info(`highlights: ${removed} older highlights of a series deselected`), 0);
}
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
  ...(questionStore && highlightStore
    ? {
        questions: {
          questions: questionStore,
          highlights: highlightStore,
          autoFacts: Boolean(ai),
          cameraName: (id: string) => config.cameras.find((c) => c.id === id)?.name ?? id,
          ...(facts ? { facts } : {}),
          ...(faces ? { faces, onFaceQueued: () => void faceWorker?.kick() } : {}),
          ...(household ? { household, register: household, onRegisterChanged: registerChanged } : {}),
        },
      }
    : {}),
  ...(household && bundler
    ? { household: { store: household, bundler, ...(plateSync ? { plates: () => plateSync.status() } : {}), ...(bundleScheduler ? { scheduler: bundleScheduler } : {}), ...(facts ? { facts } : {}), ...(highlightStore ? { highlights: highlightStore } : {}), ...(faces ? { faces } : {}) } }
    : {}),
  ...(aiLog ? { aiLog } : {}),
  ...(displays ? { displays } : {}),
  detail: () => ({
    ...(backup ? { backup: backup.status() } : {}),
    cameras: cameraProbe?.snapshot() ?? [],
    highlights: importer ? { enabled: true, lastOkAt: importer.lastOkAt, lastError: importer.lastError } : { enabled: false },
    ai: ai ? ai.status() : { enabled: false },
  }),
  ...(config.devApi && mock ? { mock } : {}),
  ...(store ? { auth: { store, publicUrl: config.publicUrl } } : {}),
  ...(highlightStore && clips && config.frigate
    ? { highlights: { store: highlightStore, clips, frigateUrl: config.frigate.url, ...(ai ? { aiStatus: () => ai.status() } : {}), ...(facts ? { facts } : {}), ...(household ? { household } : {}) } }
    : {}),
  logger: true,
});
importer =
  highlightStore && config.frigate
    ? new HighlightImporter(highlightStore, {
        frigateUrl: config.frigate.url,
        cameras: config.cameras,
        ...(frigateHttp ? { fetch: frigateHttp } : {}),
        recordingThumbnail: async (c) => {
          const jpeg = await highlightStill(c);
          return jpeg ? ffmpegThumbnail(jpeg) : undefined;
        },
        log: (msg) => app.log.warn(msg),
      })
    : undefined;
importer?.start();
// Since 0.27.0 tiny people far away get no "Wie is dit?" question; highlights of the last week are measured once.
if (importer && highlightStore && !highlightStore.getMeta('person_size_backfill')) {
  importer.backfillPersonSizes(Date.now() / 1000 - 7 * 86400).then(
    (n) => {
      highlightStore.setMeta('person_size_backfill', '1');
      app.log.info(`highlights: measured person size of ${n} older highlights`);
    },
    (err: Error) => app.log.warn(`highlights: person size backfill: ${err.message}`),
  );
}
const questionGenerator =
  questionStore && highlightStore
    ? new QuestionGenerator(highlightStore, questionStore, {
        cameras: config.cameras,
        ...(cameraProbe ? { cameraStatus: () => cameraProbe.snapshot() } : {}),
        ...(ai ? { aiStatus: () => ai.status() } : {}),
        ...(faces ? { faces } : {}),
        ...(facts
          ? {
              facts,
              // The prompt holds the register too, so a change there also makes older descriptions out of date.
              factsChangedAt: () => Math.max(facts.lastChange() ?? 0, household?.lastChange() ?? 0) || null,
              knownVehicles: () => [...facts.list().map((f) => f.text), ...register().vehicles.map(vehicleLabel)],
            }
          : {}),
        ...(household ? { household } : {}),
      })
    : undefined;
questionGenerator?.start();
// Since 0.19.0 faces also come from the 4K recording when Frigate kept no crop; earlier answers get that chance once
// (again in 0.19.1: in 0.19.0 a Frigate error during the attempt counted as "no face").
if (faces && questionStore && highlightStore && highlightStore.getMeta('faces_from_recording') !== '2') {
  questionStore.retryFacesWithoutCrop();
  highlightStore.setMeta('faces_from_recording', '2');
}
const recordingFaces = faces && config.frigate ? new RecordingFaces({ frigateUrl: config.frigate.url, ...(frigateHttp ? { fetch: frigateHttp } : {}) }) : undefined;
faceWorker =
  faces && questionStore && highlightStore
    ? new FaceWorker(questionStore, highlightStore, faces, { ...(recordingFaces ? { recording: recordingFaces } : {}), log: (msg) => app.log.warn(msg) })
    : undefined;
faceWorker?.start();
// Facts from answers about people (only with AI enabled; vehicle answers become facts directly).
const factWorker =
  ai && questionStore && highlightStore && facts
    ? new FactWorker(questionStore, highlightStore, facts, codexFactWriter(aiCall('feit')), {
        cameras: config.cameras,
        still: highlightStill,
        toJpeg: ffmpegToJpeg,
        ...(aiLog ? { callsToday: () => aiLog.callsToday().feit } : {}),
        log: (msg) => app.log.warn(msg),
      })
    : undefined;
factWorker?.start();
cameraProbe?.start();
ai?.start();
backup?.start();
bundleScheduler?.start();
plateSync?.start();

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
// Frigate pushes object and review changes over its websocket: poll at once instead of within pollMs (since 0.20.0).
const frigatePush =
  frigate && config.frigate
    ? new FrigatePush({
        url: config.frigate.url,
        ...(frigateHttp?.session ? { session: frigateHttp.session } : {}),
        ...(frigateAuth ? { certificate: frigateAuth.certificate } : {}),
        onTopic: (topic) => {
          if (topic === 'reviews' || topic === 'events') frigate.wake();
        },
        log: (msg) => app.log.warn(msg),
      })
    : undefined;
frigatePush?.start();

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
  frigatePush?.stop();
  probe?.stop();
  importer?.stop();
  questionGenerator?.stop();
  factWorker?.stop();
  faceWorker?.stop();
  cameraProbe?.stop();
  ai?.stop();
  backup?.stop();
  bundleScheduler?.stop();
  plateSync?.stop();
  clearTimeout(rebundle);
  hub.stop();
  clearInterval(purge);
  await app.close();
  store?.close();
  highlightStore?.close();
  facts?.close();
  household?.close();
  displays?.close();
  questionStore?.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: config.host, port: config.port });
