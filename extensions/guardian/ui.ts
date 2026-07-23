import type { GuardianConfig, GuardianMode } from "./config";
import type { ReviewAction, ReviewVerdict } from "./reviewer";

export function formatGuardianStatus(config: Pick<GuardianConfig, "mode">): string {
  return `Guardian: ${config.mode}`;
}

export function formatReviewPrompt(action: ReviewAction): string {
  return [
    `Action: ${action.kind} ${action.operation} ${action.target}`,
    ...(action.details ? [`Details: ${action.details}`] : []),
  ].join("\n");
}

export function formatReviewNotification(
  action: ReviewAction,
  verdict: ReviewVerdict,
  mode: GuardianMode = "auto-approve",
): string {
  return [
    `${mode === "prompt" ? "Manual approval" : "Automatic approval review"} ${verdict.outcome === "allow" ? "approved" : "denied"}`,
    `Action: ${action.kind} ${action.operation} ${action.target}`,
    ...(action.kind === "tool" && ["bash", "host-bash"].includes(action.operation) && action.details
      ? [`Command: ${action.details}`]
      : []),
    `Risk: ${verdict.riskLevel}; authorization: ${verdict.userAuthorization}`,
    `Reason: ${verdict.rationale}`,
  ].join("\n");
}

export function formatVmUnavailable(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/qemu(?:-img|-system)/i.test(message)) {
    return `Guardian sandbox could not start because QEMU is not installed or unavailable (${message}). Install QEMU and restart Pi: brew install qemu on macOS, or install qemu-system-arm on Debian/Ubuntu.`;
  }
  return `Guardian sandbox could not start: ${message}`;
}
