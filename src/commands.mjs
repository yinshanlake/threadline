import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findScope } from "./model.mjs";

const execFileAsync = promisify(execFile);

export const SLASH_COMMANDS = Object.freeze([
  { name: "help", description: "list Threadline and provider commands" },
  { name: "status", description: "show session configuration and token usage" },
  { name: "model", usage: "[MODEL [EFFORT]]", description: "list or choose model and reasoning effort" },
  { name: "permissions", usage: "[PROFILE]", description: "list or choose a Codex permission profile" },
  { name: "personality", usage: "[none|friendly|pragmatic]", description: "show or choose communication style" },
  { name: "plan", usage: "[PROMPT]", description: "switch to Plan mode; optionally send a prompt" },
  { name: "default", usage: "[PROMPT]", description: "return to Default mode; optionally send a prompt" },
  { name: "compact", description: "compact the active Codex thread context" },
  { name: "review", usage: "[INSTRUCTIONS]", description: "review uncommitted changes or use custom instructions" },
  { name: "rename", usage: "NAME", description: "rename the active Codex thread" },
  { name: "mcp", usage: "[verbose]", description: "list configured MCP servers and tools" },
  { name: "skills", usage: "[FILTER]", description: "list available Codex skills" },
  { name: "usage", description: "show account usage and rate limits when available" },
  { name: "init", description: "ask Codex to create an AGENTS.md file" },
  { name: "diff", description: "show git diff, including untracked files" },
  { name: "new", description: "start a new root provider session in Threadline" },
  { name: "copy", description: "show the last response in a copy-friendly panel" },
  { name: "threads", description: "show Threadline deep-dive threads" },
  { name: "back", description: "return to the parent Threadline scope" },
  { name: "quit", description: "save and exit Threadline" },
  { name: "exit", description: "save and exit Threadline" },
]);

const CODEX_TUI_ONLY = new Set([
  "app", "apps", "approve", "archive", "agent", "btw", "clear", "debug-config",
  "delete", "experimental", "feedback", "fork", "hooks", "ide", "import", "keymap",
  "memories", "mention", "multi-agents", "pet", "pets", "plugins", "ps", "raw",
  "resume", "sandbox-add-read-dir", "setup-default-sandbox", "side", "statusline", "stop",
  "subagents", "theme", "title", "vim",
]);

export const THREADLINE_SLASH_NAMES = new Set([
  "help", "status", "diff", "new", "copy", "threads", "back", "quit", "exit",
]);

function parse(input) {
  const match = String(input).trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/u);
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}

function formatNumber(value) {
  return typeof value === "number" ? new Intl.NumberFormat("en-US").format(value) : "unknown";
}

function permissionLabel(value) {
  return ({ ":read-only": "read-only", ":workspace": "workspace", ":danger-full-access": "danger-full-access" })[value] ?? value;
}

function normalizePermission(value) {
  const key = value.toLowerCase();
  return ({ "read-only": ":read-only", readonly: ":read-only", workspace: ":workspace", "workspace-write": ":workspace", danger: ":danger-full-access", full: ":danger-full-access", "danger-full-access": ":danger-full-access" })[key] ?? value;
}

function claudeNativeCommand(controller, name) {
  if (controller.conversation.provider !== "claude") return false;
  if (THREADLINE_SLASH_NAMES.has(name)) return false;
  const scope = findScope(controller.conversation, controller.conversation.activeScopeId);
  const commands = scope?.providerState?.slashCommands;
  if (Array.isArray(commands)) return commands.includes(name);
  return controller.provider.slashCommands?.has(name) ?? false;
}

async function discoverClaudeCommands(controller) {
  if (controller.conversation.provider !== "claude" || typeof controller.provider.discoverSlashCommands !== "function") return;
  const scope = await activeScope(controller);
  if (Array.isArray(scope.providerState?.slashCommands)) return;
  const commands = await controller.provider.discoverSlashCommands();
  scope.providerState = { ...scope.providerState, slashCommands: [...commands] };
  controller.persist();
}

function providerUnavailable(controller, name) {
  const provider = controller.conversation.provider;
  if (provider === "claude") {
    if (THREADLINE_SLASH_NAMES.has(name) || claudeNativeCommand(controller, name)) return null;
    const known = SLASH_COMMANDS.some((command) => command.name === name) || CODEX_TUI_ONLY.has(name);
    if (!known) return null;
    return { handled: true, title: `/${name}`, output: `/${name} is not exposed by the Claude Code stream-json adapter.`, message: "Command unavailable with Claude Code" };
  }
  if (provider !== "demo") return null;
  if (["status", "copy", "model", "permissions", "personality", "plan", "default", "mcp", "skills", "usage", "rename"].includes(name)) return null;
  return { handled: true, title: `/${name}`, output: "This Codex command is unavailable in demo mode.", message: "Codex command unavailable in demo mode" };
}

function commandHelp(controller) {
  return controller.slashCommands().map((command) => {
    const invocation = `/${command.name}${command.usage ? ` ${command.usage}` : ""}`;
    return `${invocation.padEnd(34)} ${command.description}`;
  }).join("\n");
}

function lastAssistant(scope) {
  return [...(scope?.turns ?? [])].reverse().find((turn) => turn.assistant?.text)?.assistant?.text ?? "No assistant response in this scope.";
}

function statusOutput(controller, scope) {
  const state = scope.providerState ?? {};
  const usage = scope.tokenUsage ?? {};
  const total = usage.total ?? {};
  const window = usage.modelContextWindow;
  const used = total.totalTokens;
  const percent = typeof used === "number" && typeof window === "number" && window > 0 ? `${((used / window) * 100).toFixed(1)}%` : "unknown";
  return [
    `Threadline scope: ${scope.id}`,
    `${controller.providerLabel()} session: ${scope.providerThreadId ?? "not started"}`,
    `Model: ${state.model ?? "unknown"}${state.effort ? ` (${state.effort})` : ""}`,
    `Mode: ${state.collaborationMode?.mode ?? "default"}`,
    `Personality: ${state.personality ?? "default"}`,
    `Permissions: ${permissionLabel(state.permissions ?? state.activePermissionProfile?.id ?? "unknown")}`,
    `Approval policy: ${state.approvalPolicy ?? "unknown"}`,
    `CWD: ${state.cwd ?? controller.conversation.cwd}`,
    `Context: ${formatNumber(used)} / ${formatNumber(window)} tokens (${percent})`,
    `Last turn: ${formatNumber(usage.last?.totalTokens)} tokens`,
  ].join("\n");
}

async function activeScope(controller, { ensure = true } = {}) {
  const id = controller.conversation.activeScopeId;
  return ensure ? controller.ensureScope(id) : findScope(controller.conversation, id);
}

function requireIdle(scope, command) {
  if ((scope?.turns ?? []).some((turn) => turn.assistant?.status === "streaming")) throw new Error(`/${command} is disabled while a task is in progress`);
}

async function listModels(controller, args, scope) {
  const response = await controller.provider.request("model/list", { cursor: null, limit: 100, includeHidden: false });
  const models = response.data ?? [];
  if (!args) {
    const output = models.map((model) => `${model.isDefault ? "*" : " "} ${model.model.padEnd(22)} ${model.displayName}  [${(model.supportedReasoningEfforts ?? []).map((item) => item.reasoningEffort).join(", ")}]`).join("\n") || "No models returned by Codex.";
    return {
      output,
      picker: models.length ? {
        kind: "model",
        models,
        currentModel: scope.providerState?.model ?? null,
        currentEffort: scope.providerState?.effort ?? null,
      } : null,
    };
  }
  const [modelName, effort] = args.split(/\s+/u);
  const model = models.find((item) => item.model.toLowerCase() === modelName.toLowerCase() || item.id.toLowerCase() === modelName.toLowerCase());
  if (!model) throw new Error(`Unknown model: ${modelName}. Run /model to list models.`);
  const allowed = model.supportedReasoningEfforts.map((item) => item.reasoningEffort);
  const selectedEffort = effort || model.defaultReasoningEffort;
  if (effort && !allowed.includes(effort)) throw new Error(`${model.model} supports: ${allowed.join(", ")}`);
  await controller.provider.updateThreadSettings(scope.providerThreadId, { model: model.model, effort: selectedEffort });
  scope.providerState = { ...scope.providerState, model: model.model, effort: selectedEffort };
  controller.persist();
  return { output: `Model changed to ${model.model} (${selectedEffort}).` };
}

async function setMode(controller, mode, prompt) {
  const response = await controller.provider.request("collaborationMode/list", {});
  const preset = (response.data ?? []).find((item) => item.mode === mode);
  if (!preset) throw new Error(`${mode} mode is unavailable in this Codex build.`);
  const scope = await activeScope(controller);
  const model = preset.model ?? scope.providerState?.model;
  if (!model) throw new Error("Codex did not report the active model. Run /model MODEL first.");
  const effort = preset.reasoning_effort ?? scope.providerState?.effort ?? null;
  const collaborationMode = { mode, settings: { model, reasoning_effort: effort, developer_instructions: null } };
  await controller.provider.updateThreadSettings(scope.providerThreadId, { collaborationMode });
  scope.providerState = { ...scope.providerState, model, effort, collaborationMode };
  controller.persist();
  let turn = null;
  if (prompt) turn = await controller.send(scope.id, prompt);
  return { output: `${mode === "plan" ? "Plan" : "Default"} mode enabled.${prompt ? ` Sent: ${prompt}` : ""}`, turn };
}

function formatMcp(response, verbose) {
  const servers = response.data ?? [];
  if (!servers.length) return "No MCP servers configured.";
  return servers.map((server) => {
    const tools = Object.keys(server.tools ?? {});
    const base = `${server.name}  auth=${server.authStatus ?? "unknown"}  tools=${tools.length}`;
    if (!verbose) return base;
    return `${base}${tools.length ? `\n  ${tools.join("\n  ")}` : ""}`;
  }).join("\n\n");
}

function formatSkills(response, filter) {
  const query = filter.toLowerCase();
  const entries = (response.data ?? []).flatMap((entry) => entry.skills ?? entry.data ?? []);
  const shown = entries.filter((skill) => !query || `${skill.name} ${skill.description}`.toLowerCase().includes(query));
  return shown.map((skill) => `${skill.enabled === false ? "-" : "+"} ${skill.name}  ${skill.description ?? ""}`).join("\n") || "No matching skills.";
}

function formatUsage(rateLimits, usage) {
  const lines = [];
  const summary = usage?.summary ?? {};
  if (Object.keys(summary).length) {
    lines.push(`Lifetime tokens: ${formatNumber(summary.lifetimeTokens)}`);
    lines.push(`Peak daily tokens: ${formatNumber(summary.peakDailyTokens)}`);
    lines.push(`Current streak: ${formatNumber(summary.currentStreakDays)} days`);
  }
  const limits = rateLimits?.rateLimits ?? null;
  if (limits) lines.push(`Rate limits: ${JSON.stringify(limits, null, 2)}`);
  return lines.join("\n") || "No account usage data returned.";
}

export async function executeSlashCommand(controller, input) {
  const parsed = parse(input);
  if (!parsed) return { handled: false };
  const { name, args } = parsed;
  if (["quit", "exit"].includes(name)) return { handled: true, quit: true };
  if (name === "help") {
    await discoverClaudeCommands(controller);
    return { handled: true, title: "Slash commands", output: commandHelp(controller), message: "Slash command help" };
  }
  if (name === "back") { controller.goToParent(); return { handled: true, message: "Opened parent scope" }; }
  if (name === "threads") return { handled: true, action: "threads", message: "Thread overview" };
  await discoverClaudeCommands(controller);
  const unavailable = providerUnavailable(controller, name);
  if (unavailable && !claudeNativeCommand(controller, name)) return unavailable;
  if (claudeNativeCommand(controller, name)) {
    const scope = await activeScope(controller);
    requireIdle(scope, name);
    const turn = await controller.send(scope.id, input);
    return { handled: true, turn, message: `Running Claude Code /${name}` };
  }
  if (CODEX_TUI_ONLY.has(name)) return { handled: true, title: `/${name}`, output: `/${name} is implemented by the original Codex TUI and is not exposed as a portable app-server command. Threadline did not send it to the model.`, message: `/${name} is Codex-TUI-only` };

  if (name === "new") {
    const scope = findScope(controller.conversation, controller.conversation.rootScopeId);
    requireIdle(scope, name);
    scope.providerThreadId = null; scope.providerState = {}; scope.tokenUsage = null; scope.turns = [];
    scope.parentId = null; scope.anchor = null; scope.collapsed = false;
    controller.conversation.scopes = [scope];
    controller.loadedThreads.clear(); controller.scopeLoads.clear(); controller.conversation.activeScopeId = scope.id; controller.persist();
    await controller.ensureScope(scope.id);
    return { handled: true, title: "New session", output: `Started ${controller.providerLabel()} session ${scope.providerThreadId}.`, message: `New ${controller.providerLabel()} session started` };
  }

  const scope = await activeScope(controller, { ensure: !["copy", "status", "diff"].includes(name) });
  if (!scope) throw new Error("Active Threadline scope no longer exists");
  switch (name) {
    case "status":
      if (!scope.providerThreadId) await controller.ensureScope(scope.id);
      return { handled: true, title: "Status", output: statusOutput(controller, scope), message: "Session status" };
    case "copy":
      return { handled: true, title: "Last response", output: lastAssistant(scope), message: "Copy-friendly response" };
    case "model": {
      const result = await listModels(controller, args, scope);
      return { handled: true, title: "Models", ...result, message: args ? "Model updated" : "Available models" };
    }
    case "permissions": {
      const response = await controller.provider.request("permissionProfile/list", { cursor: null, limit: 100, cwd: controller.conversation.cwd });
      const profiles = (response.data ?? []).filter((item) => item.allowed);
      if (!args) return { handled: true, title: "Permissions", output: profiles.map((item) => `${permissionLabel(item.id)}${item.description ? `  ${item.description}` : ""}`).join("\n"), message: "Permission profiles" };
      const id = normalizePermission(args);
      if (!profiles.some((item) => item.id.toLowerCase() === id.toLowerCase())) throw new Error(`Unknown or disallowed permission profile: ${args}`);
      await controller.provider.updateThreadSettings(scope.providerThreadId, { permissions: id });
      scope.providerState = { ...scope.providerState, permissions: id, activePermissionProfile: { id } }; controller.persist();
      return { handled: true, title: "Permissions", output: `Permissions changed to ${permissionLabel(id)}.`, message: "Permissions updated" };
    }
    case "personality": {
      const allowed = ["none", "friendly", "pragmatic"];
      if (!args) return { handled: true, title: "Personality", output: `Current: ${scope.providerState?.personality ?? "default"}\nAvailable: ${allowed.join(", ")}`, message: "Personality settings" };
      const personality = args.toLowerCase();
      if (!allowed.includes(personality)) throw new Error(`Personality must be one of: ${allowed.join(", ")}`);
      await controller.provider.updateThreadSettings(scope.providerThreadId, { personality });
      scope.providerState = { ...scope.providerState, personality }; controller.persist();
      return { handled: true, title: "Personality", output: `Personality changed to ${personality}.`, message: "Personality updated" };
    }
    case "plan":
    case "default": {
      requireIdle(scope, name);
      const result = await setMode(controller, name, args);
      return { handled: true, title: "Mode", output: result.output, turn: result.turn, message: `${name} mode enabled` };
    }
    case "compact":
      requireIdle(scope, name); {
        const turn = controller.addCommandTurn(scope.id, input);
        controller.busyScopes.add(scope.id);
        try {
          await controller.provider.compactThread(scope.providerThreadId);
          return { handled: true, turn, message: "Compacting context…" };
        } catch (error) {
          turn.assistant.status = "failed"; controller.busyScopes.delete(scope.id); controller.persist();
          throw error;
        }
      }
    case "review": {
      requireIdle(scope, name);
      const target = args ? { type: "custom", instructions: args } : { type: "uncommittedChanges" };
      const turn = controller.addCommandTurn(scope.id, input);
      controller.busyScopes.add(scope.id);
      try {
        const response = await controller.provider.startReview(scope.providerThreadId, target);
        turn.providerTurnId = response.turnId; controller.persist();
        return { handled: true, turn, message: "Review started" };
      } catch (error) {
        turn.assistant.status = "failed"; controller.busyScopes.delete(scope.id); controller.persist();
        throw error;
      }
    }
    case "rename":
      if (!args) throw new Error("Usage: /rename NAME");
      await controller.provider.setThreadName(scope.providerThreadId, args); scope.name = args; controller.persist();
      return { handled: true, title: "Rename", output: `Thread renamed to ${args}.`, message: "Thread renamed" };
    case "mcp": {
      if (args && args.toLowerCase() !== "verbose") throw new Error("Usage: /mcp [verbose]");
      const response = await controller.provider.request("mcpServerStatus/list", { cursor: null, limit: 100, detail: args ? "full" : "toolsAndAuthOnly" }, 180_000);
      return { handled: true, title: "MCP servers", output: formatMcp(response, Boolean(args)), message: "MCP server status" };
    }
    case "skills": {
      const response = await controller.provider.request("skills/list", { cwds: [controller.conversation.cwd], forceReload: false }, 60_000);
      return { handled: true, title: "Skills", output: formatSkills(response, args), message: "Available skills" };
    }
    case "usage": {
      const settled = await Promise.allSettled([controller.provider.request("account/rateLimits/read", {}), controller.provider.request("account/usage/read", {})]);
      if (settled.every((item) => item.status === "rejected")) throw new Error(settled[0].reason?.message ?? "Account usage unavailable");
      return { handled: true, title: "Usage", output: formatUsage(settled[0].value, settled[1].value), message: "Account usage" };
    }
    case "init": {
      const prompt = "Generate a file named AGENTS.md that serves as a concise contributor guide for this repository. Before writing, check whether AGENTS.md already exists in the current working directory. If it does, do not overwrite or modify it. Inspect the repository first; cover project structure, build/test commands, coding style, testing, and commit/PR guidance where applicable.";
      const turn = await controller.send(scope.id, "/init", { providerText: prompt });
      return { handled: true, turn, message: "Creating AGENTS.md…" };
    }
    case "diff": {
      const options = { cwd: controller.conversation.cwd, windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 };
      const [{ stdout: diff }, { stdout: untracked }] = await Promise.all([
        execFileAsync("git", ["diff", "--no-ext-diff", "--binary"], options),
        execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], options),
      ]);
      const extra = untracked.trim() ? `\nUntracked files:\n${untracked.trim()}` : "";
      return { handled: true, title: "Git diff", output: diff.trim() || extra ? `${diff.trim()}${extra}`.trim() : "Working tree is clean.", message: "Git diff" };
    }
    default:
      return { handled: false };
  }
}
