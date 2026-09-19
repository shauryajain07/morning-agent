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

## Moodle collection

Moodle is collected through a read-only Playwright adapter because it does not provide the needed API. Copy the Moodle settings into `.env`, for example:

```sh
MOODLE_ENABLED=true
MOODLE_BASE_URL=https://your-moodle.example/my/
MOODLE_BROWSER_PROFILE=.browser-profile
```

The first run opens a persistent Chromium profile and waits up to five minutes for you to complete Moodle, SSO, and MFA in that window. The collector never receives credentials and never submits forms. It reads the dashboard and same-origin course pages, then follows bounded same-origin resource, folder, assignment, quiz, and workshop activity pages to find nested file/download links. `MOODLE_LOGIN_TIMEOUT_MS`, `MOODLE_MAX_COURSE_PAGES`, and `MOODLE_MAX_DETAIL_PAGES` control the bounds. `MOODLE_CDP_URL` can be used instead when an already-running Chromium session is available. The browser tab is closed after collection and the attached browser itself is left open.

The browser layer is deterministic: it navigates only to the configured Moodle origin and extracts a compact page snapshot. Jev receives normalized Moodle items afterward for typed decisions; it does not choose arbitrary browser clicks or generate navigation text. Moodle mutations and coursework submission are outside the action allowlist.

External text is always treated as data. Only the allowlisted typed actions can execute, and calendar/task mutations remain approval-gated even at high confidence.
