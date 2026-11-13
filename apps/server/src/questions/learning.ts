import type { StoredCandidate } from '../highlights/store.ts';
import type { Person } from '../household/store.ts';
import type { Question } from './store.ts';

/** One period of the learning meter (Beheer → AI, since 0.30.0). */
export interface LearningPeriod {
  /** First day, YYYY-MM-DD in Europe/Amsterdam. */
  start: string;
  /** Highlights shown or answered about, without AI noise. */
  highlights: number;
  persons: {
    total: number;
    /** Named without an answer: Frigate recognised the face, or the AI named someone from the register. */
    self: number;
    /** An administrator answered who it was. */
    answered: number;
    unknown: number;
  };
  /** Vehicles the AI saw clearly, and how many it (or the server) matched to the register or facts. */
  vehicles: { total: number; known: number };
  /** Questions asked about people, vehicles and the register in this period, and how many were answered. */
  questions: { asked: number; answered: number };
}

export interface LearningStats {
  days: LearningPeriod[];
  weeks: LearningPeriod[];
}

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayOf = (t: number) => dayFormat.format(t * 1000);
/** Monday of the week of a YYYY-MM-DD day. */
function mondayOf(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
const shift = (day: string, days: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const LEARNING_KINDS = new Set(['person', 'vehicle', 'household']);

/** Annotations that name someone: "Roel Snippe (buren)", "auto van Mark Mevius". */
const NAMED = /^[^()]+ \([^()]+\)$| van \S/;

const escape =(s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * How much the system recognises by itself, per day (last 14) and per week (last 8): the share of people named
 * without an answer, the share of vehicles known, and the number of questions it still needs.
 */
export function learningStats(candidates: StoredCandidate[], questions: Question[], people: Person[], now: number): LearningStats {
  const names = [...new Set(people.flatMap((p) => [p.name.split(/\s+/)[0]!, ...p.aliases]).filter((n) => n.length >= 2))];
  const nameRe = names.length ? new RegExp(`(?<![\\p{L}])(${names.map(escape).join('|')})(?![\\p{L}])`, 'iu') : null;
  const empty = (start: string): LearningPeriod => ({
    start,
    highlights: 0,
    persons: { total: 0, self: 0, answered: 0, unknown: 0 },
    vehicles: { total: 0, known: 0 },
    questions: { asked: 0, answered: 0 },
  });
  const today = dayOf(now);
  const days = new Map(Array.from({ length: 14 }, (_, i) => shift(today, i - 13)).map((d) => [d, empty(d)]));
  const thisWeek = mondayOf(today);
  const weeks = new Map(Array.from({ length: 8 }, (_, i) => shift(thisWeek, (i - 7) * 7)).map((d) => [d, empty(d)]));
  const periods = (t: number) => [days.get(dayOf(t)), weeks.get(mondayOf(dayOf(t)))].filter((p): p is LearningPeriod => Boolean(p));

  for (const c of candidates) {
    if (c.deleted || c.aiRealEvent === false) continue;
    const highlight = c.selected || Boolean(c.annotation);
    // A recognised face counts low, so such an event is usually no highlight; it is exactly what the meter is about
    // (until 0.30.1 it counted 1 of 18 recognised faces in a week).
    const person = c.labels.some((l) => l.replace(/-verified$/, '') === 'person') && (highlight || c.subLabels.length > 0);
    if (!highlight && !person) continue;
    for (const p of periods(c.startTime)) {
      if (highlight) {
        p.highlights++;
        p.vehicles.total += c.aiVehicles.length;
        p.vehicles.known += c.aiVehicles.filter((v) => v.known).length;
      }
      if (!person) continue;
      p.persons.total++;
      // Only an answer with a name says who it was: "onbekend", "bezoeker" or "onbekende fiets" do not.
      if (c.annotation && NAMED.test(c.annotation)) p.persons.answered++;
      else if (c.subLabels.length || (nameRe && c.aiDescription && nameRe.test(c.aiDescription))) p.persons.self++;
      else p.persons.unknown++;
    }
  }
  for (const q of questions) {
    if (!LEARNING_KINDS.has(q.kind)) continue;
    for (const p of periods(q.createdAt)) {
      p.questions.asked++;
      if (q.status === 'answered') p.questions.answered++;
    }
  }
  return { days: [...days.values()].reverse(), weeks: [...weeks.values()].reverse() };
}
