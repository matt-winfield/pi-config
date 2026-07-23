#!/usr/bin/env sh
set -eu

pi_dir=${PI_CODING_AGENT_DIR:-"$HOME/.pi/agent"}
ref=${PI_CONFIG_REF:-main}
source="git:github.com/matt-winfield/pi-config@$ref"
package_dir="$pi_dir/git/github.com/matt-winfield/pi-config"

pi install "$source"

for file in settings.json keybindings.json models.json; do
  if [ -f "$package_dir/$file" ]; then
    cp "$package_dir/$file" "$pi_dir/$file"
  fi
done

PI_CONFIG_SOURCE="$source" PI_CONFIG_DIR="$pi_dir" node <<'NODE'
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const dir = process.env.PI_CONFIG_DIR;
const source = process.env.PI_CONFIG_SOURCE;
const file = `${dir}/settings.json`;
const settings = JSON.parse(fs.readFileSync(file, "utf8"));
const packages = settings.packages ?? [];
const packageSource = (pkg) => typeof pkg === "string" ? pkg : pkg.source;
settings.packages = [source, ...packages.filter((pkg) => packageSource(pkg) !== source)];
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");

for (const pkg of settings.packages.slice(1)) {
  execFileSync("pi", ["install", packageSource(pkg)], { stdio: "inherit" });
}
NODE

echo "Installed pi config from $source"
