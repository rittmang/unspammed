# Investigation: the four-attempt policy run stalled

Audited 2026-10-17 Pacific. Campaign `f6e0827d-ed3d-4478-80c3-2c3dd9e4860f` finished at 2026-10-18 04:31:28 UTC. This investigation read the saved production proposals, frozen references, predictions, settings and feedback. It made no production mutations or model requests.

## Finding

The proposer failed to turn the accepted feedback into a changed moderation rule. The system accepted cosmetic wording as new revisions and trusted descriptions of changes that were absent from the actual policy. The fourth proposal exactly repeated the third and was correctly stopped before testing. This was not four substantively different, fully tested policies.

The original three corrections remained classified as legitimate in every tested candidate. The final rejection therefore protected the live policy, but the generation/learning process did not accomplish its purpose.

| Attempt | Actual change and result                                                                                                                                                                                                                              | Original corrections fixed |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 1       | Broad rewording of the live policy. Development loss stayed 9 → 9. Legacy manual flow still advanced; validation improved, but final loss worsened 0.75 → 8.75 with four newly allowed spam messages.                                                 | 0 of 3                     |
| 2       | Changed the introductory sentence and two section headings. All seven prohibited-content rules and the ordinary-conversation allowance stayed identical to attempt 1. Development loss worsened 10.5 → 26.5; candidate flagged no spam automatically. | 0 of 3                     |
| 3       | Changed only the introductory phrase identifying the community. Development loss improved 10 → 9.75, below the required one-unit improvement; original-correction checks also failed.                                                                 | 0 of 3                     |
| 4       | Policy text exactly matched attempt 3. Duplicate detection stopped it without classification calls.                                                                                                                                                   | Not retested               |

Losses compare the baseline and candidate on the same references within each row. The reference sets change between attempts, so their absolute losses do not establish a trend across attempts.

## What went wrong

### 1. Claims of learning were not tied to rule edits

Attempts 2–4 reported criteria including improved handling of stylized text and disruptive greetings. Their policy text did not add that behavior or narrow the conflicting allowance for greetings and questions. Attempt 3 literally changed only the introduction; attempt 4 changed no policy text at all.

`proposePolicy` asks for a complete replacement and free-form descriptions of changes. Its response validation checks shape, length, prohibited references and copied message fragments, but does not connect a claimed change to an actual rule edit. Later duplicate detection normalizes whitespace, so a changed heading or introductory phrase counts as a distinct proposal. See [proposal contract](../worker/improvement.ts#L51) and [duplicate handling](../worker/improvement.ts#L609).

I replayed the saved attempts 2–4 through `proposePolicy` with a local mocked provider. All were accepted by its response validator. This reproduction confirms the validation gap without spending provider tokens; campaign-level duplicate detection still correctly rejects attempt 4.

### 2. The proposal instructions pulled against the desired boundary change

The system instruction explicitly preserves ordinary greetings and useful clarifications. The existing policy explicitly allows greetings, questions, emojis and casual conversation. Your notes describe disruptive, heavily stylized, low-information messages. A useful revision needed to distinguish that unwanted behavior from ordinary conversation and edit the conflicting allowance accordingly.

Instead, every candidate retained the blanket ordinary-communication allowance. Its flooding rule continued to describe repeated messages over time, while all three frozen correction snapshots had empty recent-sender context. A rule based on unseen repeated posting could not establish a violation from those snapshots. In-message disruption would require an explicit rule supported by the supplied message itself.

The code and saved text establish this conflict. Whether any one instruction caused the model to ignore the feedback cannot be isolated from these records; the absence of the needed rule change is directly observable.

### 3. Scoring made evaluation noisy

All ten saved evaluation runs completed with the same reported model (`google/gemini-2.5-flash-lite`) and provider (`Google`), without missing identity metadata. Billing/identity gates did not cause these failures.

Nevertheless, 9 of 13 exact message/context inputs repeated across attempts received different baseline routes under the unchanged live policy. Batch composition, position and request timing also changed, so this is evidence of instability across requests, not an isolated estimate of randomness.

Several candidate explanations explicitly identified prohibited financial or sexual solicitation while assigning scores of 0.6–0.8 with `needs_review=false`. With the saved spam threshold of 0.9 and review threshold of 0.75, those scores route to legitimate or review. The classifier request asks for a generic score but does not include the numerical routing thresholds; the proposer receives thresholds, but its output does not define score ranges. See [classification instruction](../worker/classifier.ts#L112) and [routing](../shared/improvement.ts#L103).

This helps explain apparent regressions on unrelated rules despite only cosmetic policy changes. It does not explain away the original three failures: those were consistently classified as legitimate with scores 0–0.1.

### 4. Learning memory is incomplete

Each proposer call receives the original corrections and up to twelve mistakes from the immediately previous failed phase. Earlier attempts contribute only their descriptions, phase names and scalar losses. The accumulated `trainingSources` are used to construct later development tests, but their full error examples are not all included in the next proposal request. Thus preserving source IDs is not equivalent to giving the proposer cumulative concrete lessons. See [proposal history input](../worker/improvement.ts#L84) and [revision construction](../worker/improvement.ts#L801).

The local replay verified that all three spam labels and their full owner notes were sent in every revision request. Immediate previous mistakes were also present (6, 12 and 8 examples respectively). This rules out a missing-feedback transport bug. Changing reason tags again would not address the observed failure.

### 5. The tests verified orchestration, not real policy learning

The lifecycle tests use a deliberately synthetic classifier that recognizes `spam-` prefixes and returns prearranged scores of 0.99 or 0.1. They verify persistence, revisions, reference separation and publication safeguards. They cannot establish that a real model will make a relevant edit or classify the owner's corrections correctly. See [mock classification](../tests/improvement-lifecycle.test.ts#L77).

The earlier statement that 257 tests passed was accurate, but it did not demonstrate successful real-model prompt optimization. That was a gap in validation.

## Were the checks simply too strict?

They were not the reason the original corrections remained unfixed. An offline counterfactual using each saved development baseline, changing only the three original decisions to their accepted spam labels, passed the existing performance gate in all three evaluated attempts. Loss would improve by six units: 9 → 3, 10.5 → 4.5, and 10 → 4. This proves gate feasibility, not that a real policy can achieve the counterfactual.

There is a separate design weakness: validation also requires at least one unit of improvement on fresh messages, even when the baseline is already perfect there. Such a validation gate cannot pass a tied perfect result. It did not cause attempts 2–4 to stop, because they never reached validation. A corrected design should demonstrate improvement on development and preserve performance on untouched validation/final checks rather than require every split to contain a repairable baseline error.

## Corrective work

1. Generate explicit replacements of relevant policy clauses, tied to the feedback they address. Derive the change summary from applied edits. Reject unsupported change claims and cosmetic-only proposals before spending a full evaluation run.
2. Reconcile accepted feedback with conflicting editable policy clauses. Do not treat the current greeting allowance as immutable, and do not invent repeated-post context. Preserve labelled ordinary greetings and genuine questions as contrast cases.
3. Test the triggering corrections and labelled contrast cases early. Keep a stable development regression set and cumulative concrete error/win memory. Fresh held-out messages must remain separate from material sent to the proposer.
4. Define and verify consistent score/routing semantics. Measure repeatability on the same input and batch before treating small threshold-boundary movements as evidence of a better rule. Do not loosen the original-correction or false-positive checks to manufacture a pass.
5. Report why a run stopped in plain language. Here the final reason should be that the model repeated a previous policy without generating a new rule; the generic “no reliable improvement” message hides that distinction.
6. Add regression coverage for cosmetic-only proposals, unsupported change summaries, cumulative learning, tied perfect held-out checks, and score/reason disagreement. Validate the repaired loop with real model behavior on a separate development fixture before claiming it works.

Increasing the revision limit alone leaves these failure modes in place.

## Preserved state and reproducibility

The live policy SHA-256 remains `c120c0767153c2ab43524f25b437ece9e58b7ad6b89c82f737480b3b38ec7f38`, in Enforce mode. No candidate was approved. This investigation deployed no changes and left existing labels and saved attempts intact.

Private raw snapshots are stored only in ignored `.tmp/policy-campaign-audit.json`. The ignored `.tmp/audit-policy-campaign.ts` collects the read-only evidence; `.tmp/reproduce-policy-proposal.ts` locally replays provider responses and checks the counterfactual gates without network calls. Its derived results are saved in `.tmp/policy-campaign-reproduction.json`. These files contain private development data and should remain untracked.
