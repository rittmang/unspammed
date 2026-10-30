# Single-message Gemini moderation

Implemented, pushed and deployed on **2026-10-30** at the operator's request, following the [protocol investigation](gemini-protocol-investigation.md) and [exact-input owner adjudication](gemini-owner-adjudicated-evidence.json). The operator separately authorized applying the setup to both active live groups; [rollout evidence](single-message-rollout-evidence.json) records the release identity and authenticated settings readback.

## Behavior

New workspaces use the updated attention/contact-bait policy, `google/gemini-2.5-flash-lite` through OpenRouter, **one message per model call** and a **1,024-token thinking budget**. New groups still start in **Observe**. The generic default removes the original installation's school name; it is not a claim of independent validation for every community.

The update replaces the unreadability prerequisite with the evaluated bait criteria, narrows the conflicting greeting/question allowance and retains genuine-question contrasts. [The shared policy module](../shared/moderation-policy.ts) contains the exact tested clause replacements. It preserves unrelated installed policy text and refuses automatic replacement when a custom policy does not contain either the old or updated clauses exactly once. Unknown wording needs an intentional edit rather than a guessed rewrite.

The classifier sends `reasoning: { max_tokens: 1024, exclude: true }` and reserves a total output allowance of 2,024 tokens, keeping 1,000 tokens available for the visible result. Thinking mode pins OpenRouter to the tested **Google AI Studio** provider with fallback disabled; provider rate limits follow the existing durable retry path. It rejects a multi-message thinking request before making an upstream call. Supplied recent same-sender context remains attached to the single target. The adapter does not send this reasoning option or provider pin to decision models, other models or custom endpoint URL overrides.

The live token allowance accounts for the additional output reservation and settles against reported usage, including thinking. Reasoning text is excluded; the ordinary generated classification reason remains available for review and feedback. Thinking tokens count toward output usage and billing. [OpenRouter reasoning contract](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

The serial scheduler drains successive durable work chunks, up to twenty per group invocation, checking its existing elapsed-time budget between chunks. Each classification result is committed before subsequent work; it does not require a parallel inference fan-out or rely on browser polling. An in-flight request can finish after the between-chunk deadline, subject to its own timeout and the host's execution limits. This removes the former one-chunk-per-production-tick restriction without claiming a guaranteed throughput on every hosting plan.

## Existing workspaces

Installed settings are not rewritten on read or deployment. Missing legacy fields retain **thinking off** and the former batch default; an omitted legacy policy retains the old default. Existing explicit policies, model choices, modes, thresholds, credentials and group identities remain unchanged.

In **Settings → The spam policy**, **Use evaluated Gemini setup** prepares the matching policy edits and selects OpenRouter/Gemini, batch size one and 1,024 thinking tokens. This action leaves an unsaved draft. **Save settings** applies it through the existing authenticated settings endpoint and stale-version check. The preset preserves the selected moderation mode and thresholds; it does not enable Enforce. The owner can turn thinking off and choose a batch size separately.

For the authorized 30 October rollout, both active groups were updated through that authenticated settings endpoint after code deployment and before/after comparison. Both retained their existing **Enforce** mode, **0.90** spam threshold, **0.75** review threshold and daily token limits. One policy accepted the exact evaluated replacements. The other needed an intentional adaptation: its existing rule against obscured promotional posts was retained, the evaluated bait rule was added beside it, and the greeting/question and judgment edits were applied. Reversing those edits exactly reconstructed the custom original. That custom full policy has not received a separate paid accuracy evaluation.

Replay jobs freeze batching and thinking with their policy/model/threshold snapshot. A later live settings change does not alter the queued run's execution settings. Old snapshots without the new field retain thinking off; recorded cursor progress and already completed predictions are preserved. Thinking and batching participate in new policy fingerprints, so old draft approvals may become stale rather than authorize a protocol they did not measure. Rolling back a policy version that predates thinking restores thinking off.

## Evidence and limits

The selected configuration passed the 16-case development screen and 64 previously inspected stress cases. On a separate 64-case screen, the owner adjudicated three originally synthetic-legitimate examples as spam; the unchanged outputs then matched **27/27 intended spam and 37/37 intended legitimate messages**. That is retrospective adjudication of those exact examples, not independent production accuracy. The two additional planned validation perturbations and historical regression remain unperformed. This implementation does not replace those missing experiments with mocked test results, and the text-only study makes no new image-accuracy claim.

That screen cost **7.88×** the reported same-policy batch-eight comparison. This is a measured experiment ratio, not a monthly billing forecast. The settings page states that provider usage increases; installed daily token limits remain unchanged.

Local verification, the production deployment and the separately authorized live settings changes are recorded in the [provider evidence register](provider-verification.md). Deployed HTTP and settings readback passed; no additional paid inference, manual Telegram moderation action, actual cron/restart experiment or physical Telegram-client check was requested for rollout verification. Normal live scheduling remained enabled. Those deployment checks do not establish independent production accuracy.
