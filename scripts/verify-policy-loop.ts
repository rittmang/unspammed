// Explicit, read-only provider replay. Uses private saved audit data, never production writes.
// Usage: npx tsx scripts/verify-policy-loop.ts .tmp/policy-campaign-audit.json
import { readFile, writeFile } from 'node:fs/promises';
import { proposePolicy } from '../worker/improvement';
import { classify } from '../worker/classifier';
import {
  policyGate,
  replayCostRatio,
  policyMetrics,
  routed,
  type CorrectionSnapshot,
  type PolicyOptimization,
} from '../shared/improvement';
import type { Example, Prediction, Settings } from '../shared/types';
import type { Env } from '../worker/env';

process.loadEnvFile('.dev.vars');
const path = process.argv[2];
if (!path) throw new Error('Supply the path to a private saved policy audit.');
const audit = JSON.parse(await readFile(path, 'utf8'));
const baseline: Settings = audit.drafts[0].baseline;
const evidence: CorrectionSnapshot[] = audit.feedback.map((e: any) => ({
  ...JSON.parse(e.snapshot),
  feedback: { reasonCode: e.reason_code, note: e.note },
}));
const examples: Example[] = [
  ...audit.drafts[0].phases.development.examples,
  {
    id: 'synthetic-stylized-question',
    text: "𝗛𝗶 everyone! Does anyone know where today's robotics workshop is being held?",
    label: 'ham',
    family: 'synthetic-meaningful-stylized-question',
  },
];
const env = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY } as Env;
const report: any = {
  scope:
    'Saved development fixture, not fresh held-out certification; no live policy or database writes.',
  attempts: [],
  published: false,
};
let optimization: PolicyOptimization = {
  campaignId: 'offline-verification',
  attempt: 1,
  maxAttempts: 3,
  learnedFamilies: [],
  trainingSources: [],
  history: [],
};
let passed = false;
for (let attempt = 1; attempt <= 3; attempt++) {
  const proposal = await proposePolicy(env, baseline, evidence, '', optimization);
  console.log(JSON.stringify({ attempt, diagnosis: proposal.diagnosis, edits: proposal.criteria }));
  const comparisons = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    const a = await classify(
      env,
      baseline.provider,
      baseline.model,
      baseline.policy,
      examples,
      baseline,
    );
    const b = await classify(
      env,
      baseline.provider,
      baseline.model,
      proposal.policy,
      examples,
      baseline,
    );
    const gate = policyGate(
      policyMetrics(examples, a.results, baseline),
      policyMetrics(examples, b.results, baseline),
      replayCostRatio(a, b),
    );
    const corrected = evidence.every((e) => {
      const reference = examples.find(
        (x) =>
          x.text === e.example.text &&
          JSON.stringify(x.context || []) === JSON.stringify(e.example.context || []),
      );
      const prediction = b.results.find((p) => p.id === reference?.id);
      return prediction && routed(prediction, baseline) === e.example.label;
    });
    comparisons.push({
      gate,
      corrected,
      baseline: a.results,
      candidate: b.results,
      route: {
        baseline: [a.actualModel, a.actualProvider],
        candidate: [b.actualModel, b.actualProvider],
      },
      cost: (a.cost || 0) + (b.cost || 0),
    });
    if (!corrected) break; // Fail triggering corrections before spending repeatability calls.
  }
  const stable = (which: 'baseline' | 'candidate') =>
    examples.filter(
      (e) =>
        new Set(
          comparisons.map((c) =>
            routed(
              c[which].find((p) => p.id === e.id)!,
              baseline,
            ),
          ),
        ).size > 1,
    ).length;
  passed = comparisons.every((c) => c.gate.pass && c.corrected) && stable('candidate') === 0;
  report.attempts.push({
    attempt,
    proposal,
    comparisons,
    unstableBaselineInputs: stable('baseline'),
    unstableCandidateInputs: stable('candidate'),
    passed,
  });
  console.log(
    JSON.stringify({
      attempt,
      passed,
      corrected: comparisons.map((c) => c.corrected),
      failed: comparisons.map((c) =>
        Object.entries(c.gate.checks)
          .filter(([, ok]) => !ok)
          .map(([key]) => key),
      ),
      losses: comparisons.map((c) => [c.gate.baseline.loss, c.gate.candidate.loss]),
      unstableBaselineInputs: stable('baseline'),
      unstableCandidateInputs: stable('candidate'),
    }),
  );
  if (passed) break;
  const last = comparisons[comparisons.length - 1];
  const lessons = examples.map((example) => ({
    source: example.id,
    example,
    baseline: last.baseline.find((p: Prediction) => p.id === example.id)!,
    candidate: last.candidate.find((p: Prediction) => p.id === example.id)!,
  }));
  optimization = {
    ...optimization,
    attempt: attempt + 1,
    lessons,
    revision: {
      previousPolicy: proposal.policy,
      phase: 'development',
      failedChecks: [
        ...Object.entries(last.gate.checks)
          .filter(([, ok]) => !ok)
          .map(([key]) => key),
        ...(!last.corrected ? ['correctedFeedback'] : []),
      ],
      loss: { baseline: last.gate.baseline.loss, candidate: last.gate.candidate.loss },
      examples: lessons
        .filter((e) => routed(e.candidate, baseline) !== e.example.label)
        .slice(0, 12),
    },
    history: [
      ...optimization.history,
      {
        policy: proposal.policy,
        criteria: proposal.criteria,
        phase: 'development',
        baselineLoss: last.gate.baseline.loss,
        candidateLoss: last.gate.candidate.loss,
      },
    ],
  };
}
if (passed) {
  const policy = report.attempts.at(-1).proposal.policy;
  report.savedHoldouts = [];
  for (const phase of ['validation', 'test']) {
    const refs = audit.drafts[0].phases[phase].examples;
    const a = await classify(
      env,
      baseline.provider,
      baseline.model,
      baseline.policy,
      refs,
      baseline,
    );
    const b = await classify(env, baseline.provider, baseline.model, policy, refs, baseline);
    const gate = policyGate(
      policyMetrics(refs, a.results, baseline),
      policyMetrics(refs, b.results, baseline),
      replayCostRatio(a, b),
      0,
    );
    report.savedHoldouts.push({
      phase,
      gate,
      baseline: a.results,
      candidate: b.results,
      cost: (a.cost || 0) + (b.cost || 0),
    });
    console.log(
      JSON.stringify({
        phase,
        passed: gate.pass,
        losses: [gate.baseline.loss, gate.candidate.loss],
      }),
    );
    passed = passed && gate.pass;
  }
}
report.totalCost =
  report.attempts.reduce(
    (n: number, a: any) =>
      n + (a.proposal.usage.cost || 0) + a.comparisons.reduce((n: number, c: any) => n + c.cost, 0),
    0,
  ) + (report.savedHoldouts || []).reduce((n: number, c: any) => n + c.cost, 0);
report.passed = passed;
await writeFile('.tmp/policy-loop-verification.json', JSON.stringify(report, null, 2), {
  mode: 0o600,
});
if (!passed) process.exitCode = 1;
