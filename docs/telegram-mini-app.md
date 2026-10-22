# Telegram Mini App

Watchtower reuses its dashboard, APIs, and saved data inside Telegram. Open the bot's private chat and choose **Open dashboard**. The server admits only `OWNER_TELEGRAM_ID`; a menu button's visibility is convenience, not authorization.

The same application supports Telegram owner authentication on every host, with optional browser-token or Cloudflare Access sign-in for normal browsers. An unsigned visit to `/mini/` shows only the configured choices. Browser links open a separate tab so they also work from Telegram Web's frame. A valid Telegram launch opens the dashboard directly. Cloudflare Access is not required.

By default, the Mini App uses `PUBLIC_URL/mini/` on your application host (legacy `WORKER_URL` is supported). A host-supplied HTTPS domain is sufficient. It can also use a custom domain; optional Access needs the narrowly scoped exceptions below. No separate Mini App deployment, database or Telegram user-account login is required. Start with the [complete hosting guide](hosting.md).

## Platform research

Checked against Telegram's primary documentation on 2026-10-20. Availability depends on the Telegram client and API version; newer methods must be feature/version checked. The [Mini App API](https://core.telegram.org/bots/webapps), [client integration reference](https://core.telegram.org/api/bots/webapps), and [bot features](https://core.telegram.org/bots/features#mini-apps) describe these capabilities.

| Capability                                                                   | Watchtower decision                                                                                                 |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Owner-specific chat menu                                                     | Implemented using `setChatMenuButton`.                                                                              |
| Main/profile app and `?startapp` links                                       | Available through BotFather; optional for this private dashboard.                                                   |
| Named app links, inline/keyboard buttons, inline mode, join-request launches | Other entry points; not required for the owner menu.                                                                |
| Attachment-menu integration                                                  | Production eligibility is restricted to major Telegram advertisers.                                                 |
| Signed launch identity                                                       | Implemented, verified on the server.                                                                                |
| Live themes and native chrome                                                | Implemented using the existing palette.                                                                             |
| Expansion, viewport and safe areas                                           | Implemented, including older-client fallbacks.                                                                      |
| Native Back button and external links                                        | Implemented.                                                                                                        |
| Native main/secondary/settings buttons, popups and haptics                   | Available; existing dashboard controls remain sufficient.                                                           |
| File imports                                                                 | Existing browser file picker and streamed importer.                                                                 |
| Native HTTPS downloads                                                       | Available; requires an accessible file URL. Private exports use bot documents instead.                              |
| Cloud/device/secure storage and biometrics                                   | Available; no additional credential storage needed here.                                                            |
| Write/contact/chat-selection permission prompts                              | Available; no additional permissions requested.                                                                     |
| QR scanning, clipboard, location, motion and orientation                     | Available with client/launch/permission limits; unrelated to moderation.                                            |
| Sharing messages, stories, emoji status and home-screen shortcuts            | Available; optional extensions.                                                                                     |
| Payments, Stars subscriptions and gifts                                      | Available; no billing added. Digital purchases use [Telegram Stars](https://core.telegram.org/bots/payments-stars). |

A Mini App does not acquire the owner's Telegram account privileges or arbitrary chat history. Launch context does not authorize a selected group. Full-history cleanup still uses the existing, separately connected admin account and per-user confirmation. `sendData` is a keyboard-launch feature, not a replacement for authenticated dashboard API calls. Message sharing and posting require the corresponding Telegram flows; nothing is published automatically.

## Implemented behavior

All six dashboard pages, workspace switching, labels, feedback, policy approval, model controls, settings, image inspection and strike actions use the existing server handlers. Telegram launch parameters are consumed before routing; the initial page is Overview. Native Back closes the topmost supported dialog/drawer or returns to Overview. Telegram activation events stop polling while minimized and refresh on return.

**System** follows Telegram's light/dark preference inside the Mini App. Explicit Light/Dark choices still take precedence. Native header/background/bottom-bar colors follow the dashboard palette. Older clients receive supported header-color values. Telegram's viewport and safe-area CSS variables keep content clear of system and Telegram controls.

Exports explicitly requested inside the Mini App are uploaded as JSON documents to the configured owner's private bot chat. The recipient cannot be supplied by the browser. The upload limit is **20,000,000 bytes** to bound Worker memory. Export errors remain visible and uploads are not automatically replayed. For larger exports, choose **Open in browser** and use the normal authenticated dashboard. Ordinary browser exports still download locally. File imports retain the existing streamed upload path. No export is sent during deployment verification.

## Authentication and hosting

`/mini/`, its JS/CSS files, theme bootstrap and favicon are public application code. Source maps, unknown resources and all application data remain protected. The shell contains no bot token, provider key, Telegram admin session, or saved moderation data. Opening the bare URL outside Telegram shows configured sign-in choices and does not load group data. Root and `/login` also serve public application code, while their private APIs require owner authentication.

Every `/mini/api/*` request carries raw Telegram `initData` in a header. The Worker independently derives the HMAC key from the bot token, validates the complete signed payload, rejects duplicate/ambiguous fields, requires a safe numeric user ID, and compares it with `OWNER_TELEGRAM_ID`. It accepts launch data for one hour, with at most 30 seconds of future clock skew. Expiry requires closing and reopening the Mini App. A valid payload is a bearer credential during that period; it is not a single-use token. It must never be copied into logs, URLs, persistent application settings, or support messages. `initDataUnsafe`, a claimed user-ID header, cookies, and local `DEV_MODE` never grant Mini App access. No new application session is issued.

Mini App requests retain same-origin write protection and group-registry checks. Image requests fetch authenticated bytes before displaying a revocable blob URL. The normal browser API accepts its configured signed browser cookie or strict Access authorization; Telegram credentials are accepted only by the Mini App API. Private exports additionally require a protected POST and always target the owner.

Only the Mini App shell permits the official `https://telegram.org/js/telegram-web-app.js` script and framing by `https://web.telegram.org`. The ordinary browser/login shell retains `frame-ancestors 'none'` and `X-Frame-Options: DENY`. This scoped change enables Telegram Web without making the browser dashboard embeddable elsewhere. The SDK is Telegram's supported client bridge, not a framework dependency. [Launch validation](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app), [menu API](https://core.telegram.org/bots/api#setchatmenubutton).

## Configuration

Set the existing bot token and owner ID, plus these public variables:

```json
{
  "TELEGRAM_BOT_USERNAME": "your_bot_username",
  "PUBLIC_URL": "https://your-host-supplied-domain.example",
  "DASHBOARD_URL": "https://your-host-supplied-domain.example"
}
```

Deploy first, then run with Node 22.x:

```sh
npm run telegram:mini-app             # Set and read back only the owner's private-chat menu
npm run telegram:mini-app -- --check  # Read-only verification
npm run telegram:mini-app -- --reset  # Restore that owner's default menu
```

The script reads credentials from the process environment, `WATCHTOWER_ENV_FILE`, `.env`, or legacy `.dev.vars`, checks bot identity and the owner's private chat, and never changes the global menu or webhook. If Telegram cannot find that chat, the owner must first open the bot and send `/start`. An optional profile-wide Launch app button can be configured in BotFather with the same `/mini/` URL; server authorization remains owner-only regardless of who sees it. This release uses the owner-specific menu and does not send BotFather commands.

### Use an optional Access-protected custom domain

For an installation at `https://moderation.example.com`, keep these routes on the **same deployed Worker**:

- `https://moderation.example.com/`: normal browser dashboard, protected by the existing Access application and its owner-email Allow policy.
- `https://moderation.example.com/mini/`: Mini App shell and sign-in choices; `/mini/api/*` requires signed Telegram owner credentials on every request.
- A separate public origin, if configured: webhook and scheduled group dispatch. `PUBLIC_URL` can stay on that reachable host. If they share the Access hostname, also exempt their exact machine routes as described in the [hosting guide](hosting.md#optional-cloudflare-access).

In Cloudflare Zero Trust → Access → Applications, add a **separate self-hosted application** covering exactly `moderation.example.com/mini` and `moderation.example.com/mini/*`. Give only this new application a **Bypass → Include → Everyone** policy. Include both paths because the wildcard does not cover its parent. Keep the existing whole-host owner-email application and its audience tag unchanged. Do not attach the Bypass policy to that existing application or include `/api/*`.

Cloudflare applies the more-specific path application's policy before the whole-host policy. This allows Telegram requests to reach the Worker's existing signature and owner checks; it does not grant access to moderation data. Root dashboard requests still go through Cloudflare login. See [application path precedence](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/) and [path-scoped bypass setup and required permissions](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/#bypass-a-public-endpoint), checked 2026-10-21.

After configuring Access, set the menu URL locally and read it back:

```sh
MINI_APP_URL=https://moderation.example.com/mini/ npm run telegram:mini-app
MINI_APP_URL=https://moderation.example.com/mini/ npm run telegram:mini-app -- --check
```

`MINI_APP_URL` is an optional setup-script setting in your private environment file or process environment. It must use HTTPS and end in `/mini/`, without credentials, a query or a fragment. When absent, the script uses `PUBLIC_URL/mini/` (legacy `WORKER_URL` also works). The script checks for an anonymous HTTP 200 before changing the menu; an Access login redirect fails with setup guidance. `--reset` can still restore the default menu when the site is unavailable. `DASHBOARD_URL` supplies the browser URL. Set it to an Access-protected origin only when Access is configured; otherwise it can be your normal public app origin with optional token login. Browser choices follow configured authentication methods.

Before switching the bot menu, verify that `/mini/` returns 200, unsigned `/mini/api/overview` returns 401, signed owner requests succeed, and `/` and `/api/overview` still require Access. Also verify `/mini`, Mini App assets, source-map rejection, forged/non-owner rejection, and the Cloudflare login button. To return the menu to the host-supplied domain, rerun setup with `MINI_APP_URL` set to `PUBLIC_URL/mini/`; the existing deployment and data are reused.

## Verification

Run `npm run check`, `npm run test:setup`, `npm run test:runtime`, and `npm run format:check` before deployment. For Cloudflare, also run `npx wrangler deploy --dry-run --config wrangler.generated.jsonc` after generating your own config. Dedicated tests sign launch data independently with Node crypto and exercise the real Workers Web Crypto verifier: valid owner, non-owner, different bot, modified/expired/future/duplicate/malformed data, missing configuration, local-bypass rejection, protected routes, group isolation, CSRF, authenticated images, restricted assets, bounded exports, fixed recipients and sanitized failures. Client tests cover API/header routing, exports, expiry, theme precedence and older native clients.

Browser checks should use the real Telegram SDK with isolated signed test launch data, phone/tablet/desktop sizes, theme/activation/safe-area/Back events, and the production build on the target adapter. Portability is checked locally; it does not prove that another hosting account has been deployed successfully. Test file import, image loading, labels, settings, group selection and native export requests against isolated state or mocked Telegram delivery. Confirm ordinary browser behavior too. Synthetic launch data and emulated native events verify the integration contract; final physical-device behavior still depends on the installed Telegram client. Deployment/version, live read checks and actual bot menu read-back belong in [deployment status](deployment.md).
