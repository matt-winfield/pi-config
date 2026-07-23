import { homedir } from "node:os";
import { basename, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { isWriteFlag } from "@earendil-works/gondolin";

export type FileOperation = "read" | "write" | "delete";
export type PolicyDecision = "allow" | "review";

const SENSITIVE_NAMES = new Set([
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
]);
const SENSITIVE_DIRECTORIES = new Set([
  ".agents",
  ".aws",
  ".gnupg",
  ".pi",
  ".ssh",
]);
const SKILL_CONTAINERS = [
  resolve(homedir(), ".pi", "agent"),
  resolve(homedir(), ".agents"),
];

function isConfiguredSkillPath(path: string): boolean {
  return SKILL_CONTAINERS.some((container) => {
    const relativePath = relative(resolve(container), resolve(path));
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) return false;
    return relativePath.split(sep).includes("skills");
  });
}

function isWithin(root: string, path: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

export function agentPathToGuest(
  workspace: string,
  input: string,
  home = homedir()
): string {
  const path = input.trim().replace(/^@/, "");
  if (
    path === "/workspace" ||
    path.startsWith("/workspace/") ||
    path === "/host" ||
    path.startsWith("/host/")
  ) {
    return path;
  }
  const expanded =
    path === "~" || path.startsWith("~/") ? resolve(home, path.slice(2)) : path;
  return hostPathToGuest(
    workspace,
    isAbsolute(expanded) ? expanded : resolve(workspace, expanded)
  );
}

export function hostPathToGuest(workspace: string, path: string): string {
  const absolutePath = resolve(path);
  if (isWithin(workspace, absolutePath)) {
    return posix.join(
      "/workspace",
      relative(resolve(workspace), absolutePath).split(sep).join(posix.sep)
    );
  }
  return posix.join(
    "/host",
    absolutePath.split(sep).filter(Boolean).join(posix.sep)
  );
}

export function guestPathToHost(
  workspace: string,
  guestPath: string
): string | undefined {
  const path = guestPath.startsWith("/data/") ? guestPath.slice(5) : guestPath;
  if (path === "/workspace" || path.startsWith("/workspace/")) {
    return resolve(workspace, `.${path.slice("/workspace".length)}`);
  }
  if (path === "/host" || path.startsWith("/host/")) {
    return resolve("/", `.${path.slice("/host".length)}`);
  }
  return undefined;
}

const DELETE_OPERATIONS = new Set(["unlink", "rmdir", "rm"]);
const WRITE_OPERATIONS = new Set([
  "chmod",
  "chown",
  "fchmod",
  "fchown",
  "ftruncate",
  "link",
  "lchmod",
  "lchown",
  "lutimes",
  "mkdir",
  "rename",
  "symlink",
  "truncate",
  "utimes",
  "write",
  "writeFile",
]);

export function fileOperationForVfs(context: {
  op: string;
  flags?: string | number;
}): FileOperation {
  if (DELETE_OPERATIONS.has(context.op)) return "delete";
  if (
    context.op === "open" &&
    context.flags !== undefined &&
    (typeof context.flags === "number"
      ? (context.flags & 3) !== 0
      : isWriteFlag(context.flags))
  ) {
    return "write";
  }
  return WRITE_OPERATIONS.has(context.op) ? "write" : "read";
}

export function classifyFileAccess(
  workspace: string,
  path: string,
  operation: FileOperation
): PolicyDecision {
  const absolutePath = resolve(path);
  if (operation === "read" && isConfiguredSkillPath(absolutePath)) {
    return "allow";
  }
  const name = basename(absolutePath);
  const segments = absolutePath.split(sep);
  if (
    ((name === ".env" || name.startsWith(".env.")) &&
      !name.endsWith(".example")) ||
    name.endsWith(".key") ||
    name.endsWith(".pem") ||
    SENSITIVE_NAMES.has(name) ||
    segments.some((segment) => SENSITIVE_DIRECTORIES.has(segment))
  ) {
    return "review";
  }

  return isWithin(workspace, absolutePath) ? "allow" : "review";
}
