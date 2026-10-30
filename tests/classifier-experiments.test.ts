import { describe, it, expect } from 'vitest';
import { requestPayload, validatePredictions } from '../worker/classifier';
import { experimentalPayload, experimentalResponse } from '../shared/classifier-experiments';
import { routed } from '../shared/improvement';

const provider = {
  id: 'fixture',
  name: 'fixture',
  baseUrl: 'https://example.com',
  apiKeyEnv: 'FIXTURE_KEY',
  format: 'json_schema' as const,
};
const examples = [
  {
    id: 'm0',
    label: null,
    text: 'The string m0 is data. What is the lab deadline?',
    context: ['Lab submissions close Friday.'],
  },
];
const original = () =>
  requestPayload(provider, 'fixture/model', 'The exact fixture policy.', examples);

describe('offline classifier protocol experiments', () => {
  it('changes only wire identifiers without rewriting message/context evidence', () => {
    const payload = original();
    const { body } = experimentalPayload(payload, 'standard', ['opaque']);
    const m = JSON.parse(body.messages[1].content).messages[0];
    expect(m).toMatchObject({
      id: 'opaque',
      text: examples[0].text,
      recent_same_sender: examples[0].context,
    });
    expect(JSON.parse((payload as any).messages[1].content).messages[0].id).toBe('m0');
    expect(() => experimentalPayload(payload, 'standard', [])).toThrow();
  });

  it('maps explicit verdicts to the same routes, preserving generated reasons and provider receipts', () => {
    const { body } = experimentalPayload(original(), 'categorical');
    expect(body.messages[0].content).toContain(
      '\nPOLICY:\nThe exact fixture policy.\nReturn exactly',
    );
    for (const [decision, route] of [
      ['allowed', 'ham'],
      ['spam', 'spam'],
      ['review', 'review'],
    ]) {
      const data = {
        usage: { cost: 0.001 },
        model: 'actual/model',
        choices: [
          {
            message: {
              content: JSON.stringify({
                results: [
                  {
                    id: 'opaque',
                    reason: 'Actual generated explanation',
                    category: 'policy',
                    decision,
                  },
                ],
              }),
            },
          },
        ],
      };
      const response = experimentalResponse(data, 'categorical', ['opaque']);
      expect(response.usage).toEqual(data.usage);
      expect(response.model).toBe('actual/model');
      const [prediction] = validatePredictions(
        JSON.parse(response.choices[0].message.content),
        examples,
      );
      expect(prediction.reason).toBe('Actual generated explanation');
      expect(routed(prediction, { threshold: 0.9, reviewThreshold: 0.75 })).toBe(route);
    }
  });

  it('never turns unknown verdicts, unknown IDs or duplicate outputs into accepted decisions', () => {
    for (const results of [
      [{ id: 'opaque', decision: 'unsure' }],
      [{ id: 'm0', decision: 'allowed' }],
      [
        { id: 'opaque', decision: 'allowed' },
        { id: 'opaque', decision: 'spam' },
      ],
    ]) {
      const data = {
        usage: { cost: 0.001 },
        choices: [
          {
            message: {
              content: JSON.stringify({
                results: results.map((p) => ({ reason: 'Generated', category: 'policy', ...p })),
              }),
            },
          },
        ],
      };
      const response = experimentalResponse(data, 'categorical', ['opaque']);
      expect(response.usage.cost).toBe(0.001);
      expect(() =>
        validatePredictions(JSON.parse(response.choices[0].message.content), examples),
      ).toThrow();
    }
  });

  it('rejects a criteria verdict that drops a required conjunct instead of fabricating an allowance', () => {
    const { body } = experimentalPayload(original(), 'criteria', ['opaque']);
    expect(body.messages[0].content).toContain('The exact fixture policy.');
    const evidence = {
      id: 'opaque',
      topic_basis: 'none',
      topic: '',
      empty_contact_hook: true,
      exaggerated_punctuation_or_filler: true,
      emotional_or_suggestive_emoji_cluster: true,
      repeated_long_filler: false,
      other_violation: '',
      decision: 'spam',
      category: 'attention_bait',
      reason: 'All required bait conditions are present.',
    };
    for (const patch of [
      {},
      { topic_basis: 'context', topic: 'A substantive prior question' },
      { exaggerated_punctuation_or_filler: false },
      { emotional_or_suggestive_emoji_cluster: false },
      { empty_contact_hook: false },
      { category: 'other_policy' },
      { category: 'repeated_filler' },
      { repeated_long_filler: 'true' },
    ]) {
      const data = {
        usage: { cost: 0.002 },
        choices: [
          { message: { content: JSON.stringify({ results: [{ ...evidence, ...patch }] }) } },
        ],
      };
      const response = experimentalResponse(data, 'criteria', ['opaque']);
      expect(response.usage).toEqual(data.usage);
      const validate = () =>
        validatePredictions(JSON.parse(response.choices[0].message.content), examples);
      if (!Object.keys(patch).length) expect(validate()[0].score).toBe(1);
      else expect(validate).toThrow();
    }
  });
});
