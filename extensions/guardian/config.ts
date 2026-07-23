import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type GuardianMode = "disabled" | "auto-approve" | "prompt";
export type GuardianEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface GuardianConfig {
  mode: GuardianMode;
  model: string;
  effort: GuardianEffort;
}

export const DEFAULT_GUARDIAN_CONFIG: GuardianConfig = {
  mode: "auto-approve",
  model: "gpt-5.6-luna",
  effort: "low",
};

export const GUARDIAN_CONFIG_PATH = join(homedir(), ".pi", "agent", "guardian.json");

const MODES = new Set<GuardianMode>(["disabled", "auto-approve", "prompt"]);
const EFFORTS = new Set<GuardianEffort>(["minimal", "low", "medium", "high", "xhigh", "max"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseGuardianConfig(value: unknown): GuardianConfig {
  if (!isRecord(value)) return { ...DEFAULT_GUARDIAN_CONFIG };
  return {
    mode: MODES.has(value.mode as GuardianMode)
      ? (value.mode as GuardianMode)
      : DEFAULT_GUARDIAN_CONFIG.mode,
    model:
      typeof value.model === "string" && value.model.trim()
        ? value.model.trim()
        : DEFAULT_GUARDIAN_CONFIG.model,
    effort: EFFORTS.has(value.effort as GuardianEffort)
      ? (value.effort as GuardianEffort)
      : DEFAULT_GUARDIAN_CONFIG.effort,
  };
}

export async function loadGuardianConfig(): Promise<GuardianConfig> {
  try {
    return parseGuardianConfig(JSON.parse(await readFile(GUARDIAN_CONFIG_PATH, "utf8")));
  } catch {
    return { ...DEFAULT_GUARDIAN_CONFIG };
  }
}

export async function saveGuardianConfig(config: GuardianConfig): Promise<void> {
  const directory = dirname(GUARDIAN_CONFIG_PATH);
  const temporaryPath = `${GUARDIAN_CONFIG_PATH}.tmp`;
  await mkdir(directory, { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temporaryPath, GUARDIAN_CONFIG_PATH);
}
