# Setup

Install Watchtower. Do the steps in order.
Do only the steps for your host and sign-in method.

After install, Watchtower is in Observe mode. It logs decisions only.
Turn on Enforce later in Settings.

Screenshots show example data only.

## What you need

- A Telegram account. This account is the owner.
- A Telegram supergroup. You own this group.
- A PostgreSQL database.
- One host: Cloudflare, Railway, DigitalOcean, Vercel, Render, or Fly.io.
  Any VM or host that runs a Docker image or Node 22 also works (Section 5G).
- Node 22 or newer on your computer.

You do not need these things:

- A custom domain. The host gives a free HTTPS address.
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

1. Create a PostgreSQL database at any provider you like.
   All of these work with the same URL format: Neon, Supabase, PlanetScale Postgres, Aiven, Render Postgres, Railway Postgres, DigitalOcean Managed PostgreSQL, Amazon RDS, Google Cloud SQL, Azure Database for PostgreSQL, Crunchy Bridge, Xata, or Cloudflare Hyperdrive with your own PostgreSQL.
   PlanetScale also sells a MySQL product. That product does not work. Watchtower uses PostgreSQL SQL. Use PlanetScale Postgres, not PlanetScale MySQL.
   No database on a server yet? Section 5G runs PostgreSQL next to the app on one VM.
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

Railway, DigitalOcean, and Vercel give the address only after the first deploy. Deploy two times:

1. Put `PUBLIC_URL=https://example.com` in `.env` for now. Deploy once. Do not connect Telegram yet.
2. Copy the real HTTPS address from the host.
3. Put it in `.env` as `PUBLIC_URL`.
4. Run the setup command again with `--force`.
5. Import the new values. Deploy again.

Cloudflare: skip this. The address is known before deploy.

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

Note: Vercel stops requests larger than 4.5 MB. Very large exports need another host.

### 5E. Render

1. Run setup:

```sh
npm run setup -- --provider render
npm run setup:doctor
npm run database:setup
```

2. In Render: make a new Blueprint from your repository. It uses `render.yaml`.
3. Set the values Render asks for. Or import `.watchtower/runtime.env`.
4. Deploy. Copy the `onrender.com` address. Set it as `PUBLIC_URL`.
   Run setup again with `--force`. Import the values again. Deploy again.
5. Keep the service on a plan that does not sleep.

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
6. Keep at least one machine running. `fly.toml` already sets this.

### 5G. One VM on any cloud — 1-click style

Use this for a DigitalOcean Droplet, Google Compute Engine, Azure VM, AWS Lightsail or EC2, Hetzner, Linode, Vultr, or Oracle VM. The steps are the same on all of them. This is the pattern Discourse, Ghost, and n8n use: one Docker Compose file, not one image per cloud.

1. Make a Linux VM. Open ports 80 and 443 in its firewall.
2. Paste `deploy/vm/cloud-init.yaml` as the VM user data. Set your fork URL in it first.
   No user data field? Skip this. Do step 3 by hand.
3. SSH into the VM. Edit `/opt/watchtower/app.env`. Set the values from Step 4.
4. For a database on the same VM: set `POSTGRES_PASSWORD` and the bundled `DATABASE_URL` as shown in `deploy/vm/app.env.example`.
   For a hosted database: set the normal `DATABASE_URL`.
5. Run:

```sh
sh deploy/vm/install.sh
```

6. For automatic HTTPS: set your domain DNS to the VM (Step 6), then run:

```sh
WATCHTOWER_DOMAIN=your-domain docker compose --profile https up -d
```

Add `--profile bundled-db` too if you use the VM database. 7. Set `PUBLIC_URL` to the final HTTPS address. Generate the values again and restart:

```sh
docker compose up -d --build
```

No Node is needed on the VM. The install script uses a Node container to make the private values.
Cloud marketplaces (DigitalOcean Marketplace, Google Cloud Marketplace, Azure Marketplace, AWS Marketplace) need a vendor review before a listing. This repository gives you the same result now, without a listing.

The same `docker-compose.yml` also works in **Coolify** (add it as a Docker Compose resource). **Dokku** and **CapRover** use the `Dockerfile` and `Procfile` instead; give them the values from `.watchtower/runtime.env`.

### 5H. Container services: Cloud Run, Azure Container Apps, AWS

These hosts run the Docker image but stop it between requests. The minute timer does not run.

1. Build and push the `Dockerfile` image with your cloud's tool.
2. Run it as a service. Set the values from `.watchtower/runtime.env`. Set the port to 3000. Allow at least one always-on instance if the host offers it.
3. Make a scheduler in the same cloud: Google Cloud Scheduler, Azure Logic Apps, or Amazon EventBridge Scheduler.
   Every minute, send a `GET` request to `https://your-address/api/cron` with header `Authorization: Bearer YOUR_CRON_SECRET`.
   Use the `CRON_SECRET` from `.watchtower/runtime.env`.
4. Copy the service HTTPS address. Set it as `PUBLIC_URL`. Import the values again. Deploy again.

### 5I. Any other host

Run setup once to make the value files. Use one of the six provider names as a stand-in; the value files are the same:

```sh
npm run setup -- --provider railway
```

Run the `Dockerfile` in this repository.
Or run Node 22: `npm ci`, `npm run build`, then `npm start`.
Set the values from `.watchtower/runtime.env` in the host.
Give the app one public HTTPS address. Set it as `PUBLIC_URL`.
Keep the process running at all times.

Not supported: Netlify and static-only hosts. They cannot run the timer or the database connection.
MySQL and PlanetScale MySQL (Vitess) are also not supported. The app stores data with PostgreSQL SQL. Every PostgreSQL-compatible database above works.

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
Set `PUBLIC_URL` to the new address. Run setup again with `--force`. Deploy again. Do Step 7 again.

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

1. Run setup with this flag:

```sh
npm run setup -- --provider YOUR_HOST --browser-auth --force
# YOUR_HOST is one of: cloudflare, railway, digitalocean, vercel
```

On Cloudflare, upload `.watchtower/secrets.json` again. On other hosts, import `.watchtower/runtime.env` again.

2. Deploy again with the new values.
3. Open your app address in a browser.
4. Copy `BROWSER_AUTH_TOKEN` from `.env`.
   Setup does not print it. It is also in `.watchtower/runtime.env`.
5. Paste the token into the sign-in form. Select **Sign in**.

Save the token in a password manager. Do not put it in a link.
To sign out all users: change the token. Deploy again.

### Method C. Cloudflare Access (Cloudflare only)

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
4. Add a second Access application for only `/telegram/webhook`, `/mini`, and `/mini/*`.
   Give it a Bypass policy for everyone.
   Telegram must reach these paths with no Cloudflare login.
   The app still checks the Telegram signature and owner ID on each request.

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

3. Tap a message. You see the full text, score, and reason.

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
