# Unspammed editions and pricing status

**Unspammed** is the project and product name, formerly Watchtower. The public marketing website is [unspammed.rittmang.xyz](https://unspammed.rittmang.xyz), with a separate private marketing repository. The application source repository is [github.com/rittmang/unspammed](https://github.com/rittmang/unspammed).

Public navigation, calls to action, setup guides, metadata and illustrations use **Unspammed**. The marketing primary action is **Get started**. The edition names below are reference terminology, not alternate public product branding or generic bot defaults.

| Edition           | Intended use                                                                                           | Price and current status                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unspammed Bot** | Planned hosted service associated with the claimed [@unspammedbot](https://t.me/unspammedbot) username | **US$5/month placeholder.** No launched checkout, subscription billing, customer provisioning or payment enforcement is implemented. The claimed username alone does not establish a configured or running service. |
| **Naaradmuni**    | Self-hosted edition of Unspammed; install the software using your own bot and infrastructure           | You arrange and pay your hosting, PostgreSQL and model-provider charges. Installation does not subscribe you to Unspammed Bot. Follow the [self-hosted setup guide](setup.md).                                      |

The hosted price is an editorial placeholder for product planning, not an available purchase or a promise about included groups, model usage, taxes, limits, support or service levels. Those terms remain undecided. Do not add purchase buttons that imply working checkout or represent the self-hosted runtime as a completed multi-customer service.

The application currently authorizes one owner per installation and can manage multiple registered groups for that owner. Group selection is not customer tenancy or billing authorization. A commercial hosted launch needs a separate customer/account model, subscription and entitlement handling, onboarding, operations and verified Telegram configuration.

Each self-hosted installation supplies its own bot token, numeric owner and group IDs, database, host and model credentials. The original owner's Naaradmuni bot remains that owner's installation. Neither it nor `@unspammedbot` is a default username or credential for other installations. The new hosted bot needs its own token and deliberate webhook/menu configuration before it can operate.

The rebrand preserves existing installation credentials, the stable database root namespace, saved data, browser signing keys and encrypted Telegram sessions. New configuration uses `UNSPAMMED_*`; corresponding `WATCHTOWER_*` names remain compatibility aliases. Private generated files still use `.watchtower/`, and database namespaces and persistent Compose identities retain their installed names. Historical verification records retain the actual names, builds and resource identities observed at the time.
