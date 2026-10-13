# Repository guidance

For dashboard UI changes, follow the project Arc skill in `.claude/skills/arc/SKILL.md`. Prefer installed Arc components from `components/arc`, read each component's documented props before use, and keep page layout in dashboard CSS modules. The dashboard bundle is built with `npm run dashboard:build`; generated files live in the ignored `dashboard/dist` directory.
