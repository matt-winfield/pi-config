import { describe, expect, it, vi } from "vitest";

import {
  CaffeinateManager,
  type CaffeinateChild,
  caffeinateArgs,
} from "./caffeinate";

class FakeChild {
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => true);
  private readonly listeners = new Map<string, (...args: unknown[]) => void>();

  once(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.set(event, listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    this.listeners.get(event)?.(...args);
  }
}

function child(): CaffeinateChild & FakeChild {
  return new FakeChild() as CaffeinateChild & FakeChild;
}

describe("caffeinateArgs", () => {
  it("uses the built-in distinction between idle system and display sleep", () => {
    expect(caffeinateArgs("sleep", 123)).toEqual(["-i", "-w", "123"]);
    expect(caffeinateArgs("screen", 123)).toEqual(["-i", "-d", "-w", "123"]);
    expect(caffeinateArgs("disabled", 123)).toEqual([]);
  });
});

describe("CaffeinateManager", () => {
  it("starts only while working and stops on idle", () => {
    const first = child();
    const spawnProcess = vi.fn((_args: string[]) => first as CaffeinateChild);
    const manager = new CaffeinateManager({
      parentPid: 123,
      supported: true,
      spawnProcess,
    });

    expect(spawnProcess).not.toHaveBeenCalled();
    manager.start();
    expect(spawnProcess).toHaveBeenCalledWith(["-i", "-w", "123"]);
    manager.stop();
    expect(first.kill).toHaveBeenCalledWith("SIGTERM");
    expect(manager.isRunning).toBe(false);
  });

  it("replaces the assertion when switching modes while working", () => {
    const first = child();
    const second = child();
    const spawnProcess = vi
      .fn((_args: string[]) => first as CaffeinateChild)
      .mockReturnValueOnce(first as CaffeinateChild)
      .mockReturnValueOnce(second as CaffeinateChild);
    const manager = new CaffeinateManager({
      parentPid: 123,
      supported: true,
      spawnProcess,
    });

    manager.start();
    manager.setMode("screen");

    expect(first.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawnProcess).toHaveBeenLastCalledWith(["-i", "-d", "-w", "123"]);
    manager.stop();
  });

  it("does not spawn on unsupported platforms", () => {
    const spawnProcess = vi.fn();
    const manager = new CaffeinateManager({
      supported: false,
      spawnProcess,
    });

    manager.start();

    expect(spawnProcess).not.toHaveBeenCalled();
    expect(manager.isRunning).toBe(false);
  });

  it("does not leave a retry running after work stops", async () => {
    vi.useFakeTimers();
    const spawnProcess = vi.fn((_args: string[]): CaffeinateChild => {
      throw new Error("caffeinate unavailable");
    });
    const manager = new CaffeinateManager({
      supported: true,
      spawnProcess,
    });

    manager.start();
    manager.stop();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(spawnProcess).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
