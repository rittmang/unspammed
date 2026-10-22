# Deployment operations and verification

Use [the hosting guide](hosting.md) to create a new installation. This document describes the current deployment contract and how to verify it. [Historical deployments](deployment-history.md) preserve one original account's versions and checks; those records do not establish the state of this branch or another provider.

## Public website and personal deployment: 2026-10-22

**https://watchtower.rittmang.xyz** now serves the public Astro content website from the separate private `rittmang/watchtower.rittmang.xyz` repository and `watchtower-marketing` Worker. The personal Naarad Muni dashboard and owner Mini App are at **https://naaradmuni.rittmang.xyz** and **https://naaradmuni.rittmang.xyz/mini/** on the existing `watchtower-telegram` Worker. Its database and moderation configuration were preserved; this is a hostname separation, not a second moderation installation.

The public hostname's existing custom-domain binding was reassigned to the marketing Worker after new-host verification. The owner Access application retains its audience and exact owner policy, with its primary domain and only destination now on the personal hostname. The old public-host Mini App bypass was retired; the new personal-host Mini App/machine exceptions remain narrowly scoped. The preserved private application deployment config now lists only the personal hostname, so a later application deploy cannot reclaim the marketing hostname. The webhook and internal dispatch retain their working workers.dev origin. Legacy public `/mini` and `/login` entry points redirect to the personal deployment; the marketing site does not proxy private APIs.

The marketing build passed Astro checks, static link/asset checks, a Wrangler dry run and deployed HTTPS browser checks in Chromium and WebKit. Its story and all illustrative data are separate from saved group data. See the marketing repository's deployment and verification documents for its own build evidence. These installation-specific names are operational records, never setup defaults.

## Personal deployment URL cutover: 2026-10-22 Pacific

The personal Naarad Muni deployment now uses **https://naaradmuni.rittmang.xyz** for browser sign-in and **https://naaradmuni.rittmang.xyz/mini/** for the owner's Telegram menu. The same `watchtower-telegram` Worker was deployed as version `3b1c008d-d11a-473e-a941-11b7a2bd3799`. Its runtime configuration changed only `DASHBOARD_URL`; the preserved private production config retains both custom-domain routes. The existing workers.dev origin remains the webhook and internal-work origin. The owner-only menu was configured and independently checked; the global menu and webhook registration were unchanged.

At `2026-10-22T07:54:25Z`, 51 deployed HTTP checks passed, covering trusted HTTPS, Access redirects, browser/Mini App link origins, exact local JS/CSS bytes, CSP/private-file restrictions, signed owner reads, invalid/expired/wrong-bot/non-owner rejection and unknown-group rejection. Both provisioned groups' settings and dataset metadata matched the pre-cutover fingerprints; the existing mode, policy, group registry and 4,947 dataset examples were preserved. Worker bindings, Access audience/owner variables, namespace, native schedules and both custom domains matched the exact change whitelist. Browser rendering also confirmed the new Cloudflare sign-in link. Interactive owner Access login, physical Telegram-client behavior and actual cron/restart recovery were not exercised during this cutover.

At this phase's verification time, both custom domains still served the protected personal dashboard. The later public-host transfer is recorded above; its old Access destinations and private deployment route have since been retired. This installation's domains are operational evidence, never defaults for another installation.

## Verified update: 2026-10-21 Pacific

Worker version `b4c25f08-a822-41f3-a237-1a50d1de4d41` served the build verified in this earlier update. Live checks at `2026-10-22T00:51:14Z` matched both origins' JS/CSS to local build bytes and confirmed owner reads, denied invalid/non-owner requests, group boundaries and the normal Access redirect. The existing mode, policy fingerprint, two groups and 4,947 dataset examples matched the pre-deployment baseline. Deployment did not register Telegram endpoints, send exports, change thresholds, approve a policy or connect an owner account.

The portability verification also exercised disposable Cloudflare, Vercel and DigitalOcean VM installations, with separate Render/Fly email accounts. See [the evidence register](provider-verification.md) for exact scope, actual cron/restart results, account/plan blockers and cleanup status. Provider results do not inherit this installation's permissions or original account settings.

## Current implementation

The repository provides Cloudflare Workers, persistent Node 22 and Vercel Node entry points over shared handlers. PostgreSQL stores production application state; the local SQLite adapter is isolated development/test state. Node hosting has a built-in minute scheduler; Cloudflare uses native Cron Triggers; Vercel uses the authenticated `/api/cron` endpoint. Optional owner-account cleanup uses Cloudflare's Durable Object or the portable PostgreSQL-backed admin service.

These are implementation and local-validation paths. A template does **not** by itself deploy Railway, DigitalOcean, Vercel, Render, Fly.io or a VM, register DNS, change a live webhook/menu, approve a policy, enable Enforce, or prove real MTProto connectivity on a serverless host. The [provider evidence register](provider-verification.md) records the support scope and research corrections. Record actual provider deployment evidence only after performing it in that account.

Cloudflare's previous installation and its historical account-specific config are retained separately for deliberate upgrades. Fresh setup requires your own generated config. Never deploy the old installation's credentials, hostname, Access audience, Hyperdrive ID, namespace or owner IDs as a new-user default.

## Environment and lifecycle

Use ignored `.env` and `npm run setup -- --provider PROVIDER`; add `--browser-auth` if desired. Setup writes private derived files and validates account inputs without provisioning external resources. `setup:doctor` is local/read-only; `setup:check` additionally checks Telegram permissions and public health without modifying webhook/menu state.

`PUBLIC_URL` is the canonical application HTTPS origin. `WORKER_URL` remains a legacy alias. `DATABASE_URL` is portable PostgreSQL; old PlanetScale names remain aliases. Preserve `DATABASE_ROOT_CHAT_ID`/the initial schema namespace when switching default workspaces. `DATABASE_ADMIN_URL` is bootstrap-only and must not be a runtime secret. Keep runtime-role grants and verified TLS correct when moving hosts.

The Node service listens on `PORT` (default 3000) and `HOST` (default `0.0.0.0`). Its scheduler runs at startup and each minute; `WATCHTOWER_SCHEDULER=false` disables automatic ticks for isolated checks. Durable PostgreSQL cursors resume work and retention after a process restart. A process timer cannot run while a host sleeps or scales to zero. Multiple replicas still coordinate through database leases; preserve scheduler time budgets and avoid unnecessary parallel external calls.

Vercel cannot use that timer. Its manifest schedules `/api/cron` each minute, requires `Authorization: Bearer CRON_SECRET`, and sets 300 seconds maximum function duration. Built-in minute cron requires an appropriate plan. The adapter processes bounded work and persists the rest for later ticks; a terminated invocation is recovered through leases/cursors rather than memory. See [provider constraints](hosting.md#vercel).

To upgrade, back up the database and private configuration, preserve the root namespace/session key, regenerate reviewed derived config, run additive schema setup as needed, and deploy. Confirm existing settings and datasets remain readable before changing live behavior. `--discard-legacy-history` is a special existing-installation operation for a deliberately abandoned legacy transfer; it is never a normal setup or outage-recovery command.

For an existing Cloudflare Worker, retain its complete Durable Object migration history, bindings, routes and account selection. The setup generator's `v1-admin` history is for a **new** Worker; do not replace an installed Worker's migrations with it. The preserved private configuration can be selected explicitly with `npm run deploy -- --config wrangler.production.jsonc` (add `--dry-run` first). Merge new public variables deliberately, retaining existing secrets in the host. Generating a fresh config is not a migration of an existing deployment.

## Verification checklist

Run the repository checks with test credentials and isolated state:

```sh
npm run check
npm run test:setup
npm run test:runtime
npm run format:check
```

Use a disposable loopback PostgreSQL database for opt-in integration tests, and confirm skipped tests are reported as skipped. Check Cloudflare packaging with `npx wrangler deploy --dry-run --config wrangler.generated.jsonc` after generating your own config. A provider packaging check does not register its domain or run its scheduler.

For Vercel, `npm run test:vercel` builds and executes the bundled handler locally. Use the real Vercel builder to check the emitted function, routes, cron and included assets too; TypeScript and source-adapter tests alone cannot catch a packaged module failing at startup. Record local artifact execution separately from deployed HTTP and cron checks.

Before registering your bot or enabling live work, verify:

1. Anonymous HTTPS `/health` returns 200 from the intended deployment, with valid DNS/certificate and no upstream login redirect.
2. `/` and `/login` show configured sign-in choices without private group/data requests. `/mini/` and required built assets load, while unknown Mini App resources and source maps do not.
3. Anonymous private APIs return 401. Forged, expired, wrong-bot and non-owner Telegram payloads fail; fresh owner launch data succeeds only under `/mini/api/*`. Browser cookies cannot authenticate Mini App APIs.
4. Optional browser-token login works only through protected same-origin POST over HTTPS. It returns a Secure HttpOnly SameSite cookie, never the token. Wrong token, tampered/expired cookies, old cookies after rotation, missing protection headers and foreign-Origin writes fail. Sign out clears the current browser cookie.
5. Optional Access login verifies the intended owner, issuer and audience. Webhook/Mini App/internal/cron traffic reaches the application through narrow path rules or a separate origin. An upstream bypass must still require the route's own application credential.
6. Runtime-role PostgreSQL reads/writes work with intended TLS and permissions. Additional groups cannot read or mutate one another. Restart/redeploy preserves datasets, labels, settings, work progress and encrypted optional admin sessions.
7. Webhook setup preserves pending updates and verifies bot/owner permissions. Actual delivery commits before acknowledgment; provider outages produce retryable failures. Read back webhook status and the owner's menu without printing secrets.
8. The provider actually runs minute work, survives overlap/restart, and resumes durable cursors. Test using isolated state or harmless pending work, not a production delete/ban. Test cleanup/retention against a disposable database.
9. At phone/tablet/desktop widths, exercise all six pages, both themes, navigation, import, authenticated images, label edits and normal exports against isolated state. Check Telegram native Back/themes/activation/safe areas with SDK simulation, and report physical-client checks separately.
10. Optional owner-account transport fits the target host's TCP and lifetime limits. A successful login does not authorize a real user's history deletion test. Keep per-user confirmation and audit records intact.

Read-only live HTTP checks can confirm routing/authentication and data readability. They cannot establish moderation accuracy, private device behavior or a scheduler that has not actually run. Do not send test exports to a real owner, spend provider money, or mutate production labels/settings solely to fill a verification table.

## Record a real deployment

Record provider/account scope without secrets, commit/build identity, time, public hostname, relevant plan/runtime settings, database migration scope, safe HTTP checks, actual scheduler/restart evidence and outstanding limitations. State whether Telegram menu/webhook were changed, whether model calls or Telegram effects occurred, and whether any physical clients were tested. Keep no-op/read-only checks distinct from real effects. Link to separate sanitized metadata when useful.

The current repository's historical records stay in [deployment-history.md](deployment-history.md). New providers should receive a new dated verification record after actual deployment, rather than inheriting that archive's live-success claims.
