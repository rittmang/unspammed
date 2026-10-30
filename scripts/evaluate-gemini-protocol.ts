// Checkpointed, opt-in paid experiments. No database or Telegram operations.
import { readFile, writeFile, mkdir, rename, open } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnvironment, canonicalEnvironment } from './setup-env.mjs';
import { classify, ClassificationError } from '../worker/classifier';
import { applyPolicyEdits } from '../worker/improvement';
import { digest, policyMetrics } from '../shared/improvement';
import { settingsSchema, type Example } from '../shared/types';
import {
  experimentalPayload,
  experimentalResponse,
  type ClassifierExperiment,
} from '../shared/classifier-experiments';
import { rateLimitRetry } from '../worker/provider-errors';
import type { Env } from '../worker/env';

const { values } = parseArgs({
  options: {
    input: { type: 'string' },
    output: { type: 'string' },
    split: { type: 'string', default: 'development' },
    policy: { type: 'string', default: 'candidate' },
    protocol: { type: 'string', default: 'standard' },
    'batch-size': { type: 'string', default: '1' },
    repeats: { type: 'string', default: '1' },
    'round-limit': { type: 'string', default: '3' },
    'reasoning-tokens': { type: 'string', default: '0' },
    'confirm-paid-evaluation': { type: 'boolean', default: false },
  },
});
if (!values.input || !values.output)
  throw new Error('Supply private --input and --output in .tmp/.');
for (const file of [values.input, values.output]) {
  const local = relative(resolve('.tmp'), resolve(file));
  if (!local || local.startsWith('..')) throw new Error('Private paths must be inside .tmp/.');
}
if (!['development', 'stress', 'validation', 'historical'].includes(values.split))
  throw new Error('Unknown split.');
if (!['current', 'candidate', 'concise'].includes(values.policy))
  throw new Error('Unknown policy.');
if (!['standard', 'reason-first', 'categorical', 'criteria'].includes(values.protocol))
  throw new Error('Unknown protocol.');
const protocol = values.protocol as ClassifierExperiment;
const reasoningTokens = Number(values['reasoning-tokens']);
if (!Number.isInteger(reasoningTokens) || reasoningTokens < 0 || reasoningTokens > 4096)
  throw new Error('Reasoning tokens must be 0–4096.');
const batchSize = Number(values['batch-size']),
  repeats = Number(values.repeats);
const roundLimit = Math.min(repeats, Number(values['round-limit']));
if (
  !Number.isInteger(batchSize) ||
  batchSize < 1 ||
  batchSize > 20 ||
  !Number.isInteger(repeats) ||
  repeats < 1 ||
  repeats > 3
)
  throw new Error('Use batch size 1–20 and repeats 1–3.');
if (!Number.isInteger(roundLimit) || roundLimit < 1 || roundLimit > 3)
  throw new Error('Round limit must be 1–3.');
const input = JSON.parse(await readFile(values.input, 'utf8'));
const settings = { ...settingsSchema.parse(input.settings), reasoningTokens: 0 as const };
const fixture = JSON.parse(
  await readFile(new URL('../tests/fixtures/attention-bait.json', import.meta.url), 'utf8'),
);
const concise = JSON.parse(
  await readFile(new URL('../tests/fixtures/attention-bait-concise.json', import.meta.url), 'utf8'),
);
const fixturePath =
  values.split === 'stress'
    ? '../tests/fixtures/clef-cascade-holdout.json'
    : '../tests/fixtures/gemini-batching-validation.json';
const fresh = JSON.parse(await readFile(new URL(fixturePath, import.meta.url), 'utf8'));
const policy =
  values.policy === 'current'
    ? settings.policy
    : applyPolicyEdits(settings.policy, values.policy === 'concise' ? concise.edits : fixture.edits)
        .policy;
const examples: Example[] = (
  values.split === 'development'
    ? fixture.examples.filter((e: any) => e.split === 'development')
    : values.split === 'historical'
      ? input.examples
      : fresh.examples
).map((e: Example) => ({
  ...e,
  context: e.context || [],
  media: e.media || '',
  family: e.family || 'synthetic-stress-family',
}));
if (
  !examples.length ||
  examples.length > 200 ||
  new Set(examples.map((e) => e.id)).size !== examples.length ||
  examples.some(
    (e) => !['ham', 'spam', 'review'].includes(e.label || '') || (e.media && e.media !== 'text'),
  )
)
  throw new Error('Need 1–200 unique, labelled text references.');
const ordered = (
  await Promise.all(
    examples.map(async (e) => ({ e, key: await digest('gemini-protocol-frozen-v1:' + e.id) })),
  )
)
  .sort((a, b) => a.key.localeCompare(b.key))
  .map((x) => x.e);
const plan = {
  version: 1,
  split: values.split,
  policyName: values.policy,
  policyHash: await digest(policy),
  inputsHash: await digest(examples),
  protocol,
  reasoningTokens,
  batchSize,
  repeats,
  model: settings.model,
  provider: settings.provider,
  endpoint: 'google-ai-studio',
  thresholds: { spam: settings.threshold, review: settings.reviewThreshold },
  repeatPerturbations: [
    'label-blind permutation; positional wire IDs',
    'reverse; hashed opaque wire IDs',
    'rotate seven; different hashed opaque wire IDs',
  ].slice(0, repeats),
  examples: examples.length,
  maxRequests: Math.ceil(examples.length / batchSize) * repeats,
  classifierSourceHash: await digest(
    await readFile(new URL('../worker/classifier.ts', import.meta.url), 'utf8'),
  ),
  protocolSourceHash: await digest(
    await readFile(new URL('../shared/classifier-experiments.ts', import.meta.url), 'utf8'),
  ),
  runnerSourceHash: await digest(await readFile(new URL(import.meta.url), 'utf8')),
};
console.log(JSON.stringify({ plan }));
if (!values['confirm-paid-evaluation']) process.exit(0);
if (settings.provider !== 'openrouter' || settings.model !== 'google/gemini-2.5-flash-lite')
  throw new Error('This study pins the audited Gemini OpenRouter model.');
await mkdir(resolve('.tmp'), { recursive: true });
const lockPath = values.output + '.lock';
const lock = await open(lockPath, 'wx', 0o600).catch(() => {
  throw new Error(
    'Experiment locked. Check for a running process or interrupted request before removing its lock.',
  );
});
await lock.close();
process.once('exit', () => rmSync(lockPath, { force: true }));
const seal = await digest(plan);
let report: any;
try {
  report = JSON.parse(await readFile(values.output, 'utf8'));
  if (report.seal !== seal) throw new Error('Frozen protocol changed; choose a new report.');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  report = {
    seal,
    plan,
    policy,
    examples,
    createdAt: new Date().toISOString(),
    calls: [],
    failures: [],
  };
}
const save = async () => {
  await writeFile(values.output + '.pending', JSON.stringify(report, null, 2), { mode: 0o600 });
  await rename(values.output + '.pending', values.output!);
};
if (report.inFlight)
  throw new Error('Uncertain prior completion: reconcile the receipt; do not replay.');
if (report.retryAt > Date.now()) {
  console.log(
    JSON.stringify({ waitingUntil: new Date(report.retryAt).toISOString(), requestMade: false }),
  );
  process.exit(2);
}
loadEnvironment();
const env = canonicalEnvironment() as unknown as Env;
const originalFetch = globalThis.fetch;
let aliases: string[] | undefined, receipt: any;
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://openrouter.ai/api/v1/chat/completions')
    throw new Error('Unexpected provider endpoint.');
  const { body, wireIds } = experimentalPayload(JSON.parse(String(init?.body)), protocol, aliases);
  body.provider = { only: [plan.endpoint], allow_fallbacks: false };
  if (reasoningTokens) {
    body.reasoning = { max_tokens: reasoningTokens, exclude: true };
    body.max_tokens += reasoningTokens;
  }
  const requestHash = await digest(body);
  const response = await originalFetch(url, { ...init, body: JSON.stringify(body) });
  if (!response.ok) return response;
  const data = await response.json();
  receipt = { requestHash, response: data };
  return new Response(JSON.stringify(experimentalResponse(data, protocol, wireIds)), {
    status: response.status,
    headers: { 'Content-Type': 'application/json' },
  });
};
for (let repeat = 0; repeat < roundLimit; repeat++) {
  const refs =
    repeat === 1
      ? [...ordered].reverse()
      : repeat === 2
        ? [...ordered.slice(7), ...ordered.slice(0, 7)]
        : ordered;
  for (let offset = 0; offset < refs.length; offset += batchSize) {
    const batch = refs.slice(offset, offset + batchSize),
      key = `r${repeat}:b${offset / batchSize}`;
    if (report.calls.some((c: any) => c.key === key)) continue;
    aliases = repeat
      ? await Promise.all(
          batch.map(async (e) => 'x' + (await digest(`opaque-v1:${repeat}:${e.id}`)).slice(0, 10)),
        )
      : undefined;
    receipt = undefined;
    report.inFlight = { key, ids: batch.map((e) => e.id), startedAt: new Date().toISOString() };
    await save();
    try {
      const result = await classify(
        env,
        settings.provider,
        settings.model,
        policy,
        batch,
        settings,
      );
      report.calls.push({ key, repeat, ids: batch.map((e) => e.id), ...result, receipt });
      delete report.inFlight;
      delete report.retryAt;
      report.retryAttempts = 0;
      await save();
      console.log(
        JSON.stringify({
          completed: key,
          cost: result.cost,
          model: result.actualModel,
          provider: result.actualProvider,
        }),
      );
    } catch (error) {
      if (!(error instanceof ClassificationError)) throw error;
      const retry = rateLimitRetry(error, report.retryAttempts || 0);
      report.failures.push({
        key,
        error: error.message,
        usage: error.usage,
        occurredAt: new Date().toISOString(),
      });
      if (error.usage.rejected && retry) {
        delete report.inFlight;
        report.retryAt = retry.nextAt;
        report.retryAttempts = retry.attempts;
        await save();
        console.log(JSON.stringify({ stopped: key, rejected: true, retryAt: retry.nextAt }));
        process.exit(1);
      }
      // Count terminal failures as unclassified cases, never as fabricated review/allow.
      report.calls.push({
        key,
        repeat,
        ids: batch.map((e) => e.id),
        terminalFailure: true,
        usage: error.usage,
        receipt,
      });
      delete report.inFlight;
      await save();
      console.log(
        JSON.stringify({
          terminalFailure: key,
          billedCost: error.usage.cost,
          invalidOutput: error.invalidOutput,
        }),
      );
    }
  }
}
const stats = (numbers: number[]) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  return {
    mean: numbers.reduce((a, b) => a + b, 0) / numbers.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
};
report.rounds = Array.from({ length: roundLimit }, (_, repeat) => {
  const calls = report.calls.filter((c: any) => c.repeat === repeat),
    successful = calls.filter((c: any) => !c.terminalFailure);
  const predictions = successful.flatMap((c: any) => c.results),
    evaluated = examples.filter((e) => predictions.some((p: any) => p.id === e.id));
  return {
    repeat,
    expected: examples.length,
    classified: evaluated.length,
    unclassified: calls.filter((c: any) => c.terminalFailure).flatMap((c: any) => c.ids),
    metrics: evaluated.length ? policyMetrics(evaluated, predictions, settings) : null,
    cost: calls.every((c: any) => Number.isFinite(c.cost ?? c.usage?.cost))
      ? calls.reduce((n: number, c: any) => n + (c.cost ?? c.usage?.cost), 0)
      : null,
    latency: successful.length
      ? stats(successful.flatMap((c: any) => c.ids.map(() => c.latency)))
      : null,
  };
});
report.completedRounds = roundLimit;
if (roundLimit === repeats) report.completedAt = new Date().toISOString();
else report.screenedAt = new Date().toISOString();
report.reportedSuccessfulCostUSD = report.calls
  .filter((c: any) => !c.terminalFailure)
  .reduce((n: number, c: any) => n + (c.cost || 0), 0);
await save();
console.log(
  JSON.stringify({
    complete: true,
    rounds: report.rounds.map((r: any) => ({
      repeat: r.repeat,
      classified: r.classified,
      loss: r.metrics?.loss,
      spamCaught: r.metrics?.spamFlagged,
      spamAllowed: r.metrics?.misses.length,
      falsePositives: r.metrics?.falsePositives.length,
      reviews: r.metrics?.reviews,
      cost: r.cost,
      latency: r.latency,
    })),
  }),
);
