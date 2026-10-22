# Naaradmuni hosting, DNS and Telegram setup

> New install? Use the **[setup guide](setup.md)**. It has the steps in order, with screenshots.
> This page is the reference for limits, TLS, and provider details.

This guide sets up Naaradmuni, Unspammed's self-hosted edition, from a fresh checkout. You supply and pay for your bot, infrastructure and model usage. The smallest installation is a Telegram bot, its owner and supergroup, PostgreSQL, and one public HTTPS application host with background scheduling. A model key is needed for classification/evaluation, but can be added after the site works. A custom domain and Cloudflare Access are optional. The planned Unspammed Bot hosted edition and its US$5/month placeholder are described in [editions and pricing status](brand-and-editions.md); these instructions do not provision that service.

The repository includes shared request handlers plus Cloudflare, persistent Node, and Vercel adapters. The [provider evidence register](provider-verification.md) separates templates, local tests, provider builds and actual test-account deployments. [Deployment operations](deployment.md) defines the verification checklist; [the original deployment archive](deployment-history.md) is historical context, not configuration to copy.

## Prepare Telegram and PostgreSQL

1. Create a bot with [@BotFather](https://t.me/BotFather), save its token privately, and note its username without `@`.
2. Open a private chat with the bot and send `/start`. Add it to your **supergroup** as an administrator with **Delete messages** and **Ban users / restrict members**. Your owner account must also be an administrator. Administrators receive group messages; verify privacy mode/permissions if messages are missing. [Telegram FAQ](https://core.telegram.org/bots/faq#what-messages-will-my-bot-get).
3. Obtain your numeric Telegram user ID and numeric supergroup ID beginning `-100`. Before registering the webhook, put the bot token in ignored `.env`, send a group message, and run `npm run telegram:discover`. Check that the selected owner really is your account. Usernames are not durable authentication identities. Discovery preserves pending updates and does not establish ownership for you.
4. Provision PostgreSQL on a host you choose. Use the provider's connection URL and certificate instructions. The application requires direct TCP PostgreSQL access or Cloudflare Hyperdrive. It does not require PlanetScale, a specific region, or a specific pooled port.

For PostgreSQL TLS, the default `DATABASE_SSL_MODE=verify-full` verifies the server certificate. Node hosts accept an optional PEM root through `DATABASE_SSL_CA`. Direct Cloudflare connections use the driver's Workers socket transport, which cannot install that custom CA; setup rejects this combination. Use a publicly trusted database certificate, or configure custom trust at Hyperdrive's origin connection instead. A hosted test confirmed that the private-CA endpoint failed in Workers while Node accepted it; the same Workers connection passed after switching to a publicly trusted certificate. [Workers socket TLS surface](https://github.com/cloudflare/workerd/blob/main/src/cloudflare/internal/sockets.d.ts).

Use `DATABASE_SSL_MODE=disable` only for an intentionally private network or disposable loopback database where you have chosen plaintext transport. Do not disable verification to hide a certificate error on a public database. Keep connection passwords out of shell history and logs.

Unspammed uses one schema, normally `watchtower_g` followed by the initial group ID without `-`. The initial group also supplies the stable root namespace unless `DATABASE_ROOT_CHAT_ID` is explicitly set. Preserve that namespace for an existing installation; adding groups does not require changing it. Additional group tables receive separate prefixes and their own settings, jobs and data.

`npm run database:setup` adds schema/tables without resetting saved data. Prefer running it as the runtime role so that role owns its tables and can apply later additive schema changes. If the role cannot create a schema, an administrator can create just the schema first (`CREATE SCHEMA "watchtower_g1001234567890" AUTHORIZATION "your_runtime_role";`), then run setup using the runtime connection.

Alternatively, configure a **local-only** `DATABASE_ADMIN_URL` for bootstrap. If admin and runtime roles differ, explicitly grant the runtime role `USAGE, CREATE` on the application schema, existing table/sequence privileges, and appropriate default privileges for future objects. Grants alone do not confer table ownership for future `ALTER TABLE` migrations; run those upgrades through the owning role or transfer application-object ownership deliberately. The script cannot infer the correct role or silently grant it administrator privileges. For example, after replacing these identifiers with your own:

```sql
GRANT USAGE, CREATE ON SCHEMA "watchtower_g1001234567890" TO "your_runtime_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "watchtower_g1001234567890" TO "your_runtime_role";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA "watchtower_g1001234567890" TO "your_runtime_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA "watchtower_g1001234567890" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "your_runtime_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA "watchtower_g1001234567890" GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO "your_runtime_role";
```

Run default-privilege grants as the role that creates future objects, or use `FOR ROLE` explicitly. Run application checks with the runtime connection afterward. Never deploy the admin connection. Existing PlanetScale PostgreSQL URLs remain supported through legacy aliases. Use the provider's explicit direct/DDL endpoint for `DATABASE_ADMIN_URL` when bootstrap needs one; setup must not infer a different port from a vendor hostname. Database outages are not a reason to discard history.

## Generate private configuration

Install Node 22.x and dependencies, then create your local private input file:

```sh
npm ci
cp .env.example .env
```

Fill in at least:

```dotenv
PUBLIC_URL=https://your-host-supplied-domain.example
DATABASE_URL=postgresql://your_runtime_role:YOUR_PASSWORD@your-db-host:5432/your_database
DATABASE_SSL_MODE=verify-full
TELEGRAM_BOT_TOKEN=YOUR_BOTFATHER_TOKEN
TELEGRAM_CHAT_ID=-1001234567890
OWNER_TELEGRAM_ID=123456789
TELEGRAM_BOT_USERNAME=your_bot_username
```

These are placeholders, not usable account defaults. Reserve or deploy a basic service on the host first if you need its assigned hostname. Keep the host URL stable before registering Telegram endpoints. `PUBLIC_URL` must be an HTTPS origin without credentials, path, query or fragment. `DASHBOARD_URL` optionally supplies a separate browser hostname; `MINI_APP_URL` optionally chooses the owner's menu URL and must end in `/mini/`.

```sh
npm run setup -- --provider cloudflare
# Alternatives: --provider railway, digitalocean, vercel, render, or fly
# Add --browser-auth if you want token-based browser sign-in.
npm run setup:doctor
npm run database:setup
```

Setup generates 32-byte webhook and cron secrets when absent. `--browser-auth` also generates a 32-byte URL-safe owner token. It fills missing values in the private input file, preserves existing credentials, and writes ignored, owner-readable `.watchtower/runtime.env`, `.watchtower/secrets.json`, and `.watchtower/setup.json`. Cloudflare additionally receives `wrangler.generated.jsonc`. No resources, databases, DNS records, webhook registrations or bot menus are changed by generation. If inputs change, review them and regenerate outputs with `--force`; the flag does not rotate existing input credentials.

Process environment values take precedence. `UNSPAMMED_ENV_FILE` selects an explicit private file (legacy `WATCHTOWER_ENV_FILE` is a fallback); otherwise setup tools use `.env`, then legacy `.dev.vars`. New examples use `UNSPAMMED_*`; corresponding `WATCHTOWER_*` aliases remain supported, with the new name taking priority when defined. Private `.watchtower/` outputs, the `watchtower_g…` schema namespace and existing Compose service/volume names remain stable for upgrades. Use separate environment files and bots for test and production. Never paste an entire environment file into an issue or support log. Import runtime variables using the host's secret/environment settings; exclude the admin database URL and hosting API credentials.

## Choose your host

Provider facts below were checked against primary documentation on **2026-10-21**. Limits, prices and plan features can change; verify the linked documentation before selecting a plan. Build artifacts and local tests do not prove deployment in another provider's environment.

| Included target           | Runtime and scheduler                                         | Requirements                                                                                                            |
| ------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Workers        | Shared Worker; minute Cron Trigger plus daily cleanup trigger | Your own account/Worker, reachable PostgreSQL or optional Hyperdrive; optional Durable Object for owner-account cleanup |
| Railway                   | Docker/Node web service; built-in minute timer                | Running service, reachable PostgreSQL, supplied HTTPS domain; no separate Railway cron                                  |
| DigitalOcean App Platform | Docker/Node web service; built-in minute timer                | Routable persistent web service; the supplied spec is not a Functions or static-site adapter                            |
| Vercel                    | Node function; authenticated minute cron                      | Appropriate cron plan, 300-second configuration, PostgreSQL TCP, 4.5 MB request/response ceiling                        |
| Render                    | Node Docker service; `render.yaml`                            | Non-sleeping service, reachable PostgreSQL; import all generated runtime values                                         |
| Fly.io                    | Node Docker Machine; `fly.toml`                               | Keep a Machine running; supplied config disables autostop; reachable PostgreSQL                                         |
| Linux VM                  | Compose app, optional PostgreSQL and Caddy files              | Manual server/firewall/HTTPS setup; Ubuntu/Debian cloud-init example; backups for a bundled database                    |

These are implementation choices, not a claim that every row has been deployed. Consult the [evidence register](provider-verification.md) before relying on a host. Cloud Run, Azure Container Apps, ECS, Coolify, Dokku, CapRover and Heroku are candidate integrations using the same Node image; this repository has no complete provider-specific provisioning/scheduler validation for them. Netlify has Functions, PostgreSQL and scheduled functions, but no Unspammed adapter. Static-only hosting cannot run this backend.

`DATABASE_URL` accepts PostgreSQL connections. Neon, Supabase, PlanetScale Postgres and other managed PostgreSQL products are candidates, not a claim that every endpoint was tested. Check network/IP support, TLS roots, role privileges and transaction/lease behavior using the chosen connection mode. The adapter uses transaction-scoped advisory locks and qualified tables; it does not require a session-scoped lock, but that does not verify every pooler. MySQL, MariaDB and PlanetScale MySQL (Vitess) are unsupported. SQLite remains the isolated development/test adapter.

### Cloudflare: minimum setup

You can use `workers.dev` with Telegram owner authentication and no DNS changes, custom domain or Access application. Cloudflare assigns a Workers subdomain within your account. [workers.dev domains](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).

Add these private setup inputs using your account details:

```dotenv
UNSPAMMED_PROVIDER=cloudflare
UNSPAMMED_NAME=your-unique-worker-name
CLOUDFLARE_ACCOUNT_ID=YOUR_32_CHARACTER_ACCOUNT_ID
PUBLIC_URL=https://your-unique-worker-name.your-subdomain.workers.dev
```

Generate the configuration and initialize PostgreSQL as above. Authenticate Wrangler to your own account and review the generated Worker name/account before publishing:

```sh
npx wrangler login
npm run build
npx wrangler deploy --dry-run --config wrangler.generated.jsonc
npx wrangler secret bulk .watchtower/secrets.json --config wrangler.generated.jsonc
npm run deploy
```

If Wrangler requires the Worker to exist before secret upload, perform the first code deploy, upload secrets, then redeploy; private APIs and Telegram ingestion fail closed while configuration is incomplete. The `npm run deploy` wrapper uses your generated config and refuses to silently deploy the checked-in generic template. The template is a starting point; historical installation settings remain separate.

Production data live in PostgreSQL. Hyperdrive is optional and must be created in your own account before setting `HYPERDRIVE_ID`. Disable Hyperdrive query caching for transactional application state and configure origin certificate verification. Direct `DATABASE_URL` connections work without Hyperdrive. [Hyperdrive configuration](https://developers.cloudflare.com/hyperdrive/configuration/).

Workers Free has a 10 ms CPU allowance per invocation, including short-interval cron processing. PostgreSQL avoids the old local SQLite production quota, but does not remove CPU, request, connection or provider quotas. A passing local test cannot promise a free plan will sustain your dataset/workload. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

### Railway

Choose `--provider railway`. Connect your own repository, use the checked-in `railway.json` and `Dockerfile`, and import `.watchtower/runtime.env` as service variables. Generate a public domain in **Networking**, set `PUBLIC_URL` to it, regenerate derived outputs as needed, and redeploy. The service binds the host's `PORT` and serves both the dashboard and API from one origin. Railway provides HTTPS and generated domains; no custom DNS is required. [Public networking](https://docs.railway.com/networking/public-networking).

Run the service continuously so its built-in scheduler can drain pending work each minute. Railway's separate cron product has a five-minute minimum and skips a new run while a previous one is still running; it does not provide this app's normal minute cadence. The default web-service scheduler uses PostgreSQL leases for overlapping work. Do not enable both independent schedulers accidentally. [Railway cron constraints](https://docs.railway.com/cron-jobs).

A database in a private Railway network may require explicit `DATABASE_SSL_MODE=disable` when that endpoint does not offer TLS; apply that only to the intended private connection. Public database endpoints retain verified TLS. Keep at least one service replica awake; sleeping/scaled-to-zero services have no active in-process scheduler. No persistent filesystem volume is needed for application state or encrypted Telegram sessions, which live in PostgreSQL.

### DigitalOcean App Platform

Choose `--provider digitalocean`, replace the repository/branch placeholders in `.do/app.yaml`, and create an App Platform **web service** from your repository using its Dockerfile. Import `.watchtower/runtime.env` as encrypted runtime variables. Use the assigned HTTPS app domain for `PUBLIC_URL`, regenerate configuration when needed, and redeploy. Configure the database's trusted sources and certificate according to its network settings. App Platform supports provider-supplied domains and optional custom domains. [Domain setup](https://docs.digitalocean.com/products/app-platform/how-to/manage-domains/).

The persistent Node service runs the minute scheduler. App Platform now also offers scheduled jobs, but their minimum interval is 15 minutes and jobs are not routable; that separate product cannot replace the minute web-service scheduler. A static-site deployment cannot accept Telegram webhooks or run the database-backed API. [Jobs and scheduling](https://docs.digitalocean.com/products/app-platform/how-to/manage-jobs/).

A Droplet/container host is another deployment of the same Node adapter: supervise `npm start`, terminate HTTPS at a reverse proxy, pass a trusted canonical `PUBLIC_URL`, and keep the process running. This repository's App Platform manifest does not provision or secure a Droplet for you.

### Render, Fly.io and Linux VMs

Render's Blueprint uses the Docker image as a web service. Supply the complete `.watchtower/runtime.env`, including generated webhook/cron values and existing browser/session keys. Render Free spins down after 15 idle minutes, stopping the timer; select a non-sleeping instance. The Blueprint does not create a database unless you deliberately configure its documented database block. [Render Free limits](https://render.com/docs/free).

Fly uses `fly.toml`, the same Docker image, and imported runtime secrets. Its supplied configuration disables autostop; keep a running Machine for scheduling. [Fly configuration](https://fly.io/docs/reference/configuration/).

The [VM instructions](setup.md#5g-linux-vm-manual-installation) require SSH, private inputs and an HTTPS endpoint. The installer selects `UNSPAMMED_VM_ENV` (or legacy `WATCHTOWER_VM_ENV`), then `UNSPAMMED_ENV_FILE` (or legacy `WATCHTOWER_ENV_FILE`), then `app.env`. The cloud-init file is an Ubuntu/Debian example, not a tested template for every cloud. Neither Compose nor cloud-init is a marketplace listing or one-click deployment.

### Other container platforms

Do not assume every container platform stops between requests. Cloud Run can allocate CPU between requests using instance-based billing with minimum instances; Azure Container Apps can keep minimum replicas; ECS services can keep desired tasks running. A persistent configuration can use the Node timer. A scale-to-zero/request-only CPU configuration requires external minute dispatch with `UNSPAMMED_SCHEDULER=false`, awaited `/api/cron` calls and the application cron secret. This is an integration contract, not a ready-to-deploy recipe. [Cloud Run billing/CPU](https://docs.cloud.google.com/run/docs/configuring/billing-settings), [Azure scaling](https://learn.microsoft.com/en-us/azure/container-apps/scale-app), [ECS scaling](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-auto-scaling.html).

The external scheduler must reach public Telegram/webhook routes, preserve separate application authentication, and wait for bounded work. Provider IAM authentication may require additional headers/integration. EventBridge Scheduler does not directly target arbitrary HTTPS URLs; an AWS relay or other integration is needed. EventBridge API Destinations have a five-second timeout, so they are not a drop-in caller for longer awaited work. Check this integration and provider/proxy timeouts before describing that platform as verified. [Scheduler targets](https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-targets-universal.html), [API Destinations](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-api-destinations.html).

### Vercel

Choose `--provider vercel`. Import the repository and `.watchtower/runtime.env` into **Production** environment settings, use Node 22, and retain the supplied `vercel.json`. `npm run build:vercel` builds the frontend plus a bundled server handler for the `api/index.mjs` bridge, and includes `dist/` inside the Node function. The static output contains only the already-public favicon. Application requests route through the function so authentication and Mini App headers run before responses. Do not publish the dashboard as an unauthenticated static `dist/` deployment.

Use the production deployment's stable HTTPS domain as `PUBLIC_URL`; previews must not register the production bot webhook or run production jobs. Database access uses the **Node runtime** and PostgreSQL TCP, not Vercel Edge. Bound database connections, provider calls, MTProto calls and work chunks must fit the configured function lifetime. The adapter persists work/session/alarm state in PostgreSQL; it cannot depend on a process remaining alive after a request. [Node runtime](https://vercel.com/docs/functions/runtimes/node-js).

The supplied manifest schedules `/api/cron` every minute and sets `maxDuration: 300`. Vercel authenticates cron through `Authorization: Bearer CRON_SECRET`; the application checks that secret independently. **Vercel Hobby's built-in cron is limited to once per day**, so it cannot deploy this minute-cron configuration. Use a plan supporting minute scheduling. To use a separately managed external scheduler, remove the built-in minute cron entry first and arrange authenticated minute calls yourself; confirm your plan's function-duration allowance too. [Cron usage and plan limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).

The current function limits page lists a 300-second maximum on Hobby with Fluid Compute and up to 800 seconds on Pro/Enterprise; older non-Fluid deployments have different limits. The repository deliberately sets 300 seconds. Vercel does not automatically retry failed cron invocations; durable cursors let the next successful invocation resume. [Function limits](https://vercel.com/docs/functions/limitations), [cron management](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

Vercel also limits function request/response payloads to **4.5 MB**, below some Unspammed import/export limits. Keep each upload/request and browser download within the host limit; an application-level limit does not override it. Large browser exports require a persistent Node/Worker host or a separately implemented object-storage download path. Telegram document delivery happens server-to-server, but still must fit the function's memory and time budget. [Payload limits](https://vercel.com/docs/functions/limitations).

Optional Telegram owner-account cleanup opens MTProto TCP connections. Node supports this transport, but connection startup, Telegram data-center redirects and cleanup must fit function lifetime and networking limits. Treat real account connection/cleanup on Vercel as requiring its own provider smoke test. A successful adapter test or successful Bot API call does not verify MTProto behavior there.

## DNS and custom domains

**Application hosting and DNS hosting are separate decisions.** Cloudflare DNS can point at Railway, DigitalOcean or Vercel without making the application a Cloudflare Worker. Likewise, a provider-supplied domain works without a domain you own. Start with the supplied HTTPS hostname and add a custom domain later if useful.

For a custom domain, add it in the application host first, then create exactly the DNS records that host supplies at your authoritative DNS provider. Do not copy another installation's IP address or resource ID. Wait for domain verification and a valid HTTPS certificate before changing `PUBLIC_URL`, webhook or menu URLs. Railway may require both CNAME and TXT verification records; follow its generated values. [Railway networking](https://docs.railway.com/networking/public-networking), [DigitalOcean domains](https://docs.digitalocean.com/products/app-platform/how-to/manage-domains/), [Vercel domains](https://vercel.com/docs/domains/working-with-domains/add-a-domain).

For Cloudflare Worker custom domains, configure `CLOUDFLARE_CUSTOM_DOMAIN` with your hostname in a zone you control, regenerate the Worker config, and deploy. HTTPS must work for `/health`, `/mini/`, webhook and scheduler routes. A custom domain does not supply authentication by itself.

| Your DNS situation                                                                    | Setup action                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No domain, any supported host                                                         | Use the host's assigned HTTPS hostname. No DNS account or record changes are needed.                                                                                                                               |
| External DNS (for example Route 53 or a registrar's DNS), Railway/DigitalOcean/Vercel | Keep your nameservers. Add the host's supplied CNAME/A and verification TXT records in the authoritative DNS console. A subdomain such as `moderation.example.com` avoids apex CNAME restrictions.                 |
| Cloudflare DNS, Railway/DigitalOcean/Vercel                                           | Add the host's exact records in Cloudflare DNS. Start with DNS-only during verification; adding Cloudflare's proxy is a separate networking choice with host-specific certificate and timeout behavior.            |
| Cloudflare Worker custom domain                                                       | Add the hostname through the Worker's Custom Domains configuration in a Cloudflare zone you own. Cloudflare manages its DNS record and certificate. A CNAME to somebody's `workers.dev` address is not equivalent. |

The registrar where a domain was purchased may differ from its authoritative DNS provider. Check the domain's nameservers before editing records. Do not replace nameservers merely to deploy to Railway, DigitalOcean or Vercel. Worker custom domains require the Cloudflare zone setup; retaining external authoritative DNS involves Cloudflare's separate partial/subdomain setup and its eligibility requirements, outside this project's automatic setup. Using `workers.dev` avoids that requirement. [Worker custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [partial zones](https://developers.cloudflare.com/dns/zone-setups/partial-setup/setup/), [verification records](https://developers.cloudflare.com/dns/proxy-status/use-cases/), [Railway domain/proxy behavior](https://docs.railway.com/networking/domains/working-with-domains).

After a hostname change, update the private URL inputs, regenerate derived config, deploy, and run `setup:check` before registering the webhook and owner menu again. Retain the original database namespace and secret keys. Verify both browser sign-in and Mini App access on the new host before retiring the old hostname.

## Owner sign-in

### Telegram only: no browser token or Access required

The minimum setup uses `TELEGRAM_BOT_TOKEN` and `OWNER_TELEGRAM_ID`. Every `/mini/api/*` request verifies signed Telegram launch data, its age and the exact owner ID. The public root and `/mini/` show only configured sign-in choices and contain no moderation data or credentials. The owner menu launches the dashboard. Configure `TELEGRAM_BOT_USERNAME` so the public page can link to the bot.

Bare `/mini/` without a real Telegram launch does not authenticate. Claimed user-ID headers, browser cookies and Cloudflare assertions cannot substitute for Mini App launch data. A menu button is convenience; server authorization restricts access even if others know the URL. See [Mini App security](telegram-mini-app.md).

### Optional portable browser token

Use setup's `--browser-auth` to generate a secret from at least 32 random bytes. Keep `BROWSER_AUTH_TOKEN` in the server secret store and the owner's password manager. The owner submits it only in the HTTPS sign-in form. It must never appear in a URL, query string, HTML, API response, local/session storage, logs, analytics or committed files.

The server derives an HMAC session-signing key from the token and issues a 12-hour `__Host-` cookie with `HttpOnly; Secure; SameSite=Strict; Path=/`. Requests use the cookie, not the original token. Browser-cookie mutations and login/logout require a matching Origin plus `X-Unspammed-Request: 1` (legacy `X-Watchtower-Request: 1` remains accepted). Sign out clears the current browser cookie. Replace `BROWSER_AUTH_TOKEN` and redeploy to revoke **all** existing sessions; previously copied cookies remain valid until expiry or rotation. There is no per-session server revocation database.

### Optional Cloudflare Access

Configure all three values together: `ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com`, `ACCESS_AUD` from your self-hosted application, and `ADMIN_EMAIL` for the one owner email. The application independently validates the signed assertion's issuer, audience, expiry, RS256 signature and exact owner email. A claimed email header is never authentication. Keep `DASHBOARD_URL` pointing at the Access-protected browser origin so the optional Cloudflare button reaches login. [Assertion validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

Access is an upstream login layer: requests blocked there never reach Unspammed. If an Access application covers the entire hostname, give required machine routes narrowly scoped policies or use a separate unprotected origin:

- `/mini` **and** `/mini/*`: reach the Mini App shell and signed owner API without an Access redirect.
- `/telegram/webhook`: reach the bot-secret-checked webhook.
- `/internal/work`: reach secret-authenticated group work dispatch when that origin is used.
- `/api/cron`: reach `CRON_SECRET`-authenticated external/Vercel cron when used.
- `/health`: permit anonymous health checks if needed by your host/check script.

Do not bypass the entire browser `/api/*` path just to make one machine endpoint work. Create separate more-specific Access applications for those exact paths and Bypass → Include → Everyone, while keeping the browser application's owner-only Allow policy. Cloudflare gives the more-specific application precedence. Unspammed still checks each route's own credential after the bypass. Include `/mini` separately from its wildcard child path. [Path precedence](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/).

To keep a public root sign-in shell while using Access, the simplest layout is a public app origin plus an optional Access-protected browser hostname. Both must route to the same deployment; register the browser hostname as `DASHBOARD_URL`. If instead Access protects the whole hostname, its login screen will precede Unspammed's public shell and may also block token sign-in there. Decide that intentionally.

## Register Telegram after deployment

Deploy first and confirm an anonymous HTTPS `/health` returns 200. Then:

```sh
npm run setup:check
npm run telegram:setup
npm run telegram:mini-app
npm run telegram:mini-app -- --check
```

The read-only check verifies bot/owner permissions and health before changing external configuration. Webhook setup verifies permissions, registers `/telegram/webhook` with a generated secret, and preserves pending updates. Telegram cannot complete an upstream browser login. Its webhook must reach the application and present its independent secret. [Webhook parameters](https://core.telegram.org/bots/api#setwebhook).

The menu script verifies the owner's private chat and anonymous `/mini/` reachability, changes only that owner's menu, and reads it back. It does not change the global menu or webhook. Use `--reset` to restore that owner's default menu. `MINI_APP_URL` overrides the default `PUBLIC_URL/mini/`; no additional app deployment is required. The owner must send `/start` first if the bot cannot find the private chat. A profile-wide Main App button through BotFather is optional.

If Telegram cannot resolve a newly created hostname, first inspect real DNS/certificate propagation. `TELEGRAM_WEBHOOK_IP` can temporarily select a current IPv4 address of your own host using Telegram's documented override; never copy an archived edge IP. Rerun registration without the override after propagation.

Finally open the dashboard, choose **Check Telegram**, keep Observe enabled, add provider credentials when ready, and review representative labelled results before choosing Enforce. Existing Observe decisions are not retroactively enforced.
