import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { MonitorManager, type Monitor } from "./monitor-manager";

const STATUS_ID = "monitors";
const BLUE = "\u001b[34m";
const RESET = "\u001b[0m";

function formatMonitor(monitor: Monitor): string {
  const state = monitor.running
    ? "checking"
    : monitor.lastError
      ? "error"
      : "waiting";
  return `${monitor.id} · ${monitor.name} · every ${monitor.intervalSeconds}s · ${state}`;
}

export default function monitorExtension(pi: ExtensionAPI) {
  let manager: MonitorManager | undefined;
  let context: ExtensionContext | undefined;

  const updateStatus = () => {
    if (!context) return;
    const count = manager?.list().length ?? 0;
    if (count === 0) {
      context.ui.setStatus(STATUS_ID, undefined);
      return;
    }
    const label = `${count} monitor${count === 1 ? "" : "s"} · Ctrl+Shift+M`;
    context.ui.setStatus(STATUS_ID, `${BLUE}${label}${RESET}`);
  };

  const requireManager = () => {
    if (!manager) throw new Error("The monitor session has not started");
    return manager;
  };

  const showMonitors = async (ctx: ExtensionContext) => {
    const monitors = requireManager().list();
    if (monitors.length === 0) {
      ctx.ui.notify("No active monitors", "info");
      return;
    }
    if (ctx.mode !== "tui") {
      ctx.ui.notify(monitors.map(formatMonitor).join("\n"), "info");
      return;
    }

    const selectedId = await ctx.ui.custom<string | null>(
      (tui, theme, _keybindings, done) => {
        const items: SelectItem[] = monitors.map((monitor) => ({
          value: monitor.id,
          label: monitor.name,
          description: `${monitor.id} · every ${monitor.intervalSeconds}s${monitor.lastError ? ` · ${monitor.lastError}` : ""}`,
        }));
        const container = new Container();
        container.addChild(
          new DynamicBorder((text: string) => theme.fg("accent", text))
        );
        container.addChild(
          new Text(theme.fg("accent", theme.bold("Active monitors")), 1, 0)
        );
        const list = new SelectList(items, Math.min(items.length, 12), {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        });
        list.onSelect = (item) => done(item.value);
        list.onCancel = () => done(null);
        container.addChild(list);
        container.addChild(
          new Text(theme.fg("dim", "enter stop selected · esc close"), 1, 0)
        );
        container.addChild(
          new DynamicBorder((text: string) => theme.fg("accent", text))
        );
        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            list.handleInput(data);
            tui.requestRender();
          },
        };
      }
    );

    if (selectedId && requireManager().stop(selectedId)) {
      ctx.ui.notify(`Stopped ${selectedId}`, "info");
    }
  };

  pi.registerTool({
    name: "create_monitor",
    label: "Create Monitor",
    description:
      "Create a session-scoped background monitor. The bash script runs in the current working directory no more often than every 10 seconds. A successful run wakes the agent only when stdout is non-empty and matches triggerPattern, if supplied. Identical output is delivered only once. Write scripts that stay silent when there is nothing actionable.",
    promptSnippet:
      "Create a token-free background bash monitor that wakes the agent on actionable output",
    promptGuidelines: [
      "Use create_monitor when waiting for an external change instead of repeatedly polling with model turns.",
      "Make create_monitor scripts print concise actionable context to stdout and print nothing when no action is needed.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Short human-readable monitor name" }),
      script: Type.String({
        description:
          "Bash script to execute with bash -lc in the session working directory",
      }),
      intervalSeconds: Type.Optional(
        Type.Number({
          description:
            "Polling interval in seconds; values below 10 are clamped to 10",
          minimum: 1,
        })
      ),
      triggerPattern: Type.Optional(
        Type.String({
          description:
            "Optional JavaScript regular expression that stdout must match",
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const monitor = requireManager().create(params);
      return {
        content: [{ type: "text", text: `Created ${formatMonitor(monitor)}` }],
        details: { monitor },
      };
    },
  });

  pi.registerTool({
    name: "list_monitors",
    label: "List Monitors",
    description:
      "List all background monitors active in the current session and their latest status.",
    parameters: Type.Object({}),
    async execute() {
      const monitors = requireManager().list();
      return {
        content: [
          {
            type: "text",
            text:
              monitors.length > 0
                ? monitors.map(formatMonitor).join("\n")
                : "No active monitors",
          },
        ],
        details: { monitors },
      };
    },
  });

  pi.registerTool({
    name: "stop_monitor",
    label: "Stop Monitor",
    description: "Stop and remove a background monitor in the current session.",
    parameters: Type.Object({
      id: Type.String({ description: "Monitor ID returned by create_monitor" }),
    }),
    async execute(_toolCallId, params) {
      const stopped = requireManager().stop(params.id);
      return {
        content: [
          {
            type: "text",
            text: stopped
              ? `Stopped ${params.id}`
              : `Monitor ${params.id} was not found`,
          },
        ],
        details: { id: params.id, stopped },
      };
    },
  });

  pi.registerCommand("monitors", {
    description: "View and stop active background monitors",
    handler: async (_args, ctx) => showMonitors(ctx),
  });

  pi.registerShortcut("ctrl+shift+m", {
    description: "View active background monitors",
    handler: showMonitors,
  });

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    manager = new MonitorManager({
      cwd: ctx.cwd,
      runScript: async (script, cwd, signal) => {
        const result = await pi.exec("bash", ["-lc", script], { cwd, signal });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          code: result.code ?? 1,
        };
      },
      onOutput: (monitor, output) => {
        pi.sendMessage(
          {
            customType: "monitor-event",
            content: `Monitor "${monitor.name}" (${monitor.id}) produced actionable output:\n\n${output}`,
            display: true,
            details: { monitorId: monitor.id, monitorName: monitor.name },
          },
          { deliverAs: "followUp", triggerTurn: true }
        );
      },
      onChange: updateStatus,
    });
    updateStatus();
  });

  pi.on("session_shutdown", async () => {
    manager?.stopAll();
    context?.ui.setStatus(STATUS_ID, undefined);
    manager = undefined;
    context = undefined;
  });
}
