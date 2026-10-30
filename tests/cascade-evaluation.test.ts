import { describe, expect, it } from 'vitest';
import { cascadeInputs, cascadeResults, cascadeLatency } from '../shared/cascade-evaluation';
import { routed } from '../shared/improvement';
import type { Example, Prediction } from '../shared/types';

const examples: Example[] = [
  { id: 'early', text: 'Synthetic violation', label: 'spam' },
  { id: 'later', text: 'Synthetic genuine question', label: 'ham' },
  { id: 'uncertain', text: 'Synthetic ambiguity', label: 'review' },
];
const prediction = (id: string, score: number, needs_review = false): Prediction => ({
  id,
  score,
  needs_review,
  category: 'fixture',
  reason: 'Synthetic result',
});
const first = [
  prediction('early', 0.99),
  prediction('later', 0.9899),
  prediction('uncertain', 1, true),
];

describe('offline high-cutoff cascade evaluation', () => {
  it('short circuits only a valid first-stage score at the cutoff and preserves the actual second-stage reviews', () => {
    expect(cascadeInputs(examples, first, 0.99).early.map((e) => e.id)).toEqual(['early']);
    const second = [prediction('uncertain', 0.1, true), prediction('later', 0.2)];
    const results = cascadeResults(examples, first, second, 0.99);
    expect(results.map((p) => routed(p, { threshold: 0.9, reviewThreshold: 0.75 }))).toEqual([
      'spam',
      'ham',
      'review',
    ]);
    expect(cascadeLatency(examples, first, 0.99, 25, 100)).toEqual([
      { id: 'early', latency: 25 },
      { id: 'later', latency: 125 },
      { id: 'uncertain', latency: 125 },
    ]);
  });

  it('cannot silently fabricate missing decisions, use a full-batch proxy as actual fallback, or accept invalid scores', () => {
    expect(() => cascadeInputs(examples, first.slice(1), 0.99)).toThrow();
    expect(() =>
      cascadeInputs(
        examples,
        first.map((p) => ({ ...p, id: 'early' })),
        0.99,
      ),
    ).toThrow();
    expect(() =>
      cascadeInputs(
        examples,
        first.map((p) => ({ ...p, score: NaN })),
        0.99,
      ),
    ).toThrow();
    expect(() => cascadeResults(examples, first, [prediction('later', 0.2)], 0.99)).toThrow();
    expect(() =>
      cascadeResults(
        examples,
        first,
        examples.map((e) => prediction(e.id, 0.2)),
        0.99,
      ),
    ).toThrow();
    expect(() => cascadeInputs(examples, first, 0.8)).toThrow();
  });

  it('requires no fallback result when every input short circuits and never lets Gemini undo an early error', () => {
    const allEarly = examples.map((e) => prediction(e.id, 1));
    expect(cascadeInputs(examples, allEarly, 0.99).remaining).toEqual([]);
    expect(cascadeResults(examples, allEarly, [], 0.99).every((p) => p.score === 1)).toBe(true);
  });
});
