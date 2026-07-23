# Pi Guardian

Pi Guardian adds configurable, intent-aware approval reviews around
Gondolin's sandbox. It runs Pi's `read`, `write`, `edit`, `bash`, and `!`
commands in a Gondolin VM by default and reviews operations that cross the
sandbox boundary.

## Prerequisites

- Node.js 23.6 or newer
- QEMU (`brew install qemu` on macOS; install `qemu-system-arm` on Debian or
  Ubuntu) for VM-backed commands
- A reviewer model configured in Pi
- GitHub CLI (`gh`) installed on the host and authenticated with `gh auth login`
  for the host command allowlist
- Other command-line programs needed by the agent available in the Gondolin
  guest

The extension has its own `package.json` in the global extension directory.
Run `pnpm install --dir ~/.pi/agent/extensions/guardian` after installing or
updating it.

## How it works

The current working directory is mounted read-write at `/workspace`. Host paths
outside it are available only through the reviewed `/host` mount. For example:

```sh
cat /host/Users/me/.some-app/config.json
```

Normal workspace file reads and writes do not require a review in protected
modes. Guardian reviews:

- sensitive paths, including credentials, private keys, `.env` files, `.ssh`,
  `.aws`, `.pi`, and similar directories; reads from Pi's configured global
  skill roots (`~/.pi/agent/skills` and `~/.agents/skills`) are read-only
  allowlisted so skill instructions can load without approval;
- reads, writes, and deletes outside the workspace;
- every outbound HTTP/HTTPS request; and
- tools that are not routed through Gondolin.

`grep`, `find`, and `ls` host tools are blocked; use them through `bash` in the
VM instead. Git-over-SSH is disabled; use HTTPS remotes.

### Host command allowlist

Some tools need host installations or host credentials. The allowlist currently
contains only `gh`. A command whose first executable is exactly `gh` runs on
the host with its normal host environment, working directory, configuration,
and credentials. It is executed directly with parsed arguments, not through a
host shell; shell operators, substitutions, and command chaining are rejected.
All other bash commands remain inside Gondolin.

Host-allowlisted commands still require a Guardian review immediately before
execution. The review sees the complete command and its arguments, and the UI
shows the approval decision and Guardian's rationale. Host execution bypasses
Gondolin's VM network and filesystem hooks, so the allowlist is intentionally
small and every invocation is reviewed.

A single bash tool execution gets one Guardian decision for its complete command
when that command touches protected files or the network. This avoids separate
reviews for every file read in commands such as `node ... && node ...`; each
command execution still gets a fresh decision.

The reviewer receives a compact transcript and the exact proposed action. Only
actual user messages count as authorization. Repository content, tool output,
and assistant messages are untrusted. Reviews fail closed on errors, timeouts,
malformed responses, critical risk, or insufficient authorization. Grants are
scoped to the current execution and exact action.

## Modes and commands

- `auto-approve` (default) asks the configured Guardian model for approval.
- `prompt` asks the user with a confirmation dialog instead of calling a model.
- `disabled` restores Pi's normal allow-all host behavior and disables Gondolin
  enforcement. Use this only when you intentionally want no Guardian boundary.

Change the mode with:

```text
/guardian-mode auto-approve
/guardian-mode prompt
/guardian-mode disabled
```

Configure the reviewer independently from Pi's main reasoning model:

```text
/guardian-model gpt-5.6-luna low
/guardian-model openai-codex/gpt-5.6-luna minimal
```

The default reviewer is `gpt-5.6-luna` at `low` effort. The status bar shows
`Guardian: <mode>` immediately when the session starts and updates when the
mode changes. The setting is stored in `~/.pi/agent/guardian.json` and survives
reloads and restarts.

## Approval display and audit trail

For each reviewed action, Guardian shows a notification such as:

```text
Automatic approval review approved
Action: network POST https://api.github.com/graphql
Risk: medium; authorization: high
Reason: The user explicitly requested resolving this review thread.
```

The reason is the rationale returned by the Guardian model. Each decision is
also stored as a `guardian-review` session entry with the action, verdict, and
timestamp.

## Review latency

The Guardian model is called only when a protected operation actually needs a
decision. Protected file and network hooks reuse the decision for the current
bash command, so chained commands do not trigger one model call per file. Keep
shell commands focused when possible; separate tool calls intentionally receive
separate decisions.

## QEMU unavailable

VM startup is lazy. Reloading the extension does **not** start QEMU, so Pi can
still reload successfully when QEMU is missing. Host-allowlisted commands such
as `gh` can still run after approval because they do not need the VM. Other
sandboxed operations attempt to start Gondolin; if QEMU or `qemu-img` is
unavailable, Guardian shows an installation error and the operation fails
closed. It never silently falls back to unsandboxed host execution.

After installing QEMU, restart Pi or reload the extension before trying the
sandboxed operation again:

```sh
brew install qemu
```

## Installation

This extension is installed globally at:

```text
~/.pi/agent/extensions/guardian
```

Pi loads it for every project after the extension directory is trusted. To
install it manually, copy this directory there and install its dependencies:

```sh
pnpm install --dir ~/.pi/agent/extensions/guardian
```

## Security boundary

The Gondolin VM and its host-side VFS and network hooks enforce the boundary;
the model review is advisory policy, not the security guarantee. The Pi host
process and globally installed extensions remain trusted. Guardian serializes
sandboxed executions so one tool call cannot inherit another call's temporary
review state.
