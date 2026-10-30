# Model thinking controls

Settings exposes **Thinking** independently of the evaluated Gemini preset. Changing the provider or model resets its thinking and upstream-route overrides to **Model default**, leaving moderation mode, policy, thresholds, batching and daily allowance alone. Nothing is applied until **Save settings**.

For OpenRouter, the authenticated `/api/model-catalog` route streams public model metadata to the browser without forwarding credentials or parsing the entire catalog inside the Worker. The browser uses that model's advertised reasoning metadata to offer effort choices and hide Off when thinking is mandatory. Model-default, Off, token-budget and effort modes have distinct request semantics. Future effort names advertised by the gateway do not need a model-name whitelist. See [OpenRouter's reasoning options and model discovery contract](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

Some current catalog entries omit the native `supports_max_tokens` flag. For reasoning models without advertised effort selection, the UI offers the gateway's token-budget control; OpenRouter may map it to effort rather than enforce a native hard token budget. Advertised effort choices take priority when the native-budget flag is absent. Model-specific minimums and provider limits still apply. An unavailable catalog shows a retryable error and preserves the saved configuration.

## Budgets, output and routing

Token budgets accept positive integers up to 65,536. The total output limit includes thinking and classification output; token-budget mode requires room beyond the budget for at least 1,000 visible tokens, increasing for larger batches. Effort mode exposes a separate total output cap, initially at most 16,384 tokens in the UI, so choosing a stronger effort does not silently remove output limits. The application cap is 262,144, further bounded in the UI by the model's advertised completion limit. Effort is not an exact reasoning-token count or a promise of enough visible output for every model.

Live reservations include the entire output cap and settle against reported usage. Batching is independent of explicit thinking mode. The tested preset still chooses one message per call; selecting another budget or batch size does not inherit its accuracy evidence.

**Upstream provider (optional)** accepts an OpenRouter provider slug. A value pins that route with fallback disabled; an empty value restores automatic routing. Changing the model clears that pin, so an old Google route does not follow an unrelated model.

Custom chat providers can opt into the same OpenRouter-compatible `reasoning` request object by declaring their capabilities in `MODEL_PROVIDERS_JSON`:

```json
[
  {
    "id": "custom",
    "name": "Custom",
    "baseUrl": "https://provider.example/v1",
    "apiKeyEnv": "CUSTOM_API_KEY",
    "format": "json_object",
    "reasoning": {
      "supports_max_tokens": true,
      "supported_efforts": ["high", "medium", "low"],
      "mandatory": false
    }
  }
]
```

This declaration must describe that endpoint's actual contract. It does not implement another vendor's native SDK or infer support from a compatible-looking URL. OpenRouter routing fields are never forwarded to custom endpoints. Decision-model requests keep their separate protocol and receive no thinking controls.

## Compatibility

Optional saved fields `reasoningMode`, `reasoningEffort`, `maxOutputTokens` and `modelEndpoint` participate in new policy fingerprints and frozen replay snapshots. They are omitted from old fingerprints. Old clients preserve existing fields they do not send; an explicit mode save can clear obsolete overrides. Rolling back to an older version clears fields it did not have.

Legacy configurations and frozen runs without an explicit mode retain their previous behavior, including the old Gemini route pin and one-target cap. This narrow compatibility branch does not restrict new explicit controls. A legacy run without any settings snapshot uses its old batch size with thinking off, regardless of current live overrides. Explicit overrides also stay with their model: different model-lab or image-fallback routes start from model defaults.

No additional paid model inference is needed to verify request serialization, metadata handling, saved settings or replay isolation. Those software checks do not establish moderation accuracy for another model, effort level, budget or batching choice. The [original investigation and selected preset](single-message-moderation.md) retain their measured scope.
