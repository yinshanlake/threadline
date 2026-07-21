import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const VERSION_TIMEOUT = 10_000;
const SLASH_DISCOVERY_TIMEOUT = 20_000;
const TURN_TIMEOUT = 10 * 60_000;
const STOP_TIMEOUT = 2_000;
const ASSISTANT_COMPLETION_GRACE = 1_000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SLASH_NAME = /^[a-z0-9][a-z0-9:_-]*$/iu;

function normalizeClaudeSessionId(value) {
  const sessionId = String(value ?? "").trim().toLowerCase();
  if (!SESSION_ID.test(sessionId)) throw new Error(`Invalid Claude Code session ID: ${value}`);
  return sessionId;
}

function commandForFile(file) {
  const resolved = path.resolve(file);
  if (!existsSync(resolved)) throw new Error(`THREADLINE_CLAUDE_PATH does not exist: ${resolved}`);
  const lower = resolved.toLowerCase();
  if (process.platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
    throw new Error("THREADLINE_CLAUDE_PATH must point to claude.exe on Windows, not a shell wrapper");
  }
  return lower.endsWith(".js") || lower.endsWith(".mjs")
    ? { file: process.execPath, args: [resolved] }
    : { file: resolved, args: [] };
}

function defaultCommand() {
  if (process.env.THREADLINE_CLAUDE_PATH) return commandForFile(process.env.THREADLINE_CLAUDE_PATH);
  if (process.platform !== "win32") return { file: "claude", args: [] };

  const directories = (process.env.Path || process.env.PATH || "")
    .split(path.delimiter)
    .filter((entry) => entry && path.isAbsolute(entry));
  const candidates = [
    ...directories.map((directory) => path.join(directory, "claude.exe")),
    path.join(os.homedir(), ".local", "bin", "claude.exe"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { file: candidate, args: [] };
  }
  return { file: "claude.exe", args: [] };
}

function activityForTool(block = {}) {
  const name = block.name || "tool";
  const input = block.input ?? {};
  if (name === "Bash") {
    return { id: block.id, type: "commandExecution", command: input.command, cwd: input.cwd, status: "inProgress", input };
  }
  if (["Edit", "Write", "NotebookEdit"].includes(name)) {
    const target = input.file_path || input.notebook_path;
    return {
      id: block.id,
      type: "fileChange",
      status: "inProgress",
      changes: target ? [{ type: name.toLowerCase(), path: target }] : [],
      input,
    };
  }
  if (name === "WebSearch") return { id: block.id, type: "webSearch", query: input.query, status: "inProgress", input };
  if (name.startsWith("mcp__")) {
    const [, server = "mcp", ...tool] = name.split("__");
    return { id: block.id, type: "mcpToolCall", server, tool: tool.join("__") || "tool", arguments: input, status: "inProgress" };
  }
  return { id: block.id, type: "dynamicToolCall", tool: name, arguments: input, status: "inProgress" };
}

function usageEvent(message = {}) {
  const usage = message.usage ?? {};
  const input = Number(usage.input_tokens ?? 0)
    + Number(usage.cache_creation_input_tokens ?? 0)
    + Number(usage.cache_read_input_tokens ?? 0);
  const output = Number(usage.output_tokens ?? 0);
  if (!input && !output) return null;
  return {
    total: { inputTokens: input, outputTokens: output, totalTokens: input + output },
    last: { inputTokens: input, outputTokens: output, totalTokens: input + output },
    modelContextWindow: null,
  };
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content.every((entry) => entry?.type === "text" && typeof entry.text === "string")) {
    return content.map((entry) => entry.text).join("\n");
  }
  try { return JSON.stringify(content ?? "", null, 2); } catch { return String(content ?? ""); }
}

function normalizeSlashCommands(commands) {
  if (!Array.isArray(commands)) return [];
  const names = commands.map((command) => typeof command === "string" ? command : command?.name);
  return [...new Set(names
    .filter((name) => typeof name === "string" && SLASH_NAME.test(name))
    .map((name) => name.toLowerCase()))];
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    const onSpawn = () => { child.off("error", onError); resolve(); };
    const onError = (error) => { child.off("spawn", onSpawn); reject(error); };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

export class ClaudeProvider extends EventEmitter {
  constructor({
    command = null,
    cwd = process.cwd(),
    yolo = false,
    versionTimeout = VERSION_TIMEOUT,
    slashDiscoveryTimeout = SLASH_DISCOVERY_TIMEOUT,
    turnTimeout = TURN_TIMEOUT,
    stopTimeout = STOP_TIMEOUT,
    assistantCompletionGrace = ASSISTANT_COMPLETION_GRACE,
  } = {}) {
    super();
    this.name = "claude";
    this.displayName = "Claude Code";
    this.forkMode = "tail-only";
    this.command = command ?? defaultCommand();
    this.cwd = cwd;
    this.yolo = yolo;
    this.versionTimeout = versionTimeout;
    this.slashDiscoveryTimeout = slashDiscoveryTimeout;
    this.turnTimeout = turnTimeout;
    this.stopTimeout = stopTimeout;
    this.assistantCompletionGrace = assistantCompletionGrace;
    this.initialized = null;
    this.connectPromise = null;
    this.forkBases = new Map();
    this.freshThreads = new Set();
    this.active = new Map();
    this.slashCommands = new Set();
    this.slashCommandsDiscovered = false;
    this.slashDiscoveryPromise = null;
    this.closed = false;
  }

  async connect() {
    if (this.initialized) return this.initialized;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.#readVersion();
    try {
      this.initialized = await this.connectPromise;
      return this.initialized;
    } finally {
      this.connectPromise = null;
    }
  }

  async #readVersion() {
    const child = spawn(this.command.file, [...(this.command.args ?? []), "--version"], {
      cwd: this.cwd, env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Claude Code version check timed out"));
      }, this.versionTimeout);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    if (result.code !== 0) {
      throw new Error(`Claude Code version check failed (${result.signal || result.code}): ${stderr.trim() || "no error output"}`);
    }
    const version = stdout.trim();
    return { platformFamily: process.platform, userAgent: version || "Claude Code", version, providerName: "claude" };
  }

  async discoverSlashCommands() {
    await this.connect();
    if (this.slashCommandsDiscovered) return [...this.slashCommands];
    if (this.slashDiscoveryPromise) return this.slashDiscoveryPromise;
    this.slashDiscoveryPromise = this.#probeSlashCommands();
    try {
      const commands = await this.slashDiscoveryPromise;
      this.slashCommands = new Set(commands);
      this.slashCommandsDiscovered = true;
      return commands;
    } finally {
      this.slashDiscoveryPromise = null;
    }
  }

  async #probeSlashCommands() {
    if (this.closed) throw new Error("Claude Code provider is closed");
    const args = [
      ...(this.command.args ?? []),
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--permission-mode", "dontAsk",
    ];
    const child = spawn(this.command.file, args, {
      cwd: this.cwd, env: process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    return new Promise((resolve, reject) => {
      let stdoutBuffer = "";
      let stderr = "";
      let commands = null;
      let spawnError = null;
      let stopTimer = null;
      const timeout = setTimeout(() => {
        try { child.kill(); } catch {}
      }, this.slashDiscoveryTimeout);
      timeout.unref?.();
      const stop = () => {
        try { child.kill(); } catch {}
        stopTimer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch {}
        }, this.stopTimeout);
        stopTimer.unref?.();
      };
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk;
        while (true) {
          const newline = stdoutBuffer.indexOf("\n");
          if (newline < 0) break;
          const line = stdoutBuffer.slice(0, newline).trim();
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (!line) continue;
          try {
            const message = JSON.parse(line);
            if (message.type === "system" && message.subtype === "init" && Array.isArray(message.slash_commands)) {
              commands = normalizeSlashCommands(message.slash_commands);
              clearTimeout(timeout);
              stop();
              break;
            }
          } catch {}
        }
      });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", (error) => { spawnError = error; });
      child.once("close", () => {
        clearTimeout(timeout);
        clearTimeout(stopTimer);
        if (commands) resolve(commands);
        else if (spawnError) reject(spawnError);
        else reject(new Error(`Claude Code slash-command discovery failed: ${stderr.trim() || "no command catalog returned"}`));
      });
      child.stdin.end("/__threadline_command_catalog__");
    });
  }

  async startThread({ cwd = this.cwd } = {}) {
    await this.connect();
    const threadId = randomUUID();
    this.freshThreads.add(threadId);
    return { threadId, state: this.#state(cwd, { pendingSession: true, forkFrom: null }) };
  }

  async resumeThread(threadId, { cwd = this.cwd, state } = {}) {
    await this.connect();
    const normalized = normalizeClaudeSessionId(threadId);
    const suppliedState = state && typeof state === "object" ? state : null;
    const forkFrom = suppliedState?.pendingSession && suppliedState?.forkFrom
      ? normalizeClaudeSessionId(suppliedState.forkFrom)
      : null;
    if (forkFrom) this.forkBases.set(normalized, forkFrom);
    else if (suppliedState?.pendingSession) this.freshThreads.add(normalized);
    else {
      this.forkBases.delete(normalized);
      this.freshThreads.delete(normalized);
    }
    return {
      threadId: normalized,
      state: this.#state(cwd, {
        pendingSession: Boolean(suppliedState?.pendingSession),
        forkFrom,
      }),
    };
  }

  async forkThread(threadId, _lastTurnId, { cwd = this.cwd } = {}) {
    await this.connect();
    const source = normalizeClaudeSessionId(threadId);
    const target = randomUUID();
    this.forkBases.set(target, source);
    return {
      threadId: target,
      state: this.#state(cwd, { pendingSession: true, forkFrom: source }),
    };
  }

  async send(threadId, text) {
    await this.connect();
    if (this.closed) throw new Error("Claude Code provider is closed");
    const sessionId = normalizeClaudeSessionId(threadId);
    if (this.active.has(sessionId)) throw new Error("This Claude Code session already has a turn in progress");

    const forkBase = this.forkBases.get(sessionId);
    const firstTurn = this.freshThreads.has(sessionId);
    // Claude's print protocol exposes a session ID but no stable turn ID. Use
    // a Threadline-local UUID only to correlate this one streamed invocation.
    const turnId = randomUUID();
    const sessionArgs = forkBase
      ? ["--resume", forkBase, "--fork-session", "--session-id", sessionId]
      : firstTurn
        ? ["--session-id", sessionId]
        : ["--resume", sessionId];
    const args = [
      ...(this.command.args ?? []),
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      ...(this.yolo ? ["--dangerously-skip-permissions"] : ["--permission-mode", "dontAsk"]),
      ...sessionArgs,
    ];
    const child = spawn(this.command.file, args, {
      cwd: this.cwd, env: process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const operation = {
      child,
      threadId: sessionId,
      turnId,
      forkBase,
      firstTurn,
      stdoutBuffer: "",
      blocks: new Map(),
      toolInputs: new Map(),
      currentMessageId: null,
      messageSerial: 0,
      sawResult: false,
      sessionInitialized: false,
      interrupted: false,
      stopping: false,
      completed: false,
      closed: false,
      spawnError: null,
      timer: null,
      stopTimer: null,
      assistantTimer: null,
      syntheticCommandOutput: false,
      closePromise: null,
      resolveClose: null,
    };
    operation.closePromise = new Promise((resolve) => { operation.resolveClose = resolve; });
    this.active.set(sessionId, operation);

    child.stdout.on("data", (chunk) => this.#consume(operation, chunk));
    child.stderr.on("data", (chunk) => {
      const value = String(chunk).trimEnd();
      if (value) this.emit("log", value);
    });
    child.on("error", (error) => { operation.spawnError = error; });
    child.on("close", (code, signal) => this.#closeOperation(operation, code, signal));

    try {
      await waitForSpawn(child);
    } catch (error) {
      this.active.delete(sessionId);
      throw error;
    }
    operation.timer = setTimeout(() => this.#timeoutOperation(operation), this.turnTimeout);
    operation.timer.unref?.();
    child.stdin.end(String(text));
    this.emit("turn-start", { threadId: sessionId, turnId });
    return { turnId };
  }

  async interrupt(threadId, turnId) {
    const operation = this.active.get(normalizeClaudeSessionId(threadId));
    if (!operation || (turnId && operation.turnId !== turnId)) return;
    operation.interrupted = true;
    this.#complete(operation, "interrupted", null);
    this.#requestStop(operation);
    await this.#waitForStop(operation);
  }

  async close() {
    this.closed = true;
    const operations = [...this.active.values()];
    for (const operation of operations) {
      operation.interrupted = true;
      this.#complete(operation, "interrupted", null);
      this.#requestStop(operation);
    }
    await Promise.all(operations.map((operation) => this.#waitForStop(operation)));
  }

  #state(cwd, extra = {}) {
    return {
      model: null,
      cwd,
      approvalPolicy: this.yolo ? "never" : "dontAsk",
      permissions: this.yolo ? "bypassPermissions" : "dontAsk",
      effort: null,
      ...(this.slashCommandsDiscovered ? { slashCommands: [...this.slashCommands] } : {}),
      ...extra,
    };
  }

  #consume(operation, chunk) {
    operation.stdoutBuffer += chunk;
    while (true) {
      const newline = operation.stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = operation.stdoutBuffer.slice(0, newline).trim();
      operation.stdoutBuffer = operation.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.emit("protocol-error", {
          message: "Claude Code emitted malformed stream-json; the line was ignored",
          line,
          error,
        });
        continue;
      }
      this.#message(operation, message);
    }
  }

  #message(operation, message) {
    if (message.type === "system" && message.subtype === "init") {
      operation.sessionInitialized = true;
      if (message.session_id && message.session_id.toLowerCase() !== operation.threadId) {
        this.emit("protocol-error", {
          message: "Claude Code initialized an unexpected session ID",
          expectedSessionId: operation.threadId,
          actualSessionId: message.session_id,
        });
      }
      const hasSlashCommands = Array.isArray(message.slash_commands);
      const slashCommands = hasSlashCommands ? normalizeSlashCommands(message.slash_commands) : null;
      if (hasSlashCommands) {
        this.slashCommands = new Set(slashCommands);
        this.slashCommandsDiscovered = true;
      }
      this.emit("thread-settings", {
        threadId: operation.threadId,
        settings: {
          model: message.model,
          cwd: message.cwd || this.cwd,
          approvalPolicy: message.permissionMode || (this.yolo ? "never" : "dontAsk"),
          permissions: message.permissionMode || (this.yolo ? "bypassPermissions" : "dontAsk"),
          ...(hasSlashCommands ? { slashCommands } : {}),
        },
      });
      if (hasSlashCommands) this.emit("slash-commands", { threadId: operation.threadId, commands: slashCommands });
      return;
    }
    if (message.type === "system" && message.subtype === "commands_changed") {
      const slashCommands = normalizeSlashCommands(message.commands);
      this.slashCommands = new Set(slashCommands);
      this.slashCommandsDiscovered = true;
      this.emit("thread-settings", {
        threadId: operation.threadId,
        settings: { slashCommands },
      });
      this.emit("slash-commands", { threadId: operation.threadId, commands: slashCommands });
      return;
    }
    if (message.type === "system" && message.subtype === "local_command_output") {
      const text = typeof message.content === "string" ? message.content : "";
      if (text) {
        this.emit("item-complete", {
          threadId: operation.threadId,
          turnId: operation.turnId,
          item: {
            id: message.uuid || `${operation.turnId}-local-command`,
            type: "agentMessage",
            text,
            phase: "final_answer",
          },
        });
      }
      return;
    }
    if (message.type === "stream_event") {
      this.#streamEvent(operation, message.event ?? {});
      return;
    }
    if (message.type === "assistant") {
      const assistantMessage = message.message ?? {};
      const syntheticCommand = assistantMessage.model === "<synthetic>"
        && assistantMessage.stop_reason === "stop_sequence";
      this.#assistant(operation, assistantMessage);
      if (syntheticCommand) operation.syntheticCommandOutput = true;
      if (message.isApiErrorMessage || message.error) {
        const errorMessage = message.message?.error
          || message.error
          || "Claude Code returned an API error";
        this.emit("provider-error", {
          threadId: operation.threadId,
          turnId: operation.turnId,
          willRetry: false,
          message: String(errorMessage),
        });
        operation.terminalStatus = "failed";
        operation.terminalError = { message: String(errorMessage) };
        this.#requestStop(operation);
      } else {
        this.#considerAssistantComplete(operation, message.message ?? {});
      }
      return;
    }
    if (message.type === "user") {
      for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
        if (block.type !== "tool_result" || !block.tool_use_id) continue;
        const output = toolResultText(block.content);
        if (output) {
          this.emit("item-output", {
            threadId: operation.threadId, turnId: operation.turnId, itemId: block.tool_use_id, text: output,
          });
        }
        this.emit("item-update", {
          threadId: operation.threadId,
          turnId: operation.turnId,
          itemId: block.tool_use_id,
          patch: { status: block.is_error ? "failed" : "completed", result: message.toolUseResult },
        });
      }
      return;
    }
    if (message.type === "result") this.#result(operation, message);
  }

  #streamEvent(operation, event) {
    if (event.type === "message_start") {
      operation.messageSerial += 1;
      operation.currentMessageId = event.message?.id || `${operation.turnId}-message-${operation.messageSerial}`;
      operation.blocks.clear();
      operation.toolInputs.clear();
      return;
    }
    const index = event.index ?? 0;
    if (event.type === "content_block_start") {
      if (!operation.currentMessageId) {
        operation.messageSerial += 1;
        operation.currentMessageId = `${operation.turnId}-message-${operation.messageSerial}`;
      }
      const block = event.content_block ?? {};
      const id = block.id || `${operation.currentMessageId}-text-${index}`;
      operation.blocks.set(index, { ...block, id });
      if (block.type === "text") {
        this.emit("item-start", {
          threadId: operation.threadId,
          turnId: operation.turnId,
          item: { id, type: "agentMessage", text: block.text || "", phase: "final_answer" },
        });
      } else if (block.type === "tool_use") {
        this.emit("item-start", {
          threadId: operation.threadId, turnId: operation.turnId, item: activityForTool({ ...block, id }),
        });
      }
      return;
    }
    if (event.type === "content_block_delta") {
      const block = operation.blocks.get(index);
      if (!block) return;
      if (event.delta?.type === "text_delta") {
        this.emit("delta", {
          threadId: operation.threadId, turnId: operation.turnId, itemId: block.id, text: event.delta.text || "",
        });
      } else if (event.delta?.type === "input_json_delta") {
        operation.toolInputs.set(index, (operation.toolInputs.get(index) || "") + (event.delta.partial_json || ""));
      }
      return;
    }
    if (event.type === "content_block_stop") {
      const block = operation.blocks.get(index);
      if (!block || block.type !== "tool_use") return;
      let input = block.input ?? {};
      const serialized = operation.toolInputs.get(index);
      if (serialized) {
        try { input = JSON.parse(serialized); } catch {}
      }
      this.emit("item-update", {
        threadId: operation.threadId,
        turnId: operation.turnId,
        itemId: block.id,
        patch: activityForTool({ ...block, input }),
      });
    }
  }

  #assistant(operation, message) {
    const content = Array.isArray(message.content) ? message.content : [];
    const messageId = message.id || operation.currentMessageId || `${operation.turnId}-message-${operation.messageSerial || 1}`;
    content.forEach((block, index) => {
      if (block.type === "text") {
        const streamed = operation.blocks.get(index);
        const id = streamed?.type === "text" ? streamed.id : `${messageId}-text-${index}`;
        this.emit("item-complete", {
          threadId: operation.threadId,
          turnId: operation.turnId,
          item: { id, type: "agentMessage", text: block.text || "", phase: "final_answer" },
        });
      } else if (block.type === "tool_use") {
        const item = activityForTool(block);
        this.emit("item-update", {
          threadId: operation.threadId, turnId: operation.turnId, itemId: item.id, patch: item,
        });
      }
    });
    const tokenUsage = usageEvent(message);
    if (tokenUsage) {
      this.emit("token-usage", { threadId: operation.threadId, turnId: operation.turnId, tokenUsage });
    }
  }

  #considerAssistantComplete(operation, message) {
    const content = Array.isArray(message.content) ? message.content : [];
    const stopReason = message.stop_reason ?? message.stopReason ?? null;
    if (!stopReason || stopReason === "tool_use" || content.some((block) => block.type === "tool_use")) return;
    operation.terminalStatus = "completed";
    operation.terminalError = null;
    clearTimeout(operation.assistantTimer);
    operation.assistantTimer = setTimeout(() => {
      if (operation.closed || operation.sawResult || operation.completed) return;
      this.#requestStop(operation);
    }, this.assistantCompletionGrace);
    operation.assistantTimer.unref?.();
  }

  #result(operation, message) {
    if (operation.sawResult) return;
    operation.sawResult = true;
    clearTimeout(operation.assistantTimer);
    const priorFailure = operation.terminalStatus === "failed";
    const resultText = typeof message.result === "string" ? message.result.trim() : "";
    const commandError = operation.syntheticCommandOutput
      && /^(?:unknown command:|error:|\/[^\s]+ (?:isn't|is not) available\b)/iu.test(resultText);
    const failed = priorFailure || commandError || message.is_error || !["success", "completed"].includes(message.subtype);
    operation.terminalStatus = failed ? "failed" : "completed";
    operation.terminalError = failed
      ? operation.terminalError ?? { message: resultText || message.subtype || "Claude Code turn failed" }
      : null;
    if (failed) {
      this.emit("provider-error", {
        threadId: operation.threadId, turnId: operation.turnId, willRetry: false, message: operation.terminalError.message,
      });
    }
    operation.assistantTimer = setTimeout(() => {
      if (!operation.closed) this.#requestStop(operation);
    }, this.assistantCompletionGrace);
    operation.assistantTimer.unref?.();
  }

  #timeoutOperation(operation) {
    if (operation.completed || operation.closed) return;
    const message = `Claude Code turn timed out after ${this.turnTimeout} ms`;
    this.emit("provider-error", {
      threadId: operation.threadId, turnId: operation.turnId, willRetry: false, message,
    });
    this.#complete(operation, "failed", { message });
    this.#requestStop(operation);
  }

  #closeOperation(operation, code, signal) {
    if (operation.closed) return;
    operation.closed = true;
    clearTimeout(operation.timer);
    clearTimeout(operation.stopTimer);
    clearTimeout(operation.assistantTimer);
    if (operation.stdoutBuffer.trim()) this.#consume(operation, "\n");
    if (this.active.get(operation.threadId) === operation) this.active.delete(operation.threadId);
    if (!operation.completed) {
      if (operation.sawResult || operation.terminalStatus) {
        this.#complete(operation, operation.terminalStatus, operation.terminalError);
      } else if (operation.interrupted || this.closed) {
        this.#complete(operation, "interrupted", null);
      } else {
        const message = operation.spawnError?.message
          || `Claude Code exited before a result (${signal || (code ?? "unknown")})`;
        this.emit("provider-error", {
          threadId: operation.threadId, turnId: operation.turnId, willRetry: false, message, error: operation.spawnError,
        });
        this.#complete(operation, "failed", { message });
      }
    }
    operation.resolveClose?.();
  }

  #complete(operation, status, error) {
    if (operation.completed) return;
    operation.completed = true;
    clearTimeout(operation.timer);
    if (operation.sessionInitialized) {
      this.freshThreads.delete(operation.threadId);
      this.forkBases.delete(operation.threadId);
    }
    this.emit("turn-complete", {
      threadId: operation.threadId,
      turnId: operation.turnId,
      status,
      error,
      state: operation.sessionInitialized ? { pendingSession: false, forkFrom: null } : null,
    });
  }

  #requestStop(operation) {
    if (operation.closed || operation.stopping) return;
    operation.stopping = true;
    try { operation.child.kill(); } catch {}
    operation.stopTimer = setTimeout(() => {
      if (operation.closed) return;
      try { operation.child.kill("SIGKILL"); } catch {}
    }, this.stopTimeout);
    operation.stopTimer.unref?.();
  }

  async #waitForStop(operation) {
    if (operation.closed) return;
    const wait = (timeout) => Promise.race([
      operation.closePromise,
      new Promise((resolve) => {
        const timer = setTimeout(resolve, timeout);
        timer.unref?.();
      }),
    ]);
    await wait(this.stopTimeout);
    if (operation.closed) return;
    try { operation.child.kill("SIGKILL"); } catch {}
    await wait(this.stopTimeout);
  }
}

export { normalizeClaudeSessionId };
