# Clef before Gemini: measured cascade evaluation

Investigated **2026-10-30** through paid OpenRouter calls. This adds an offline experiment runner, fixtures and routing tests. It does not install a cascade in moderation, deploy code, approve a policy, change group settings or perform database/Telegram mutations.

## Finding

**Do not add this strict-cutoff Clef cascade on the evidence measured here.** At 0.99, it skipped no Gemini work. At 0.95, it skipped only messages Gemini already caught, never the target bait variants. Actual residual-batch execution sometimes changed Gemini's decisions, with inconsistent gains under the installed policy and additional false positives under the candidate. Cost and latency increased in every actual validation run. This rejects the tested configuration, not every possible model cascade.

Seven experiments completed **236 successful model requests** at provider-reported cost **US$0.08223307**. A separate two-case Clef API smoke request cost **US$0.00021336**, making this investigation's reported total **US$0.08244643**. Twelve known unbilled 429 rejections were checkpointed and retried after their deadlines; no uncertain billed request was replayed. These totals exclude the earlier prompt-only investigation.

## Completed validation results

Each row uses the same 64 cases: **24 spam, including 16 bait/filler variants, and 40 legitimate controls**. Triplets are normal/reversed/rotated input orders. “Caught” means routed to automatic spam at the application's final threshold; review is separate.

| First-stage cutoff / policy    | Clef early exits | Early bait/filler catches | Spam automatically caught: Gemini → cascade | Legitimate messages blocked: Gemini → cascade | Actual cost ratio   | Extra mean request time |
| ------------------------------ | ---------------- | ------------------------- | ------------------------------------------- | --------------------------------------------- | ------------------- | ----------------------- |
| 0.99 / candidate, one order    | 0/64             | 0/16                      | 23 → 23                                     | 6 → 6                                         | 2.73×               | 449 ms                  |
| 0.95 / installed, three orders | 6 / 4 / 5        | 0 / 0 / 0                 | 8 / 8 / 10 → 10 / 8 / 10                    | 1 / 1 / 1 → 0 / 1 / 1                         | 2.53 / 2.85 / 2.85× | 354 / 364 / 341 ms      |
| 0.95 / candidate, three orders | 7 / 4 / 5        | 0 / 0 / 0                 | 23 / 22 / 24 → 24 / 24 / 24                 | 6 / 4 / 5 → 8 / 6 / 5                         | 2.87 / 2.94 / 2.82× | 500 / 468 / 453 ms      |

Every early exit was correctly labelled spam, already automatically caught by that run's Gemini baseline. **No early decision rescued an allowed spam message or promoted a reviewed spam message.** Clef made no early false positives on these 40 controls; this small, related synthetic set does not certify a production false-positive rate.

At 0.99 all 64 final decisions exactly matched Gemini alone, including its six false positives. The cascade cost **$0.00716180** versus **$0.00262265**, and sampled case-weighted mean duration rose from **1,764.625 ms to 2,213.625 ms**. No work avoided means no accuracy or cost benefit in this run.

At 0.95 the distinction between direct decisions and fallback changes matters:

- With the installed policy, allowed spam counts were **12 / 12 / 10 → 11 / 12 / 9**. No allowed spam became automatically caught; the two net improvements were moves to review. Automatic catches changed through other review-to-spam moves. Weighted loss was **36 / 36.5 / 32.75 → 23.75 / 37.25 / 31.75**, improving in two orders and worsening in one.
- With the candidate, the increased automatic catches came from Gemini's previously reviewed spam. Reduced batches introduced **2 / 2 / 1** new false positives, with one existing false positive repaired in the final order. Weighted loss was **61.25 / 41.25 / 50.75 → 80 / 60.25 / 50.5**. The chain is not safe merely because Clef's own early decisions were correct.
- In all **23 zero-exit batches** of the two 0.95 comparisons, identical-input Gemini A/A calls produced identical final routes. All observed route differences occurred in reduced batches. This associates changes with the altered composition in these runs; it does not establish that the first model contributed new reasoning or that all future identical requests will be deterministic.

The application's loss weights are 10 for blocking legitimate content, 2 for allowing spam, 0.25 for unnecessarily reviewing legitimate content and 0.5 for reviewing spam. Counts above remain the primary evidence; an aggregate loss improvement cannot hide a new false positive. Repeated orders share cases and must not be treated as independent trials or summed into a population accuracy claim.

## Development diagnostics and alternatives tried

Under both full policies, no development case exited at **0.975 or above**, across all three orders. At **0.95**, only **1 / 2 / 2** broad spam controls exited; Gemini already caught them. A [focused first-stage bait rule](../tests/fixtures/clef-first-stage-policy.txt) produced **zero exits even at 0.95** in all three orders. Thus the negative finding is not limited to reusing a broad policy verbatim.

The one-message-at-a-time candidate diagnostic also produced no 0.99 exit. Clef scored the five original target patterns **0.6951, 0.8688, 0.8804, 0.2458 and 0.8339**; none reached even 0.95. Obvious crypto/paid-coursework controls scored **0.9754/0.9711**. Gemini alone correctly routed all 16 development cases in this one diagnostic, which is a useful clue about batching, not independent validation of a single-message production protocol.

Lowering the cutoff to 0.90 after seeing these results would be post-hoc tuning, not validation of the requested strict threshold. Exploratory rescoring at that level still failed to catch the original target patterns consistently across orders. A next experiment should address batching/context reliability or use a first-stage model demonstrably complementary on frozen target/control contrasts. Any future cascade must also meet false-positive and total-cost requirements on separately adjudicated traffic. None of those follow-up experiments is claimed complete here.

## Question and experimental design

Test the proposed pipeline: **Clef scores every message; only scores at or above a strict cutoff end as spam; Gemini classifies every remaining message.** A low Clef score never means automatic allowance. Gemini cannot undo a Clef false positive. Gemini receives the original message/context and policy, without Clef's score or explanation.

Compare against the installed model, `google/gemini-2.5-flash-lite`, on the same inputs and policy. Keep final spam/review thresholds **0.9/0.75**. Evaluate the installed policy and the experimental replacement from the [attention-bait investigation](attention-bait-investigation.md) separately; do not credit policy changes as cascade gains. The candidate remains unapproved.

Use the existing Decisions adapter for `cloudflare/clef`, pin OpenRouter routing to **PrimeIntellect** for Clef and **Google AI Studio** for Gemini, and disable provider fallback. Returned identities and usage receipts confirm those models/providers. This verifies these OpenRouter routes; it does not verify direct Workers AI, other Clef providers or hosted application deployment. OpenRouter documents Clef's [Decisions interface](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request) and [providers](https://openrouter.ai/cloudflare/clef). The Cloudflare endpoint's documented text truncation caveat is another reason not to generalize this PrimeIntellect experiment to every route.

1. Freeze **16 synthetic development contrasts**, including five original target patterns, before inspecting Clef results. Explore cutoffs 0.95, 0.975, 0.99, 0.995 and 0.999. Development sweeps reuse full-batch Gemini predictions and are explicitly counterfactual, not measured cascade executions.
2. Freeze **64 new synthetic validation cases** before those development results: 16 bait/filler variants, eight broader spam controls and 40 legitimate controls. Controls include actual questions with matching decorations, supplied-context follow-ups, ordinary greetings, multilingual conversation and substantive announcements. These labels express the experimental intended boundary, not independent owner adjudication.
3. Prespecify **0.99 as primary** and **0.95 as secondary** before validation. At 0.99, run an actual 64-case cascade under the candidate policy. At 0.95, run actual cascades under both policies across a label-blind permutation, reversed order and a seven-position rotation. Batch size is eight for both paired arms; actual fallback batches contain only residual messages. These are repeat robustness tests on 64 cases, not 192 independent observations. The hypothetical eight-message first stage differs from the current live decision-model scheduler's maximum of five; a separate one-message development diagnostic checks whether the no-exit finding is only a multi-message effect.
4. Execute a separate paid Gemini baseline and an actual paid residual call, even when no message exits early. Alternate which arm executes first. Zero-exit batches give an **A/A control**: the two Gemini calls have identical message/context inputs. Reduced batches can differ through composition or sampling; a changed fallback decision alone does not establish complementary Clef reasoning.
5. Keep policy, inputs, threshold, provider and classifier/helper source hashes in a sealed checkpoint ledger. Record every completed request before continuing; stop on failures. Resume only known unbilled 429 rejections after their retry deadline, never an uncertain paid call.

The frozen [validation fixture](../tests/fixtures/clef-cascade-holdout.json), [focused first-stage rule](../tests/fixtures/clef-first-stage-policy.txt), [runner](../scripts/evaluate-clef-cascade.ts) and [offline summarizer](../scripts/summarize-clef-cascade.ts) make the protocol inspectable. Private ledgers retain raw predictions and receipts in ignored `.tmp/`; the [aggregate evidence](clef-cascade-evidence.json) publishes hashes and counts without real message text, credentials or provider request IDs.

## Mechanism, cost and latency

An advantageous early-spam cascade needs a first stage that catches additional violations safely or skips enough expensive second-stage work. A strict numerical cutoff alone does not establish either. The model's score is not verified as a calibrated probability for this community policy.

Provider receipts, not a claim that a decision model must be cheaper, determine this comparison. Clef's tested PrimeIntellect route lists **$0.24 per million input tokens and no output-token charge**; Gemini Flash Lite's public model page lists **$0.10 input / $0.40 output**. Actual Gemini endpoint prices can vary. The study therefore records actual reported costs, plus token counts, rather than projecting monthly savings from a synthetic spam mixture. [Clef prices](https://openrouter.ai/cloudflare/clef), [Gemini prices](https://openrouter.ai/google/gemini-2.5-flash-lite).

In a simplified per-message model, cost improves only when `Clef cost < early-exit fraction × Gemini cost avoided`. Repeated policy/schema input, small residual batches and different endpoint pricing affect the real break-even point. Early exits have Clef's request duration; remaining messages wait for Clef **plus** Gemini. Reported latency is case-weighted batch request time, excludes rate-limit waits and is not a production latency percentile. Multiple messages sharing one request are not independent timing samples.

## Reproducing the experiment

Use Node 22 and a private ignored input snapshot with `settings` conforming to the application's settings schema, including its policy, model, provider and thresholds. Credentials come through the shared environment loader; they are never copied into the ledger. The historical `examples` field is unnecessary for synthetic splits. The candidate's exact clause edits require the audited policy text; a different installation must define and hash its own corresponding candidate rather than assume identical clauses.

```sh
# Dry protocol inspection: no provider request without the explicit paid flag.
node --import tsx scripts/evaluate-clef-cascade.ts \
  --input .tmp/attention-bait-input.json \
  --output .tmp/clef-cascade-validation-current-095.json \
  --split validation --policy current --cutoff 0.95

# Add --confirm-paid-evaluation only to authorize actual inference.
# Reuse the same output to resume a known unbilled rejection after its deadline.

# Aggregate completed ledgers; repeat --report for each experiment.
node --import tsx scripts/summarize-clef-cascade.ts \
  --report .tmp/clef-cascade-validation-current-095.json \
  --output .tmp/clef-cascade-summary.json
```

No labels, fixture family names or sender identities enter model requests. Scores route through the same threshold semantics as application decisions. Offline tests verify strict cutoff inclusion, preservation of review decisions, exact residual-input completeness and inability to undo an early false positive.

Node **22.22.0** verification passed: `npm run check` (**295 Workers tests**, 31 optional skips; **39 setup/deployment tests**; **12 portable runtime tests**, three optional PostgreSQL skips; and **one bundled Vercel build/execution test**) plus `npm run format:check`. No disposable PostgreSQL endpoint was supplied. These local checks do not establish a deployed cascade, scheduler recovery, Telegram effects or production model accuracy. The actual paid inference evidence is recorded separately above and in the hashed aggregate ledger.
