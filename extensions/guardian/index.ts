import { realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, parse, relative, resolve } from "node:path";
import {
  HttpRequestBlockedError,
  RealFSProvider,
  VM,
  createHttpHooks,
  type VfsHookContext,
} from "@earendil-works/gondolin";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type BashOperations,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import {
  agentPathToGuest,
  classifyFileAccess,
  fileOperationForVfs,
  guestPathToHost,
} from "./policy";
import {
  enforceReviewPolicy,
  reviewAction,
  type ReviewAction,
  type ReviewVerdict,
} from "./reviewer";
import {
  DEFAULT_GUARDIAN_CONFIG,
  loadGuardianConfig,
  saveGuardianConfig,
  type GuardianConfig,
  type GuardianEffort,
  type GuardianMode,
} from "./config";
import { parseHostCommand, type HostCommand } from "./host-command";
import {
  formatGuardianStatus,
  formatReviewNotification,
  formatReviewPrompt,
  formatVmUnavailable,
} from "./ui";

const GUEST_WORKSPACE = "/workspace";
const GUEST_HOST = "/host";
const BLOCKED_HOST_TOOLS = new Set(["find", "grep", "ls"]);
const SANDBOXED_TOOLS = new Set(["bash", "edit", "read", "write"]);

interface ActiveExecution {
  ctx: ExtensionContext;
  description: string;
  signal?: AbortSignal;
  command?: string;
  commandVerdict?: ReviewVerdict;
  decisions: Map<string, ReviewVerdict>;
  lastDenial?: string;
}

async function canonicalize(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return resolve(path);
    return resolve(await canonicalize(parent), basename(path));
  }
}

function toolDescription(name: string, params: unknown): string {
  const serialized = JSON.stringify(params);
  return `${name}: ${serialized.length > 4_000 ? `${serialized.slice(0, 4_000)}…` : serialized}`;
}

function createReadOperations(vm: VM, workspace: string): ReadOperations {
  return {
    readFile: (path) => vm.fs.readFile(agentPathToGuest(workspace, path)),
    access: (path) => vm.fs.access(agentPathToGuest(workspace, path)),
    detectImageMimeType: async (path) => {
      const extension = extname(path).toLowerCase();
      if (extension === ".png") return "image/png";
      if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
      if (extension === ".gif") return "image/gif";
      if (extension === ".webp") return "image/webp";
      return null;
    },
  };
}

function createWriteOperations(vm: VM, workspace: string): WriteOperations {
  return {
    writeFile: (path, content) =>
      vm.fs.writeFile(agentPathToGuest(workspace, path), content, {
        encoding: "utf8",
      }),
    mkdir: (path) => vm.fs.mkdir(agentPathToGuest(workspace, path), { recursive: true }),
  };
}

function createEditOperations(vm: VM, workspace: string): EditOperations {
  const read = createReadOperations(vm, workspace);
  const write = createWriteOperations(vm, workspace);
  return {
    readFile: read.readFile,
    access: read.access,
    writeFile: write.writeFile,
  };
}

function hostWorkingDirectory(workspace: string, cwd: string): string {
  const mapped = guestPathToHost(workspace, cwd);
  if (mapped) return mapped;
  const absoluteCwd = resolve(cwd);
  const relativeCwd = relative(resolve(workspace), absoluteCwd);
  return relativeCwd === "" || (!relativeCwd.startsWith("..") && !isAbsolute(relativeCwd))
    ? absoluteCwd
    : workspace;
}

async function executeHostBash(
  pi: ExtensionAPI,
  workspace: string,
  command: HostCommand,
  cwd: string,
  options: Parameters<BashOperations["exec"]>[2],
): Promise<{ exitCode: number }> {
  const result = await pi.exec(command.executable, command.args, {
    cwd: hostWorkingDirectory(workspace, cwd),
    signal: options.signal,
    timeout: options.timeout ? options.timeout * 1_000 : undefined,
  });
  if (result.stdout) options.onData(Buffer.from(result.stdout));
  if (result.stderr) options.onData(Buffer.from(result.stderr));
  if (options.signal?.aborted) throw new Error("aborted");
  if (result.killed && options.timeout) throw new Error(`timeout:${options.timeout}`);
  return { exitCode: result.code };
}

async function executeBash(
  vm: VM,
  workspace: string,
  command: string,
  cwd: string,
  options: Parameters<BashOperations["exec"]>[2],
): Promise<{ exitCode: number }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timer = options.timeout
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeout * 1_000)
    : undefined;
  try {
    const process = vm.exec(["/bin/bash", "-lc", command], {
      cwd: agentPathToGuest(workspace, cwd),
      signal: controller.signal,
      stdout: "pipe",
      stderr: "pipe",
    });
    for await (const chunk of process.output()) options.onData(chunk.data);
    const result = await process;
    return { exitCode: result.exitCode };
  } catch (error) {
    if (options.signal?.aborted) throw new Error("aborted");
    if (timedOut) throw new Error(`timeout:${options.timeout}`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

export default function guardianExtension(pi: ExtensionAPI): void {
  const workspace = process.cwd();
  const workspaceRead = createReadTool(GUEST_WORKSPACE);
  const workspaceWrite = createWriteTool(GUEST_WORKSPACE);
  const workspaceEdit = createEditTool(GUEST_WORKSPACE);
  const workspaceBash = createBashTool(GUEST_WORKSPACE);
  const hostRead = createReadTool(workspace);
  const hostWrite = createWriteTool(workspace);
  const hostEdit = createEditTool(workspace);
  const hostBash = createBashTool(workspace);
  let config: GuardianConfig = { ...DEFAULT_GUARDIAN_CONFIG };
  const configReady = loadGuardianConfig().then((loaded) => {
    config = loaded;
    return loaded;
  });
  let vm: VM | undefined;
  let vmStarting: Promise<VM> | undefined;
  let vmStartupError: string | undefined;
  let activeExecution: ActiveExecution | undefined;
  let queue = Promise.resolve();

  async function promptReview(ctx: ExtensionContext, action: ReviewAction): Promise<ReviewVerdict> {
    if (!ctx.hasUI) {
      return {
        riskLevel: "high",
        userAuthorization: "unknown",
        outcome: "deny",
        rationale: "Manual Guardian approval is unavailable in this mode.",
      };
    }
    const approved = await ctx.ui.confirm("Guardian approval required", formatReviewPrompt(action));
    return enforceReviewPolicy(action, {
      riskLevel: "high",
      userAuthorization: approved ? "high" : "unknown",
      outcome: approved ? "allow" : "deny",
      rationale: approved
        ? "The user approved this action manually."
        : "The user denied this action manually.",
    });
  }

  async function performReview(
    ctx: ExtensionContext,
    action: ReviewAction,
    signal?: AbortSignal,
  ): Promise<ReviewVerdict> {
    const currentConfig = await configReady;
    if (currentConfig.mode === "disabled") {
      return {
        riskLevel: "low",
        userAuthorization: "high",
        outcome: "allow",
        rationale: "Guardian is disabled; Pi's default allow-all behavior is active.",
      };
    }

    ctx.ui.setStatus("guardian", "Guardian: reviewing");
    const verdict =
      currentConfig.mode === "prompt"
        ? await promptReview(ctx, action)
        : await reviewAction(ctx, action, signal, currentConfig);
    pi.appendEntry("guardian-review", {
      action,
      verdict,
      mode: currentConfig.mode,
      model: currentConfig.mode === "auto-approve" ? currentConfig.model : undefined,
      effort: currentConfig.mode === "auto-approve" ? currentConfig.effort : undefined,
      timestamp: Date.now(),
    });
    ctx.ui.notify(
      formatReviewNotification(action, verdict, currentConfig.mode),
      verdict.outcome === "allow" ? "info" : "error",
    );
    ctx.ui.setStatus(
      "guardian",
      verdict.outcome === "deny" &&
          /unavailable|authentication|review failed/i.test(verdict.rationale)
        ? "Guardian: reviewer unavailable"
        : formatGuardianStatus(currentConfig),
    );
    return verdict;
  }

  async function authorize(action: ReviewAction): Promise<boolean> {
    const execution = activeExecution;
    if (!execution) return false;
    const reviewActionForExecution =
      execution.command && (action.kind === "file" || action.kind === "network")
        ? {
            kind: "tool" as const,
            operation: "bash",
            target: "bash",
            details: execution.command,
          }
        : action;
    const key = JSON.stringify(reviewActionForExecution);
    let verdict =
      reviewActionForExecution.operation === "bash"
        ? execution.commandVerdict
        : execution.decisions.get(key);
    if (!verdict) {
      verdict = await performReview(execution.ctx, reviewActionForExecution, execution.signal);
      if (reviewActionForExecution.operation === "bash") execution.commandVerdict = verdict;
      else execution.decisions.set(key, verdict);
    }
    if (verdict.outcome === "deny") {
      execution.lastDenial = verdict.rationale;
      return false;
    }
    return true;
  }

  async function updateConfig(
    patch: Partial<GuardianConfig>,
    ctx: ExtensionContext,
  ): Promise<GuardianConfig> {
    await configReady;
    config = { ...config, ...patch };
    await saveGuardianConfig(config);
    pi.appendEntry("guardian-config", {
      ...config,
      timestamp: Date.now(),
    });
    ctx.ui.setStatus("guardian", formatGuardianStatus(config));
    ctx.ui.notify(
      `Guardian ${patch.mode ? "mode" : "reviewer"} updated: ${
        patch.mode ?? `${config.model} (${config.effort})`
      }`,
      "info",
    );
    return config;
  }

  pi.registerCommand("guardian-mode", {
    description: "Set Guardian mode: disabled, auto-approve, or prompt",
    handler: async (args, ctx) => {
      await configReady;
      const value = args.trim();
      if (!value) {
        ctx.ui.notify(`Guardian mode: ${config.mode}`, "info");
        return;
      }
      if (!("disabled" === value || "auto-approve" === value || "prompt" === value)) {
        ctx.ui.notify("Usage: /guardian-mode disabled|auto-approve|prompt", "error");
        return;
      }
      await updateConfig({ mode: value as GuardianMode }, ctx);
    },
  });

  pi.registerCommand("guardian-model", {
    description: "Set Guardian reviewer model and effort",
    handler: async (args, ctx) => {
      await configReady;
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        ctx.ui.notify(
          `Guardian reviewer: ${config.model} (${config.effort})\nUsage: /guardian-model <model> [effort]`,
          "info",
        );
        return;
      }
      if (parts.length > 2) {
        ctx.ui.notify(
          "Usage: /guardian-model <model> [minimal|low|medium|high|xhigh|max]",
          "error",
        );
        return;
      }
      const effort = parts[1] as GuardianEffort | undefined;
      if (effort && !["minimal", "low", "medium", "high", "xhigh", "max"].includes(effort)) {
        ctx.ui.notify("Effort must be minimal, low, medium, high, xhigh, or max.", "error");
        return;
      }
      await updateConfig({ model: parts[0]!, ...(effort ? { effort } : {}) }, ctx);
    },
  });

  async function guardFileAccess(context: VfsHookContext): Promise<void> {
    const paths = [context.path, context.oldPath, context.newPath].filter(
      (path): path is string => path !== undefined,
    );
    for (const guestPath of paths) {
      const hostPath = guestPathToHost(workspace, guestPath);
      if (!hostPath) continue;
      if (context.op === "symlink")
        throw new Error("Guardian blocks host-visible symlink creation");
      const canonicalPath = await canonicalize(hostPath);
      const operation = fileOperationForVfs(context);
      if (classifyFileAccess(workspace, canonicalPath, operation) === "allow") continue;
      const allowed = await authorize({
        kind: "file",
        operation,
        target: canonicalPath,
        details: activeExecution?.description,
      });
      if (!allowed) throw new Error(`Guardian denied ${operation} access to ${canonicalPath}`);
    }
  }

  async function guardNetworkRequest(request: Request): Promise<Request | Response | void> {
    const body = request.body ? (await request.clone().text()).slice(0, 8_000) : undefined;
    const allowed = await authorize({
      kind: "network",
      operation: request.method,
      target: request.url,
      details: [activeExecution?.description, body && `Body: ${body}`].filter(Boolean).join("\n"),
    });
    if (!allowed) {
      throw new HttpRequestBlockedError(
        activeExecution?.lastDenial ?? "Guardian denied network access",
      );
    }
  }

  async function startVm(ctx?: ExtensionContext): Promise<VM> {
    const { httpHooks } = createHttpHooks({ onRequest: guardNetworkRequest });
    const created = await VM.create({
      sessionLabel: `pi guardian ${basename(workspace)}`,
      httpHooks,
      dns: { mode: "synthetic", syntheticHostMapping: "per-host" },
      allowWebSockets: false,
      vfs: {
        mounts: {
          [GUEST_WORKSPACE]: new RealFSProvider(workspace),
          [GUEST_HOST]: new RealFSProvider(parse(workspace).root),
        },
        hooks: { before: guardFileAccess },
      },
    });
    vm = created;
    if (ctx) ctx.ui.setStatus("guardian", formatGuardianStatus(config));
    ctx?.ui.notify(
      "Guardian started. Workspace access is automatic; sensitive, external-file, network, and host-tool actions are reviewed.",
      "info",
    );
    return created;
  }

  async function ensureVm(ctx?: ExtensionContext): Promise<VM> {
    if (vm) return vm;
    if (vmStartupError) throw new Error(vmStartupError);
    vmStarting ??= startVm(ctx)
      .catch((error) => {
        vmStartupError = formatVmUnavailable(error);
        ctx?.ui.notify(vmStartupError, "error");
        throw new Error(vmStartupError);
      })
      .finally(() => {
        vmStarting = undefined;
      });
    return vmStarting;
  }

  async function runSerialized<T>(
    ctx: ExtensionContext,
    description: string,
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
    command?: string,
  ): Promise<T> {
    const previous = queue;
    let release = () => {};
    queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    activeExecution = {
      ctx,
      description,
      signal,
      command,
      decisions: new Map(),
    };
    try {
      const result = await work();
      if (activeExecution.lastDenial) {
        throw new Error(`Guardian denied access: ${activeExecution.lastDenial}`);
      }
      return result;
    } finally {
      activeExecution = undefined;
      release();
    }
  }

  pi.registerTool({
    ...workspaceRead,
    async execute(id, params, signal, onUpdate, ctx) {
      if ((await configReady).mode === "disabled")
        return hostRead.execute(id, params, signal, onUpdate);
      return runSerialized(ctx, toolDescription("read", params), signal, async () => {
        const activeVm = await ensureVm(ctx);
        return createReadTool(GUEST_WORKSPACE, {
          operations: createReadOperations(activeVm, workspace),
        }).execute(
          id,
          { ...params, path: agentPathToGuest(workspace, params.path) },
          signal,
          onUpdate,
        );
      });
    },
  });

  pi.registerTool({
    ...workspaceWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      if ((await configReady).mode === "disabled")
        return hostWrite.execute(id, params, signal, onUpdate);
      return runSerialized(ctx, toolDescription("write", params), signal, async () => {
        const activeVm = await ensureVm(ctx);
        return createWriteTool(GUEST_WORKSPACE, {
          operations: createWriteOperations(activeVm, workspace),
        }).execute(
          id,
          { ...params, path: agentPathToGuest(workspace, params.path) },
          signal,
          onUpdate,
        );
      });
    },
  });

  pi.registerTool({
    ...workspaceEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      if ((await configReady).mode === "disabled")
        return hostEdit.execute(id, params, signal, onUpdate);
      return runSerialized(ctx, toolDescription("edit", params), signal, async () => {
        const activeVm = await ensureVm(ctx);
        return createEditTool(GUEST_WORKSPACE, {
          operations: createEditOperations(activeVm, workspace),
        }).execute(
          id,
          { ...params, path: agentPathToGuest(workspace, params.path) },
          signal,
          onUpdate,
        );
      });
    },
  });

  pi.registerTool({
    ...workspaceBash,
    async execute(id, params, signal, onUpdate, ctx) {
      if ((await configReady).mode === "disabled")
        return hostBash.execute(id, params, signal, onUpdate);
      return runSerialized(
        ctx,
        params.command,
        signal,
        async () => {
          const hostCommand = parseHostCommand(params.command);
          if (hostCommand) {
            const allowed = await authorize({
              kind: "tool",
              operation: "host-bash",
              target: hostCommand.executable,
              details: params.command,
            });
            if (!allowed) throw new Error(`Guardian denied host command: ${params.command}`);
            const tool = createBashTool(GUEST_WORKSPACE, {
              operations: {
                exec: (_command, cwd, options) =>
                  executeHostBash(pi, workspace, hostCommand, cwd, options),
              },
            });
            return tool.execute(id, params, signal, onUpdate);
          }

          const activeVm = await ensureVm(ctx);
          const tool = createBashTool(GUEST_WORKSPACE, {
            operations: {
              exec: (command, cwd, options) =>
                executeBash(activeVm, workspace, command, cwd, options),
            },
          });
          return tool.execute(id, params, signal, onUpdate);
        },
        params.command,
      );
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    const currentConfig = await configReady;
    if (currentConfig.mode === "disabled") return;
    if (SANDBOXED_TOOLS.has(event.toolName)) return;
    if (BLOCKED_HOST_TOOLS.has(event.toolName)) {
      if (currentConfig.mode === "prompt") {
        const verdict = await performReview(
          ctx,
          {
            kind: "tool",
            operation: event.toolName,
            target: event.toolName,
            details: JSON.stringify(event.input).slice(0, 8_000),
          },
          ctx.signal,
        );
        if (verdict.outcome === "deny") return { block: true, reason: verdict.rationale };
        return;
      }
      return {
        block: true,
        reason: `${event.toolName} is disabled on the host; use bash inside Gondolin instead.`,
      };
    }
    const verdict = await performReview(
      ctx,
      {
        kind: "tool",
        operation: event.toolName,
        target: event.toolName,
        details: JSON.stringify(event.input).slice(0, 8_000),
      },
      ctx.signal,
    );
    if (verdict.outcome === "deny") return { block: true, reason: verdict.rationale };
  });

  pi.on("user_bash", async (event, ctx) => {
    if ((await configReady).mode === "disabled") return;
    return {
      operations: {
        exec(command, cwd, options) {
          return runSerialized(
            ctx,
            event.command,
            options.signal,
            async () => {
              const hostCommand = parseHostCommand(command);
              if (hostCommand) {
                const allowed = await authorize({
                  kind: "tool",
                  operation: "host-bash",
                  target: hostCommand.executable,
                  details: command,
                });
                if (!allowed) throw new Error(`Guardian denied host command: ${command}`);
                return executeHostBash(pi, workspace, hostCommand, cwd, options);
              }

              const activeVm = await ensureVm(ctx);
              return executeBash(activeVm, workspace, command, cwd, options);
            },
            command,
          );
        },
      },
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    const currentConfig = await configReady;
    ctx.ui.setStatus("guardian", formatGuardianStatus(currentConfig));
  });

  pi.on("session_shutdown", async () => {
    const activeVm = vm;
    vm = undefined;
    if (activeVm) await activeVm.close();
  });

  pi.on("before_agent_start", async (event) => {
    const currentConfig = await configReady;
    return {
      systemPrompt: `${event.systemPrompt}\n\nGuardian:\n- Mode: ${currentConfig.mode}. Change it with /guardian-mode disabled|auto-approve|prompt.\n- Reviewer: ${currentConfig.model} (${currentConfig.effort}). Change it with /guardian-model <model> [effort].\n- In protected modes, ordinary commands run lazily in a Gondolin VM with ${GUEST_WORKSPACE} mapped read-write to ${workspace}.\n- The exact command gh ... is the only host bash allowlist entry and requires Guardian approval before using host credentials.\n- Use ${GUEST_HOST}<absolute-host-path> for files outside the workspace; each access is automatically reviewed.\n- Network requests and non-sandboxed tools are automatically reviewed.\n- Do not use ~ for host files because it refers to the VM's home directory.`,
    };
  });
}
