import type { Camera } from '@uitkijk/shared';
import type { AiStatus } from '../ai/worker.ts';
import type { CameraVideoStatus } from '../camera-probe.ts';
import type { FaceLibrary } from '../faces/library.ts';
import { hourInAmsterdam } from '../highlights/importer.ts';
import { periodOf } from '../highlights/selection.ts';
import type { HighlightStore, StoredCandidate } from '../highlights/store.ts';
import type { QuestionStore } from './store.ts';
import { askableVehicle, normalizeVehicle, vehicleNoun } from './vehicles.ts';

export interface GeneratorOptions {
  cameras: Camera[];
  cameraStatus?: () => CameraVideoStatus[];
  aiStatus?: () => AiStatus | undefined;
  /** Frigate's face library: a person question needs a face Frigate can learn (or another stable feature). */
  faces?: Pick<FaceLibrary, 'ready' | 'attemptsFor' | 'refresh'>;
  intervalMs?: number;
  /** Epoch seconds. */
  now?: () => number;
}

/** Open questions per kind, so the list stays short and answerable. */
export const OPEN_LIMITS = { person: 3, vehicle: 3, highlight: 2, noise: 2 } as const;
const NOISE_THRESHOLD = 5;
const CAMERA_DOWN_S = 3600;

const dayKey = (epochS: number) => new Date(epochS * 1000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
const timeText = (epochS: number) =>
  new Date(epochS * 1000).toLocaleString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });
const PERIOD_NL = { nacht: "'s nachts", avond: "'s avonds", dag: 'overdag' } as const;

/** ISO week of the Amsterdam calendar day, e.g. 2026-W45, for weekly suggestions. */
export function isoWeek(epochS: number): string {
  const [y, m, d] = dayKey(epochS).split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7)); // Thursday of this week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / 86400000 / 7 - (3 - ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** "Een persoon loopt." + ". Voordeur" must not become "loopt.. Voordeur". */
const sentence = (text: string) => `${text.trim().replace(/[.!?…]+$/, '')}.`;

/**
 * Turns what the system does not know (yet) into questions and suggestions for administrators:
 * unknown people and vehicles (cars, bicycles, scooters), borderline highlights, recurring false alarms and system problems.
 * Every question has a key that is used once, so nothing is asked twice.
 */
export class QuestionGenerator {
  private readonly highlights: HighlightStore;
  private readonly questions: QuestionStore;
  private readonly opts: Required<GeneratorOptions>;
  private readonly names: Map<string, string>;
  private readonly cameraFailedSince = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(highlights: HighlightStore, questions: QuestionStore, options: GeneratorOptions) {
    this.highlights = highlights;
    this.questions = questions;
    this.names = new Map(options.cameras.map((c) => [c.id, c.name]));
    this.opts = {
      cameraStatus: () => [],
      aiStatus: () => undefined,
      faces: { ready: false, attemptsFor: () => [], refresh: async () => {} },
      intervalMs: 10 * 60_000,
      now: () => Date.now() / 1000,
      ...options,
    };
  }

  start(): void {
    const loop = async () => {
      try {
        // Fresh face attempts; on failure the generator asks no new person questions (the cache is not ready).
        await this.opts.faces.refresh().catch(() => {});
        this.runOnce();
      } finally {
        this.timer = setTimeout(loop, this.opts.intervalMs);
      }
    };
    this.timer = setTimeout(loop, 60_000);
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  private name(id: string) {
    return this.names.get(id) ?? id;
  }

  /** One pass; returns the number of new questions. */
  runOnce(): number {
    const now = this.opts.now();
    // Questions about highlights that were deleted in the meantime are closed.
    for (const q of this.questions.list('open', 1000)) {
      if (q.highlightId && (this.highlights.get(q.highlightId)?.deleted ?? true)) this.questions.dismissForHighlight(q.highlightId, now);
    }
    const recent = this.highlights.candidatesSince(now - 14 * 86400);
    let added = 0;
    const add = (q: Parameters<QuestionStore['add']>[0]) => {
      if (this.questions.add(q, now)) added++;
    };
    const room = (kind: keyof typeof OPEN_LIMITS) => OPEN_LIMITS[kind] - this.questions.openCount(kind);
    const faces = this.opts.faces;
    const freeHighlight = (c: StoredCandidate) => !this.questions.hasForHighlight(c.id);

    // Open vehicle questions about something the AI could not tell apart are withdrawn.
    for (const q of this.questions.list('open', 1000)) {
      if (q.kind === 'vehicle' && !askableVehicle(String(q.data.vehicle ?? ''))) this.questions.withdraw(q.id, now);
    }

    // Unknown people: real events with a person whom Frigate did not recognise and nobody named yet. Best first.
    // The answer puts the name on the highlight (and in its description); a face Frigate kept is also learned.
    const people = recent
      .filter((c) => c.selected && c.hasThumbnail && c.startTime > now - 7 * 86400 && c.labels.some((l) => l.startsWith('person')))
      // Also after a 👍/👎 question about the same highlight, but never two open questions at once.
      .filter((c) => c.subLabels.length === 0 && c.aiRealEvent === true && !c.annotation)
      .filter((c) => !this.questions.hasForHighlight(c.id, 'person') && !this.questions.hasOpenForHighlight(c.id))
      .sort((a, b) => b.score - a.score);
    for (const c of people.slice(0, Math.max(0, room('person')))) {
      const attempts = faces.ready ? faces.attemptsFor(c.detections) : [];
      const guess = attempts.find((a) => a.guess && a.score >= 0.5);
      add({
        kind: 'person',
        key: `person:${c.id}`,
        highlightId: c.id,
        title: 'Wie is dit?',
        body:
          `${sentence(c.aiDescription ?? c.description)} ${this.name(c.camera)}, ${timeText(c.startTime)}.` +
          (guess ? ` Frigate denkt aan ${guess.guess} (${Math.round(guess.score * 100)}%), maar weet het niet zeker.` : ''),
        data: {
          faces: attempts.slice(0, 4).map((a) => a.file),
          ...(guess ? { guess: guess.guess } : {}),
        },
      });
    }

    // Cars, bicycles, scooters and motorbikes the AI saw (also parked ones) but could not match to a fact, to build
    // up who owns which vehicle. One question per distinct vehicle; a highlight never has two open questions.
    const seenVehicles = new Set<string>();
    const busy = new Set<string>();
    const vehicles: { c: StoredCandidate; vehicle: string; key: string }[] = [];
    for (const c of [...recent].sort((a, b) => b.startTime - a.startTime)) {
      if (!c.hasThumbnail || this.questions.hasOpenForHighlight(c.id)) continue;
      const seen = [...(c.aiVehicle && !c.aiVehicleKnown ? [c.aiVehicle] : []), ...c.aiVehicles.filter((v) => !v.known).map((v) => v.description)];
      for (const vehicle of seen) {
        const key = normalizeVehicle(vehicle);
        if (busy.has(c.id) || !askableVehicle(vehicle) || seenVehicles.has(key) || this.questions.has(`vehicle:${key}`)) continue;
        seenVehicles.add(key);
        busy.add(c.id);
        vehicles.push({ c, vehicle, key });
      }
    }
    for (const { c, vehicle, key } of vehicles.slice(0, Math.max(0, room('vehicle')))) {
      const noun = vehicleNoun(vehicle);
      add({
        kind: 'vehicle',
        key: `vehicle:${key}`,
        highlightId: c.id,
        title: `Van wie is deze ${noun}?`,
        body: `De AI ziet: ${sentence(vehicle)} ${this.name(c.camera)}, ${timeText(c.startTime)}.${platesText(c.plates, vehicle)} Klopt de omschrijving niet precies, pas hem dan aan.`,
        data: { vehicle, noun },
      });
    }

    const threshold = this.highlights.threshold();
    // Borderline highlights without feedback: a quick 👍/👎 teaches the selection the most here.
    const borderline = recent
      .filter((c) => c.selected && c.hasThumbnail && c.startTime > now - 3 * 86400 && c.feedback === null && c.aiRealEvent !== false)
      .filter((c) => c.score >= threshold && c.score < threshold + 0.6 && freeHighlight(c))
      .sort((a, b) => a.score - b.score);
    for (const c of borderline.slice(0, Math.max(0, room('highlight')))) {
      add({
        kind: 'highlight',
        key: `highlight:${c.id}`,
        highlightId: c.id,
        title: 'Was dit een goede highlight?',
        body: `${sentence(c.aiDescription ?? c.description)} ${this.name(c.camera)}, ${timeText(c.startTime)}. Het systeem twijfelde (relevantie ${c.score.toFixed(1)}).`,
      });
    }

    // Recurring false alarms per camera and time of day this week.
    const noise = new Map<string, StoredCandidate[]>();
    for (const c of recent.filter((x) => x.startTime > now - 7 * 86400 && x.aiRealEvent === false)) {
      const key = `${c.camera}|${periodOf(hourInAmsterdam(c.startTime))}`;
      noise.set(key, [...(noise.get(key) ?? []), c]);
    }
    for (const [key, list] of [...noise].sort((a, b) => b[1].length - a[1].length)) {
      if (list.length < NOISE_THRESHOLD || room('noise') <= 0) continue;
      const [camera, period] = key.split('|') as [string, keyof typeof PERIOD_NL];
      add({
        kind: 'noise',
        key: `noise:${key}:${isoWeek(now)}`,
        title: `Veel valse alarmen bij ${this.name(camera)} ${PERIOD_NL[period]}`,
        body: `De afgelopen week zag de AI ${list.length} highlights van ${this.name(camera)} ${PERIOD_NL[period]} als ruis. Mogelijke oorzaken: spinnenweb of insecten voor de lens, reflectie van de infraroodverlichting, bewegende takken of koplampen. Overweeg de lens te controleren of de alarmzone in Frigate aan te passen. Deze highlights staan niet op de tv.`,
        data: { camera, period, count: list.length },
      });
    }

    // System: a camera without a picture for more than an hour.
    for (const s of this.opts.cameraStatus()) {
      if (s.video !== 'failed') {
        this.cameraFailedSince.delete(s.id);
        continue;
      }
      const since = this.cameraFailedSince.get(s.id) ?? now;
      this.cameraFailedSince.set(s.id, since);
      if (now - since >= CAMERA_DOWN_S) {
        add({
          kind: 'system',
          key: `system:camera:${s.id}:${dayKey(now)}`,
          title: `${this.name(s.id)} geeft geen beeld`,
          body: `Sinds ${timeText(since)} levert ${this.name(s.id)} geen beeld aan De Uitkijk${s.detail ? ` (${s.detail})` : ''}. Controleer stroom/netwerk van de camera; de NVR en Frigate gebruiken dezelfde camera.`,
        });
      }
    }

    // System: AI login or daily limit.
    const ai = this.opts.aiStatus();
    if (ai?.lastError && /log ?in|logged|auth|401|unauthori[sz]ed|token/i.test(ai.lastError)) {
      add({
        kind: 'system',
        key: `system:ai-login:${dayKey(now)}`,
        title: 'Codex lijkt uitgelogd',
        body: `AI-beschrijvingen mislukken: "${ai.lastError}". Opnieuw inloggen: docker exec -it de-uitkijk-server-1 codex login --device-auth (op 503-web-ubuntu). Tot die tijd blijven de beschrijvingen op regels gebaseerd.`,
      });
    }
    if (ai && ai.callsToday >= ai.dailyCap) {
      add({
        kind: 'system',
        key: `system:ai-cap:${dayKey(now)}`,
        title: 'Dagelijks AI-maximum bereikt',
        body: `Vandaag zijn ${ai.callsToday} beschrijvingen gemaakt (maximum ${ai.dailyCap}). De rest wacht tot morgen. Gebeurt dit vaak, dan kan het maximum omhoog of de selectie strenger.`,
      });
    }
    return added;
  }
}

/** Plates Frigate read that the AI's description does not mention yet (both without dashes or spaces). */
function platesText(plates: string[], vehicle: string): string {
  const bare = vehicle.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const extra = plates.filter((p) => !bare.includes(p));
  return extra.length ? ` Frigate las ${extra.length === 1 ? 'kenteken' : 'kentekens'} ${extra.join(', ')}.` : '';
}
