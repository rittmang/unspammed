# Setup

Install Watchtower. Do the steps in order.
Do only the steps for your host and sign-in method.

New groups start in Observe mode. They log decisions only.
Choose Enforce later in Settings after reviewing results. Upgrades preserve existing mode and settings.

Screenshots show example data only.

## What you need

- A Telegram account. This account is the owner.
- A Telegram supergroup. You own this group.
- A PostgreSQL database.
- One host with an included template: Cloudflare, Railway, DigitalOcean App Platform, Vercel, Render, or Fly.io; or a Linux VM for a manual Compose install (Section 5G).
- Node 22.x on your computer.

Templates are not proof of deployment in each provider's test account. Check the [provider evidence register](provider-verification.md) for current validation and missing hosted checks. Other Docker/Node platforms need their own networking, scheduler and deployment verification.

You do not need these things:

- A custom domain on the six managed hosts above. Use their supplied HTTPS address. A VM needs a working HTTPS hostname or a separately configured HTTPS proxy.
- A model key. Add it later.
- Cloudflare Access. It is one sign-in option only.

## Step 1. Make the bot

1. Open Telegram. Go to [@BotFather](https://t.me/BotFather).
2. Send `/newbot`.
3. Give the bot a name. Give it a username. The username must end in `bot`.
4. BotFather sends a token. Save the token in a password manager.
   Do not share the token. Do not put it in Git.
5. Open a private chat with your bot. Send `/start`.

## Step 2. Prepare the group

1. Add the bot to your supergroup.
2. Make the bot an administrator.
   Give it **Delete messages** and **Ban users**.
3. Make your owner account an administrator in the same group.
4. Send one message in the group. You need this message in Step 4.

## Step 3. Get a database

1. Create a PostgreSQL database reachable from your application host. Managed PostgreSQL services such as Neon, Supabase or PlanetScale Postgres are candidates; they have not all been tested with Watchtower. Use the provider's connection/TLS instructions and verify permissions, transactions and persistence on your actual endpoint. Cloudflare Hyperdrive is an optional connection layer, not a database.
   MySQL/MariaDB and PlanetScale's MySQL/Vitess product are unsupported.
   For PostgreSQL on the same VM, see Section 5G.
2. Copy the connection URL. It looks like this:

```text
postgresql://user:password@host:5432/database
```

3. Keep TLS on. Watchtower checks the certificate by default.
   Turn TLS off only for a private network or a test database on your own computer.

## Step 4. Set your private values

On your computer:

```sh
npm ci
cp .env.example .env
```

Open `.env`. Set these values:

| Name                    | Value                                                        |
| ----------------------- | ------------------------------------------------------------ |
| `TELEGRAM_BOT_TOKEN`    | The token from BotFather (Step 1).                           |
| `TELEGRAM_BOT_USERNAME` | Optional. Your bot username, without `@`. Setup can find it. |
| `OWNER_TELEGRAM_ID`     | Your numeric Telegram user ID. Numbers only.                 |
| `TELEGRAM_CHAT_ID`      | Your supergroup ID. It starts with `-100`.                   |
| `DATABASE_URL`          | The PostgreSQL URL from Step 3.                              |
| `PUBLIC_URL`            | The HTTPS address of your app. See Step 5.                   |

Do not guess the IDs. To get the IDs:

1. Put only the bot token in `.env`.
2. Send a message in the group.
3. Run:

```sh
npm run telegram:discover
```

Check the result. The owner ID must be your account.
Do not use a username as an ID.

`.env` is private. Git ignores it. Do not paste it in an issue or log.

## Step 5. Choose a host

Do the steps for one host only.

If you do not know the host's assigned address until creating/deploying the service, deploy in two stages:

1. Put `PUBLIC_URL=https://example.com` in `.env` for now. Deploy once. Do not connect Telegram yet.
2. Copy the real HTTPS address from the host.
3. Put it in `.env` as `PUBLIC_URL`.
4. Run the setup command again with `--force`.
5. Import the new values. Deploy again.

For Cloudflare, choose the Worker name and account's `workers.dev` subdomain first. For Fly, reserve your own app name first. Do not register Telegram against the temporary placeholder.

### 5A. Cloudflare Workers

You need a Cloudflare account. Add these values to `.env`:

```dotenv
WATCHTOWER_PROVIDER=cloudflare
WATCHTOWER_NAME=your-unique-worker-name
CLOUDFLARE_ACCOUNT_ID=your-account-id
PUBLIC_URL=https://your-unique-worker-name.your-subdomain.workers.dev
```

Find `CLOUDFLARE_ACCOUNT_ID` in the Cloudflare dashboard, in the right column on the Workers page.
Find your `workers.dev` subdomain on the same page.

Then:

```sh
npm run setup -- --provider cloudflare
npm run setup:doctor
npm run database:setup
npm run build
npx wrangler login
npx wrangler deploy --dry-run --config wrangler.generated.jsonc
npx wrangler secret bulk .watchtower/secrets.json --config wrangler.generated.jsonc
npm run deploy
```

If Wrangler asks for a deploy first: deploy. Upload the secrets. Deploy again.
No custom domain or DNS change is needed. Hyperdrive is optional. A direct `DATABASE_URL` works.

### 5B. Railway

1. Run setup:

```sh
npm run setup -- --provider railway
npm run setup:doctor
npm run database:setup
```

2. In Railway: make a new project. Add a service from your GitHub repository.
   Railway uses the `Dockerfile` and `railway.json` in this repository.
3. Open **Variables**. Import the values from `.watchtower/runtime.env`.
   Do not import `DATABASE_ADMIN_URL`.
4. Deploy.
5. Open **Networking**. Generate a domain. Copy the HTTPS address.
6. Put it in `.env` as `PUBLIC_URL`. Then:

```sh
npm run setup -- --provider railway --force
```

7. Import `.watchtower/runtime.env` again. Deploy again.
8. Keep the service running. Do not let it sleep.
   The app checks for new work every minute inside the service.
   Do not add a Railway Cron service for this app.

### 5C. DigitalOcean App Platform

1. Run setup:

```sh
npm run setup -- --provider digitalocean
npm run setup:doctor
npm run database:setup
```

2. Open `.do/app.yaml`. Set your GitHub owner, repository, and branch.
3. In DigitalOcean: create an app from this repository with the `.do/app.yaml` spec. It makes one **web service**. Do not use a static site.
4. Add the values from `.watchtower/runtime.env` as encrypted runtime variables.
5. Deploy. Copy the HTTPS address of the app.
6. Put it in `.env` as `PUBLIC_URL`. Then:

```sh
npm run setup -- --provider digitalocean --force
```

7. Import the values again. Deploy again.
8. If your database blocks unknown addresses, add the app to the database trusted sources.

A Droplet also works: run the Docker image, or `npm ci`, `npm run build`, then `npm start`. Keep it running. Put HTTPS in front of it.

### 5D. Vercel

You need a Vercel plan that allows cron jobs every minute. The free Hobby plan does not.

1. Run setup:

```sh
npm run setup -- --provider vercel
npm run setup:doctor
npm run database:setup
```

2. In Vercel: import this repository as a project. Set the Node version to 22.
3. Open **Settings → Environment Variables**. Add the values from `.watchtower/runtime.env` to **Production** only.
4. Deploy. Copy the stable production HTTPS address.
   Do not use a preview address for the bot.
5. Put it in `.env` as `PUBLIC_URL`. Then:

```sh
npm run setup -- --provider vercel --force
```

6. Import the values again. Deploy again.

Vercel limits both function requests and responses to 4.5 MB, below Watchtower's larger export allowance. Large browser downloads need another host or a separately implemented download path. Optional Telegram owner-account transport also needs provider testing. See [Vercel constraints](hosting.md#vercel).

### 5E. Render

1. Run setup:

```sh
npm run setup -- --provider render
npm run setup:doctor
npm run database:setup
```

2. In Render: make a new Blueprint from your repository. It uses `render.yaml`.
3. Copy the requested values from `.watchtower/runtime.env`, including the generated webhook and cron secrets. Import the complete runtime file as service variables so optional browser/session/TLS settings are retained too.
4. Deploy. Copy the `onrender.com` address. Set it as `PUBLIC_URL`.
   Run setup again with `--force`. Import the values again. Deploy again.
5. Keep the service on a plan that does not sleep for continuous minute processing. Render Free passed hosted function/database/restart checks, but its 15-minute idle spin-down interrupts the in-process scheduler. See the [evidence register](provider-verification.md).

### 5F. Fly.io

1. Run setup:

```sh
npm run setup -- --provider fly
npm run setup:doctor
npm run database:setup
```

2. Install `flyctl`. Run `fly auth login`.
3. Open `fly.toml`. Set your app name and region.
4. Run:

```sh
fly launch --no-deploy
fly secrets import < .watchtower/runtime.env
fly deploy
```

5. Copy the `fly.dev` address. Set it as `PUBLIC_URL`.
   Run setup again with `--force`. Import the secrets again. Deploy again.
6. Keep at least one machine running. `fly.toml` already sets this. Account verification may require a credit card: the verified test account could not create any Machine without one. The documented trial's five-minute forced stop also prevents demonstrating continuous scheduling; see the [evidence register](provider-verification.md).

### 5G. Linux VM: manual installation

The Compose files are intended for a Linux VM with Docker Compose v2. They have not been deployed to every VM provider. Cloud firewalls, VM images, SSH and user-data support differ by provider.

1. Create a VM and configure SSH access. Allow public HTTP/HTTPS ports 80/443 for the proxy, keeping PostgreSQL and the app's port private.
2. For an Ubuntu/Debian image supporting cloud-init, replace the repository placeholder in `deploy/vm/cloud-init.yaml` and use it as cloud-init user data. It prepares the checkout only. On other images, install Docker/Compose and clone your repository manually.
3. SSH in and change to the checkout (the example uses `/opt/watchtower`). Copy `deploy/vm/app.env.example` to ignored `app.env` if needed. Set the bot/owner/group values and final `PUBLIC_URL`. Keep this file private.
4. For external PostgreSQL, set `DATABASE_URL` and leave `COMPOSE_PROFILES` empty unless using Caddy. For bundled PostgreSQL, set `COMPOSE_PROFILES=bundled-db`, leaving `DATABASE_URL` and `DATABASE_SSL_MODE` blank on first install; setup generates separate administrator/application passwords and a restricted application role. For Caddy HTTPS, set `WATCHTOWER_DOMAIN`, point that hostname's DNS to the VM, make `PUBLIC_URL=https://your-hostname`, and add `https` to the profiles (`COMPOSE_PROFILES=bundled-db,https` for both). The bundled database uses a Docker volume: plan backups outside the VM.
5. Run the installer from the checkout using the commands below. It generates private runtime values, builds the image, initializes the schema and starts the selected services.

```sh
sudo sh deploy/vm/install.sh
```

After changing `PUBLIC_URL` or other private inputs, rerun the installer so derived runtime values are regenerated before restarting. Preserve existing browser/session keys. Follow its health-check output, then continue to Step 7 after public HTTPS works. No local Node installation is needed on the VM; the installer uses a Node container.

For later status/log/stop commands, pass the generated private Compose file: `docker compose --env-file .watchtower/compose.env ps`. Changing a password in `app.env` does not rotate the password inside an existing database volume.

This is a scripted manual install. It is not a cloud marketplace listing or one-click provisioning. Coolify, Dokku and CapRover are candidate image/Compose integrations and require their own validation.

### 5H. Other container services

Cloud Run, Azure Container Apps and AWS ECS can run containers, but this repository does not include a complete tested deployment for them. They can keep instances running with the right CPU/scaling settings. A sleeping configuration needs a separate scheduler integration; merely building the image does not supply one.

Use the [container extension requirements](hosting.md#other-container-platforms) to evaluate networking, public webhooks, TLS, CPU, minute dispatch and request lifetime. Do not treat EventBridge Scheduler as an arbitrary authenticated HTTP caller. Choose an included template above if you need the existing setup steps.

### 5I. Any other host

For an experienced operator integrating a different persistent Node host, setup can generate the runtime values using an existing Node target:

```sh
npm run setup -- --provider railway
```

Run the `Dockerfile` in this repository.
Or run Node 22: `npm ci`, `npm run build`, then `npm start`.
Set the values from `.watchtower/runtime.env` in the host.
Give the app one public HTTPS address. Set it as `PUBLIC_URL`.
Keep a process running with CPU available between requests, or implement awaited authenticated minute dispatch. Test the host separately before relying on it.

Netlify has server functions, scheduled functions and PostgreSQL support, but Watchtower has no Netlify adapter. Static-only hosts cannot run this backend. MySQL/MariaDB and PlanetScale MySQL (Vitess) have no storage adapter. See the [support inventory](provider-verification.md).

## Step 6. DNS — only if you want your own domain

Skip this step if you use the host address.

The registrar and the DNS host can differ. Check the nameservers first.
Change DNS only at the DNS host.

| Your case                                                | What to do                                                                                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| No own domain                                            | Do nothing. Use the host address.                                                                                           |
| DNS at a registrar or Route 53, app on Railway/DO/Vercel | Add the exact CNAME, A, and TXT records your host shows you. Use a subdomain, for example `moderation.example.com`.         |
| DNS at Cloudflare, app on Railway/DO/Vercel              | Add the same records in Cloudflare DNS. Keep the proxy off (DNS only) until the site works.                                 |
| App on Cloudflare Workers                                | In Cloudflare, add the domain as a Worker Custom Domain in a zone you own. Cloudflare makes the record and the certificate. |

Do not copy IP addresses or IDs from another install.
Wait until the host shows the domain as active and HTTPS works.
Set `PUBLIC_URL` to the new address. Run setup again with `--force` and deploy again. For the VM path, edit `app.env` (and `WATCHTOWER_DOMAIN` for Caddy), then rerun `sudo sh deploy/vm/install.sh` instead. Do Step 7 again using that installation's credentials.

## Step 7. Connect Telegram

Your app must be online first. Check:

```sh
curl https://your-app-address/health
```

It must answer `{"ok":true,"service":"watchtower"}`.

Then:

```sh
npm run setup:check
npm run telegram:setup
npm run telegram:mini-app
npm run telegram:mini-app -- --check
```

For the VM installer path, run these commands **on the VM from its checkout** instead. They use the deployed runtime values, including the secrets generated there:

```sh
sudo docker compose --env-file .watchtower/compose.env exec watchtower node scripts/setup.mjs --provider railway --check
sudo docker compose --env-file .watchtower/compose.env exec watchtower node scripts/telegram-setup.mjs
sudo docker compose --env-file .watchtower/compose.env exec watchtower node scripts/telegram-mini-app.mjs
sudo docker compose --env-file .watchtower/compose.env exec watchtower node scripts/telegram-mini-app.mjs --check
```

The `railway` name selects the shared Node setup check; it does not deploy to Railway. Do not register using a different desktop `.env` whose webhook secret differs from the VM's.

`telegram:setup` sets your app as the Telegram webhook. It keeps pending messages.
`telegram:mini-app` adds an **Open dashboard** button to your private chat with the bot. It changes nothing else.

## Step 8. Sign in

Choose one method, or more.

### Method A. Telegram (smallest setup)

1. Open your private chat with the bot.
2. Tap **Open dashboard**.

The app checks the signed Telegram data and your owner ID on each request.
No other account can sign in.

![Sign-in page on a phone, light theme](screenshots/sign-in-light-390.png)

### Method B. Browser token

Use this to sign in from a normal browser.

For the VM path, the installer already enables browser-token sign-in. Read `BROWSER_AUTH_TOKEN` privately from that VM's `app.env` or `.watchtower/runtime.env`, save it in your password manager, and enter it on the HTTPS sign-in page. Do not generate a separate token on your desktop. To change it later, edit the VM's `app.env` and rerun `sudo sh deploy/vm/install.sh`. The following npm/import steps apply to the other hosting paths.

1. Run setup with this flag:

```sh
npm run setup -- --provider YOUR_HOST --browser-auth --force
# YOUR_HOST is one of: cloudflare, railway, digitalocean, vercel, render, fly
```

On Cloudflare, upload `.watchtower/secrets.json` again. On other hosts, import `.watchtower/runtime.env` again.

2. Deploy again with the new values.
3. Open your app address in a browser.
4. Copy `BROWSER_AUTH_TOKEN` from `.env`.
   Setup does not print it. It is also in `.watchtower/runtime.env`.
5. Paste the token into the sign-in form. Select **Sign in**.

Save the token in a password manager. Do not put it in a link.
To sign out all users: change the token. Deploy again.

### Method C. Cloudflare Access (optional upstream service)

1. In Cloudflare Zero Trust, make an Access application for your app address.
   Allow only your email address. Copy its audience tag.
2. Set these values in `.env`:

```dotenv
ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
ACCESS_AUD=your-audience-tag
ADMIN_EMAIL=you@example.com
DASHBOARD_URL=https://your-app-address
```

3. Run setup again with `--force`. Deploy again.
4. If Access covers the whole hostname, configure narrowly scoped applications for `/telegram/webhook`, `/mini`, and `/mini/*`, plus `/internal/work`, `/api/cron` and `/health` where used. Each required path must reach the app without a browser login. Keep ordinary browser APIs protected. The application still requires each route's own credential. Follow the [Access path instructions](hosting.md#optional-cloudflare-access).

Access can sit in front of another application host; DNS hosting and application hosting are independent. Its configuration and upstream headers must be verified on that host.

### Local test only

`npm run dev` signs you in automatically at `127.0.0.1`. Local use only.
Hosted setup turns this off.

## Step 9. Check the result

Open the dashboard. You see the Overview page.
The group is in Observe mode. This is correct.

![Overview on a phone, light theme](screenshots/overview-light-390.png)
![Overview on a phone, dark theme](screenshots/overview-dark-390.png)

1. Send a test message in your group.
2. Wait one minute. Open **Messages**. The message must be there.

![Messages on a phone, light theme](screenshots/messages-light-390.png)

3. Tap a message to inspect its text. Scores and reasons require a configured model key and completed classification; installing/importing without a key does not perform inference.

![Message detail on a phone, dark theme](screenshots/message-detail-dark-390.png)

4. Open **Settings**. Add your model key when you are ready.

![Settings on a desktop, dark theme](screenshots/settings-dark-1440.png)

5. Keep Observe on. Read some results.
   Turn on **Enforce** in Settings only when the results are right.

More screens: [all screenshots](screenshots/).

## Optional steps

### Add a model key

In **Settings**, open the provider section and add your key. Keys are saved on the server, not in the browser.
For a custom OpenAI-compatible provider, set `MODEL_PROVIDERS_JSON` in `.env`. See the example in `.env.example`.

### Add a second group

1. Add the bot to the new supergroup. Make it an administrator, as in Step 2.
2. In the dashboard, select **Add or manage groups**.
3. Check the permissions. Activate the group. It starts in Observe.
   Do not change `DATABASE_ROOT_CHAT_ID` for an existing install.

### Delete all old messages of one user (owner account)

Use your own Telegram account, not the bot.

1. Go to [my.telegram.org/apps](https://my.telegram.org/apps). Make an app. Copy the API ID and API hash.
2. Put `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` in your private `.env` file.
3. Run: `npm run telegram:admin:configure -- --new-session-key`
   Use `--new-session-key` only for a fresh install with no saved sessions. To keep saved sessions, restore the old `TELEGRAM_SESSION_KEY` in `.env` first, and run the command without the flag.
4. Import the values from `.watchtower/admin-secrets.json` into your host. Deploy again.
5. In **Strike history**, select **Connect account**. Follow the steps on screen.
6. Confirm each user. The app does not delete on its own.

![Strike history on a phone, light theme](screenshots/strike-history-light-390.png)

## Problems

| Problem                          | Fix                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| Sign-in page shows no options    | Deploy first. Then do Step 8 again for your method.                                               |
| Token sign-in fails              | Copy `BROWSER_AUTH_TOKEN` from `.env`. Deploy again after `--browser-auth` if you did not.        |
| Bot does not reply / no messages | Run `npm run setup:check`. Check the bot admin rights. Run `npm run telegram:setup` again.        |
| Health check fails               | Check the host is running and `PUBLIC_URL` is the exact HTTPS address.                            |
| DNS change does not work         | Edit DNS where the nameservers point. Wait. Check the host shows the domain as active.            |
| Database error about TLS         | Use the certificate settings of your database provider. Do not turn TLS off on a public database. |

## More documents

- [Mobile layout and themes](mobile-and-themes.md)
- [Telegram Mini App details](telegram-mini-app.md)
- [Hosting reference](hosting.md)
- [Deployment checks](deployment.md)
- [Provider evidence and research corrections](provider-verification.md)
