import { spawn, type ChildProcess } from "node:child_process";

export type CaffeinateMode = "disabled" | "sleep" | "screen";
export type CaffeinateChild = Pick<ChildProcess, "once" | "kill">;
export type SpawnCaffeinate = (args: string[]) => CaffeinateChild;

export const DEFAULT_CAFFEINATE_MODE: CaffeinateMode = "sleep";
export const CAFFEINATE_BINARY = "/usr/bin/caffeinate";
export const CAFFEINATE_RETRY_DELAY_MS = 1_000;

const MODE_ALIASES: Record<string, CaffeinateMode> = {
  disabled: "disabled",
  off: "disabled",
  sleep: "sleep",
  idle: "sleep",
  "prevent-sleep": "sleep",
  screen: "screen",
  display: "screen",
  "prevent-screen": "screen",
  "prevent-display-sleep": "screen",
};

export function parseCaffeinateMode(value: string): CaffeinateMode | undefined {
  return MODE_ALIASES[value.trim().toLowerCase()];
}

export function formatCaffeinateMode(mode: CaffeinateMode): string {
  switch (mode) {
    case "disabled":
      return "disabled";
    case "sleep":
      return "prevent sleep (display may turn off)";
    case "screen":
      return "prevent screen sleep";
  }
}

export function caffeinateArgs(mode: CaffeinateMode, parentPid: number): string[] {
  if (mode === "disabled") return [];
  // Tie the assertion to pi's PID so it is released after a crash.
  return ["-i", ...(mode === "screen" ? ["-d"] : []), "-w", String(parentPid)];
}

export interface CaffeinateManagerOptions {
  parentPid?: number;
  supported?: boolean;
  spawnProcess?: SpawnCaffeinate;
  onError?: (error: unknown) => void;
}

export class CaffeinateManager {
  private readonly parentPid: number;
  private readonly supported: boolean;
  private readonly spawnProcess: SpawnCaffeinate;
  private readonly onError?: (error: unknown) => void;
  private mode: CaffeinateMode = DEFAULT_CAFFEINATE_MODE;
  private working = false;
  private child?: CaffeinateChild;
  private childMode?: Exclude<CaffeinateMode, "disabled">;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private failureReported = false;

  constructor(options: CaffeinateManagerOptions = {}) {
    this.parentPid = options.parentPid ?? process.pid;
    this.supported = options.supported ?? process.platform === "darwin";
    this.spawnProcess =
      options.spawnProcess ??
      ((args) => spawn(CAFFEINATE_BINARY, args, { stdio: "ignore" }));
    this.onError = options.onError;
  }

  get currentMode(): CaffeinateMode {
    return this.mode;
  }

  get isSupported(): boolean {
    return this.supported;
  }

  get isWorking(): boolean {
    return this.working;
  }

  get isRunning(): boolean {
    return this.child !== undefined;
  }

  setMode(mode: CaffeinateMode): void {
    if (mode === this.mode) {
      this.reconcile();
      return;
    }
    this.mode = mode;
    this.failureReported = false;
    this.clearRetry();
    this.stopChild();
    this.reconcile();
  }

  start(): void {
    if (!this.working) this.failureReported = false;
    this.working = true;
    this.reconcile();
  }

  stop(): void {
    this.working = false;
    this.failureReported = false;
    this.clearRetry();
    this.stopChild();
  }

  private shouldRun(): boolean {
    return this.supported && this.working && this.mode !== "disabled";
  }

  private reconcile(): void {
    if (!this.shouldRun()) {
      this.clearRetry();
      this.stopChild();
      return;
    }
    if (this.child && this.childMode === this.mode) return;
    if (this.retryTimer) return;
    this.launch(this.mode);
  }

  private launch(mode: Exclude<CaffeinateMode, "disabled">): void {
    let child: CaffeinateChild;
    try {
      child = this.spawnProcess(caffeinateArgs(mode, this.parentPid));
    } catch (error) {
      this.handleFailure(error);
      return;
    }

    this.child = child;
    this.childMode = mode;
    child.once("error", (error) => this.handleChildFailure(child, error));
    child.once("exit", (code, signal) => {
      this.handleChildFailure(
        child,
        new Error(
          `caffeinate exited unexpectedly${
            signal ? ` with signal ${signal}` : ` with code ${code ?? "unknown"}`
          }`,
        ),
      );
    });
  }

  private handleChildFailure(child: CaffeinateChild, error: unknown): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.childMode = undefined;
    this.handleFailure(error);
  }

  private handleFailure(error: unknown): void {
    if (!this.failureReported) {
      this.failureReported = true;
      try {
        this.onError?.(error);
      } catch {
        // Error reporting must not take down the agent.
      }
    }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (!this.shouldRun() || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.reconcile();
    }, CAFFEINATE_RETRY_DELAY_MS);
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private stopChild(): void {
    const child = this.child;
    this.child = undefined;
    this.childMode = undefined;
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch (error) {
      try {
        child.kill("SIGKILL");
      } catch {
        // There is nothing else we can do if the process is already gone.
      }
      try {
        this.onError?.(error);
      } catch {
        // Error reporting must not take down the agent.
      }
    }
  }
}
