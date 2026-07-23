import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  CaffeinateManager,
  formatCaffeinateMode,
  parseCaffeinateMode,
  type CaffeinateMode,
} from "./caffeinate";

const STATUS_ID = "caffeinate";

function updateStatus(ctx: ExtensionContext, mode: CaffeinateMode): void {
  ctx.ui.setStatus(
    STATUS_ID,
    mode === "disabled" ? undefined : `Caffeinate: ${formatCaffeinateMode(mode)}`,
  );
}

export default function caffeinateExtension(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  const manager = new CaffeinateManager({
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      context?.ui.notify(`Caffeinate failed: ${message}`, "error");
    },
  });

  pi.registerCommand("caffeinate-mode", {
    description: "Set Caffeinate mode: disabled, sleep, or screen",
    handler: async (args, ctx) => {
      const value = args.trim();
      if (!value) {
        ctx.ui.notify(
          `Caffeinate mode: ${formatCaffeinateMode(manager.currentMode)}\nUsage: /caffeinate-mode disabled|sleep|screen`,
          "info",
        );
        return;
      }

      const mode = parseCaffeinateMode(value);
      if (!mode) {
        ctx.ui.notify(
          "Usage: /caffeinate-mode disabled|sleep|screen",
          "error",
        );
        return;
      }

      manager.setMode(mode);
      updateStatus(ctx, mode);
      ctx.ui.notify(`Caffeinate mode: ${formatCaffeinateMode(mode)}`, "info");
      if (mode !== "disabled" && !manager.isSupported) {
        ctx.ui.notify("Caffeinate is only available on macOS.", "warning");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    updateStatus(ctx, manager.currentMode);
  });

  pi.on("agent_start", async () => {
    manager.start();
  });

  pi.on("agent_settled", async () => {
    manager.stop();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    manager.stop();
    ctx.ui.setStatus(STATUS_ID, undefined);
    context = undefined;
  });
}

export { DEFAULT_CAFFEINATE_MODE } from "./caffeinate";
