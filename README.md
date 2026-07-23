# pi-config

Personal [pi](https://pi.dev) configuration, extensions, skills, prompts, and themes.

This repository is also a pi package. The package resources live in the conventional
`extensions/`, `skills/`, `prompts/`, and `themes/` directories.

## Install on a new machine

```bash
curl -fsSL https://pi.dev/install.sh | sh
curl -fsSL https://raw.githubusercontent.com/matt-winfield/pi-config/main/install.sh | sh
```

The second command installs this package, applies the saved settings, and installs its
pinned packages. Start pi and run `/login` to authenticate.

## Update this repository from the current pi installation

Run this from a checkout of this repository:

```bash
./scripts/sync-from-pi.sh
git diff
```

The script copies the safe, user-editable configuration files and the canonical global
resource directories from `${PI_CODING_AGENT_DIR:-~/.pi/agent}`. It pins npm packages to
the installed version and Git packages to the installed commit when their local caches
are available.

Review and push the result:

```bash
git add -A
git commit -m "Sync pi configuration"
git push
```

Set `PI_CODING_AGENT_DIR` when pi uses a different configuration directory:

```bash
PI_CODING_AGENT_DIR=/path/to/pi/agent ./scripts/sync-from-pi.sh
```

## What is deliberately excluded

- `auth.json` and literal secrets
- sessions and conversation history
- npm and Git package caches
- generated model catalogs and trust decisions
- `node_modules`

Third-party packages are represented by their pinned entries in `settings.json` and are
reinstalled with `pi install` rather than copied into this repository. If `models.json`
or another configuration file contains a literal credential, the sync script stops; use
an environment-variable reference such as `$OPENAI_API_KEY` instead.
