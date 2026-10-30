// Explicit, checkpointed paid evaluation. No database or Telegram operations.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnvironment, canonicalEnvironment } from './setup-env.mjs';
import { classify, ClassificationError } from '../worker/classifier';
import { applyPolicyEdits } from '../worker/improvement';
import { digest, policyMetrics, routed } from '../shared/improvement';
import { cascadeInputs, cascadeResults, cascadeLatency } from '../shared/cascade-evaluation';
import { settingsSchema, type Example, type Prediction } from '../shared/types';
import { rateLimitRetry } from '../worker/provider-errors';
import type { Env } from '../worker/env';

const { values } = parseArgs({
  options: {
    input: { type: 'string' },
    output: { type: 'string' },
    split: { type: 'string', default: 'development' },
    policy: { type: 'string', default: 'current' },
    'first-policy': { type: 'string', default: 'full' },
    repeats: { type: 'string', default: '3' },
    'batch-size': { type: 'string', default: '8' },
    cutoff: { type: 'string', default: '0.99' },
    'confirm-paid-evaluation': { type: 'boolean', default: false },
  },
});
if (!values.input || !values.output)
  throw new Error('Supply --input and --output inside ignored .tmp/.');
for (const path of [values.input, values.output]) {
  const local = relative(resolve('.tmp'), resolve(path));
  if (!local || local.startsWith('..'))
    throw new Error('Private input/output must be inside .tmp/.');
}
if (!['development', 'validation', 'historical'].includes(values.split))
  throw new Error('Unknown split.');
if (!['current', 'candidate'].includes(values.policy)) throw new Error('Unknown policy.');
if (!['full', 'focused'].includes(values['first-policy']))
  throw new Error('Unknown first-stage policy.');
const repeats = Number(values.repeats),
  cutoff = Number(values.cutoff),
  batchSize = Number(values['batch-size']);
if (
  !Number.isInteger(repeats) ||
  repeats < 1 ||
  repeats > 3 ||
  !Number.isFinite(cutoff) ||
  cutoff < 0.95 ||
  cutoff > 1 ||
  !Number.isInteger(batchSize) ||
  batchSize < 1 ||
  batchSize > 30
)
  throw new Error('Use 1–3 repeats, a cutoff from 0.95 to 1, and batch size 1–30.');
const input = JSON.parse(await readFile(values.input, 'utf8'));
const settings = { ...settingsSchema.parse(input.settings), reasoningTokens: 0 as const };
if (settings.threshold > cutoff)
  throw new Error('The early cutoff must not be below the frozen spam threshold.');
const fixture = JSON.parse(
  await readFile(new URL('../tests/fixtures/attention-bait.json', import.meta.url), 'utf8'),
);
const holdout = JSON.parse(
  await readFile(new URL('../tests/fixtures/clef-cascade-holdout.json', import.meta.url), 'utf8'),
);
const policy =
  values.policy === 'current'
    ? settings.policy
    : applyPolicyEdits(settings.policy, fixture.edits).policy;
const firstPolicy =
  values['first-policy'] === 'focused'
    ? await readFile(
        new URL('../tests/fixtures/clef-first-stage-policy.txt', import.meta.url),
        'utf8',
      )
    : policy;
const examples: Example[] = (
  values.split === 'development'
    ? fixture.examples.filter((e: any) => e.split === 'development')
    : values.split === 'validation'
      ? holdout.examples
      : input.examples
).map((e: Example) => ({
  ...e,
  context: e.context || [],
  media: e.media || '',
  family: e.family || 'synthetic-stress-family',
}));
if (
  !examples.length ||
  examples.length > 200 ||
  examples.some(
    (e) => !['ham', 'spam', 'review'].includes(e.label || '') || (e.media && e.media !== 'text'),
  ) ||
  new Set(examples.map((e) => e.id)).size !== examples.length
)
  throw new Error('Need 1–200 unique, labelled text references.');
// A fixed label-blind permutation mixes related contrasts; reverse/rotation stress order effects.
const ordered = (
  await Promise.all(
    examples.map(async (e) => ({ e, key: await digest('clef-cascade-frozen-v1:' + e.id) })),
  )
)
  .sort((a, b) => a.key.localeCompare(b.key))
  .map((x) => x.e);
const plan = {
  version: 1,
  split: values.split,
  policyName: values.policy,
  policyHash: await digest(policy),
  ...(values['first-policy'] === 'focused'
    ? { firstPolicyName: 'focused', firstPolicyHash: await digest(firstPolicy) }
    : {}),
  inputsHash: await digest(examples),
  cutoff,
  repeats,
  batchSize,
  examples: examples.length,
  mode: values.split === 'development' ? 'counterfactual-development' : 'actual-sequential-cascade',
  firstModel: 'cloudflare/clef',
  secondModel: settings.model,
  provider: settings.provider,
  firstEndpoint: 'primeintellect',
  secondEndpoint: 'google-ai-studio',
  classifierSourceHash: await digest(
    await readFile(new URL('../worker/classifier.ts', import.meta.url), 'utf8'),
  ),
  helperSourceHash: await digest(
    await readFile(new URL('../shared/cascade-evaluation.ts', import.meta.url), 'utf8'),
  ),
  maxRequests:
    Math.ceil(examples.length / batchSize) * repeats * (values.split === 'development' ? 2 : 3),
};
console.log(JSON.stringify({ plan }));
if (!values['confirm-paid-evaluation']) process.exit(0);
loadEnvironment();
const env = canonicalEnvironment() as unknown as Env;
if (settings.provider !== 'openrouter')
  throw new Error('This experiment requires the frozen OpenRouter classifier.');
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('https://openrouter.ai/api/'))
    throw new Error('Unexpected experimental provider endpoint.');
  const body = JSON.parse(String(init?.body));
  body.provider = {
    only: [body.model === 'cloudflare/clef' ? plan.firstEndpoint : plan.secondEndpoint],
    allow_fallbacks: false,
  };
  return originalFetch(url, { ...init, body: JSON.stringify(body) });
};
const seal = await digest({
  plan,
  settings: { threshold: settings.threshold, reviewThreshold: settings.reviewThreshold },
});
let report: any;
try {
  report = JSON.parse(await readFile(values.output, 'utf8'));
  if (report.seal !== seal) throw new Error('Frozen inputs/protocol changed. Choose a new report.');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  report = {
    seal,
    plan,
    policy,
    firstPolicy,
    settings: { threshold: settings.threshold, reviewThreshold: settings.reviewThreshold },
    examples,
    createdAt: new Date().toISOString(),
    calls: [],
    failures: [],
  };
}
await mkdir(resolve('.tmp'), { recursive: true });
const save = async () => {
  const pending = values.output + '.pending';
  await writeFile(pending, JSON.stringify(report, null, 2), { mode: 0o600 });
  await rename(pending, values.output!);
};
if (report.inFlight)
  throw new Error(
    'A prior request has uncertain billing/completion. Reconcile its receipt; do not replay it.',
  );
if (report.retryAt > Date.now()) {
  console.log(
    JSON.stringify({ waitingUntil: new Date(report.retryAt).toISOString(), requestMade: false }),
  );
  process.exitCode = 2;
  process.exit();
}
async function call(key: string, model: string, refs: Example[]) {
  const saved = report.calls.find((c: any) => c.key === key);
  if (saved) return saved;
  if (!refs.length)
    return { key, results: [], input: 0, output: 0, cost: 0, latency: 0, skipped: true };
  report.inFlight = { key, model, ids: refs.map((e) => e.id), startedAt: new Date().toISOString() };
  await save();
  try {
    const result = await classify(
      env,
      settings.provider,
      model,
      model === plan.firstModel ? firstPolicy : policy,
      refs,
      settings,
    );
    const stored = { key, model, ids: refs.map((e) => e.id), ...result };
    report.calls.push(stored);
    delete report.inFlight;
    delete report.retryAt;
    report.retryAttempts = 0;
    await save();
    console.log(
      JSON.stringify({
        completed: key,
        model: result.actualModel,
        provider: result.actualProvider,
        cost: result.cost,
      }),
    );
    return stored;
  } catch (error) {
    if (error instanceof ClassificationError) {
      const retry = rateLimitRetry(error, report.retryAttempts || 0);
      report.failures.push({
        key,
        error: error.message,
        usage: error.usage,
        at: new Date().toISOString(),
      });
      if (error.usage.rejected) {
        delete report.inFlight;
        report.retryAt = retry?.nextAt;
        report.retryAttempts = retry?.attempts;
      }
      await save();
      console.error(
        JSON.stringify({
          stopped: key,
          rejected: !!error.usage.rejected,
          cost: error.usage.cost,
          retryAt: report.retryAt,
        }),
      );
      process.exitCode = 1;
      process.exit();
    }
    throw error;
  }
}
const thresholds = [0.95, 0.975, 0.99, 0.995, 0.999];
const rounds: any[] = [];
for (let repeat = 0; repeat < repeats; repeat++) {
  const refs =
    repeat === 1
      ? [...ordered].reverse()
      : repeat === 2
        ? [...ordered.slice(7), ...ordered.slice(0, 7)]
        : ordered;
  const baseline: Prediction[] = [],
    cascade: Prediction[] = [],
    firstPredictions: Prediction[] = [];
  const caseLatencies: any[] = [],
    baselineLatencies: any[] = [];
  let cascadeCost = 0,
    baselineCost = 0,
    costKnown = true;
  const roundBatches: any[] = [];
  for (let offset = 0; offset < refs.length; offset += batchSize) {
    const batch = refs.slice(offset, offset + batchSize),
      batchId = offset / batchSize,
      prefix = `r${repeat}:b${batchId}`;
    let gemini: any;
    if (repeat !== 1) gemini = await call(prefix + ':gemini-alone', settings.model, batch);
    const first = await call(prefix + ':clef', plan.firstModel, batch);
    const { early, remaining } = cascadeInputs(batch, first.results, cutoff);
    const second =
      values.split === 'development'
        ? null
        : await call(prefix + ':gemini-fallback', settings.model, remaining);
    if (repeat === 1) gemini = await call(prefix + ':gemini-alone', settings.model, batch);
    baseline.push(...gemini.results);
    firstPredictions.push(...first.results);
    const fallback =
      second?.results ||
      gemini.results.filter((p: Prediction) => remaining.some((e) => e.id === p.id));
    cascade.push(...cascadeResults(batch, first.results, fallback, cutoff));
    if (values.split !== 'development')
      caseLatencies.push(
        ...cascadeLatency(batch, first.results, cutoff, first.latency, second.latency),
      );
    baselineLatencies.push(...batch.map((e) => ({ id: e.id, latency: gemini.latency })));
    costKnown &&=
      gemini.cost !== null &&
      first.cost !== null &&
      (values.split === 'development' || second.cost !== null);
    baselineCost += gemini.cost || 0;
    if (values.split !== 'development') cascadeCost += (first.cost || 0) + (second.cost || 0);
    roundBatches.push({
      ids: batch.map((e) => e.id),
      earlyIds: early.map((e) => e.id),
      fallbackIds: remaining.map((e) => e.id),
      firstKey: first.key,
      baselineKey: gemini.key,
      secondKey: second?.key,
    });
  }
  const metrics = (predictions: Prediction[]) => policyMetrics(examples, predictions, settings);
  const before = metrics(baseline),
    after = metrics(cascade);
  const firstHigh = cascadeInputs(examples, firstPredictions, cutoff).early;
  const baselineMap = new Map(baseline.map((p) => [p.id, p]));
  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      mean: values.reduce((a, b) => a + b, 0) / values.length,
      p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    };
  };
  rounds.push({
    repeat,
    baseline: before,
    cascade: after,
    early: {
      total: firstHigh.length,
      spam: firstHigh.filter((e) => e.label === 'spam').length,
      ham: firstHigh.filter((e) => e.label === 'ham').length,
      review: firstHigh.filter((e) => e.label === 'review').length,
    },
    newFalsePositives: after.falsePositives.filter((id) => !before.falsePositives.includes(id)),
    repairedMisses: examples
      .filter(
        (e) =>
          e.label === 'spam' &&
          routed(baselineMap.get(e.id)!, settings) === 'ham' &&
          routed(
            cascade.find((p) => p.id === e.id)!,
            settings,
          ) === 'spam',
      )
      .map((e) => e.id),
    baselineCost: costKnown ? baselineCost : null,
    cascadeCost: costKnown && values.split !== 'development' ? cascadeCost : null,
    baselineLatency: stats(baselineLatencies.map((e) => e.latency)),
    cascadeLatency: caseLatencies.length ? stats(caseLatencies.map((e) => e.latency)) : null,
    batches: roundBatches,
    thresholdSweep:
      values.split === 'development'
        ? thresholds.map((t) => {
            const { early, remaining } = cascadeInputs(examples, firstPredictions, t);
            const simulated = cascadeResults(
              examples,
              firstPredictions,
              baseline.filter((p) => remaining.some((e) => e.id === p.id)),
              t,
            );
            return {
              cutoff: t,
              earlySpam: early.filter((e) => e.label === 'spam').length,
              earlyHam: early.filter((e) => e.label === 'ham').length,
              metrics: metrics(simulated),
            };
          })
        : undefined,
  });
}
report.rounds = rounds;
report.completedAt = new Date().toISOString();
report.reportedSuccessfulCostUSD = report.calls.every((c: any) => c.cost !== null)
  ? report.calls.reduce((n: number, c: any) => n + c.cost, 0)
  : null;
report.identities = {
  clef: [
    ...new Set(
      report.calls
        .filter((c: any) => c.model === plan.firstModel)
        .map((c: any) => `${c.actualModel} / ${c.actualProvider}`),
    ),
  ],
  gemini: [
    ...new Set(
      report.calls
        .filter((c: any) => c.model === plan.secondModel)
        .map((c: any) => `${c.actualModel} / ${c.actualProvider}`),
    ),
  ],
};
await save();
console.log(
  JSON.stringify({
    complete: true,
    rounds: rounds.map((r) => ({
      repeat: r.repeat,
      baselineLoss: r.baseline.loss,
      cascadeLoss: r.cascade.loss,
      early: r.early,
      newFalsePositives: r.newFalsePositives.length,
      repairedMisses: r.repairedMisses.length,
      baselineCost: r.baselineCost,
      cascadeCost: r.cascadeCost,
    })),
    cost: report.reportedSuccessfulCostUSD,
    identities: report.identities,
  }),
);
