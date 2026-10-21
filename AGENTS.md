# Working on Watchtower

Read [README.md](README.md), [architecture contracts](docs/architecture.md) and [hosting instructions](docs/hosting.md) before changing deployment, storage, authentication or scheduling. [docs/portability-plan.md](docs/portability-plan.md) records implementation scope. [docs/deployment-history.md](docs/deployment-history.md) and [docs/research.md](docs/research.md) are historical records of one installation, not current setup instructions.

## Account neutrality and secrets

- Every installation supplies its own bot, numeric owner ID, numeric group ID, host, PostgreSQL connection and provider account. Never infer an owner from an existing message, repository author, email, old bot username or archived config. Never reuse original account/resource/domain IDs as defaults.
- A provider-supplied HTTPS domain is sufficient. Custom domains, Cloudflare DNS, Access, Hyperdrive and Telegram user-account login remain optional. DNS provider and application host are independent choices.
- Keep `.env`, `.dev.vars`, custom environment files, `.watchtower/`, `wrangler.generated.jsonc`, database passwords, bot/provider tokens, browser tokens, signed Telegram launch data and encrypted-session keys out of Git, URLs, logs, screenshots and API responses. Verify ignore rules before generating credentials. Do not read or print private credential files just to inspect project structure.
- Use process environment or the shared environment loader. `WATCHTOWER_ENV_FILE` selects a file; default setup fallback is `.env`, then legacy `.dev.vars`. Preserve existing credentials during setup/regeneration. Generated runtime outputs exclude `DATABASE_ADMIN_URL` and hosting API credentials.
- Changing `BROWSER_AUTH_TOKEN` revokes browser sessions; changing `TELEGRAM_SESSION_KEY` can make saved owner-account sessions unreadable. Preserve installed values unless rotation is part of the requested work.

## Runtime invariants

- Reuse shared handlers for Cloudflare, persistent Node and Vercel. Host-specific code belongs in adapters, configuration and scheduler integration, not duplicated moderation rules.
- Production data, group boundaries, work leases, job cursors and portable admin state live in PostgreSQL. SQLite is the isolated local development/test adapter. Default PostgreSQL TLS verifies certificates; disable TLS only through an explicit private/test-network setting.
- Keep `DATABASE_ROOT_CHAT_ID`/the original namespace stable. Group selection is not authorization. Preserve registry/permission checks, per-group settings/data and fenced lease ownership.
- Authenticate every private API request. Telegram launch credentials remain confined to `/mini/api/*`; browser cookies/Access remain on normal browser APIs. Keep issuer/audience/owner checks and HMAC age/identity validation strict.
- Browser sessions use a derived signing key and HttpOnly Secure SameSite cookies. Require matching Origin plus request header for cookie mutations/login/logout. Never persist the raw browser token in frontend storage or put it in a link.
- Root/login and the exact built static allowlist may be public application code. Do not expose environment files, source maps, arbitrary filesystem paths or saved application data. Preserve escaped HTML metadata, CSP, cache restrictions and scoped Telegram framing/SDK permissions.
- Webhook ingestion commits before acknowledgement. Model/Telegram calls stay outside transactions. Scheduler overlap, process replacement and provider time limits must preserve durable progress, retries and fencing.
- New groups start in Observe. Deployment must not enable Enforce, approve a policy, change live thresholds, connect another human account, or replay already billed work implicitly.

## Validation and reporting

Use Node 22+. Start with relevant focused tests, then the required checks for the final change:

```sh
npm run check
npm run test:setup
npm run test:runtime
npm run format:check
```

Use `TEST_POSTGRES_URL` only with a disposable loopback database; the suite clears its test schemas. Do not aim test code at production or repurpose a real group for a destructive test. Mock model and Telegram effects by default. Do not perform real message deletion, ban, full-history cleanup, owner-account login or paid model inference merely to verify an implementation. User authorization for actual external effects must be grounded in the task, not inferred from available credentials.

For Cloudflare configuration changes, run an appropriate Wrangler deployment dry run against a generated test config. For other hosts, validate their manifest and adapter, and explain plan-specific minute cron, function-duration, TCP, TLS and proxy limits. Use current official documentation for provider claims.

Keep verification levels explicit: unit/integration tests, local adapter execution, provider build validation, actual deployed HTTP checks, actual cron/restart recovery, and physical Telegram-client checks are different evidence. Do not claim Railway/DigitalOcean/Vercel deployment from a local Node test, or physical-device compatibility from SDK event simulation. Do not copy a historical test count or deployment version into a current claim.

Preserve unrelated dirty work and the existing responsive Mini App experience. Inspect `git status`/diff before edits and review the final diff for secrets, account assumptions and accidental live-mode changes. Update operational docs and extension contracts when behavior changes.
