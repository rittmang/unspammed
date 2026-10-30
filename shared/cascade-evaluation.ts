// Offline evaluation helpers only. This module is not part of live moderation routing.
import type { Example, Prediction } from './types';

function indexed(expected: string[], predictions: Prediction[], stage: string) {
  const ids = new Set(expected);
  if (
    ids.size !== expected.length ||
    predictions.length !== expected.length ||
    new Set(predictions.map((p) => p.id)).size !== expected.length ||
    predictions.some(
      (p) => !ids.has(p.id) || !Number.isFinite(p.score) || p.score < 0 || p.score > 1,
    )
  )
    throw new Error(`${stage} needs exactly one valid prediction per expected input.`);
  return new Map(predictions.map((p) => [p.id, p]));
}

export function cascadeInputs(examples: Example[], first: Prediction[], cutoff: number) {
  if (!Number.isFinite(cutoff) || cutoff < 0.9 || cutoff > 1)
    throw new Error('The experimental first-stage cutoff must be between 0.9 and 1.');
  const byId = indexed(
    examples.map((e) => e.id),
    first,
    'First stage',
  );
  return {
    early: examples.filter((e) => {
      const p = byId.get(e.id)!;
      return !p.needs_review && p.score >= cutoff;
    }),
    remaining: examples.filter((e) => {
      const p = byId.get(e.id)!;
      return p.needs_review || p.score < cutoff;
    }),
  };
}

export function cascadeResults(
  examples: Example[],
  first: Prediction[],
  second: Prediction[],
  cutoff: number,
) {
  const { early, remaining } = cascadeInputs(examples, first, cutoff);
  const firstById = new Map(first.map((p) => [p.id, p]));
  const secondById = indexed(
    remaining.map((e) => e.id),
    second,
    'Second stage',
  );
  const earlyIds = new Set(early.map((e) => e.id));
  return examples.map((e) =>
    earlyIds.has(e.id) ? { ...firstById.get(e.id)!, needs_review: false } : secondById.get(e.id)!,
  );
}

export function cascadeLatency(
  examples: Example[],
  first: Prediction[],
  cutoff: number,
  firstMs: number,
  secondMs: number,
) {
  const { early, remaining } = cascadeInputs(examples, first, cutoff);
  if (![firstMs, secondMs].every((n) => Number.isFinite(n) && n >= 0))
    throw new Error('Invalid stage latency.');
  return [
    ...early.map((e) => ({ id: e.id, latency: firstMs })),
    ...remaining.map((e) => ({ id: e.id, latency: firstMs + secondMs })),
  ];
}
