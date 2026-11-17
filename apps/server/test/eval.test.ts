import { afterEach, describe, expect, it } from 'vitest';
import { evalCases, judge, report, summarise } from '../src/ai/eval.ts';
import { HighlightStore } from '../src/highlights/store.ts';
import { QuestionStore } from '../src/questions/store.ts';

const cleanup: (() => unknown)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const NOW = 1_794_900_000;

describe('AI evaluation (0.41.0)', () => {
  it('builds cases from answers, without visit copies, unknowns or deleted highlights', () => {
    const highlights = new HighlightStore(':memory:');
    const questions = new QuestionStore(':memory:');
    cleanup.push(() => highlights.close(), () => questions.close());
    const add = (id: string, t: number) => {
      highlights.insert({ id, startTime: t, endTime: t + 10, cameras: ['oprit'], camera: 'oprit', frigateCamera: 'f', repEvent: 'e', clipStart: t, clipEnd: t + 10, eventStart: t, eventEnd: t + 10, labels: ['person'], subLabels: [], score: 3, reasons: [], description: 'x' }, [id]);
      return id;
    };
    const ask = (kind: 'person' | 'vehicle', id: string, answer: string | null, body = 'x', by = 'mark') => {
      questions.add({ kind, key: `${kind}:${id}`, highlightId: id, title: 't', body }, NOW);
      const q = questions.getByKey(`${kind}:${id}`)!;
      questions.resolve(q.id, answer ? 'answered' : 'dismissed', answer, by, NOW);
    };
    ask('person', add('a', NOW - 100), 'Tineke Mevius (bewoner)');
    ask('person', add('b', NOW - 200), 'onbekend');
    ask('person', add('c', NOW - 300), 'Johan Mevius (bewoner)', 'Zelfde bezoek als vraag 1.');
    ask('vehicle', add('d', NOW - 400), 'Witte bestelbus is van Roel Snippe');
    ask('person', add('e', NOW - 500), null, 'x', 'systeem');
    highlights.setAiResult('e', 'Niemand.', false, NOW, null, false, null, [], 'nee');
    add('f', NOW - 600);
    highlights.setFeedback('f', 1, NOW);
    const cases = evalCases(questions.list('all'), (id) => highlights.get(id), highlights.candidatesSince(0), 10);
    expect(cases.map((c) => [c.kind, c.highlightId])).toEqual([['persoon', 'a'], ['voertuig', 'd'], ['niemand', 'e'], ['goed', 'f']]);
    expect(cases.find((c) => c.kind === 'voertuig')!.owner).toBe('Roel');
    expect(evalCases(questions.list('all'), (id) => highlights.get(id), [], 1).filter((c) => c.kind === 'persoon')).toHaveLength(1);
  });

  it('judges each kind and counts contradictions before the server checks', () => {
    const base = { description: 'Een persoon loopt.', realEvent: true };
    const person = { kind: 'persoon' as const, highlightId: 'a', truth: 'Tineke (bewoner)' };
    expect(judge(person, base, { ...base, personSeen: 'onduidelijk' }).pass).toBe(true);
    const nobody = { description: 'Er is niemand te zien.', realEvent: true, personSeen: 'ja' as const };
    const r = judge(person, nobody, { ...nobody, personSeen: 'nee' });
    expect(r).toMatchObject({ pass: false, contradiction: true });
    const van = { kind: 'voertuig' as const, highlightId: 'd', truth: 'x', owner: 'Roel' };
    expect(judge(van, base, { description: 'Roel stapt uit zijn bus.', realEvent: true }).pass).toBe(true);
    expect(judge(van, base, { description: 'Een bus staat er.', realEvent: true, vehicles: [{ description: 'bus', known: false }] }).pass).toBe(false);
    const s = summarise([r, judge(person, base, base)], 'gpt-6-luna', NOW);
    expect(s.kinds.persoon).toEqual({ n: 2, pass: 1 });
    const text = report(s, { ...s, contradictions: 0, kinds: { persoon: { n: 2, pass: 2 } } });
    expect(text).toContain('nu 1/2 (50%)   vorige 2/2 (100%)');
    expect(text).toContain('Tegenstrijdig ("niemand" met "ja"): nu 1, vorige 0');
  });
});
