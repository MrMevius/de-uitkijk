import type { StoredCandidate } from '../highlights/store.ts';

/**
 * Who a person in a highlight is, from the same moment on the property (since 0.43.0): an administrator's answer or a
 * face Frigate recognised in another highlight within two minutes, both with one person. Up to then residents were
 * asked about again and again (58% of 129 answers about people in nine days, 38 of 43 at the Voordeur), because
 * Frigate rarely learns their faces (side views, night).
 *
 * Checked against those 129 answers (person count unknown before 0.34.0 taken as one): with faces 9 of 14 right (four
 * of the five wrong ones were Frigate's Roel/Jasper mix-ups); with answers only 7 of 8 on any camera, 2 of 2 on the
 * same camera. Hence `answersOnly` where it changes something by itself.
 */
export const NEAR_S = 120;

/** People who come back: an answer naming one of them makes a highlight count as known. */
export const KNOWN_CATEGORIES = new Set(['bewoner', 'familie', 'bezoeker', 'buren', 'vaste hulp']);

/** Splits a stored person answer "Tineke (bewoner)" into name and category. */
export function parsePersonAnswer(answer: string): { name: string; category: string } {
  const m = /^(.*) \(([^()]+)\)$/.exec(answer);
  if (m) return { name: m[1]!, category: m[2]! };
  return { name: '', category: answer };
}

export interface VisitIdentity {
  name: string;
  /** The answer category ("bewoner") from an administrator's answer; null for a face Frigate recognised. */
  category: string | null;
  /** "antwoord": an administrator named them; "gezicht": Frigate recognised the face. */
  source: 'antwoord' | 'gezicht';
  /** The highlight it comes from. */
  from: StoredCandidate;
}

const single = (c: Pick<StoredCandidate, 'personCount'>) => c.personCount === 1;

/**
 * The one person of `h` named nearby, or null when it is not clear: `h` must have one person, and every named
 * highlight within `NEAR_S` (one person each; any camera, or only `h`'s camera with `sameCamera`) must name the same
 * person. An answer wins from a face; a passer-by, courier or "onbekend" names nobody who comes back.
 */
export function visitIdentity(h: StoredCandidate, nearby: StoredCandidate[], { sameCamera = false, answersOnly = false } = {}): VisitIdentity | null {
  if (!single(h) || h.subLabels.length || h.annotation) return null;
  const found: VisitIdentity[] = [];
  for (const c of nearby) {
    if (c.id === h.id || c.deleted || Math.abs(c.startTime - h.startTime) > NEAR_S || !single(c)) continue;
    if (sameCamera && c.camera !== h.camera) continue;
    const answer = c.annotation ? parsePersonAnswer(c.annotation) : null;
    if (answer?.name && KNOWN_CATEGORIES.has(answer.category)) found.push({ name: answer.name, category: answer.category, source: 'antwoord', from: c });
    else if (!answersOnly && !c.annotation && c.subLabels.length === 1) found.push({ name: c.subLabels[0]!, category: null, source: 'gezicht', from: c });
  }
  const names = new Set(found.map((f) => f.name.toLowerCase()));
  if (names.size !== 1) return null;
  return found.find((f) => f.source === 'antwoord') ?? found[0]!;
}
