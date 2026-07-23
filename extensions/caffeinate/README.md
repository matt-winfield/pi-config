# pi-caffeinate

Keeps a macOS Mac awake while pi is running an agent turn.

The extension uses the built-in `/usr/bin/caffeinate` utility:

- `sleep` (default) runs `caffeinate -i`: idle system sleep is prevented, but the display may turn off.
- `screen` runs `caffeinate -i -d`: idle system sleep and display sleep are prevented.

These are native macOS assertions; `-s` is AC-power-only, so the default uses `-i` to work on MacBooks on battery too.
- `disabled` does not start Caffeinate and removes the status-bar entry.

Change the session mode with:

```text
/caffeinate-mode disabled
/caffeinate-mode sleep
/caffeinate-mode screen
```

Caffeinate starts on `agent_start` and stops on `agent_settled` or session shutdown. It is launched with `-w <pi-pid>`, so macOS releases its assertion if pi is killed or crashes. An unexpected Caffeinate exit is retried while pi is still working; stopping work cancels pending retries.

The setting is session-scoped and defaults to `sleep` for each new session. No Caffeinate process is started on non-macOS systems.
