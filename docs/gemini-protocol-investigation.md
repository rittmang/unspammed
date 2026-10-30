# Gemini batching and response protocols

Investigated **2026-10-30**, following the [attention-bait prompt investigation](attention-bait-investigation.md) and [Clef cascade tests](clef-cascade-investigation.md). These are opt-in paid inference experiments using frozen local snapshots. No database write, Telegram effect, policy approval or deployment is involved.

The operator subsequently requested the selected setup in application code. That separate [single-message implementation](single-message-moderation.md) changes new-workspace defaults and offers an explicit installed-workspace preset; it does not alter this investigation's original fixtures, predictions or gate results.

## Owner adjudication after review

After seeing all three flagged targets and their supplied context, the owner explicitly classified them as spam: **“no these are spammy too, so it's fine.”** The original synthetic legitimate labels for `n37`, `n38` and `n46` therefore do not represent the owner's intended boundary. This is a correction to those three labels, rather than acceptance of three owner-confirmed legitimate messages being flagged.

The [adjudication record](../tests/fixtures/gemini-owner-adjudication.json) binds each correction to a hash of its complete text/context/media input. The [separate rescoring evidence](gemini-owner-adjudicated-evidence.json) uses the unchanged model outputs and leaves every other label unchanged. The selected **proposed policy + single-message calls + 1,024 thinking tokens** now scores **27/27 expected spam caught, 37/37 expected legitimate messages allowed, zero false positives and zero reviews** on that 64-case screen. The batch-eight same-policy comparison still has three false positives and seven unnecessary reviews; the installed-policy thinking control catches 12/27 spam, allows 14 and reviews one, with one false positive.

The selected configuration is a promising candidate under this clarified boundary. The original fixture, model receipts and original rejection remain immutable; this is retrospective owner adjudication after predictions were shown, not a new blind validation or a claim that all 64 labels were independently reviewed. No new inference was requested, the two planned repeat rounds and historical regression remain unperformed, and no live settings, approval state or deployment changed. Broader rules for unreviewed decorated messages must not be inferred from these three exact decisions.

## Original assessment before owner adjudication

**The selected candidate failed the original experimental labels.** The strongest arm combined the proposed policy, one message per call and 1,024 thinking tokens. It correctly classified all 16 development and 64 previously inspected stress cases, then caught **24/24** spam examples but blocked **3/40** messages labelled legitimate on the separately frozen 64-case validation set. The prespecified stop rule rejected it at that point. The owner's later adjudication above changes how those three results should be interpreted.

The original single-message arm without thinking caught **24/24** spam examples on the development stress set but blocked **4/40** legitimate messages and unnecessarily reviewed another. Its false positives included brief generic help, context-grounded follow-ups and a warning about a scam. Smaller batches alone are not a sufficient fix.

On those same 16 development cases, the installed policy caught only **3/7** spam examples with single-message calls. Changing the policy matters; the original test alone did not establish readiness for Enforce.

The [aggregate evidence](gemini-protocol-evidence.json) retains every captured arm, including incomplete screens, invalid outputs and unknown costs. Each private ledger has a SHA-256 digest. Raw texts and provider receipts stay in ignored `.tmp/` files.

## Frozen design and development results

The [original plan](../tests/fixtures/gemini-protocol-plan.json) screens batch sizes 1, 2, 4 and 8, reason-first output and a categorical verdict. Model and endpoint are fixed to `google/gemini-2.5-flash-lite / Google AI Studio` on OpenRouter, without provider fallback. Spam/review thresholds remain **0.9/0.75**. `needs_review` participates in routing; a reason calling something spam below 0.9 is not an automatic catch. Categorical spam/allowed/review maps to the same application routes, not to calibrated probabilities.

| Proposed-policy arm          | First 16-case development screen                                |
| ---------------------------- | --------------------------------------------------------------- |
| Standard, batch 8            | 7/7 spam caught; one legitimate message blocked                 |
| Standard, batch 4            | 7/7 spam caught; one legitimate message blocked                 |
| Standard, batch 2            | 7/7 spam caught; two legitimate messages unnecessarily reviewed |
| Standard, batch 1            | 7/7 spam caught; no incorrect route in the first screen         |
| Reason first, batch 1        | 7/7 spam caught; one context-grounded legitimate reply blocked  |
| Categorical verdict, batch 1 | 7/7 spam caught; no incorrect route in the first screen         |

Single-message standard and categorical outputs were shortlisted adaptively. Across three opaque-ID perturbations, every usable development prediction was correct, but standard had one terminal failure and categorical had two. Missing outcomes are not counted as correct. The categorical failures included an output category exceeding the application's existing 80-character limit.

Next, reuse the **64 previously inspected cascade cases as development stress evidence**, not a fresh holdout:

- Standard single-message: 64 classified; 24 spam caught, four legitimate messages blocked, one legitimate message unnecessarily reviewed.
- Categorical single-message: stopped after 45 attempted cases, with 44 classified, one terminal failure and 19 not attempted. Two classified legitimate messages were blocked. The arm was already falsified; completing its remaining repeats would not rescue it.

No accuracy rate for the full categorical stress set follows from its partial coverage. The complete standard stress screen is also synthetic, previously inspected evidence, not an estimate of independently adjudicated production accuracy.

## Follow-up hypotheses

The [follow-up plan](../tests/fixtures/gemini-protocol-followup-plan.json) freezes further development ideas before fresh validation:

1. **Shorter policy with explicit exceptions.** Replace the long bait rule with four required conditions and make context, ordinary help and scam warnings explicit exceptions. The [concise fixture](../tests/fixtures/attention-bait-concise.json) preserves unrelated policy clauses.
2. **Evidence predicates before the verdict.** In a single call, ask for topic source, hook/presentation/emoji/filler predicates and any independently satisfied other rule. A deterministic guard rejects contradictory spam verdicts as unclassified; it never silently changes them to legitimate or review.
3. **Combine those two changes.** Check whether the shorter wording preserves the legitimate messages while the evidence predicates recover the bait.
4. **Single-message calls plus 1,024 thinking tokens.** Added after the first three screens failed, before any fresh validation. Earlier thinking experiments used multiple messages per request, so the interaction with isolation remained untested. Requested thinking is distinguished from reasoning tokens actually reported in receipts.

The first three screens reject their candidates:

| Follow-up arm                           | Development result                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| Concise policy, standard single-message | 5/7 spam caught; one allowed and one reviewed; no legitimate false positives        |
| Original candidate, evidence predicates | 7/7 spam caught; two legitimate messages blocked                                    |
| Concise policy, evidence predicates     | 15/16 classified; one contradictory output rejected, one legitimate message blocked |

The single-message/thinking combination passed **16/16 development** and **64/64 stress** cases with complete coverage and known reported costs/identities. Development receipts actually reported **132–795 reasoning tokens** per call. The same execution settings with the installed policy still caught only **3/7** development spam cases. That supports retaining a policy change as part of the experimental hypothesis, rather than attributing the development improvement entirely to execution settings.

On the same 64 stress cases, thinking increased reported cost from **US$0.00613928 to US$0.02402196** (3.91×) and mean case request duration from **703 ms to 2,492 ms**. These are paid experimental request measurements, excluding rate-limit waits, not monthly cost or production throughput estimates.

The explicit-predicate protocol exposed a limitation: for an ordinary greeting with one emoji, Gemini asserted an emoji cluster; for a short help request without elongated text or repeated punctuation, it asserted exaggeration. It also failed to use a supplied substantive context. A logically consistent set of generated booleans does not prove those booleans match the source. This experiment gives no support for replacing semantic checks with self-reported model evidence.

Google's [structured-output documentation](https://ai.google.dev/gemini-api/docs/generate-content/structured-output?hl=en) distinguishes schema-conforming JSON from semantically correct values. Schema/property order and predicate checks are experimental interventions, not guarantees of correct policy application.

## Prospective validation and rejection

The separate **64-case fresh fixture** has SHA-256 `0a820b8fd64a3f4e0cbb158bf27a2ddde83b236f4df2fa48e8ab2e17956a3942`. The [selection record](../tests/fixtures/gemini-validation-selection.json) locked the policy hash, single-message protocol, thinking budget, comparisons and stop rule before any predictions were requested on this fixture. Its labels express the intended synthetic boundary, not independent owner adjudication or independent campaign families.

The selected arm's first complete validation screen classified all 64 messages, caught all 24 spam examples and produced **three false positives**. Two legitimate follow-ups supplied real questions in recent same-sender context: a scanned-signature requirement and travel reimbursement. Gemini still called the targets empty bait. The third was an ordinary short help request with emojis but **without exaggerated punctuation or elongated filler**, another required condition. The failed example IDs are `n37`, `n38` and `n46`; their synthetic texts/context are in the frozen fixture and private request ledger.

The same-policy standard batch-eight baseline also caught 24/24 spam, but blocked six legitimate messages and unnecessarily reviewed seven. The combined intervention reduced those errors in this screen while still failing the zero-false-positive gate. It cost **US$0.02238533 versus US$0.00283910** (7.88×), with mean case request duration **2,347 ms versus 1,719 ms**. The comparison changes both isolation and thinking; it does not identify which caused each difference. These quality/latency observations are one synthetic screen, not production accuracy or service-level guarantees.

The installed-policy control uses the selected single-message/thinking settings and the same frozen inputs to isolate the policy change. It caught **11/24** spam, allowed 12, reviewed one and blocked **2/40** legitimate messages, at **US$0.01793240**. The replacement therefore improves spam coverage but fails the legitimate-message boundary. All three arms classified all 64 cases and retain their observed outcomes in the aggregate evidence.

Because the selected arm failed, **no second/third validation repeat or historical regression was requested**. The ledger intentionally has one screened round of the three planned perturbations; it does not claim the entire validation plan completed. Failed fresh cases are now exposed development material and cannot become a new holdout by renaming them or changing their IDs. No tuning or repeated paid attempts were used to erase this rejection.

Under the original synthetic assumptions, supplied context and the full conjunction of presentation cues appeared to be violated. The owner's later judgment establishes that these three hooks are unwanted despite those assumptions. The tested candidate wording still contains narrower exceptions; aligning broader wording with the clarified owner boundary would be a separate change requiring evaluation. The adjudication does not retroactively change the exact prompt that produced these decisions.

## Reproduction and accounting

Across **19 captured experiments**, the evidence contains **527 successful requests**, **six terminal failed requests** and **15 known unbilled rate-limit rejections**. Available receipts report **US$0.11102833**; **three requests have unknown reported cost**, so total billing is not established. Counts include repeated/adaptive development calls and are not independent test cases. Unknown/invalid outcomes remain in the evidence rather than disappearing from accuracy or cost reporting.

Use Node **22.x**, the shared private environment loader and an ignored `.tmp/` snapshot with `settings` and optional historical `examples`. Exact clause edits fail closed if they do not match the supplied policy. Labels, family names and original source IDs do not enter requests. This study does not ship an account-specific policy as a default.

```sh
# Dry plan: no inference without the paid flag.
node --import tsx scripts/evaluate-gemini-protocol.ts \
  --input .tmp/attention-bait-input.json \
  --output .tmp/gemini-protocol-example.json \
  --split development --policy candidate --protocol standard \
  --batch-size 1 --repeats 3 --round-limit 1

# Additional experimental options:
# --policy concise
# --protocol reason-first|categorical|criteria
# --reasoning-tokens 1024
# --split stress|validation|historical
# Add --confirm-paid-evaluation only for an intentional paid experiment.

node --import tsx scripts/summarize-gemini-protocol.ts \
  --report .tmp/gemini-protocol-example.json \
  --output .tmp/gemini-protocol-example-summary.json
```

Every accepted response is checkpointed before another request. The ledger keeps the raw provider response, usage, request hash and observed identity, even when the output is unusable. Known unbilled rate-limit rejections can resume only after their recorded deadline. Terminal or uncertain paid requests are never replayed automatically; an interrupted in-flight marker blocks resumption. Source/input/policy hashes reject incompatible resumptions. Earlier ledgers refer to earlier source hashes; use a new report for a changed experiment.

The summarizer recomputes routing from validated predictions rather than trusting cached summary counts. It reports classified, terminal-unclassified and not-attempted cases separately. Unknown cost stays unknown; known reported cost includes billed invalid outputs. It omits private messages, generated reasons, source IDs and provider request IDs. Tests cover missing-response accounting, unknown billing, duplicate calls, incomplete successful outputs and privacy.

The helpers are imported only by offline tooling/tests. No runtime classifier prompt, default batching setting, model, threshold or installed policy changes as a result of these experiments. The existing feedback/diagnosis improvements remain separate, as described in the original investigation.

## Software verification

Node **22.22.0**: `npm run check`, `npm run test:setup`, `npm run test:runtime` and `npm run format:check` passed. The current check includes **299 Workers tests** (31 optional skips), **41 setup/tooling tests**, **12 portable runtime tests** (three optional PostgreSQL skips) and **one bundled Vercel build/execution test**. The added tests exercise experimental response validation, contradictory evidence, routing, paid-failure accounting, duplicate calls/receipts and aggregate privacy. No disposable PostgreSQL database was supplied.

These are local software/build checks. The actual paid model-request evidence is reported separately above; no deployed HTTP, cron/restart recovery or physical Telegram-client verification is claimed.
