import { describe, expect, it, vi } from "vitest";

import { MonitorManager } from "./monitor-manager";

describe("MonitorManager", () => {
  it("only emits non-empty output that matches the configured pattern", async () => {
    const onOutput = vi.fn();
    const manager = new MonitorManager({
      cwd: "/project",
      onOutput,
      runScript: vi
        .fn()
        .mockResolvedValueOnce({ stdout: "no changes\n", stderr: "", code: 0 })
        .mockResolvedValueOnce({
          stdout: "ACTION: review requested\n",
          stderr: "",
          code: 0,
        }),
    });

    const monitor = manager.create({
      name: "PR review",
      script: "check-pr",
      intervalSeconds: 10,
      triggerPattern: "^ACTION:",
    });

    await manager.runNow(monitor.id);
    await manager.runNow(monitor.id);

    expect(onOutput).toHaveBeenCalledOnce();
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ id: monitor.id, name: "PR review" }),
      "ACTION: review requested"
    );

    manager.stopAll();
  });

  it("does not emit identical actionable output more than once", async () => {
    const onOutput = vi.fn();
    const manager = new MonitorManager({
      cwd: "/project",
      onOutput,
      runScript: vi
        .fn()
        .mockResolvedValue({ stdout: "new review", stderr: "", code: 0 }),
    });
    const monitor = manager.create({ name: "Review", script: "check" });

    await manager.runNow(monitor.id);
    await manager.runNow(monitor.id);

    expect(onOutput).toHaveBeenCalledOnce();
    manager.stopAll();
  });

  it("clamps polling to no more than once every ten seconds", async () => {
    vi.useFakeTimers();
    const runScript = vi
      .fn()
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const manager = new MonitorManager({
      cwd: "/project",
      onOutput: vi.fn(),
      runScript,
    });

    const monitor = manager.create({
      name: "Fast monitor",
      script: "check",
      intervalSeconds: 1,
    });

    expect(monitor.intervalSeconds).toBe(10);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(runScript).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runScript).toHaveBeenCalledOnce();

    manager.stopAll();
    vi.useRealTimers();
  });
});
