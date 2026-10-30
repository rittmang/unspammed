# Empty attention/contact bait: measured investigation

Investigated **2026-10-30**, using a read-only, repeatable-read production snapshot and explicit paid OpenRouter experiments. No database writes, Telegram operations, policy approvals, deployments, mode changes or threshold changes were performed. Private snapshots and request receipts remain in ignored `.tmp/attention-bait-*.json` files.

## What the evidence establishes

The installed classifier is `google/gemini-2.5-flash-lite`, with spam/review cutoffs **0.9/0.75**. The policy audited here hashes to `40a3426fc347f70ab344d311ee72da763fd837f4faa8f484a33535a331050be4`.

The current rule requires excessive presentation to make content **difficult to read or understand**. The ordinary-conversation allowance separately permits questions and greetings. Saved predictions call the missed, readable contact hooks “simple questions,” despite their lack of an actual question or topic. Requiring unreadability creates an unnecessary prerequisite; merely labelling the text “disruptive” does not remove it.

Feedback reaches the proposer. Several recent spam corrections use `missing_context` with an empty note, or have no reason and are correctly held. “The post does not state its question” and “the classifier lacks material evidence” are different observations. Related variants across different senders remain one campaign family, not independent proof of generalization.

The proposer already returns a diagnosis, but the orchestration previously discarded it. Compact dashboard responses also omitted measured outcomes. An owner therefore saw a generic unsuccessful status rather than the proposed behavioral explanation and actual errors. The code change retains the diagnosis and reports completed comparison counts separately; it does not pretend the diagnosis proves causation.

## The behavioral change to request

Use **Empty attention or contact bait**, with an explanation such as:

> Treat an unspecified question/doubt or availability/contact hook as spam when it has no actual subject in the full message or supplied context and combines exaggerated punctuation or elongated filler with unrelated emotional/suggestive emoji bait. Readable words, a single post and lack of advertising do not exempt this combination. Preserve actual topic-bearing questions even with identical decoration, simple greetings, brief ordinary help requests and meaningful conversation. Repeated long greeting filler can be a within-message violation; do not invent repeated posting by the sender.

This must replace the unreadability prerequisite and narrow the conflicting question allowance. Missing subject alone, one emoji, unfamiliar language or an elongated greeting alone is insufficient. A literal phrase, emoji or sender blacklist would overfit the examples.

The [fixture](../tests/fixtures/attention-bait.json) contains three exact clause replacements and **40 synthetic cases**: 16 development cases and 24 exploratory challenge cases. Controls include matched genuine questions with the same decoration, Hindi/transliteration, ordinary help requests, meaningful emotional disclosures, student announcements and supplied-context follow-ups. Synthetic labels express the intended experimental boundary; they are not independently adjudicated production holdouts.

## Why a successful screenshot replay is insufficient

Paired calls use the same Gemini model, observed provider, message/context snapshots and thresholds. Neither labels, family names, sender identities nor real message IDs go to the classifier. Outcomes use the application's actual routing, including `needs_review`; an explanation saying “spam” is not counted as an automatic catch below 0.9.

| Experiment                                            | Apparent success                                                                      | Failure found by changing order                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| First explicit combination rule                       | All five target patterns caught; all legitimate controls allowed in the initial order | Reversed batch flagged two genuine topic-bearing questions                                                 |
| Full-message exclusion first                          | Initial development loss 10 → 0                                                       | Reversed batch deferred four spam cases and two genuine questions to review                                |
| Ordered rule plus explicit score semantics            | Initial development loss 10 → 0                                                       | Reversed batch flagged two genuine questions; exploratory challenge also showed misses and false positives |
| Reason before score in the same call                  | Two orders corrected the development cases                                            | Rotated order still allowed three target hooks                                                             |
| Synthetic boundary contrasts plus reason before score | Normal and reversed development orders had no errors                                  | Rotated order allowed three hooks and flagged a context-grounded legitimate follow-up                      |

These are observed failures, not estimates of independent statistical error rates. The first repeats sometimes repeated identical requests; later experiments also rotated positions. Reordering the same cases is a robustness check, not fresh validation. The exploratory challenge initially included one generic announcement labelled legitimate that conflicted with an observed owner correction; that control was replaced by a substantive cancellation announcement before subsequent validation. Older challenge results are retained as exploratory evidence; the other listed failures do not depend on that control.

**No completed prompt-only variant tested so far is supported for Enforce.** The most elaborate candidate hashes to `1cd28c7d81acd5b7f66ede8932f950c4e92f77b649689c54077a76fea2ebb67a`; its wording is a reproducible experimental candidate, not an approved recommendation to paste into production. A later experiment must not erase the earlier failures.

## Same-model execution experiments

The application does not request classifier reasoning tokens. Google documents thinking as off by default for Gemini 2.5 Flash Lite. The replay tool can request a bounded thinking budget **within the same model call**, or change batch size and response-property order as separate experiments. These are classifier-protocol changes, not policy-only improvements or a second decision-model layer. [Google thinking defaults](https://ai.google.dev/gemini-api/docs/thinking), [OpenRouter reasoning budgets and output accounting](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

The first matched batch with a 1,024-token thinking budget caught the target examples and preserved both decorated genuine questions under both the current and candidate policies. The **completed** 16-case development comparison still failed: candidate loss was **10, 20, 0** across normal, reversed and rotated orders. It flagged a context-grounded genuine follow-up in the first order and two genuine topic-bearing questions in the reversed order. Thinking was actually used: the instrumented resumed calls reported 682–772 reasoning tokens; this is not inferred only from the requested budget.

The corrected 24-case challenge with the same 1,024-token budget also failed in all three orders. The candidate caught **9/9, 8/9, 9/9** spam cases but flagged **2/15** legitimate cases in each order; the reversed order additionally deferred two legitimate cases unnecessarily. This does not pass the existing false-positive gate. Adding evidence-first output and raising the budget to 2,048 tokens eliminated development false positives, but still missed **0, 1, 3** of the seven spam cases across the three orders. Neither execution change is a verified fix.

The retrospective run froze 97 saved owner-labelled inputs. Thirty paired references completed before Gemini returned a `PROHIBITED_CONTENT` provider error on the next baseline batch, with billing unknown. Its in-flight marker and completed calls were preserved; that request was not retried. No full-corpus accuracy claim or fresh-validation claim follows. The separate single-message experiment was interrupted after one paired case and establishes no single-message accuracy rate.

Pre-generation upstream 429 rejections are saved with zero rejected-request usage; completed calls are checkpointed and are never automatically repeated. The tool records actual model/provider, measured cost and available reasoning-token counts. It does not save hidden reasoning text. Completed provider requests reported `google/gemini-2.5-flash-lite / Google AI Studio`; old production observations on a differently named provider are not substituted for these new paired calls.

The [aggregate evidence](attention-bait-evidence.json) records each experiment's policy hashes, request counts, routing metrics, observed identities and private-report digest. Across 143 completed requests, provider receipts reported **US$0.06313**; one blocked response reported no cost, so total billing is not known. Raw private snapshots and receipts remain untracked. Counts include exploratory failed variants, not 143 independent test messages.

The result is a **necessary behavioral specification and a reproducible failed-candidate benchmark**, not proof that every possible prompt must fail. No second model was added. A fallback model layer remains outside this work.

## Reproduction

Use Node **22.x**, the shared environment loader and your own provider credentials. Prepare a private `.tmp/` JSON input with `{ "settings": <frozen Settings>, "examples": <optional labelled retrospective references> }`. Its policy must contain the fixture's exact existing clauses; a different policy fails before inference rather than silently substituting an account-specific default.

```sh
# Prints the bounded request plan; no provider calls without the explicit paid flag.
node --import tsx scripts/verify-attention-bait.ts \
  --input .tmp/attention-bait-input.json \
  --output .tmp/attention-bait-replay.json --split development --repeats 3

# Explicit paid paired evaluation; saved calls are resumed, never duplicated.
node --import tsx scripts/verify-attention-bait.ts \
  --input .tmp/attention-bait-input.json \
  --output .tmp/attention-bait-replay.json --split development --repeats 3 \
  --confirm-paid-evaluation
```

Use a different output file when changing inputs or experimental flags. `--split challenge` evaluates the synthetic variations; `--split regression` uses the private retrospective examples. `--reason-first`, `--reasoning-tokens 1024` and `--batch-size 1` are separate protocol experiments. `--endpoint <provider-slug>` optionally pins an experimental OpenRouter endpoint; it changes only those test requests, never account defaults. Provider routing uses [OpenRouter's explicit provider-selection contract](https://openrouter.ai/docs/guides/routing/provider-selection).

The tool stops on provider failures. A known rejected 429 saves a retry deadline and refuses early retries. Interrupted requests or uncertain billed failures retain an in-flight marker and require receipt reconciliation before resuming. Reports contain private text and remain under ignored `.tmp/`. Unknown cost or changing observed identities cannot be treated as successful paired evidence. No database or Telegram operation is performed by the replay.

## Implementation scope

- Added a reason requiring an observable explanation, while preserving existing feedback and grouping related variants once.
- Passed the reason's readable name and the owner's note to the proposer.
- Retained optional draft diagnoses and derived compact aggregate outcomes from completed comparisons, without exposing frozen references.
- Replaced generic duplicate/failed-boundary status text with the observed reason and count where available.
- Added focused mocked regressions for persistence, reason transport, family handling and summary privacy. These tests establish software behavior, not Gemini accuracy.

The runtime classifier prompt, default policy, model, inference protocol, installed settings and approval gates remain unchanged by this implementation. The experimental changes are reviewable in the fixture and replay reports. Production rollout requires a passing measured candidate under the intended protocol and the existing explicit owner approval into Observe.

## Verification levels

Node **22.22.0**: `npm run check`, `npm run test:setup`, `npm run test:runtime` and `npm run format:check` passed. The full check includes 292 passed Workers tests (31 optional tests skipped), 39 setup/deployment tests, 12 passed portable runtime tests (three optional database tests skipped), and the bundled Vercel build/execution test. No disposable PostgreSQL URL was supplied for the optional integration tests. Focused tests establish feedback transport, diagnosis persistence, family grouping and compact-summary privacy; they do not simulate the real-model accuracy findings above.

An isolated browser fixture verified the required explanation and family guidance, expandable diagnosis and measured outcomes, explicit rejection status and no horizontal overflow at 320/390/1280px; desktop dark appearance was also checked. This is browser verification, not a physical Telegram-client check. A second read-only comparison confirmed the complete saved configuration unchanged in both provisioned groups. No deployed HTTP or scheduler/restart check was needed or claimed because no deployment occurred.
