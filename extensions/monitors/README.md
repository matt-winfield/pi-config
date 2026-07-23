# Agent monitors

This project-local Pi extension gives the model three tools:

- `create_monitor` runs a Bash script periodically.
- `list_monitors` lists monitors in the current session.
- `stop_monitor` cancels one monitor.

A monitor wakes the model only when its script exits successfully with non-empty stdout and that output matches the optional `triggerPattern`. Repeated identical output is suppressed. Polling intervals below 10 seconds are clamped to 10 seconds; the default is 60 seconds.

Monitors are session-scoped and are stopped automatically on reload, session switch, fork, or exit. Scripts execute with `bash -lc` in Pi's working directory and have the same permissions as Pi.

The blue footer status shows the active count. Press `Ctrl+Shift+M` or run `/monitors` to open the monitor list; selecting a monitor stops it.

## Script guidance

A script should print concise context only when the agent can act. Keep baseline state in a temporary file when the command itself always returns current state. For example, a GitHub monitor can fetch the latest review/comment ID, compare it with a state file, and print the new comment only when the ID changes.

Run the focused tests with:

```bash
pnpm exec vitest run --config extensions/monitors/vitest.config.ts
```
