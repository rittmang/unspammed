# Portable installation plan

The original deployment worked, but its checked-in hostname, owner, group, Hyperdrive binding, database provider restriction, Access-only browser login, and Worker-only scheduling prevented a clean installation elsewhere.

## Configuration contract

- One installation has one Telegram owner and an initial supergroup. Additional groups use the existing registry and isolated tables. Never infer a new owner's identity from another deployment.
- Required external inputs: a Telegram bot token, owner and group IDs, a PostgreSQL connection, and a public HTTPS origin. A model provider credential is needed before live model inference. Hosting-provided domains avoid any DNS requirement.
- `PUBLIC_URL` and `DATABASE_URL` are provider-neutral names. Existing `WORKER_URL` and `PLANETSCALE_DATABASE_URL` remain supported for upgrades. Runtime and schema-administrator credentials remain separate.
- Setup generates application secrets locally, excludes them from source control and public configuration, and preserves existing configuration on reruns.
- Telegram Mini App authentication validates signed launch data against the configured bot and owner. Optional browser authentication uses a generated token or Cloudflare Access. Public static shells never grant API access.

## Implementation work

1. Replace provider-specific database validation with generic PostgreSQL and verified TLS by default. Permit explicit private-network TLS configuration, retain Hyperdrive, and preserve existing schemas and data.
2. Share request handling between Workers, a persistent Node process, and a Vercel Node function. Give each runtime an explicit scheduling adapter with bounded, awaited work and existing database leases.
3. Persist optional Telegram admin sessions and alarms outside Workers without weakening serialization or encryption.
4. Provide a setup generator, environment validation, safe Telegram configuration, deployment templates, and separate guides for each hosting stack and DNS-provider choice.
5. Document the extension contract and human-only setup steps in `AGENTS.md` and the setup guides.

## Acceptance checks

| Area           | Required evidence                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh setup    | Isolated source copy with no existing credentials; generated config uses only supplied fixture identities; reruns preserve secrets             |
| Database       | Real disposable PostgreSQL schema initialization and rerun; existing application integration tests; generic TLS validation                     |
| Authentication | Forged, expired, missing, and non-owner Telegram data rejected; browser session and CSRF protection; Access path retained                      |
| Runtime        | Node and Vercel adapter requests, static serving, webhook protections, cron authentication, bounded scheduling, persistent admin state         |
| Hosting        | Templates and commands validated locally; provider prerequisites and paid-plan limits stated; distinguish local checks from actual deployments |
| Upgrade        | Existing production configuration saved locally; legacy environment names and migrations retained; no production-data resets                   |

Live accounts on additional providers are not provisioned as part of local verification. Provider guides must identify any remaining account-side steps and must not claim deployments that were not performed. The [provider evidence register](provider-verification.md) separates implemented templates from local checks, provider builds and actual test-account deployments; generic container and managed PostgreSQL candidates remain unverified until tested individually.
