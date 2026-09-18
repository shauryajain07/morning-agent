# Morning Agent

Local, macOS-first morning briefing CLI. Deterministic TypeScript code owns orchestration and action policy; TypeSafe AI's Jev supplies narrow typed decisions only.

## Commands

```sh
npm install
npm run morning -- --mock
npm run morning -- --mock --dry-run --verbose
npm test
npm run typecheck
npm run build
```

Live Jev decisions require `TYPESAFE_API_KEY`. The official `@typesafe-ai/sdk` client is configured for `jev-latest`; no other model provider is used. Without credentials, use `--mock` to run the complete offline fixture workflow.

State is stored in `.data/morning-agent.sqlite` by default. Set `MORNING_AGENT_DB_PATH` to override it.

External text is always treated as data. Only the allowlisted typed actions can execute, and calendar/task mutations remain approval-gated even at high confidence.
