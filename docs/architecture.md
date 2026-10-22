# Architecture and extension contracts

Unspammed's application state and renewable work leases live in PostgreSQL. Host adapters provide HTTP, assets and scheduling; they reuse the same bot authentication, group registry, moderation, evaluation, policy and export handlers. Hosting must not change the meaning of a strike, a dataset label, an owner or a group boundary.

The current runtime is one owner per installation, with multiple registered groups. It powers self-hosted Unspammed installations. The planned Unspammed Bot commercial edition does not establish customer tenancy, subscriptions, checkout, entitlements or automatic provisioning; those require separate implementation and authorization. See [the edition contract](brand-and-editions.md).

| Component                                    | Contract                                                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `worker/index.ts`                            | Fetch-based routing, authenticated webhook/internal work, owner authorization, group selection and bounded scheduler entry points       |
| `worker/group.ts`                            | Group-scoped moderation, strikes, datasets, evaluations and policies; provider effects occur outside database transactions              |
| `worker/database.ts`, `worker/storage.ts`    | PostgreSQL connections, verified TLS, schema/namespace creation, parameterized queries, transaction fencing and durable leases          |
| `worker/directory.ts`                        | Owner-managed group discovery, permission checks, activation and namespace isolation                                                    |
| `worker/auth.ts`                             | Loopback-only local bypass, optional signed browser cookie, optional strict Cloudflare Access assertion validation, protected mutations |
| `worker/mini-app.ts`, `worker/html-shell.ts` | Telegram HMAC owner validation, bounded fixed-recipient exports, controlled portable HTML transformation and public asset allowlist     |
| `worker/telegram-admin.ts`                   | Optional owner-account login and explicitly requested per-user history cleanup                                                          |
| `server/`                                    | Node HTTP/assets, canonical public origin, persistent scheduler and PostgreSQL-backed admin-service adapter                             |
| `api/index.mjs`, `server/vercel.ts`          | Vercel bridge to the bundled Node handler and bounded authenticated cron processing                                                     |
| `scripts/setup*.mjs`                         | Private environment loading, validation, secret generation and provider configuration; no provider provisioning                         |
| `src/`                                       | Shared browser/Mini App React dashboard, authentication gate and authenticated API client                                               |
| `worker/local.ts`, local storage             | Isolated SQLite development/test adapter, never the production database default                                                         |

## Persistence and work

Webhook acknowledgement follows durable ingestion. Telegram retries a failed ingestion instead of losing a message. Pending classification, retries, action outbox, dataset/evaluation cursors, policy-improvement records and encrypted owner-account sessions survive process replacement through PostgreSQL.

A renewable lease serializes work per group. Fenced writes reject an expired worker's results after another worker takes over. Database transactions must remain short and must not contain model, Telegram or unrelated network calls. New hosting adapters must preserve this behavior across overlapping cron invocations and multiple replicas. They may schedule work more often; they must not rely on a timer alone to remember pending work.

`DATABASE_ROOT_CHAT_ID` fixes the schema namespace for an installation, falling back to the initial `TELEGRAM_CHAT_ID` for compatibility. Preserve the root namespace during upgrades. Additional groups use isolated prefixed tables inside that namespace. Group selection is server-validated against the owner-managed registry; a browser header is not permission to create or activate an arbitrary group.

Existing `WORKER_URL`, `PLANETSCALE_DATABASE_URL` and `PLANETSCALE_ADMIN_DATABASE_URL` remain aliases for portable URL inputs. PostgreSQL TLS behavior is explicit, not selected by matching a vendor hostname. Hyperdrive is a Cloudflare-specific optional transport binding. Do not infer a provider from an email, domain, port number, account ID or previously deployed resource.

New setup/runtime configuration uses `UNSPAMMED_*`, with corresponding `WATCHTOWER_*` aliases retained and the new name taking priority when defined. Request headers use `X-Unspammed-*`, with existing `X-Watchtower-*` aliases accepted for compatibility. The health response identifies the service as `unspammed`. The rebrand does not migrate `.watchtower/` private files, `watchtower_g…` database namespaces, saved browser state, cookie/signing identities, Compose service names or persistent database volumes. Treat those as compatibility contracts, not display copy; changing them needs an explicit migration and upgrade tests.

## Request and authentication boundaries

`PUBLIC_URL` is the canonical public HTTPS origin. Node/Vercel adapters construct application URLs from it instead of trusting arbitrary forwarded Host/Proto headers. A reverse proxy must preserve request paths, request bodies, credential headers, Origin and Set-Cookie. Keep the browser and its APIs same-origin; introducing cross-origin APIs requires an explicit authentication/CSRF design.

Public root/login and allowed built JS/CSS, favicon and theme bootstrap contain application code only. Source maps, environment files and unknown Mini App resources are not public routes. `htmlShell` transforms only the controlled Vite HTML document using deterministic string replacement and escaped environment attributes. It does not parse arbitrary user HTML and does not require Cloudflare HTMLRewriter.

The public asset allowlist uses exact script, stylesheet and modulepreload references from that controlled build document, plus the fixed theme bootstrap and favicon. It does not authorize a directory by file extension. Adding lazy chunks or new asset types requires extending the build manifest/allowlist deliberately and testing that unlisted files and source maps remain inaccessible.

Browser login exchanges the optional strong server token for a signed, expiring `__Host-` HttpOnly Secure SameSite cookie. The key derives from that token; rotation revokes existing sessions. The token is never a URL parameter or persistent frontend value. Cookie writes require same-origin Origin and the request-protection header. Optional Access validates issuer, audience, RS256 signature, expiry and owner email independently of the edge layer.

Mini App requests remain under `/mini/api/*` and use raw signed Telegram `initData` in a header. They do not accept browser cookies, claimed user IDs, Access headers or the local development bypass as substitutes. The ordinary browser API does not accept Telegram launch credentials. Public API method status reveals only configured authentication choices and whether the requester is authenticated.

Webhook, internal work and cron each use their own expected secret route contract; none uses owner browser cookies. Do not turn an upstream Access bypass into an authorization bypass inside the application. Preserve CSP, no-store and frame restrictions: only the Mini App allows Telegram's SDK and Telegram Web framing; the normal dashboard denies embedding.

## Add a hosting provider

1. Implement a thin Fetch/Response adapter with canonical URL handling, body bounds, abort/error handling and safe static serving. Reuse `createWorker`; do not fork moderation logic.
2. Supply PostgreSQL network/TLS settings and runtime-only credentials. Keep bootstrap/admin URLs and hosting API credentials local. Verify with a disposable database and a separate runtime role.
3. Provide at-least-minute durable work dispatch appropriate to the host's actual plan/lifetime. A persistent timer requires a running instance with CPU between requests; otherwise use authenticated, awaited scheduled invocations. Document shutdown, overlapping jobs, request/proxy limits, maximum run duration and restart recovery. Serverless background timers are insufficient.
4. For the optional Telegram owner-account service, supply `TELEGRAM_ADMIN_SERVICE` with the existing fetch contract or the Cloudflare Durable Object binding. Persist encrypted session/alarm state, serialize concurrent access and fit host TCP/lifetime limits.
5. Preserve all route authorization, mutation protection, group isolation, public asset restrictions and security headers. Test forged/non-owner Telegram launches, session expiry/rotation, Access audience/issuer checks and upstream redirects.
6. Add generic manifests and private setup outputs with no original account defaults. Document domain/TLS, cron and TCP constraints using current primary documentation.
7. Report local adapter verification separately from provider build validation and real test-account deployment in the [provider evidence register](provider-verification.md). An actual provider smoke must check HTTPS, webhook ingress, authenticated reads, durable scheduling/restart and optional account transport without destructive moderation or paid inference unless authorized. Verify larger import/export bodies against the provider and reverse proxy; a common adapter does not ensure feature parity across host limits.

New model providers belong behind the classifier's validated protocol/capability/usage interface. New storage systems require a real adapter implementing transaction, lease and fencing semantics; a renamed environment variable is not a storage port. New UI features should use existing authenticated APIs and work identically in normal browsers and Telegram where supported.
