# Morning Agent

Local, macOS-first morning briefing CLI. Deterministic TypeScript code owns orchestration and action policy; TypeSafe AI's Jev supplies narrow typed decisions only.

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

Live Jev decisions require `TYPESAFE_API_KEY` in `.env` (the `npm run morning` script loads it automatically). The official `@typesafe-ai/sdk` client is configured for `jev-latest`; no other model provider is used. Without credentials, use `--mock` to run the complete offline fixture workflow.

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

`GMAIL_ACCESS_TOKEN` is supported for a short-lived token. Alternatively, set `GMAIL_CREDENTIALS_PATH` and `GMAIL_TOKEN_PATH` to the OAuth client and token JSON files. A Google API key alone cannot read a private mailbox. With no `GMAIL_QUERY`, the collector lists recent Gmail messages, fetches their full read-only MIME payloads, and applies the exact lookback window using Gmail's received timestamp; use `GMAIL_QUERY="is:unread newer_than:1d"` to restrict it to unread mail. It never modifies labels, marks mail read, sends, replies, archives, or deletes.

## Moodle collection

Moodle is collected through a read-only Playwright adapter because it does not provide the needed API. Copy the Moodle settings into `.env`, for example:

```sh
MOODLE_ENABLED=true
MOODLE_BASE_URL=https://your-moodle.example/my/
MOODLE_BROWSER_PROFILE=.browser-profile
```

The first run opens a persistent Chromium profile and waits up to five minutes for you to complete Moodle, SSO, and MFA in that window. The collector never receives credentials and never submits forms. It reads the dashboard and same-origin course pages, then follows bounded same-origin resource, folder, assignment, quiz, and workshop activity pages to find nested file/download links. `MOODLE_LOGIN_TIMEOUT_MS`, `MOODLE_MAX_COURSE_PAGES`, and `MOODLE_MAX_DETAIL_PAGES` control the bounds. `MOODLE_CDP_URL` can be used instead when an already-running Chromium session is available. The browser tab is closed after collection and the attached browser itself is left open.

The browser layer is deterministic: it navigates only to the configured Moodle origin and extracts a compact page snapshot. Jev receives normalized Moodle items afterward for typed decisions; it does not choose arbitrary browser clicks or generate navigation text. Moodle mutations and coursework submission are outside the action allowlist.

## Outlook collection

Outlook email is collected through the read-only Outlook Web UI, alongside the Moodle browser adapter. It does not use Microsoft Graph or automate credentials. Enable it in `.env`:

```sh
OUTLOOK_ENABLED=true
OUTLOOK_BASE_URL=https://outlook.office.com/mail/
OUTLOOK_BROWSER_PROFILE=.outlook-browser-profile
OUTLOOK_LOOKBACK_HOURS=24
```

The first run opens a separate persistent Chromium profile and waits up to five minutes for you to complete Outlook, SSO, and MFA manually. Later runs reuse that session. It reads the inbox list for the configured lookback window, follows no email actions, and never marks messages read, replies, archives, deletes, or sends mail. `OUTLOOK_MAX_SCROLLS` bounds list scrolling, and `OUTLOOK_CDP_URL` can attach to an already-running Chromium session. Native Outlook desktop is not used by the standalone CLI; the persistent Outlook Web profile makes this work the same way as Moodle.

Outlook records use the existing `email` source and go through the same TypeSafe Jev email questions as Gmail/mock email. Stable browser-derived IDs and the local SQLite seen-item store prevent the same message from being briefed repeatedly on daily runs.

External text is always treated as data. Only the allowlisted typed actions can execute, and calendar/task mutations remain approval-gated even at high confidence.
