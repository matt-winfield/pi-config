export const MINIMUM_INTERVAL_SECONDS = 10;
export const DEFAULT_INTERVAL_SECONDS = 60;
export const MAX_EVENT_OUTPUT_BYTES = 50 * 1024;

export interface MonitorDefinition {
  name: string;
  script: string;
  intervalSeconds?: number;
  triggerPattern?: string;
}

export interface Monitor {
  id: string;
  name: string;
  script: string;
  intervalSeconds: number;
  triggerPattern?: string;
  createdAt: number;
  lastRunAt?: number;
  lastTriggeredAt?: number;
  lastError?: string;
  running: boolean;
}

export interface ScriptResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface MonitorManagerOptions {
  cwd: string;
  runScript: (
    script: string,
    cwd: string,
    signal: AbortSignal
  ) => Promise<ScriptResult>;
  onOutput: (monitor: Monitor, output: string) => void;
  onChange?: (monitors: readonly Monitor[]) => void;
}

interface ManagedMonitor {
  monitor: Monitor;
  pattern?: RegExp;
  timer?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
  lastDeliveredOutput?: string;
}

export class MonitorManager {
  private readonly monitors = new Map<string, ManagedMonitor>();
  private nextId = 1;

  constructor(private readonly options: MonitorManagerOptions) {}

  create(definition: MonitorDefinition): Monitor {
    const name = definition.name.trim();
    const script = definition.script.trim();
    if (!name) throw new Error("Monitor name must not be empty");
    if (!script) throw new Error("Monitor script must not be empty");

    const pattern = definition.triggerPattern
      ? new RegExp(definition.triggerPattern, "m")
      : undefined;
    const requestedInterval =
      definition.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
    const intervalSeconds = Math.max(
      MINIMUM_INTERVAL_SECONDS,
      Number.isFinite(requestedInterval)
        ? requestedInterval
        : DEFAULT_INTERVAL_SECONDS
    );
    const monitor: Monitor = {
      id: `monitor-${this.nextId++}`,
      name,
      script,
      intervalSeconds,
      triggerPattern: definition.triggerPattern,
      createdAt: Date.now(),
      running: false,
    };
    const managed = { monitor, pattern } satisfies ManagedMonitor;
    this.monitors.set(monitor.id, managed);
    this.schedule(managed);
    this.notifyChange();
    return { ...monitor };
  }

  list(): Monitor[] {
    return [...this.monitors.values()].map(({ monitor }) => ({ ...monitor }));
  }

  stop(id: string): boolean {
    const managed = this.monitors.get(id);
    if (!managed) return false;
    if (managed.timer) clearTimeout(managed.timer);
    managed.controller?.abort();
    this.monitors.delete(id);
    this.notifyChange();
    return true;
  }

  stopAll(): void {
    for (const id of this.monitors.keys()) this.stop(id);
  }

  async runNow(id: string): Promise<void> {
    const managed = this.monitors.get(id);
    if (!managed || managed.monitor.running) return;

    const controller = new AbortController();
    managed.controller = controller;
    managed.monitor.running = true;
    managed.monitor.lastRunAt = Date.now();
    managed.monitor.lastError = undefined;
    this.notifyChange();

    try {
      const result = await this.options.runScript(
        managed.monitor.script,
        this.options.cwd,
        controller.signal
      );
      if (controller.signal.aborted || !this.monitors.has(id)) return;
      if (result.code !== 0) {
        managed.monitor.lastError =
          result.stderr.trim() || `Script exited with code ${result.code}`;
        return;
      }

      const output = result.stdout.trim();
      const actionable =
        output.length > 0 && (!managed.pattern || managed.pattern.test(output));
      if (actionable && output !== managed.lastDeliveredOutput) {
        const truncated = Buffer.from(output)
          .subarray(0, MAX_EVENT_OUTPUT_BYTES)
          .toString("utf8");
        managed.lastDeliveredOutput = output;
        managed.monitor.lastTriggeredAt = Date.now();
        this.options.onOutput({ ...managed.monitor }, truncated);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        managed.monitor.lastError =
          error instanceof Error ? error.message : String(error);
      }
    } finally {
      managed.monitor.running = false;
      managed.controller = undefined;
      this.notifyChange();
    }
  }

  private schedule(managed: ManagedMonitor): void {
    managed.timer = setTimeout(async () => {
      await this.runNow(managed.monitor.id);
      if (this.monitors.has(managed.monitor.id)) this.schedule(managed);
    }, managed.monitor.intervalSeconds * 1000);
    managed.timer.unref?.();
  }

  private notifyChange(): void {
    this.options.onChange?.(this.list());
  }
}
