# Policy improvement loop repair

An independent read-only subagent review confirmed the investigation's six main findings: unsupported change claims, conflicting greeting instructions, incomplete learning memory, impossible perfect-validation gates, unspecified score/routing semantics, and test coverage limited to mocked orchestration.

The backend now requests exact existing-clause replacements and a diagnosis. The application applies unique nonoverlapping edits and derives the displayed change descriptions from those replacements. Formatting, heading-only, and introduction-only changes are rejected. These structural checks do not prove semantic learning; actual correction replay remains required.

Owner labels define the desired boundary. The proposer must reconcile conflicting allowances, use observable behavior, preserve labelled legitimate contrasts, and avoid inventing additional prerequisites such as commercial intent or unseen repetition. Revision requests explicitly compare failed classifier explanations against the conditions the previous candidate introduced.

OpenRouter drafting defaults to `google/gemini-2.5-flash`, with a bounded 2,000-token reasoning budget and a 6,000-token total output budget. `POLICY_DRAFT_MODEL` overrides the drafting model. Custom providers retain their configured model. This is separate from the evaluation model, which remains the frozen live model. The budget follows [OpenRouter's reasoning-token contract](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens); reasoning counts against total output. Drafting may cost more than the previous Flash Lite default.

Revisions retain concrete errors and successful contrasts in bounded memory, prioritize updated mistakes, deduplicate overlapping evidence, and trim older lessons to fit the actual UTF-8 request limit. Copied-message protection includes older lessons. Development references are retained across revisions, while fresh references go to validation and final checks. Fresh-reference limits reserve room for retained training data under the 120-reference corpus cap. Any exposed held-out failures used for a later revision become training data; later final checks still require unused families and inputs.

The cost check requires known billing and measured token counts. For the same observed model/provider, it uses the larger of the input-token and output-token ratios as a conservative upper bound on uncached cost growth, retaining the 1.5× cap. This avoids comparing a cold candidate against a discounted warm baseline; unknown or estimated usage still fails.

Development requires weighted improvement and correction of every triggering feedback item. Validation and final checks permit equal performance while retaining all existing checks for new false positives, misses, review behavior, cost, reference identity, and model/provider identity.

The classifier receives the actual live or frozen evaluation thresholds. Its score now explicitly means confidence that the supplied community policy was violated, rather than severity or commerciality. A clear noncommercial disruption can therefore score above the spam cutoff. Model scores remain uncalibrated and nondeterminism remains possible.

No frontend components or styles were changed for this repair. Implementation verification did not publish a policy or change production data. The code was subsequently deployed as Worker version `13125bab-9eb8-48ed-9c87-415f22fb14dd`; see [deployment verification](deployment.md). The live policy and enforcement settings were preserved.

## Verification

`npm run check` runs TypeScript checking, the Workers test suite, and the production frontend build. New regressions cover the edit contract, invalid/overlapping edits, short multilingual rules, cumulative memory, UTF-8 evidence budgeting, copied older evidence, and perfect held-out ties.

For an explicit paid, read-only replay against private saved development data:

```sh
npx tsx scripts/verify-policy-loop.ts .tmp/policy-campaign-audit.json
```

The script uses `.dev.vars` for credentials, never writes to a database or publishes a policy, and saves private results only to ignored `.tmp/policy-loop-verification.json`. It checks the original corrections, legitimate saved messages, a meaningful stylized question, repeated routing, and saved validation/final messages. These historical fixtures establish regression behavior, not certification on a fresh sealed production test. Early failed real-provider runs were rejected; they exposed the need for a better proposer and policy-relative score semantics.

## Observed result

The final code check passed: TypeScript, 240 tests, and production build. Twenty-six tests were skipped, including optional integration coverage. A second subagent review found no remaining blocking issue after its corpus-budget and custom-endpoint findings were fixed.

The real-provider fixture generated actual clause edits, fixed all three original owner corrections in each of three repeated development comparisons, and showed zero candidate route changes across those repeats. The meaningful stylized-question contrast remained legitimate. Development weighted loss fell from 38 to 2 over 20 references.

Saved validation tied at loss 60 and correctly passed the nonregression gate. The saved final check failed: baseline loss 1 versus candidate loss 40.25, including new false positives. The final gate rejected the candidate. This demonstrates correction learning and rejection safeguards; it does **not** establish a production-ready policy or successful generalization. The fixture was not published. The final replay cost approximately $0.0126; earlier diagnostic replays incurred additional provider charges.

The classifier can still misinterpret unrelated policy boundaries; changing score semantics is not calibration or a guarantee of accuracy. The stored cost ratio is an uncached token-cost bound under common input/output unit prices, not an actual invoice ratio; separately priced resources, tiered pricing, or per-request fees require separate accounting.
