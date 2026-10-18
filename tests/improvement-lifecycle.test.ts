import { env } from 'cloudflare:workers';
import { abortAllDurableObjects, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type Example, type Settings } from '../shared/types';
import { digest, policyFingerprint, type ImprovementOverview } from '../shared/improvement';
import { GroupModerator } from '../worker/local-group';
import { GroupService } from '../worker/group';
import { PostgresDatabase, SqliteDatabase, STORAGE_TABLES } from '../worker/database';
import { initializePostgres, initialMigration } from '../worker/storage';
import { ImprovementService, modelIdentityMatches } from '../worker/improvement';

const candidate =
  'Flag scams and deceptive, unsolicited commercial recruitment. Allow useful community announcements and ordinary questions. Require review when material facts are missing. Judge repeated disruption using only the supplied recent same-sender context.';
const references: Example[] = ['spam', 'ham', 'review'].flatMap((label) =>
  Array.from({ length: label === 'review' ? 3 : 6 }, (_, i) => ({
    id: `${label}-${i}`,
    text: `${label}-case ${String.fromCharCode(65 + i)} with distinct message evidence`,
    label: label as Example['label'],
    family: `${label}-independent-${i}`,
    context: [],
    media: '',
  })),
);
type Target = { fetch(request: Request): Promise<Response> };
let target: Target,
  tick: () => Promise<void>,
  requests: Record<string, any>[],
  missingMetadata: boolean,
  observedProvider: string,
  proposedPolicy: string,
  editContext: () => Promise<void>,
  readFrozen: (id: string) => Promise<{ corpus: Record<string, Example[]> }>,
  optimizerMode: 'off' | 'repair' | 'always_bad' | 'final_failure' | 'perfect_holdout',
  proposalCount: number,
  classificationCalls: number,
  addCorrections: () => Promise<void>;
beforeEach(() => {
  requests = [];
  missingMetadata = false;
  observedProvider = 'Google AI Studio';
  proposedPolicy = candidate;
  optimizerMode = 'off';
  proposalCount = 0;
  classificationCalls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://openrouter.ai/api/v1/chat/completions');
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      if (body.messages[0].content.startsWith('Draft a complete replacement')) {
        proposalCount++;
        return Response.json({
          model: body.model,
          choices: [
            {
              message: {
                content: JSON.stringify({
                  edits: [
                    {
                      before: JSON.parse(body.messages[1].content).existingPolicy,
                      after:
                        optimizerMode === 'off'
                          ? proposedPolicy
                          : `${candidate} Attempt ${proposalCount}: preserve contextual evidence.`,
                    },
                  ],
                }),
              },
            },
          ],
          usage: { total_tokens: 100, cost: 0.00001 },
        });
      }
      classificationCalls++;
      const examples = JSON.parse(body.messages[1].content).messages;
      const upgraded = body.messages[0].content.includes(candidate);
      // A deterministic mock with a known miss exercises the state machine, not model accuracy.
      return Response.json({
        ...(missingMetadata ? {} : { model: body.model, provider: observedProvider }),
        choices: [
          {
            message: {
              content: JSON.stringify({
                results: examples.map((e: { id: string; text: string }) => ({
                  id: e.id,
                  score:
                    e.text.startsWith('spam-') &&
                    ((upgraded &&
                      !(
                        optimizerMode === 'always_bad' ||
                        (optimizerMode === 'repair' &&
                          body.messages[0].content.includes('Attempt 1:')) ||
                        (optimizerMode === 'final_failure' && classificationCalls === 6)
                      )) ||
                      (optimizerMode === 'final_failure' && classificationCalls === 5) ||
                      (optimizerMode === 'perfect_holdout' && classificationCalls >= 3))
                      ? 0.99
                      : 0.1,
                  needs_review: e.text.startsWith('review-'),
                  category: 'policy',
                  reason: 'Mock decision',
                })),
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.00001 },
      });
    }),
  );
});
afterEach(async () => {
  await abortAllDurableObjects();
  await reset();
  vi.unstubAllGlobals();
});
async function call(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  if (path === '/improvement/clarify' && body) body = { automatic: false, ...(body as object) };
  return target.fetch(
    new Request(`https://group.internal/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function state() {
  const response = await call('/improvement');
  expect(response.status).toBe(200);
  return response.json() as Promise<ImprovementOverview>;
}
async function setup() {
  const stub = env.GROUPS.get(env.GROUPS.idFromName(crypto.randomUUID()));
  target = { fetch: (r) => stub.fetch(r) };
  tick = () => runInDurableObject(stub, (instance: GroupModerator) => instance.alarm());
  editContext = () =>
    runInDurableObject(stub, async (_instance, ctx) => {
      ctx.storage.sql.exec("UPDATE examples SET context='[\"New context\"]' WHERE id='ham-0'");
    });
  readFrozen = (id) =>
    runInDurableObject(stub, async (_instance, ctx) => {
      const row = ctx.storage.sql
        .exec<{ payload: string }>('SELECT payload FROM policy_reference_sets WHERE draft_id=?', id)
        .one();
      return JSON.parse(row.payload);
    });
  addCorrections = () =>
    runInDurableObject(stub, async (_instance, ctx) => {
      const db = new SqliteDatabase(ctx);
      const service = new ImprovementService(
        db,
        env,
        async () => defaultSettings,
        async () => {},
      );
      const [dataset] = await db.exec<{ id: string }>('SELECT id FROM datasets LIMIT 1');
      for (const index of [0, 2, 4]) {
        const example = automaticPool[index];
        await service.record(
          `dataset:${dataset.id}:${example.id}`,
          {
            example,
            prediction: {
              id: example.id,
              score: 0.1,
              category: 'ordinary',
              reason: 'Original missed solicitation',
            },
            policy: defaultSettings.policy,
            settings: defaultSettings,
            action: { status: 'allowed' },
          },
          {
            label: 'spam',
            reasonCode: 'promotion',
            note: 'Unsolicited promotion should be caught.',
            family: example.family!,
            contextComplete: true,
            resolveConflict: false,
          },
        );
      }
    });
  await call('/overview');
}
async function draftAndFreeze(pool = references, runAllChecks = false) {
  expect(
    (await call('/datasets', { name: 'Balanced independent references', data: pool })).status,
  ).toBe(201);
  expect(
    (
      await call('/improvement/clarify', {
        clarification:
          'Clarify that deceptive unsolicited recruitment is spam while helpful relevant announcements are legitimate.',
      })
    ).status,
  ).toBe(202);
  await tick();
  const d = (await state()).drafts[0];
  expect(d.status).toBe('draft');
  expect((await call(`/improvement/${d.id}/evaluate`, { runAllChecks })).status).toBe(202);
  return d.id;
}
async function advance(id: string, status: string) {
  for (let i = 0; i < 12; i++) {
    const s = await state();
    if (s.drafts.find((d) => d.id === id)?.status === status) return s;
    await tick();
  }
  throw new Error(
    `Did not reach ${status}: ${JSON.stringify((await state()).drafts.map((d) => [d.status, d.error]))}`,
  );
}
async function ready() {
  const id = await draftAndFreeze();
  await advance(id, 'validated');
  expect((await call(`/improvement/${id}/test`, {})).status).toBe(202);
  await advance(id, 'ready');
  return id;
}
async function publish(id: string) {
  const d = (await state()).drafts.find((d) => d.id === id)!;
  return call(`/improvement/${id}/publish`, {
    expectedParent: d.parent,
    candidateHash: await digest(d.candidate),
    acknowledgeTradeoffs: true,
  });
}
async function successfulFlow() {
  const id = await ready(),
    s = await state(),
    d = s.drafts[0];
  expect(d.results?.validation?.pass).toBe(true);
  expect(d.results?.test?.pass).toBe(true);
  expect(d.corpus).toBeUndefined();
  expect(d.referenceOrigins).toBeUndefined();
  const before = (await (await call('/overview')).json()) as {
    settings: Settings;
    stats: { deleted: number };
  };
  expect(before.settings.policy).toBe(defaultSettings.policy);
  expect(before.stats.deleted).toBe(0);
  expect(
    (
      await call(`/improvement/${id}/publish`, {
        expectedParent: d.parent,
        candidateHash: await digest(d.candidate),
        acknowledgeTradeoffs: false,
      })
    ).status,
  ).toBe(400);
  expect((await call('/settings', { ...defaultSettings, mode: 'enforce' }, 'PUT')).status).toBe(
    200,
  );
  expect((await publish(id)).status).toBe(200);
  const next = (await (await call('/overview')).json()) as { settings: Settings };
  expect(next.settings.policy).toBe(candidate);
  expect(next.settings.mode).toBe('observe');
  expect(
    (
      await call('/improvement/rollback', {
        versionId: d.parent,
        expectedParent: await policyFingerprint(next.settings),
      })
    ).status,
  ).toBe(200);
  expect(((await (await call('/overview')).json()) as { settings: Settings }).settings.policy).toBe(
    defaultSettings.policy,
  );
  const replays = requests.filter(
    (r) => !r.messages[0].content.startsWith('Draft a complete replacement'),
  );
  expect(replays.length).toBe(6);
  expect(new Set(replays.map((r) => r.model)).size).toBe(1);
  for (let i = 0; i < 6; i += 2) expect(replays[i].messages[1]).toEqual(replays[i + 1].messages[1]);
  expect(replays.every((r) => !r.messages[1].content.includes('"label"'))).toBe(true);
}
const automaticPool: Example[] = Array.from({ length: 120 }, (_, i) => ({
  id: `automatic-${i}`,
  text: `${i % 2 ? 'ham' : 'spam'}-case ${String.fromCharCode(65 + i)} distinct evidence ${i}`,
  label: i % 2 ? 'ham' : 'spam',
  family: `automatic-family-${i}`,
}));
async function startAutomatic() {
  expect(
    (await call('/datasets', { name: 'Independent automatic references', data: automaticPool }))
      .status,
  ).toBe(201);
  expect(
    (
      await call('/improvement/clarify', {
        clarification: 'Clarify deceptive unsolicited recruitment using contextual evidence.',
        automatic: true,
      })
    ).status,
  ).toBe(202);
  return (await state()).drafts[0].id;
}
async function finishAutomatic() {
  for (let i = 0; i < 48; i++) {
    const d = (await state()).drafts[0];
    if (d.status === 'failed') throw new Error(d.error);
    if (
      !['queued', 'drafting', 'preparing', 'development', 'validation', 'test'].includes(d.status)
    )
      return d;
    await tick();
  }
  throw new Error(`Automatic run did not finish: ${(await state()).drafts[0].status}`);
}

describe('policy replay lifecycle', () => {
  beforeEach(setup);
  it('reports saved check progress without exposing replay details in the summary', async () => {
    const id = await draftAndFreeze();
    const frozen = (await readFrozen(id)).corpus;
    const total = frozen.development.length * 2;
    const summary = async () =>
      ((await (await call('/improvement?view=summary')).json()) as ImprovementOverview).drafts[0];
    expect((await summary()).progress).toEqual({
      stage: 'development',
      completedChecks: 0,
      totalChecks: total,
    });
    await tick();
    const s = await summary();
    // A tick checkpoints at least one policy, or advances to the next stage.
    if (s.progress!.stage === 'development') {
      expect(s.progress!.completedChecks).toBeGreaterThan(0);
      expect(s.progress!.completedChecks).toBeLessThanOrEqual(total);
      expect(s.progress!.totalChecks).toBe(total);
    } else expect(s.progress!.stage).toBe('validation');
    expect(s.runs).toBeUndefined();
    expect(s.results).toBeUndefined();
    expect(s.corpus).toBeUndefined();
  });
  it('accepts tied perfect validation and final results after development improves', async () => {
    optimizerMode = 'perfect_holdout';
    await startAutomatic();
    const d = await finishAutomatic();
    expect(d.status).toBe('ready');
    expect(d.results?.development?.baseline.loss).toBeGreaterThan(0);
    for (const phase of ['validation', 'test'] as const) {
      expect(d.results?.[phase]?.baseline.loss).toBe(0);
      expect(d.results?.[phase]?.candidate.loss).toBe(0);
      expect(d.results?.[phase]?.pass).toBe(true);
    }
  }, 30000);
  it('starts directly from three corrections and requires those original corrections to be fixed', async () => {
    optimizerMode = 'repair';
    await call('/datasets', { name: 'Correction reference messages', data: automaticPool });
    await addCorrections();
    expect((await state()).drafts[0].optimization?.attempt).toBe(1);
    const d = await finishAutomatic();
    expect(d.status).toBe('ready');
    expect(d.results?.development?.checks.correctedFeedback).toBe(true);
    expect(d.optimization?.revision?.failedChecks).toContain('correctedFeedback');
    expect(d.optimization?.attempt).toBe(2);
    const proposal = JSON.parse(
      requests.find((r) => r.messages[0].content.startsWith('Draft a complete replacement'))!
        .messages[1].content,
    );
    expect(proposal.developmentCorrections).toHaveLength(3);
    expect(proposal.developmentCorrections[0].note).toBe('Unsolicited promotion should be caught.');
  }, 30000);
  it('learns from failed predictions, revises automatically, and offers only the final approved candidate', async () => {
    optimizerMode = 'repair';
    const root = await startAutomatic();
    const d = await finishAutomatic();
    expect(d.status).toBe('ready');
    expect(d.optimization).toMatchObject({ campaignId: root, attempt: 2, previousDraftId: root });
    const proposals = requests.filter((r) =>
      r.messages[0].content.startsWith('Draft a complete replacement'),
    );
    expect(proposals).toHaveLength(2);
    const learning = JSON.parse(proposals[1].messages[1].content);
    expect(learning.previousAttempt.policy).toContain('Attempt 1:');
    expect(learning.previousAttempt.mistakes.length).toBeGreaterThan(0);
    expect(learning.previousAttempt.mistakes[0]).toMatchObject({
      expectedLabel: 'spam',
      previousCandidatePrediction: { reason: 'Mock decision' },
    });
    expect(learning.previousAttempt.mistakes[0]).not.toHaveProperty('source');
    expect(learning.earlierAttempts).toHaveLength(1);
    expect(learning.cumulativeLessons.length).toBeGreaterThan(0);
    expect(learning.cumulativeLessons.some((e: any) => e.expectedLabel === 'ham')).toBe(true);
    expect(learning.cumulativeLessons[0]).not.toHaveProperty('source');
    const frozen = (await readFrozen(d.id)).corpus;
    const learned = new Set(d.optimization!.learnedFamilies);
    for (const e of [...frozen.validation, ...frozen.test])
      expect(learned.has(e.family!)).toBe(false);
    expect((await state()).drafts).toHaveLength(1);
    const compact = (await (await call('/improvement?view=summary')).json()) as ImprovementOverview;
    expect(compact.drafts).toHaveLength(1);
    expect(compact.drafts[0].candidate).toBe(d.candidate);
    expect(compact.drafts[0].progress).toEqual({
      stage: 'approval',
      completedChecks: 0,
      totalChecks: 0,
    });
    expect(compact.drafts[0].results).toBeUndefined();
    expect(compact.drafts[0].runs).toBeUndefined();
    expect(compact.drafts[0].optimization?.revision).toBeUndefined();
    expect(compact.feedback).toEqual([]);
    expect(
      ((await (await call('/overview')).json()) as { settings: Settings }).settings.policy,
    ).toBe(defaultSettings.policy);
    expect((await publish(d.id)).status).toBe(200);
  }, 30000);

  it('learns from a failed final check and reserves genuinely fresh final messages for its revision', async () => {
    optimizerMode = 'final_failure';
    const root = await startAutomatic();
    const d = await finishAutomatic();
    expect(d.status).toBe('ready');
    expect(d.optimization?.attempt).toBe(2);
    expect(d.optimization?.revision?.phase).toBe('test');
    const previous = (await readFrozen(root)).corpus;
    const revised = (await readFrozen(d.id)).corpus;
    const exposed = new Set(
      Object.values(previous)
        .flat()
        .map((e) => e.text),
    );
    for (const e of [...revised.validation, ...revised.test])
      expect(exposed.has(e.text)).toBe(false);
    expect(revised.development.some((e) => previous.test.some((old) => old.text === e.text))).toBe(
      true,
    );
  }, 30000);

  it('stops after four unsuccessful candidates and preserves the current live policy', async () => {
    optimizerMode = 'always_bad';
    await startAutomatic();
    const d = await finishAutomatic();
    expect(d.status).toBe('rejected');
    expect(d.optimization?.attempt).toBe(4);
    expect(proposalCount).toBe(4);
    expect(d.optimization?.history).toHaveLength(3);
    expect((await publish(d.id)).status).toBe(409);
    expect(
      ((await (await call('/overview')).json()) as { settings: Settings }).settings.policy,
    ).toBe(defaultSettings.policy);
  }, 30000);

  it('pauses for insufficient references without issuing classifier calls or repeated drafting calls', async () => {
    await call('/improvement/clarify', {
      clarification: 'Clarify deceptive unsolicited recruitment.',
      automatic: true,
    });
    const d = await finishAutomatic();
    expect(d.status).toBe('needs_examples');
    expect(requests).toHaveLength(1);
    await tick();
    expect(requests).toHaveLength(1);
  });

  it('does not try to repair provider identity failures by rewriting the policy', async () => {
    missingMetadata = true;
    await startAutomatic();
    const d = await finishAutomatic();
    expect(d.status).toBe('rejected');
    expect(proposalCount).toBe(1);
    expect(d.optimization?.attempt).toBe(1);
  });

  it('runs every check from one action with binary labels and still requires publication approval', async () => {
    const pool: Example[] = Array.from({ length: 18 }, (_, i) => {
      const label = i % 2 ? 'ham' : 'spam';
      return {
        id: `binary-${i}`,
        text: `${label}-case ${String.fromCharCode(65 + i)} with distinct evidence`,
        label,
        family: `binary-family-${i}`,
      };
    });
    const id = await draftAndFreeze(pool, true);
    expect((await publish(id)).status).toBe(409);
    const d = (await advance(id, 'ready')).drafts[0];
    expect(d.runAllChecks).toBe(true);
    expect(d.referenceLabels).toEqual({ spam: 9, ham: 9, review: 0 });
    expect(d.results?.validation?.pass).toBe(true);
    expect(d.results?.test?.pass).toBe(true);
    expect(requests).toHaveLength(7);
    expect(
      ((await (await call('/overview')).json()) as { settings: Settings }).settings.policy,
    ).toBe(defaultSettings.policy);
    expect((await publish(id)).status).toBe(200);
  });

  it('stops automatic testing at failed validation without opening the final test', async () => {
    missingMetadata = true;
    const id = await draftAndFreeze(references, true);
    const d = (await advance(id, 'rejected')).drafts[0];
    expect(d.runs?.test).toBeUndefined();
    expect((await publish(id)).status).toBe(409);
  });

  it(
    'replays paired fixed inputs, requires exact owner approval, publishes and rolls back',
    successfulFlow,
  );
  it('keeps the test hidden while running and disallows mutable labels on policy replay runs', async () => {
    const id = await draftAndFreeze();
    const d = (await advance(id, 'validated')).drafts[0];
    expect(
      (
        await call(`/evaluations/${d.runs!.validation![0]}/reviews`, [
          { id: references[0].id, label: 'spam' },
        ])
      ).status,
    ).toBe(409);
    await call(`/improvement/${id}/test`, {});
    const test = (await state()).drafts[0].runs!.test!;
    for (const runId of test)
      expect((await call(`/evaluations/${runId}/examples`)).status).toBe(409);
    const visible = (await (await call('/evaluations')).json()) as { id: string }[];
    expect(visible.some((r) => test.includes(r.id))).toBe(false);
    await advance(id, 'ready');
    expect((await call(`/evaluations/${test[0]}/examples`)).status).toBe(200);
  });
  it.each(['label', 'remove', 'context', 'held'])(
    'blocks publication when frozen source changes: %s',
    async (kind) => {
      const id = await ready();
      const datasets = (await (await call('/datasets')).json()) as { id: string }[];
      const dataset = datasets[0].id;
      if (kind === 'remove') await call(`/datasets/${dataset}`, undefined, 'DELETE');
      else if (kind === 'label')
        await call(`/datasets/${dataset}/labels`, [{ id: 'ham-0', label: 'spam' }]);
      else if (kind === 'held')
        await call(`/datasets/${dataset}/labels`, [
          { id: 'ham-0', label: 'ham', reasonCode: 'missing_context', contextComplete: false },
        ]);
      else await editContext();
      expect((await publish(id)).status).toBe(409);
      expect(
        ((await (await call('/overview')).json()) as { settings: Settings }).settings.policy,
      ).toBe(defaultSettings.policy);
    },
  );
  it('refuses stale settings-tab saves after publication', async () => {
    const before = await policyFingerprint(defaultSettings),
      id = await ready();
    await publish(id);
    expect(
      (await call('/settings', { ...defaultSettings, expectedPolicyFingerprint: before }, 'PUT'))
        .status,
    ).toBe(409);
  });
  it('rejects unverified provider identity even with perfect mock predictions', async () => {
    missingMetadata = true;
    const id = await draftAndFreeze();
    const s = await advance(id, 'rejected');
    expect(s.drafts[0].results?.validation?.checks.fixedModelAndProvider).toBe(false);
    expect((await publish(id)).status).toBe(409);
  });
  it('rejects a provider change between development and validation', async () => {
    const id = await draftAndFreeze();
    await advance(id, 'validation');
    observedProvider = 'A different provider';
    const s = await advance(id, 'rejected');
    expect(s.drafts[0].results?.validation?.checks.unchangedObservedModelAndProvider).toBe(false);
  });
  it('checks balanced references before any replay calls', async () => {
    await call('/datasets', { name: 'Too few', data: references.slice(0, 3) });
    await call('/improvement/clarify', {
      clarification: 'Clarify the boundary for unsolicited commercial promotion.',
    });
    await tick();
    const d = (await state()).drafts[0];
    expect((await call(`/improvement/${d.id}/evaluate`, {})).status).toBe(400);
    expect(requests).toHaveLength(1);
    expect((await state()).drafts[0].status).toBe('draft');
  });
  it('does not reuse sealed test identities in a second draft, even under family aliases', async () => {
    const id = await ready();
    await call(`/improvement/${id}/discard`, {});
    // New family names cannot make the exact classifier inputs fresh.
    await call('/datasets', {
      name: 'Renamed aliases',
      data: references.map((e) => ({ ...e, family: `renamed-${e.id}` })),
    });
    proposedPolicy = candidate + ' Treat missing authorization as material uncertainty.';
    await call('/improvement/clarify', {
      clarification:
        'A new owner clarification should be evaluated on genuinely fresh message families.',
    });
    await tick();
    const next = (await state()).drafts.find((d) => d.id !== id)!;
    expect(next.status).toBe('draft');
    expect((await call(`/improvement/${next.id}/evaluate`, {})).status).toBe(400);
    expect(requests).toHaveLength(8);
  });
});
it('recognizes a documented dated Decisions model identity without accepting another model or arbitrary aliases', () => {
  expect(modelIdentityMatches('typesafe/jev-1.13', 'typesafe/jev-1.13-20260917', true)).toBe(true);
  expect(modelIdentityMatches('typesafe/jev-1.13', 'typesafe/jev-1.14-20260917', true)).toBe(false);
  expect(modelIdentityMatches('typesafe/jev-1.13', 'typesafe/jev-1.13-latest', true)).toBe(false);
  expect(
    modelIdentityMatches(
      'google/gemini-2.5-flash-lite',
      'google/gemini-2.5-flash-lite-20260917',
      false,
    ),
  ).toBe(false);
});
describe.skipIf(!env.TEST_POSTGRES_URL)('policy lifecycle on production Postgres adapter', () => {
  beforeEach(async () => {
    expect(new URL(String(env.TEST_POSTGRES_URL)).hostname).toBe('127.0.0.1');
    await initializePostgres(env, true);
    const db = new PostgresDatabase(env);
    await db.transaction(async () => {
      await db.exec(
        `TRUNCATE ${[...STORAGE_TABLES, 'storage_state', 'work_state'].join(',')} RESTART IDENTITY`,
      );
      await db.exec('INSERT INTO work_state (id) VALUES (1)');
      await db.exec('INSERT INTO config (id,value) VALUES (1,?)', JSON.stringify(defaultSettings));
      await db.exec(
        'INSERT INTO storage_state (id,value) VALUES (1,?)',
        JSON.stringify({ ...initialMigration(), ready: true, status: 'complete' }),
      );
    });
    const service = new GroupService(db, env);
    target = service;
    tick = async () => {
      await db.withWorkLease(() => service.alarm());
    };
    readFrozen = async (id) => {
      const [row] = await db.exec<{ payload: string }>(
        'SELECT payload FROM policy_reference_sets WHERE draft_id=?',
        id,
      );
      return JSON.parse(row.payload);
    };
  });
  it(
    'runs approval, replay and rollback using only a disposable loopback database',
    successfulFlow,
  );
  it('revises a failed candidate under production work leases and retains final approval', async () => {
    optimizerMode = 'repair';
    const root = await startAutomatic();
    const d = await finishAutomatic();
    expect(d.status).toBe('ready');
    expect(d.optimization).toMatchObject({ campaignId: root, attempt: 2 });
    expect(proposalCount).toBe(2);
    const frozen = (await readFrozen(d.id)).corpus;
    for (const e of [...frozen.validation, ...frozen.test])
      expect(d.optimization!.learnedFamilies.includes(e.family!)).toBe(false);
    expect(
      ((await (await call('/overview')).json()) as { settings: Settings }).settings.policy,
    ).toBe(defaultSettings.policy);
    expect((await publish(d.id)).status).toBe(200);
  }, 30000);
});
