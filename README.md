# Unspammed

[Public website](https://unspammed.rittmang.xyz)

Unspammed is a private Telegram moderation bot with a dashboard for reviewing messages, labelling datasets, comparing models, and improving your moderation policy. Cloudflare Workers, persistent Node 22 and Vercel entry points share the same moderation, PostgreSQL storage and authentication code. Provider templates and their actual verification status are listed in the [provider evidence register](docs/provider-verification.md).

Add [**@unspammedbot** to your Telegram group](https://t.me/unspammedbot?startgroup&admin=delete_messages+restrict_members), or self-host **Unspammed** with your own bot, infrastructure and model-provider billing. The operator confirmed the public bot running and ready for new groups on 2026-10-22. This repository does not implement hosted signup, checkout, subscription billing or automatic customer provisioning; the earlier US$5/month figure remains a planning placeholder. See [editions and pricing status](docs/brand-and-editions.md).

New groups start in **Observe**: messages can be scored and reviewed, but Unspammed does not delete messages, issue strikes or ban until you explicitly choose **Enforce**. Historical imports never trigger live moderation.

## What you need

For your self-hosted Unspammed installation, bring your own:

- Telegram bot, numeric owner user ID, and a supergroup where both the bot and owner are administrators. The bot needs Delete messages and Ban users permissions.
- PostgreSQL database and an application role that can use and create objects in its application schema.
- Public HTTPS application host and a scheduler that keeps processing persisted work. Your host's supplied domain is sufficient.
- Model-provider key when you are ready to classify messages or run evaluations. A key is optional for installation, importing, labelling and reviewing saved data.

A custom domain, Cloudflare DNS, Cloudflare Access, Hyperdrive, and a Telegram user-account session are optional. The shared Mini App handler authenticates the owner using the bot token and numeric owner ID. For normal browser sign-in, setup can generate a private owner token; Cloudflare Access is another optional method.

Follow [the hosting, DNS and Telegram guide](docs/hosting.md). It explains the Cloudflare, persistent Node and Vercel requirements. [Deployment operations](docs/deployment.md) separates local tests from actual provider deployments. Original account details are retained only in [historical deployment records](docs/deployment-history.md).

## Run locally

Requires Node **22.x**.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. The local development script uses Wrangler on port 8787, Vite on 5173, and isolated SQLite state under `.tmp/dev/state`. Its default credentials are deliberately fake and isolated in ignored `.tmp/dev/local.vars`; it never reads or edits your hosted credential files. Set `UNSPAMMED_ENV_FILE` explicitly only when you intend to use a separate test bot. The local owner bypass requires both `DEV_MODE=true` and a loopback request URL. Hosted setup requires `DEV_MODE=false`.

Without credentials you can inspect the UI and import, label and export evaluation datasets. Provider calls require a real key. Use a separate bot and disposable test supergroup for development with Telegram credentials. Local SQLite is a development adapter for one group; production and multi-group operation use PostgreSQL.

## Prepare your deployment

Follow the **[setup guide](docs/setup.md)**. It covers BotFather, the group, PostgreSQL, private configuration, the included provider templates, a manual Linux VM path, DNS and Telegram registration, and Telegram/browser-token/Access sign-in. An included template is not a completed test-account deployment; consult the [evidence register](docs/provider-verification.md).

Short version:

```sh
npm ci
cp .env.example .env   # set your bot token, owner/group IDs, DATABASE_URL, PUBLIC_URL
npm run setup -- --provider cloudflare   # Or: railway, digitalocean, vercel, render, fly
npm run setup:doctor
npm run database:setup
# deploy on your host, then:
npm run setup:check
npm run telegram:setup
npm run telegram:mini-app
```

Setup creates no hosted resources and does not register Telegram endpoints; `database:setup` writes only to your database, and `telegram:setup` is the first step that changes Telegram. `.env` is private and ignored by Git. Setup tools read process environment first, then `UNSPAMMED_ENV_FILE` (legacy `WATCHTOWER_ENV_FILE` remains supported), otherwise `.env`, otherwise legacy `.dev.vars`. Existing private `.watchtower/` outputs and database namespaces remain stable across the rebrand.

## Moderation and review

The dashboard includes Overview, Messages, Strike history, Model lab, Policy improvement and Settings. Multiple supergroups share one database while keeping their messages, settings, strikes, models and lab datasets separate. Use **Add or manage groups**, verify bot/owner permissions, and explicitly activate new workspaces in Observe. Keep the initial database namespace stable when adding or switching groups.

- First strike deletes the spam message and records a strike.
- Second strike also queues deletion of that person's tracked messages still inside Telegram's deletion window.
- Third strike permanently bans the person and queues eligible tracked-message deletion.

The Bot API generally limits deletion to messages less than 48 hours old. A successful ban does not prove every historical message disappeared. Unspammed records spam internally; the Bot API provides no native Report Spam or arbitrary group-history export endpoint. Optional owner-account cleanup uses Telegram's client API and requires a separate connection and per-user confirmation. [Telegram deletion](https://core.telegram.org/bots/api#deletemessage), [banChatMember](https://core.telegram.org/bots/api#banchatmember), [client history deletion](https://core.telegram.org/method/channels.deleteParticipantHistory).

Text, captions, polls and hidden links are classified. Enabled image processing supports photos and JPEG/PNG/WebP image documents with configurable vision routing; unsupported/unavailable media goes to review without a strike. Video and audio are not analysed. The owner, known administrators, bots, anonymous admins and channel senders are exempt; a failed administrator lookup prevents enforcement.

Model lab imports Telegram Desktop JSON or normalized datasets, supports independent human labels, and saves comparisons with precision, recall, F1, threshold curves, usage, latency and reported cost. Imports and label edits make no model calls. Live moderation has its own daily token allowance; model-lab/replay calls have separate accounting and can incur uncapped provider charges. [Policy improvement](docs/policy-improvement.md) uses reasoned corrections, frozen evaluations, explicit owner approval and an Observe rollout. Publishing application code does not approve a policy or change existing moderation mode.

The [Telegram Mini App](docs/telegram-mini-app.md) reuses all saved data with signed owner authentication, native Back, themes, safe areas, authenticated images, and private bot-chat exports. Ordinary browser exports download locally. [Mobile layouts and themes](docs/mobile-and-themes.md) document all six responsive pages.

## Verify changes

```sh
npm run check                 # TypeScript, Workers/setup/runtime tests, frontend build
npm run test:setup            # Isolated setup/tooling tests
npm run test:runtime          # Portable Node adapter tests
npm run format:check
```

Optional PostgreSQL integration tests require a **disposable loopback database**. They clear test namespaces and must never target a live installation:

```sh
TEST_POSTGRES_URL=postgresql://test_user@127.0.0.1:5432/unspammed_test npm run check
```

`npm run test:fresh` copies the source without private deployment files, installs from the lockfile, and checks all six provider setup choices. Supply `TEST_POSTGRES_URL` to additionally initialize a new schema and exercise the production-only Node dependencies with browser and Telegram owner authentication. This clean-install check needs a disposable local database administrator able to create a temporary restricted role; it removes that role and schema afterward. Without the variable, database/runtime verification is explicitly skipped.

For Cloudflare, also run `npx wrangler deploy --dry-run --config wrangler.generated.jsonc` after setup. A dry run and local adapter checks establish build compatibility; they do not establish deployment, DNS, TLS, cron execution, device behavior or account permissions. Follow the [verification checklist](docs/deployment.md#verification-checklist) before enabling Enforce.

For Vercel adapter changes, run `npm run test:vercel` to build and execute the bundled Node handler locally. Provider-builder validation and actual hosted checks remain separate evidence.

See [architecture and extension contracts](docs/architecture.md), [portability implementation plan](docs/portability-plan.md), and [agent instructions](AGENTS.md) for future work.
