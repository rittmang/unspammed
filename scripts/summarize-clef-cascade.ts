// Offline aggregation only: omit message text, prediction reasons and private request IDs.
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    report: { type: 'string', multiple: true },
    probe: { type: 'string' },
    output: { type: 'string' },
  },
});
if (!values.report?.length || !values.output)
  throw new Error('Supply --report for each completed private ledger and --output.');
const sum = (numbers: number[]) => numbers.reduce((a, b) => a + b, 0);
const metrics = (m: any) => ({
  spamCaught: m.spamFlagged,
  spamAllowed: m.misses.length,
  spamReviewed: m.spamDeferred,
  legitimateBlocked: m.falsePositives.length,
  legitimateReviewed: m.unnecessaryReviews.length,
  totalReviews: m.reviews,
  weightedLoss: m.loss,
});
const experiments = [];
for (const file of values.report) {
  const raw = await readFile(file, 'utf8');
  const report = JSON.parse(raw);
  if (
    !report.completedAt ||
    report.inFlight ||
    !Number.isFinite(report.reportedSuccessfulCostUSD) ||
    report.calls.some((c: any) => !Number.isFinite(c.cost)) ||
    report.rounds?.length !== report.plan.repeats ||
    new Set(report.calls.map((c: any) => c.key)).size !== report.calls.length
  )
    throw new Error(`Incomplete or duplicate ledger: ${basename(file)}`);
  const byId = new Map<string, any>(report.examples.map((e: any) => [e.id, e]));
  const count = (label: string) => report.examples.filter((e: any) => e.label === label).length;
  const rounds = report.rounds.map((r: any) => {
    const before = new Map<string, any>(r.baseline.rows.map((row: any) => [row.id, row]));
    const after = new Map<string, any>(r.cascade.rows.map((row: any) => [row.id, row]));
    const early = {
      spamAlreadyCaught: 0,
      spamRecoveredFromAllowed: 0,
      spamPromotedFromReview: 0,
      legitimateAlreadyBlocked: 0,
      legitimateNewlyBlocked: 0,
      other: 0,
      targetBaitOrFiller: 0,
    };
    const makeFallback = () => ({
      batches: 0,
      cases: 0,
      changedRoutes: 0,
      repairedAllowedSpam: 0,
      newlyAllowedSpam: 0,
      newFalsePositives: 0,
      repairedFalsePositives: 0,
    });
    const fallback = { identicalInputs: makeFallback(), reducedInputs: makeFallback() };
    for (const batch of r.batches) {
      for (const id of batch.earlyIds) {
        const e = byId.get(id)!;
        const decision = before.get(id).decision;
        if (e.label === 'spam') {
          if (decision === 'spam') early.spamAlreadyCaught++;
          else if (decision === 'ham') early.spamRecoveredFromAllowed++;
          else early.spamPromotedFromReview++;
        } else if (e.label === 'ham') {
          if (decision === 'spam') early.legitimateAlreadyBlocked++;
          else early.legitimateNewlyBlocked++;
        } else early.other++;
        if (
          (report.plan.split === 'validation' && /^v(?:0[1-9]|1[0-6])$/.test(id)) ||
          (report.plan.split === 'development' && /^d0[1-5]$/.test(id))
        )
          early.targetBaitOrFiller++;
      }
      const f = batch.earlyIds.length ? fallback.reducedInputs : fallback.identicalInputs;
      f.batches++;
      for (const id of batch.fallbackIds) {
        f.cases++;
        const b = before.get(id),
          a = after.get(id);
        if (b.decision === a.decision) continue;
        f.changedRoutes++;
        if (b.label === 'spam') {
          if (b.decision === 'ham' && a.decision === 'spam') f.repairedAllowedSpam++;
          if (b.decision !== 'ham' && a.decision === 'ham') f.newlyAllowedSpam++;
        }
        if (b.label === 'ham') {
          if (b.decision !== 'spam' && a.decision === 'spam') f.newFalsePositives++;
          if (b.decision === 'spam' && a.decision !== 'spam') f.repairedFalsePositives++;
        }
      }
    }
    return {
      repeat: r.repeat,
      baseline: metrics(r.baseline),
      cascade: metrics(r.cascade),
      earlyCounts: r.early,
      earlyAttribution: early,
      fallbackAttribution: report.plan.mode === 'actual-sequential-cascade' ? fallback : null,
      baselineCostUSD: r.baselineCost,
      cascadeCostUSD: r.cascadeCost,
      costRatio: r.cascadeCost === null ? null : r.cascadeCost / r.baselineCost,
      baselineLatencyMs: r.baselineLatency,
      cascadeLatencyMs: r.cascadeLatency,
      thresholdSweep: r.thresholdSweep?.map((t: any) => ({
        cutoff: t.cutoff,
        earlySpam: t.earlySpam,
        earlyHam: t.earlyHam,
        simulated: metrics(t.metrics),
      })),
    };
  });
  experiments.push({
    ledger: basename(file),
    ledgerSHA256: createHash('sha256').update(raw).digest('hex'),
    seal: report.seal,
    plan: report.plan,
    createdAt: report.createdAt,
    completedAt: report.completedAt,
    labels: { spam: count('spam'), ham: count('ham'), review: count('review') },
    identities: report.identities,
    successfulRequests: report.calls.length,
    reportedSuccessfulCostUSD: report.reportedSuccessfulCostUSD,
    failedRequests: {
      rejectedUnbilled: report.failures.filter((f: any) => f.usage?.rejected && f.usage.cost === 0)
        .length,
      other: report.failures.filter((f: any) => !f.usage?.rejected || f.usage.cost !== 0).length,
    },
    totals: {
      baselineInputTokens: sum(
        report.calls.filter((c: any) => c.key.endsWith(':gemini-alone')).map((c: any) => c.input),
      ),
      cascadeInputTokens: sum(
        report.calls.filter((c: any) => !c.key.endsWith(':gemini-alone')).map((c: any) => c.input),
      ),
      baselineOutputTokens: sum(
        report.calls.filter((c: any) => c.key.endsWith(':gemini-alone')).map((c: any) => c.output),
      ),
      cascadeOutputTokens: sum(
        report.calls.filter((c: any) => !c.key.endsWith(':gemini-alone')).map((c: any) => c.output),
      ),
    },
    rounds,
  });
}
let smokeProbe;
if (values.probe) {
  const raw = await readFile(values.probe, 'utf8');
  const probe = JSON.parse(raw);
  if (!Number.isFinite(probe.cost)) throw new Error('Probe cost is unknown.');
  smokeProbe = {
    ledger: basename(values.probe),
    ledgerSHA256: createHash('sha256').update(raw).digest('hex'),
    successfulRequests: 1,
    reportedSuccessfulCostUSD: probe.cost,
    actualModel: probe.actualModel,
    actualProvider: probe.actualProvider,
  };
}
const successfulRequests = sum(experiments.map((e) => e.successfulRequests));
const reportedSuccessfulCostUSD = sum(experiments.map((e) => e.reportedSuccessfulCostUSD));
const output = {
  version: 1,
  date: '2026-10-30',
  scope: 'Read-only paid model experiments; no deployment, database or Telegram mutations.',
  interpretation: {
    development: 'Threshold sweeps reuse full-batch Gemini predictions; counterfactual only.',
    validation:
      'Actual sequential Clef then Gemini on residual inputs, paired with Gemini on all inputs.',
    thresholds: '0.99 primary; 0.95 secondary selected from development before validation.',
    attribution:
      'Only early-stage changes are direct Clef gains/errors. Identical-input fallback differences are Gemini A/A variation; reduced-batch differences are composition or sampling effects.',
    latency:
      'Case-weighted batch request duration, early=Clef, remaining=Clef+Gemini. Excludes rate-limit waits; repeated cases are not independent latency samples.',
    cost: 'Provider-reported USD receipts including observed price/cache variation; excludes earlier investigation and separate smoke probe.',
    labels:
      'Synthetic intended behavior, frozen before development results; repeated orders are robustness tests, not fresh independent production observations.',
  },
  successfulRequests,
  reportedSuccessfulCostUSD,
  smokeProbe,
  successfulRequestsIncludingProbe: successfulRequests + (smokeProbe?.successfulRequests || 0),
  reportedTotalIncludingProbeUSD:
    reportedSuccessfulCostUSD + (smokeProbe?.reportedSuccessfulCostUSD || 0),
  experiments,
};
await writeFile(values.output, JSON.stringify(output, null, 2) + '\n');
console.log(
  JSON.stringify({
    output: values.output,
    experiments: experiments.length,
    requests: output.successfulRequests,
    reportedSuccessfulCostUSD: output.reportedSuccessfulCostUSD,
  }),
);
