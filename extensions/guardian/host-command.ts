const SHELL_OPERATORS = new Set([
  ";",
  "&",
  "|",
  "<",
  ">",
  "`",
  "$",
  "(",
  ")",
  "\n",
  "\r",
]);

export const HOST_BASH_ALLOWLIST = new Set(["gh", "git"] as const);

export type HostExecutable = "gh" | "git";

export interface HostCommand {
  executable: HostExecutable;
  args: string[];
}

export function parseHostCommand(command: string): HostCommand | undefined {
  const tokens: string[] = [];
  let token = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const character of command.trim()) {
    if (escaped) {
      token += character;
      started = true;
      escaped = false;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      started = true;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (SHELL_OPERATORS.has(character)) return undefined;
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    token += character;
    started = true;
  }

  if (quote || escaped) return undefined;
  if (started) tokens.push(token);
  const executable = tokens[0];
  if (!executable || !HOST_BASH_ALLOWLIST.has(executable as HostExecutable))
    return undefined;
  return { executable: executable as HostExecutable, args: tokens.slice(1) };
}
