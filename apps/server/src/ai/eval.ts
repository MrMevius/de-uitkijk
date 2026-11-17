import type { StoredCandidate } from '../highlights/store.ts';
import type { Question } from '../questions/store.ts';
import type { AiVerdict } from './codex.ts';
import { firstName, saysNobody } from './knowledge.ts';

/**
 * Evaluation of the description AI against what administrators answered (since 0.41.0). A prompt change is run on
 * the same cases before it is released and compared with the previous run: on 2026-11-17 a manual test with another
 * model than production needed three releases to show what the production model did.
 *
 * Each case is a highlight with a known truth from an answer; the AI gets the highlight as in production, but without
 * the answer.
 */
export type EvalKind = 'persoon' | 'niemand' | 'voertuig' | 'goed';

export interface EvalCase {
  kind: EvalKind;
  highlightId: string;
  /** What the answer says, e.g. "Tineke Mevius (bewoner)" or "Witte bestelbus is van Roel Snippe". */
  truth: string;
  /** Owner's first name for vehicle cases. */
  owner?: string;
}

export const EVAL_KINDS: Record<EvalKind, string> = {
  persoon: 'Persoon aanwezig (antwoord op "Wie is dit?"): niet "nee"',
  niemand: 'Geen persoon (vraag ingetrokken omdat niemand te zien was): "nee"',
  voertuig: 'Voertuig met eigenaar (antwoord op "Van wie is deze …?"): als bekend herkend of eigenaar genoemd',
  goed: 'Goede highlight (👍): echte gebeurtenis',
};

const VISIT_BODY = /^Zelfde bezoek/;

/** The newest cases of each kind, at most `perKind` each, from answered questions and ratings. */
export function evalCases(questions: Question[], highlights: (id: string) => StoredCandidate | undefined, rated: StoredCandidate[], perKind: number): EvalCase[] {
  const cases: EvalCase[] = [];
  const seen = new Set<string>();
  const push = (c: EvalCase) => {
    const h = highlights(c.highlightId);
    if (!h || h.deleted || seen.has(c.highlightId) || cases.filter((x) => x.kind === c.kind).length >= perKind) return;
    seen.add(c.highlightId);
    cases.push(c);
  };
  const newest = [...questions].sort((a, b) => (b.answeredAt ?? b.createdAt) - (a.answeredAt ?? a.createdAt));
  for (const q of newest) {
    if (!q.highlightId) continue;
    if (q.kind === 'person' && q.status === 'answered' && q.answer && !/^(onbekend|voorbijganger)$/.test(q.answer) && !VISIT_BODY.test(q.body)) {
      push({ kind: 'persoon', highlightId: q.highlightId, truth: q.answer });
    }
    // Withdrawn by the system because the AI saw nobody: only the ones nobody answered otherwise.
    if (q.kind === 'person' && q.status === 'dismissed' && q.answeredBy === 'systeem' && highlights(q.highlightId)?.aiPersonSeen === 'nee') {
      push({ kind: 'niemand', highlightId: q.highlightId, truth: 'niemand (Frigate zag ten onrechte een persoon)' });
    }
    const owner = q.kind === 'vehicle' && q.status === 'answered' ? q.answer?.split(' is van ')[1] : undefined;
    if (owner) push({ kind: 'voertuig', highlightId: q.highlightId, truth: q.answer!, owner: firstName(owner) });
  }
  for (const h of [...rated].sort((a, b) => b.startTime - a.startTime)) {
    if (h.feedback === 1) push({ kind: 'goed', highlightId: h.id, truth: '👍' });
  }
  return cases;
}

export interface EvalResult {
  case: EvalCase;
  pass: boolean;
  /** The AI's own answer contradicts itself: "niemand te zien" with person_seen "ja" (before the server's checks). */
  contradiction: boolean;
  description: string;
  personSeen: string | null;
  realEvent: boolean;
  error?: string;
}

/** Whether the checked verdict agrees with the answer. */
export function judge(c: EvalCase, raw: AiVerdict, verdict: AiVerdict): EvalResult {
  const pass =
    c.kind === 'persoon'
      ? verdict.personSeen !== 'nee'
      : c.kind === 'niemand'
        ? verdict.personSeen === 'nee'
        : c.kind === 'voertuig'
          ? Boolean(verdict.vehicleKnown && verdict.vehicle) ||
            (verdict.vehicles ?? []).some((v) => v.known) ||
            new RegExp(`(?<![\\p{L}])${c.owner!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'iu').test(verdict.description)
          : verdict.realEvent;
  return {
    case: c,
    pass,
    contradiction: raw.personSeen === 'ja' && saysNobody(raw.description),
    description: verdict.description,
    personSeen: verdict.personSeen ?? null,
    realEvent: verdict.realEvent,
  };
}

export interface EvalSummary {
  at: number;
  model: string;
  kinds: Partial<Record<EvalKind, { n: number; pass: number }>>;
  contradictions: number;
  errors: number;
  results: EvalResult[];
}

export function summarise(results: EvalResult[], model: string, at: number): EvalSummary {
  const kinds: EvalSummary['kinds'] = {};
  for (const r of results.filter((r) => !r.error)) {
    const k = (kinds[r.case.kind] ??= { n: 0, pass: 0 });
    k.n++;
    if (r.pass) k.pass++;
  }
  return { at, model, kinds, contradictions: results.filter((r) => r.contradiction).length, errors: results.filter((r) => r.error).length, results };
}

const pct = (k?: { n: number; pass: number }) => (k && k.n ? `${k.pass}/${k.n} (${Math.round((100 * k.pass) / k.n)}%)` : '-');

/** A plain-text report, with the previous run beside it when there is one. */
export function report(now: EvalSummary, before?: EvalSummary): string {
  const lines = [`AI-evaluatie, model ${now.model}${before ? ` (vorige run ${new Date(before.at * 1000).toISOString().slice(0, 16)})` : ''}`, ''];
  for (const kind of Object.keys(EVAL_KINDS) as EvalKind[]) {
    if (!now.kinds[kind] && !before?.kinds[kind]) continue;
    lines.push(`${EVAL_KINDS[kind]}\n  nu ${pct(now.kinds[kind])}${before ? `   vorige ${pct(before.kinds[kind])}` : ''}`);
  }
  lines.push(`Tegenstrijdig ("niemand" met "ja"): nu ${now.contradictions}${before ? `, vorige ${before.contradictions}` : ''}`);
  if (now.errors) lines.push(`Fouten: ${now.errors}`);
  const failed = now.results.filter((r) => !r.pass || r.error);
  if (failed.length) {
    lines.push('', 'Niet goed:');
    for (const r of failed) lines.push(`- [${r.case.kind}] ${r.case.highlightId}: ${r.error ?? `${r.description} (person_seen ${r.personSeen}, echt ${r.realEvent})`} — antwoord: ${r.case.truth}`);
  }
  return lines.join('\n');
}
