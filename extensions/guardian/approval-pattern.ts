import { parseHostCommand, type HostCommand } from "./host-command";
import type { ReviewAction, ReviewVerdict } from "./reviewer";

const MAX_PATTERN_LENGTH = 1_000;
const WILDCARD = ".*";

export interface ApprovalPattern {
  pattern: string;
  matcher: RegExp;
}

export interface ApprovalPatternGrant {
  pattern: ApprovalPattern;
  verdict: ReviewVerdict;
  expiresAt?: number;
}

function wildcardPattern(pattern: string): RegExp | undefined {
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH) return undefined;
  const expression = pattern
    .split(WILDCARD)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(WILDCARD);
  try {
    return new RegExp(`^${expression}$`);
  } catch {
    return undefined;
  }
}

function sameExecutable(command: HostCommand, pattern: HostCommand): boolean {
  return command.executable === pattern.executable;
}

export function createApprovalPattern(
  pattern: string,
  action: ReviewAction
): ApprovalPattern | undefined {
  const command = action.details?.trim();
  const normalized = pattern.trim();
  if (
    action.kind !== "tool" ||
    action.operation !== "host-bash" ||
    !command ||
    !normalized
  ) {
    return undefined;
  }

  const parsedCommand = parseHostCommand(command);
  const parsedPattern = parseHostCommand(normalized);
  if (
    !parsedCommand ||
    !parsedPattern ||
    action.target !== parsedCommand.executable ||
    !sameExecutable(parsedCommand, parsedPattern)
  ) {
    return undefined;
  }

  const matcher = wildcardPattern(normalized);
  if (!matcher || !matcher.test(command)) return undefined;
  return { pattern: normalized, matcher };
}

export function findApprovalPattern(
  grants: ApprovalPatternGrant[],
  action: ReviewAction
): ApprovalPatternGrant | undefined {
  const now = Date.now();
  return [...grants]
    .reverse()
    .find(
      (grant) =>
        (!grant.expiresAt || grant.expiresAt > now) &&
        isApprovalPatternMatch(grant.pattern, action)
    );
}

export function isApprovalPatternMatch(
  cached: ApprovalPattern,
  action: ReviewAction
): boolean {
  const command = action.details?.trim();
  if (action.kind !== "tool" || action.operation !== "host-bash" || !command) {
    return false;
  }
  const parsed = parseHostCommand(command);
  if (!parsed || action.target !== parsed.executable) return false;
  const patternCommand = parseHostCommand(cached.pattern);
  return Boolean(
    patternCommand &&
    sameExecutable(parsed, patternCommand) &&
    cached.matcher.test(command)
  );
}
