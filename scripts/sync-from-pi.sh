#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
pi_dir=${PI_CODING_AGENT_DIR:-"$HOME/.pi/agent"}

REPO_ROOT="$repo_root" PI_DIR="$pi_dir" python3 - <<'PY'
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

repo = Path(os.environ["REPO_ROOT"]).resolve()
pi = Path(os.environ["PI_DIR"]).expanduser().resolve()
settings_path = pi / "settings.json"

if not settings_path.is_file():
    raise SystemExit(f"Pi settings not found: {settings_path}")


def git_base(source):
    raw = source[4:] if source.startswith("git:") else source
    if raw.startswith(("http://", "https://", "ssh://", "git://")):
        parsed = urlsplit(raw)
        base = f"{parsed.netloc}{parsed.path}".rstrip("/")
    else:
        base = raw.rstrip("/")
    if base.startswith("git@"):
        base = base[4:].replace(":", "/", 1)
    if "@" in base.rsplit("/", 1)[-1]:
        base = base.rsplit("@", 1)[0]
    return base.rstrip("/")


def pin_package(package):
    source = package.get("source") if isinstance(package, dict) else package
    if not isinstance(source, str):
        return package

    if source.startswith("npm:"):
        raw = source[4:]
        slash = raw.find("/")
        at = raw.rfind("@")
        name = raw[:at] if at > slash else raw
        manifest = pi / "npm" / "node_modules" / name / "package.json"
        if manifest.is_file():
            version = json.loads(manifest.read_text())["version"]
            pinned = f"npm:{name}@{version}"
        else:
            print(f"warning: could not resolve installed npm package {source}", file=sys.stderr)
            pinned = source
    elif source.startswith(("git:", "http://", "https://", "ssh://", "git://")) or source.startswith("git@"):
        checkout = pi / "git" / git_base(source)
        try:
            commit = subprocess.check_output(
                ["git", "-C", str(checkout), "rev-parse", "HEAD"],
                text=True,
                stderr=subprocess.DEVNULL,
            ).strip()
        except (OSError, subprocess.CalledProcessError):
            print(f"warning: could not resolve installed git package {source}", file=sys.stderr)
            pinned = source
        else:
            pinned = f"git:{git_base(source)}@{commit}"
    else:
        pinned = source

    if isinstance(package, dict):
        result = dict(package)
        result["source"] = pinned
        return result
    return pinned


def has_literal_secret(value, key=""):
    if isinstance(value, dict):
        return any(has_literal_secret(v, str(k)) for k, v in value.items())
    if isinstance(value, list):
        return any(has_literal_secret(v, key) for v in value)
    if not isinstance(value, str):
        return False
    sensitive = ("api_key", "apikey", "token", "secret", "password", "cookie", "authorization")
    return any(part in key.lower() for part in sensitive) and not value.startswith(("$", "!"))


def copy_json(name, reject_secrets=False):
    source = pi / name
    target = repo / name
    if not source.is_file():
        target.unlink(missing_ok=True)
        return
    data = json.loads(source.read_text())
    if reject_secrets and has_literal_secret(data):
        raise SystemExit(
            f"Refusing to copy {source}: it contains a literal secret. "
            "Use environment-variable references (for example $OPENAI_API_KEY) first."
        )
    if name == "settings.json":
        data = dict(data)
        if "packages" in data:
            data["packages"] = [
                pin_package(package)
                for package in data["packages"]
                if not str(
                    package.get("source") if isinstance(package, dict) else package
                ).startswith("git:github.com/matt-winfield/pi-config@")
            ]
    target.write_text(json.dumps(data, indent=2) + "\n")
    shutil.copystat(source, target, follow_symlinks=True)


copy_json("settings.json", reject_secrets=True)
copy_json("keybindings.json", reject_secrets=True)
copy_json("models.json", reject_secrets=True)

for kind in ("extensions", "skills", "prompts", "themes"):
    source = pi / kind
    target = repo / kind
    if target.exists() or target.is_symlink():
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            target.unlink()
    if source.is_dir():
        shutil.copytree(
            source,
            target,
            symlinks=False,
            ignore=shutil.ignore_patterns("node_modules", ".git"),
        )
    else:
        target.mkdir()
        (target / ".gitkeep").touch()

print(f"Synced pi configuration from {pi} to {repo}")
PY
