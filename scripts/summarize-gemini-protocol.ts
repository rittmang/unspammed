// Offline only. Publish counts/hashes, never message text, reasons or provider request IDs.
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { policyMetrics } from '../shared/improvement';
import { validatePredictions } from '../worker/classifier';

const { values } = parseArgs({
  options: {
    report: { type: 'string', multiple: true },
    output: { type: 'string' },
  },
});
if (!values.report?.length || !values.output)
  throw new Error('Supply --report for every private ledger and --output.');
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const knownCost = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const experiments = [];
const ledgerHashes = new Set<string>();
const receiptIds = new Set<string>();
for (const file of values.report) {
  const raw = await readFile(file, 'utf8');
  const ledgerHash = createHash('sha256').update(raw).digest('hex');
  if (ledgerHashes.has(ledgerHash)) throw new Error('Duplicate ledger content.');
  ledgerHashes.add(ledgerHash);
  const r = JSON.parse(raw);
  if (new Set(r.calls.map((c: any) => c.key)).size !== r.calls.length)
    throw new Error(`Duplicate paid calls: ${basename(file)}`);
  for (const call of r.calls) {
    const id = call.requestId ?? call.usage?.requestId ?? call.receipt?.response?.id;
    if (!id) continue;
    if (receiptIds.has(id)) throw new Error('Duplicate provider receipt across captured calls.');
    receiptIds.add(id);
  }
  const rounds = [];
  for (let repeat = 0; repeat < r.plan.repeats; repeat++) {
    const calls = r.calls.filter((c: any) => c.repeat === repeat);
    if (!calls.length) continue;
    const attempted = calls.flatMap((c: any) => c.ids);
    if (new Set(attempted).size !== attempted.length)
      throw new Error(`Duplicate cases in repeat: ${basename(file)}`);
    const predictions = calls
      .filter((c: any) => !c.terminalFailure)
      .flatMap((c: any) => {
        const refs = r.examples.filter((e: any) => c.ids.includes(e.id));
        return validatePredictions({ results: c.results }, refs);
      });
    const evaluated = r.examples.filter((e: any) => predictions.some((p: any) => p.id === e.id));
    const metrics = evaluated.length
      ? policyMetrics(evaluated, predictions, {
          threshold: r.plan.thresholds.spam,
          reviewThreshold: r.plan.thresholds.review,
        })
      : null;
    const costs = calls.map((c: any) => c.cost ?? c.usage?.cost);
    rounds.push({
      repeat,
      expected: r.examples.length,
      attempted: attempted.length,
      classified: evaluated.length,
      terminalUnclassified: calls.filter((c: any) => c.terminalFailure).flatMap((c: any) => c.ids)
        .length,
      notAttempted: r.examples.length - attempted.length,
      spamCaught: metrics?.spamFlagged ?? 0,
      spamAllowed: metrics?.misses.length ?? 0,
      spamReviewed: metrics?.spamDeferred ?? 0,
      legitimateBlocked: metrics?.falsePositives.length ?? 0,
      legitimateReviewed: metrics?.unnecessaryReviews.length ?? 0,
      weightedLossOnClassifiedOnly: metrics?.loss ?? null,
      costUSD: costs.every(knownCost) ? sum(costs) : null,
      requestLatencyMeanMs: calls.length
        ? sum(calls.map((c: any) => c.latency ?? c.usage?.latency ?? 0)) / calls.length
        : null,
    });
  }
  const costs = r.calls.map((c: any) => c.cost ?? c.usage?.cost);
  const reasoning = r.calls
    .map((c: any) => c.receipt?.response?.usage?.completion_tokens_details?.reasoning_tokens)
    .filter((n: unknown): n is number => typeof n === 'number' && Number.isFinite(n));
  const unknownCosts = costs.filter((c: any) => !knownCost(c)).length + Number(Boolean(r.inFlight));
  experiments.push({
    ledger: basename(file),
    ledgerSHA256: ledgerHash,
    seal: r.seal,
    plan: r.plan,
    createdAt: r.createdAt,
    completedAt: r.completedAt ?? null,
    screenedAt: r.screenedAt ?? null,
    completedRounds: r.completedRounds ?? null,
    hasUncertainInFlightRequest: Boolean(r.inFlight),
    labels: Object.fromEntries(
      ['spam', 'ham', 'review'].map((label) => [
        label,
        r.examples.filter((e: any) => e.label === label).length,
      ]),
    ),
    successfulRequests: r.calls.filter((c: any) => !c.terminalFailure).length,
    terminalFailedRequests: r.calls.filter((c: any) => c.terminalFailure).length,
    rejectedUnbilledRequests: r.failures.filter((f: any) => f.usage?.rejected && f.usage.cost === 0)
      .length,
    unknownCostRequests: unknownCosts,
    knownReportedCostUSD: sum(costs.filter(knownCost)),
    allCapturedBillingKnown: unknownCosts === 0,
    reportedReasoningTokens: reasoning.length
      ? {
          requests: reasoning.length,
          total: sum(reasoning),
          min: Math.min(...reasoning),
          max: Math.max(...reasoning),
        }
      : null,
    identities: [
      ...new Set(
        r.calls
          .filter((c: any) => !c.terminalFailure)
          .map((c: any) => `${c.actualModel || 'unknown'} / ${c.actualProvider || 'unknown'}`),
      ),
    ],
    rounds,
  });
}
const evidence = {
  version: 1,
  generatedAt: new Date().toISOString(),
  scope:
    'Adaptive development and prospectively selected synthetic validation. Missing/invalid outcomes and unfinished screens remain explicit. Repeats are not independent cases. Synthetic labels are not independent production adjudication; no deployed-accuracy claim.',
  experiments,
  successfulRequests: sum(experiments.map((e) => e.successfulRequests)),
  terminalFailedRequests: sum(experiments.map((e) => e.terminalFailedRequests)),
  rejectedUnbilledRequests: sum(experiments.map((e) => e.rejectedUnbilledRequests)),
  unknownCostRequests: sum(experiments.map((e) => e.unknownCostRequests)),
  knownReportedCostUSD: sum(experiments.map((e) => e.knownReportedCostUSD)),
  totalBillingKnown: experiments.every((e) => e.allCapturedBillingKnown),
};
await writeFile(values.output, JSON.stringify(evidence, null, 2) + '\n');
console.log(
  JSON.stringify({
    experiments: experiments.length,
    successfulRequests: evidence.successfulRequests,
    terminalFailedRequests: evidence.terminalFailedRequests,
    unknownCostRequests: evidence.unknownCostRequests,
    knownReportedCostUSD: evidence.knownReportedCostUSD,
  }),
);
