// Read-only, opt-in paid evaluation. No database or Telegram operations.
// Supply private { settings, examples?: Example[] } input; reports may contain private text.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnvironment, canonicalEnvironment } from './setup-env.mjs';
import { classify, estimateTokens, ClassificationError } from '../worker/classifier';
import { applyPolicyEdits } from '../worker/improvement';
import { digest, policyMetrics, routed } from '../shared/improvement';
import { settingsSchema, type Example, type Prediction } from '../shared/types';
import type { Env } from '../worker/env';
import { rateLimitRetry } from '../worker/provider-errors';

const { values } = parseArgs({
  options: {
    input: { type: 'string' },
    output: { type: 'string' },
    split: { type: 'string', default: 'development' },
    repeats: { type: 'string', default: '1' },
    'reason-first': { type: 'boolean', default: false },
    'batch-size': { type: 'string', default: '10' },
    endpoint: { type: 'string' },
    'reasoning-tokens': { type: 'string', default: '0' },
    'confirm-paid-evaluation': { type: 'boolean', default: false },
  },
});
if (!values.input || !values.output)
  throw new Error('Supply --input and --output paths inside ignored .tmp/.');
for (const path of [values.input, values.output]) {
  const local = relative(resolve('.tmp'), resolve(path));
  if (local.startsWith('..') || local === '..' || resolve(path) === resolve('.tmp'))
    throw new Error('Private input/output must be inside .tmp/.');
}
const repeats = Number(values.repeats);
const batchSize = Number(values['batch-size']);
const reasoningTokens = Number(values['reasoning-tokens']);
if (!Number.isInteger(reasoningTokens) || reasoningTokens < 0 || reasoningTokens > 4096)
  throw new Error('Reasoning tokens must be 0–4096.');
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 30)
  throw new Error('Batch size must be 1–30.');
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3)
  throw new Error('Repeats must be 1–3.');
if (!['development', 'challenge', 'regression', 'all'].includes(values.split))
  throw new Error('Unknown split.');
const fixture = JSON.parse(
  await readFile(new URL('../tests/fixtures/attention-bait.json', import.meta.url), 'utf8'),
);
const input = JSON.parse(await readFile(values.input, 'utf8'));
const settings = { ...settingsSchema.parse(input.settings), reasoningTokens: 0 as const };
const candidate = applyPolicyEdits(settings.policy, fixture.edits).policy;
const synthetic = fixture.examples.filter(
  (e: any) => values.split === 'all' || e.split === values.split,
);
const examples: Example[] = (
  values.split === 'regression'
    ? input.examples
    : values.split === 'all'
      ? [...synthetic, ...(input.examples || [])]
      : synthetic
).map((e: any) => ({ ...e, context: e.context || [], media: e.media || '' }));
if (!examples.length || examples.length > 200) throw new Error('Need 1–200 references.');
if (new Set(examples.map((e) => e.id)).size !== examples.length)
  throw new Error('Reference IDs must be unique.');
loadEnvironment();
const env = canonicalEnvironment() as unknown as Env;
let observedReasoningTokens: number | null = null;
// Experimental protocol ablation: the same classifier/model, one inference per input.
// The baseline and candidate receive exactly the same protocol change.
if (values['reason-first'] || values.endpoint || reasoningTokens) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (values.endpoint) body.provider = { only: [values.endpoint], allow_fallbacks: false };
    if (reasoningTokens) {
      body.reasoning = { max_tokens: reasoningTokens, exclude: true };
      body.max_tokens += reasoningTokens;
    }
    if (values['reason-first'])
      body.messages[0].content +=
        '\nFor EACH message, read its ENTIRE text and supplied recent context independently. Write the reason FIRST: identify its actual subject or contribution (or explicitly its absence), then the decisive evidence and applicable policy rule. Only after this evidence check choose category, needs_review and score. A generic announcement that a question exists is not its subject. Do not infer missing content. Do not label a substantive question as empty merely because its opening resembles another message. Choose score from the supplied numerical thresholds after deciding the rule outcome.';
    const item = body.response_format?.json_schema?.schema?.properties?.results?.items;
    if (item && values['reason-first']) {
      const p = item.properties;
      item.properties = {
        id: p.id,
        reason: p.reason,
        category: p.category,
        needs_review: p.needs_review,
        score: p.score,
      };
      item.required = ['id', 'reason', 'category', 'needs_review', 'score'];
    }
    const response = await originalFetch(url, { ...init, body: JSON.stringify(body) });
    const data = (await response
      .clone()
      .json()
      .catch(() => null)) as {
      usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
    } | null;
    observedReasoningTokens = data?.usage?.completion_tokens_details?.reasoning_tokens ?? null;
    return response;
  };
}
const batches = Array.from({ length: Math.ceil(examples.length / batchSize) }, (_, i) =>
  examples.slice(i * batchSize, i * batchSize + batchSize),
);
const plan = {
  split: values.split,
  repeats,
  reasonFirst: values['reason-first'],
  batchSize,
  endpoint: values.endpoint,
  reasoningTokens,
  examples: examples.length,
  requests: batches.length * 2 * repeats,
  estimatedTokensPerRepeat: batches.reduce(
    (n, b) =>
      n +
      estimateTokens(env, settings.provider, settings.model, settings.policy, b) +
      estimateTokens(env, settings.provider, settings.model, candidate, b),
    0,
  ),
  model: settings.model,
  baselineHash: await digest(settings.policy),
  candidateHash: await digest(candidate),
};
console.log(JSON.stringify({ plan }));
if (!values['confirm-paid-evaluation']) process.exit(0);
const seal = await digest({ plan, examples });
let report: any;
try {
  report = JSON.parse(await readFile(values.output, 'utf8'));
  if (report.seal !== seal) throw new Error('Report inputs changed; choose a new output path.');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  report = {
    seal,
    plan,
    createdAt: new Date().toISOString(),
    scope:
      'Read-only paired development/synthetic or retrospective regression evidence. Not sealed production certification. No publication.',
    baseline: settings.policy,
    candidate,
    examples,
    calls: [],
  };
}
await mkdir(resolve('.tmp'), { recursive: true });
const save = () => writeFile(values.output!, JSON.stringify(report, null, 2), { mode: 0o600 });
if (report.retryAt > Date.now())
  throw new Error(
    `Provider retry is due after ${new Date(report.retryAt).toISOString()}. No request was made.`,
  );
for (let repeat = 0; repeat < repeats; repeat++) {
  for (let batch = 0; batch < batches.length; batch++) {
    const refs =
      repeat % 2
        ? [...batches[batch]].reverse()
        : repeat === 2
          ? [...batches[batch].slice(3), ...batches[batch].slice(0, 3)]
          : batches[batch];
    for (const variant of repeat % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const key = `${repeat}:${batch}:${variant}`;
      if (report.calls.some((c: any) => c.key === key)) continue;
      // Save an in-flight marker. Interrupted/unknown billing is never silently replayed.
      if (report.inFlight)
        throw new Error('A prior request has uncertain completion. Reconcile it before resuming.');
      report.inFlight = { key, startedAt: new Date().toISOString() };
      await save();
      let response;
      try {
        response = await classify(
          env,
          settings.provider,
          settings.model,
          variant === 'baseline' ? settings.policy : candidate,
          refs,
          settings,
        );
      } catch (error) {
        if (error instanceof ClassificationError) {
          report.failures ??= [];
          const retry = rateLimitRetry(error, report.retryAttempts || 0);
          report.retryAttempts = retry?.attempts;
          report.retryAt = retry?.nextAt;
          report.failures.push({
            key,
            error: error.message,
            usage: error.usage,
            occurredAt: new Date().toISOString(),
            retryAt: report.retryAt,
          });
          if (error.usage.rejected) delete report.inFlight;
          await save();
          console.error(
            JSON.stringify({
              stopped: key,
              rejected: !!error.usage.rejected,
              cost: error.usage.cost,
              detail: 'Provider failure saved privately. No automatic retry.',
            }),
          );
          process.exitCode = 1;
          process.exit();
        }
        throw error;
      }
      report.calls.push({ key, repeat, batch, variant, ...response, observedReasoningTokens });
      delete report.inFlight;
      delete report.retryAt;
      report.retryAttempts = 0;
      await save();
      console.log(
        JSON.stringify({
          completed: key,
          cost: response.cost,
          actualModel: response.actualModel,
          actualProvider: response.actualProvider,
        }),
      );
    }
  }
}
report.comparisons = Array.from({ length: repeats }, (_, repeat) =>
  Object.fromEntries(
    ['baseline', 'candidate'].map((variant) => {
      const calls = report.calls.filter((c: any) => c.repeat === repeat && c.variant === variant);
      const predictions: Prediction[] = calls.flatMap((c: any) => c.results);
      return [
        variant,
        {
          metrics: policyMetrics(
            examples.map((e) => ({ ...e, family: e.family || 'synthetic-fixture' })),
            predictions,
            settings,
          ),
          errors: examples.flatMap((e) => {
            const p = predictions.find((p) => p.id === e.id)!;
            return routed(p, settings) !== e.label
              ? [
                  {
                    id: e.id,
                    label: e.label,
                    route: routed(p, settings),
                    score: p.score,
                    reason: p.reason,
                  },
                ]
              : [];
          }),
        },
      ];
    }),
  ),
);
report.totalCost = report.calls.every((c: any) => c.cost !== null)
  ? report.calls.reduce((n: number, c: any) => n + c.cost, 0)
  : null;
report.identities = [
  ...new Set(report.calls.map((c: any) => JSON.stringify([c.actualModel, c.actualProvider]))),
];
report.completedAt = new Date().toISOString();
await save();
console.log(
  JSON.stringify({
    comparisons: report.comparisons.map((comparison: any, repeat: number) => ({
      repeat,
      ...Object.fromEntries(
        ['baseline', 'candidate'].map((variant) => {
          const m = comparison[variant].metrics;
          return [
            variant,
            {
              loss: m.loss,
              spamCaught: m.spamFlagged,
              spamAllowed: m.misses.length,
              falsePositives: m.falsePositives.length,
              spamDeferred: m.spamDeferred,
              unnecessaryReviews: m.unnecessaryReviews.length,
            },
          ];
        }),
      ),
    })),
    totalCost: report.totalCost,
    identities: report.identities,
  }),
);
