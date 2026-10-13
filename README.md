# Morning Agent

Local, macOS-first morning briefing CLI. Deterministic TypeScript code owns orchestration and action policy; the decision provider supplies narrow typed decisions only.

## Website and downloads

The project landing page is published at [shauryajain07.github.io/morning-agent](https://shauryajain07.github.io/morning-agent/). The [source ZIP](https://github.com/shauryajain07/morning-agent/archive/refs/heads/main.zip) is a Node.js project archive, not a signed macOS installer. See the [getting started guide](https://shauryajain07.github.io/morning-agent/getting-started.html) before connecting any accounts. The source is available for noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE).

## Commands

```sh
npm install
npx playwright install chromium
npm run morning -- --mock
npm run morning -- --mock --dry-run --verbose
npm test
npm run typecheck
npm run build
```

By default, live decisions use the local Laya-MLX runtime when `LAYA_MLX_ENABLED=true`. Set `LAYA_MLX_ENABLED=false` to use the existing TypeSafe Jev provider (`TYPESAFE_API_KEY`), or set `LAYA_MLX_FALLBACK_TO_TYPESAFE=true` to explicitly allow that provider as a fallback. Without either provider, use `--mock` to run the complete offline fixture workflow.

## Local Laya-MLX decisions

Laya-MLX is used only for typed `choice`, `score`, and `noul` decisions. The application keeps its existing labels, confidence fields, response contracts, action policy, and deterministic briefing text. It does not use Laya-MLX to generate chat replies, emails, prose, or arbitrary JSON; no existing Jev feature in this repository requires text generation.

The Node adapter starts the supplied Python environment lazily and keeps one local worker/model instance alive for a morning run. Configure it in `.env`:

```sh
LAYA_MLX_ENABLED=true
LAYA_MLX_MODEL=aac6fef/laya-mlx
LAYA_MLX_DTYPE=float16
LAYA_MLX_DEVICE=gpu
LAYA_MLX_BATCH_SIZE=16
LAYA_MLX_CHECKOUT=/absolute/path/to/laya-mlx
LAYA_MLX_PYTHON=/absolute/path/to/laya-mlx/.venv/bin/python
```

Inference runs locally on Apple Silicon through MLX. The model is expected in Hugging Face's local cache; model weights are external artifacts and must not be committed to Git. If the cache needs to download from Hugging Face, set `HF_HUB_DISABLE_XET=1` before running the application.

The existing urgency labels (`today`, `soon`, `later`, `none`) are represented to the model as an ordered `score` rubric and mapped back to the same application output. Email/news/course classification remains `choice`, and yes/no questions remain `noul`.

Run the optional real-model example after the cache is available:

```sh
LAYA_MLX_INTEGRATION=true npm test -- tests/layaMlx.test.ts
```

State is stored in `.data/morning-agent.sqlite` by default. Set `MORNING_AGENT_DB_PATH` to override it.

## Gmail collection

Gmail is collected through the Gmail API with a read-only OAuth scope. Configure either a refresh-token credential set or standard Google OAuth JSON files in `.env`:

```sh
GMAIL_ENABLED=true
GMAIL_CLIENT_ID=your-oauth-client-id
GMAIL_CLIENT_SECRET=your-oauth-client-secret
GMAIL_REFRESH_TOKEN=your-refresh-token
GMAIL_LOOKBACK_HOURS=24
GMAIL_MAX_MESSAGES=500
```

`GMAIL_ACCESS_TOKEN` is supported for a short-lived token. Alternatively, set `GMAIL_CREDENTIALS_PATH` and `GMAIL_TOKEN_PATH` to the OAuth client and token JSON files. A Google API key alone cannot read a private mailbox. With no `GMAIL_QUERY`, the collector lists recent Gmail messages, fetches their full read-only MIME payloads, reads supported text attachments, records attachment metadata, and applies the exact lookback window using Gmail's received timestamp; use `GMAIL_QUERY="is:unread newer_than:1d"` to restrict it to unread mail. If `GMAIL_MAX_MESSAGES` is reached, the saved Gmail page cursor continues on the next run. A message with an unreadable date is retained with its raw date text for classification. It never modifies labels, marks mail read, sends, replies, archives, or deletes.

For a new setup, download Google’s desktop OAuth `credentials.json`, place it at `.gmail-credentials.json`, set `GMAIL_TOKEN_PATH=.gmail-token.json`, and run `npm run gmail:login`. A browser consent screen opens locally, requests only `gmail.readonly`, and saves the refresh token in the ignored token file. Then set `GMAIL_ENABLED=true` and run the normal dry run.

## Moodle collection

Moodle is collected through a read-only Playwright adapter because it does not provide the needed API. Copy the Moodle settings into `.env`, for example:

```sh
MOODLE_ENABLED=true
MOODLE_BASE_URL=https://your-moodle.example/my/
MOODLE_BROWSER_PROFILE=.browser-profile
```

The first run opens a persistent Chromium profile and waits up to five minutes for you to complete Moodle, SSO, and MFA in that window. The collector never receives credentials and never submits forms. It discovers every course-view link exposed on the dashboard (not only the five local folder mappings), reads same-origin course pages, then visits bounded resource, folder, assignment, quiz, and workshop detail pages. Assignment pages contribute their full visible page text and deadline context; file links retain available filename and MIME metadata. `MOODLE_LOGIN_TIMEOUT_MS`, `MOODLE_NAVIGATION_DELAY_MS`, `MOODLE_SETTLE_DELAY_MS`, `MOODLE_MAX_COURSE_PAGES`, and `MOODLE_MAX_DETAIL_PAGES` control the wait and bounds. When a cap or individual page failure leaves work pending, the dashboard reports partial coverage and the saved cursor continues those URLs on the next run. `MOODLE_CDP_URL` can be used instead when an already-running Chromium session is available. The browser tab is closed after collection and the attached browser itself is left open.

Moodle accessibility skip links are ignored. If the dashboard exposes both MATH1851 sections, the collector uses the `MATH1851_1AB`/AB course for its files and activities.

The browser layer is deterministic: it navigates only to the configured Moodle origin, waits for each page to settle, applies a small delay between navigations, and extracts a compact page snapshot. Browser sources run serially so several persistent Chromium profiles do not compete for macOS resources. A closed or crashed browser stops only that source and is shown in the dashboard; it cannot keep retrying forever or discard already collected sources. Legacy submission/comment records from older crawls remain in local history but are hidden from the live dashboard. The selected typed-decision provider receives normalized Moodle items afterward; it does not choose arbitrary browser clicks or generate navigation text. Moodle mutations and coursework submission are outside the action allowlist.

## Local dashboard

Run `npm run dashboard` and open `http://127.0.0.1:4782`. The dashboard is local-only: it reads the same SQLite state, streams run stages over a live connection, picks up runs launched separately with `npm run morning`, shows the inbox/work/coursework mix, and gives you a review queue for typed decisions below the confidence threshold. Each source reports its scanned, extracted, skipped, truncated, missed, and pending counts. Failed pages and reached caps mark coverage partial, and source cursors resume on the next run. Dashboard runs persist collected state but run in dry-run mode; accepting or dismissing a low-confidence item records your review without sending mail, submitting Moodle work, or making an external mutation.

The dashboard uses Arc components for its metric cards, primary run action, and activity table. `npm run dashboard` builds the local browser bundle before starting the server; run `npm run dashboard:build` to build it separately and `npm run dashboard:typecheck` to check its React components. Arc source files live under `components/arc`, with the project skill in `.claude/skills/arc/`.

Run `npm run recall` to score the labeled extraction baseline across Gmail, Outlook, Moodle, and EdStem lesson snapshots. The checked-in examples are synthetic, provider-shaped fixtures with no live account content; they check parser and uncertainty behavior but do not estimate recall on a user's real inbox or courses. Replace or extend them with reviewed, sanitized source snapshots to measure live-source recall and keep a reason beside each miss.

## Outlook collection

Outlook email is collected through the read-only Outlook Web UI, alongside the Moodle browser adapter. It does not use Microsoft Graph or automate credentials. Enable it in `.env`:

```sh
OUTLOOK_ENABLED=true
OUTLOOK_BASE_URL=https://outlook.office.com/mail/
OUTLOOK_BROWSER_PROFILE=.outlook-browser-profile
OUTLOOK_LOOKBACK_HOURS=24
```

The first run opens a separate persistent Chromium profile and waits up to five minutes for you to complete Outlook, SSO, and MFA manually. Later runs reuse that session. It scrolls until two passes add no new inbox rows or the safety limit is reached, then opens each message to read its full visible body and attachment names. `OUTLOOK_MAX_SCROLLS` and `OUTLOOK_MAX_MESSAGES` are reported in coverage; a reached limit or failed message page is shown as partial and resumes from the saved message cursor next run. A message with an unreadable date is retained with its raw date text for classification. The collector never marks messages read, replies, archives, deletes, or sends mail. `OUTLOOK_NAVIGATION_DELAY_MS`, `OUTLOOK_SETTLE_DELAY_MS`, and `OUTLOOK_CDP_URL` configure browser pacing or an existing Chromium session. Native Outlook desktop is not used by the standalone CLI; the persistent Outlook Web profile makes this work the same way as Moodle.

Outlook records use the existing `email` source and go through the same typed email questions as Gmail/mock email. Stable browser-derived IDs and the local SQLite seen-item store prevent the same message from being briefed repeatedly on daily runs.

External text is always treated as data. Only the allowlisted typed actions can execute, and calendar/task mutations remain approval-gated even at high confidence.

## GitHub, EdStem Lessons, and daily news

GitHub is collected read-only through the official REST API. Configure one of these modes in `.env`: `GITHUB_TOKEN` for participating notifications, `GITHUB_USERNAME` for public activity, or `GITHUB_REPOS=owner/repo,other/repo` for recent repository issues and pull requests. `GITHUB_LOOKBACK_HOURS` and `GITHUB_MAX_ITEMS` bound the collection. GitHub is disabled until one of these values is configured or `GITHUB_ENABLED=true` is set.

EdStem Lessons are collected read-only through the authenticated Ed Discussion web UI, because access may arrive through a course login/SSO link. Enable the headed browser adapter in `.env`:

```sh
EDSTEM_ENABLED=true
EDSTEM_BASE_URL=https://edstem.org/us/
EDSTEM_BROWSER_PROFILE=.edstem-browser-profile
```

The first run opens a persistent Chromium profile and waits up to five minutes for you to complete EdStem login, SSO, or MFA manually. Later runs reuse that profile. The collector follows course Lessons pages and bounded lesson links, waits for each page to settle, and never posts, marks lessons read, submits answers, or changes upstream state. EdStem discussions and other areas remain outside this collector's configured scope; coverage says "Lessons only" so that this source cannot look broader than it is. `EDSTEM_NAVIGATION_DELAY_MS`, `EDSTEM_SETTLE_DELAY_MS`, and `EDSTEM_COURSES` control the browser pace and course scope. Page caps and failures appear as partial coverage and the saved page cursor continues on the next run. Lesson content is classified by the same typed `worthReading` decision as news, and content fingerprints prevent unchanged lessons from appearing as new every morning.
Leave `EDSTEM_COURSE_URLS` empty to discover every course visible from your authenticated Ed home page; add explicit course links only when Ed's home page does not expose a course. The dashboard's course selector keeps a large course list navigable without requiring one configuration entry per course.

Daily news uses read-only RSS/Atom feeds. Set `NEWS_FEEDS` to a comma-separated list of feeds, or keep the defaults in `.env.example`. Every `news` and `edstem` item gets one typed `worthReading` decision with a category. Items judged worth reading appear under `[READ NEXT]` in the briefing and in the dashboard’s News/Ed Lessons/Files filters. Stable lesson/article IDs and the existing local seen-item store prevent the same item from being briefed repeatedly on later runs.
