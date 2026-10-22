# Mobile browser layout and color themes

The dashboard supports phone, tablet and desktop browsers, and the same owner-only [Telegram Mini App](telegram-mini-app.md). Phone pages use a shared summary-to-detail pattern: show the current state or a short preview first; expand an item for full data and controls. This is implemented by `src/Disclosure.tsx`, using native keyboard-accessible details/summary elements. Opening a section does not discard unsaved edits or list filters. Telegram Back closes the most recently opened section before leaving the page.

| Page / view               | Initial phone view                                                                        | Details and actions                                                                                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview                  | Moderation state, four compact counts, recent messages                                    | Expand counts for their definitions, and charts/policy for activity and escalation details. Tap a message for the full decision.                                                                                                                                 |
| Message feed              | Search, status filter, export and compact message rows                                    | Tap a row for original full text, sender, timestamp, score, reason, model, IDs, labels, feedback and moderation. Closing returns to the same list position.                                                                                                      |
| Strike history            | Searchable people, strike count, ban state and last-seen date                             | Expand a person for their Telegram ID, exact timestamp, cleanup history, reset/unban and full-history cleanup. Running/failed cleanup stays visible in the summary. Cleanup confirmation is preserved. Admin account setup and the action log expand separately. |
| Model lab / comparisons   | Dataset selection, collapsed configuration and concise run summaries                      | Expand a run for all accuracy, usage, cost and latency fields, export/resume/cancel and run selection. Expand configuration for models, sample size, prompt and threshold.                                                                                       |
| Model lab / scored review | Compact scored-message previews and human labels                                          | Expand a message for original text/context, label buttons, feedback and model decisions. Expand Review options for model selection, filters, search, sort and blind review. Blind review removes decision hints from summaries too.                              |
| Model lab / datasets      | Compact examples and current labels                                                       | Expand an example for complete text, sender context, label controls and feedback. Imports, exports, capture, deletion and pagination remain available.                                                                                                           |
| Policy improvement        | Current state, progress and the next action                                               | Expand stages, proposed changes, instructions and version history. All checks, full policy text, restore actions and errors remain available. Approval stays explicit.                                                                                           |
| Settings                  | Sections with the current mode, policy size, model, image state, retention and exemptions | Expand the section to edit. Unsaved edits stay mounted when collapsed. Save remains available; invalid fields automatically reveal their section. Connections expand separately.                                                                                 |

All six pages are reachable through the compact header's navigation button. The drawer scrolls on short screens, closes after page/group selection, and supports a close button, backdrop, Escape and keyboard focus containment. Page changes start at the top. Current page and group remain visible in the header. Group management uses compact expandable group summaries and separate connection instructions/defaults. Message details, group management and setup guides share full-screen phone dialogs with a sticky close control. Appearance, provider status and Mini App export/browser guidance live in the drawer.

Message and example previews normalize whitespace and clamp to two lines, preventing blank lines or long text from creating oversized rows. Expanded content preserves original text and wraps unbroken strings. Phone records do not require sideways scrolling to reach decisions or actions. Desktop retains its comparison, review and strike tables; major settings and overview sections start expanded on desktop.

Phone inputs/selects/textareas use at least 16px type, with 44px control heights. Message reading text uses 15–16px type; secondary metadata is smaller. Message detail screens fill the available viewport, scroll independently and keep the close button visible. Safe areas and Telegram viewport changes are respected. All data changes use the existing authenticated APIs; these layout changes add no dependencies or database changes.

## Color themes

Choose **System**, **Light**, or **Dark** under **Appearance** in the navigation menu. System follows the browser preference, or Telegram's native theme inside the Mini App. Explicit choices persist across reloads and groups; if storage is unavailable, the current selection still works.

Both modes use the existing olive, lime and terracotta palette. Semantic variables in `src/styles.css` cover surfaces, text, controls, status colors, charts and dialogs; native controls follow `color-scheme`. `public/theme.js` restores preferences before paint through a same-origin script that preserves the Content Security Policy.

## Verification

Use Node 22.x:

```sh
npm run check
npm run format:check
npx wrangler deploy --dry-run
```

Review every page above, including the dataset and scored-review tabs, at 320, 390, 650, 768 and 1440 CSS pixels in both themes and in browser/Mini App modes. Check both collapsed summaries and expanded content. Use realistic messages, multiline spam, emoji, long names, complete/running/failed cleanup jobs, multiple saved runs and proposed policy/history data.

Check reading density as well as overflow: at 390 × 844 the header occupies one row, at least four message previews fit in the feed, and at least six strike summaries fit without showing IDs or action buttons in every row. Settings should show a section index rather than a wall of fields. Recent messages precede secondary overview charts. Every summary and action must remain usable with touch and keyboard.

Exercise strike search, expansion, reset/cleanup confirmation, account login and action-log retry; feed filters/search/pagination and full-message inspection; dataset and scored-review labels/feedback, run details and blind review; settings saves and invalid collapsed fields; policy stages/proposed changes/history/instructions; group switching/setup, exports, drawer focus and native Back. Verify theme persistence, safe areas, viewport changes, full text preservation and list position restoration. Use isolated data for mutations and mock Telegram delivery. Physical client testing depends on available devices; report that separately from SDK event simulation. Deployment results are recorded in [deployment status](deployment.md).
