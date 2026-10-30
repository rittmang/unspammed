import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const privateMarker = 'PRIVATE_EVIDENCE_MUST_NOT_BE_PUBLISHED';
const prediction = (id, score) => ({
  id,
  score,
  category: 'fixture',
  reason: privateMarker,
  needs_review: false,
});
function report() {
  return {
    seal: 'fixture-seal',
    plan: { repeats: 3, thresholds: { spam: 0.9, review: 0.75 } },
    examples: ['spam', 'ham', 'ham', 'spam'].map((label, i) => ({
      id: `${privateMarker}-${i}`,
      label,
      text: privateMarker,
      family: 'synthetic-fixture-family',
    })),
    calls: [
      {
        key: 'r0:b0',
        repeat: 0,
        ids: [`${privateMarker}-0`, `${privateMarker}-1`],
        results: [prediction(`${privateMarker}-0`, 1), prediction(`${privateMarker}-1`, 0)],
        cost: 0.001,
        latency: 20,
        actualModel: 'fixture/model',
        actualProvider: 'Fixture',
        receipt: { response: { id: privateMarker } },
      },
      {
        key: 'r0:b1',
        repeat: 0,
        ids: [`${privateMarker}-2`],
        terminalFailure: true,
        usage: { cost: null, latency: 10 },
      },
    ],
    failures: [{ key: 'r0:b1', error: privateMarker, usage: { cost: null } }],
  };
}
function summarize(t, ledger) {
  const dir = mkdtempSync(join(tmpdir(), 'unspammed-evidence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, 'input.json'),
    output = join(dir, 'output.json');
  writeFileSync(input, JSON.stringify(ledger));
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/summarize-gemini-protocol.ts',
      '--report',
      input,
      '--output',
      output,
    ],
    {
      encoding: 'utf8',
      timeout: 30000,
      env: Object.fromEntries(
        ['PATH', 'TMPDIR'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]),
      ),
    },
  );
  return { ...result, read: () => readFileSync(output, 'utf8') };
}

test('protocol evidence distinguishes missing/failed cases, preserves unknown cost and omits private evidence', (t) => {
  const result = summarize(t, report());
  assert.equal(result.status, 0, result.stderr);
  const raw = result.read(),
    evidence = JSON.parse(raw);
  assert.ok(!raw.includes(privateMarker));
  assert.equal(evidence.unknownCostRequests, 1);
  assert.equal(evidence.totalBillingKnown, false);
  assert.equal(evidence.knownReportedCostUSD, 0.001);
  const [round] = evidence.experiments[0].rounds;
  assert.equal(round.expected, 4);
  assert.equal(round.classified, 2);
  assert.equal(round.terminalUnclassified, 1);
  assert.equal(round.notAttempted, 1);
  assert.equal(round.spamCaught, 1);
  assert.equal(round.costUSD, null);
  assert.equal(evidence.experiments[0].rounds.length, 1);
});

test('protocol evidence refuses duplicated paid calls and incomplete successful responses', (t) => {
  const duplicate = report();
  duplicate.calls.push(duplicate.calls[0]);
  assert.match(summarize(t, duplicate).stderr, /Duplicate paid calls/);
  const repeatedReceipt = report();
  repeatedReceipt.calls[1].usage.requestId = privateMarker;
  assert.match(summarize(t, repeatedReceipt).stderr, /Duplicate provider receipt/);
  const missing = report();
  missing.calls[0].results.pop();
  const result = summarize(t, missing);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exactly one result/);
});
