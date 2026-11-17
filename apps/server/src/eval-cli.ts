// Evaluation of the description AI against administrators' answers (since 0.41.0), see docs/ai.md.
//
//   docker exec de-uitkijk-server-1 node apps/server/src/eval-cli.ts [per-soort]
//
// Runs the newest answered cases of each kind (default 10, so about 40 AI calls) through the production pipeline
// without the answer, prints a report next to the previous run and stores the run in <data>/eval/. It writes nothing
// else: descriptions, questions and the AI log stay as they are. The calls count against the ChatGPT plan, not
// against the daily description cap.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexDescriber } from './ai/codex.ts';
import { evalCases, judge, report, summarise, type EvalResult, type EvalSummary } from './ai/eval.ts';
import { FactStore } from './ai/facts.ts';
import { promptKnowledge } from './ai/knowledge.ts';
import { recordingStill } from './ai/still.ts';
import { AiWorker } from './ai/worker.ts';
import { loadConfig } from './config.ts';
import { frigateFetch, readFrigateAuth } from './frigate/client.ts';
import { HighlightStore } from './highlights/store.ts';
import { HouseholdStore } from './household/store.ts';
import { QuestionStore } from './questions/store.ts';

const config = loadConfig();
if (!config.frigate || config.ai !== 'codex') {
  console.error('De evaluatie heeft Frigate en UITKIJK_AI=codex nodig.');
  process.exit(2);
}
const perKind = Math.max(1, Math.min(50, Number(process.argv[2]) || 10));
const db = join(config.dataDir, 'uitkijk.db');
const highlights = new HighlightStore(db);
const questions = new QuestionStore(db);
const facts = new FactStore(db);
const household = new HouseholdStore(db);
const frigate = frigateFetch(config.frigate.url, readFrigateAuth(config.frigate.authFile));
const model = config.aiModel;

const register = () => ({ people: household.people(), vehicles: household.vehicles() });
const worker = new AiWorker(highlights, codexDescriber({ codexHome: join(config.dataDir, 'codex'), model }), {
  cameras: config.cameras,
  model,
  facts: () => promptKnowledge(register(), facts.list()),
  register,
  still: recordingStill(config.frigate.url, frigate),
});

const now = Date.now() / 1000;
const rated = highlights.candidatesSince(now - 90 * 86400).filter((h) => h.feedback === 1);
const cases = evalCases(questions.list('all', 5000), (id) => highlights.get(id), rated, perKind);
console.error(`${cases.length} casussen, model ${model}`);

const results: EvalResult[] = [];
for (const [i, c] of cases.entries()) {
  const h = highlights.get(c.highlightId)!;
  try {
    const { raw, verdict } = await worker.verdictFor(h, { withAnswer: false });
    results.push(judge(c, raw, verdict));
  } catch (err) {
    results.push({ case: c, pass: false, contradiction: false, description: '', personSeen: null, realEvent: false, error: (err as Error).message.slice(0, 200) });
  }
  console.error(`${i + 1}/${cases.length} ${c.kind} ${results.at(-1)!.pass ? 'goed' : 'NIET GOED'}`);
}

const dir = join(config.dataDir, 'eval');
mkdirSync(dir, { recursive: true });
const previous = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().at(-1);
const before = previous ? (JSON.parse(readFileSync(join(dir, previous), 'utf8')) as EvalSummary) : undefined;
const summary = summarise(results, model, now);
writeFileSync(join(dir, `${new Date(now * 1000).toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(summary, null, 1));
console.log(report(summary, before));
for (const store of [highlights, questions, facts, household]) store.close();
