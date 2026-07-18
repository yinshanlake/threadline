import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT = 30_000;
const require = createRequire(import.meta.url);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

function bundledCodex() {
  try {
    return require.resolve("@openai/codex/bin/codex.js");
  } catch {
    const candidate = path.resolve(moduleDirectory, "..", "..", "node_modules", "@openai", "codex", "bin", "codex.js");
    return existsSync(candidate) ? candidate : null;
  }
}

function defaultCommand() {
  const explicit = process.env.THREADLINE_CODEX_PATH;
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!existsSync(resolved)) throw new Error(`THREADLINE_CODEX_PATH does not exist: ${resolved}`);
    if (resolved.toLowerCase().endsWith(".js")) return { file: process.execPath, args: [resolved, "app-server", "--stdio"] };
    return { file: resolved, args: ["app-server", "--stdio"] };
  }
  const bundled = bundledCodex();
  if (bundled) return { file: process.execPath, args: [bundled, "app-server", "--stdio"] };
  if (process.platform === "win32") {
    const directories = (process.env.Path || process.env.PATH || "").split(path.delimiter).filter((entry) => entry && path.isAbsolute(entry));
    const candidates = directories.flatMap((directory) => [
      path.join(directory, "codex.exe"),
      path.join(directory, "node_modules", "@openai", "codex", "bin", "codex.js"),
    ]);
    if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js"));
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      if (candidate.toLowerCase().endsWith(".js")) return { file: process.execPath, args: [candidate, "app-server", "--stdio"] };
      return { file: candidate, args: ["app-server", "--stdio"] };
    }
    throw new Error("Could not locate Codex. Reinstall Threadline or set THREADLINE_CODEX_PATH to codex.exe or codex.js.");
  }
  return { file: "codex", args: ["app-server", "--stdio"] };
}

export class CodexProvider extends EventEmitter {
  constructor({ command = defaultCommand(), cwd = process.cwd(), requestTimeout = DEFAULT_TIMEOUT } = {}) {
    super();
    this.command = command;
    this.cwd = cwd;
    this.requestTimeout = requestTimeout;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.stdoutBytes = 0;
    this.initialized = null;
    this.connectPromise = null;
    this.closing = false;
  }

  async connect() {
    if (this.initialized) return this.initialized;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.#connect();
    try { return await this.connectPromise; } finally { this.connectPromise = null; }
  }

  async #connect() {
    if (this.child) throw new Error("Codex app-server is already running without an initialized connection");
    this.closing = false;

    this.child = spawn(this.command.file, this.command.args ?? [], {
      cwd: this.cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.#consume(chunk));
    this.child.stderr.on("data", (chunk) => this.emit("log", String(chunk).trimEnd()));
    this.child.on("error", (error) => this.#fail(error));
    this.child.on("exit", (code, signal) => {
      const expected = this.closing;
      const error = new Error(`Codex app-server exited (${signal || (code ?? "unknown")})`);
      this.#fail(error, expected);
      this.child = null;
      this.initialized = null;
    });

    try {
      const result = await this.request("initialize", {
        clientInfo: { name: "threadline", title: "Threadline", version: "0.2.0" },
        capabilities: { experimentalApi: true }
      }, 10_000);
      this.notify("initialized", {});
      this.initialized = result;
      return result;
    } catch (error) {
      this.child?.stdin?.end();
      this.child?.kill();
      this.child = null;
      throw error;
    }
  }

  request(method, params = {}, timeout = this.requestTimeout) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error("Codex app-server is not connected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      this.#write({ id, method, params });
    });
  }

  notify(method, params = {}) {
    this.#write({ method, params });
  }

  respond(id, result) {
    this.#write({ id, result });
  }

  respondError(id, code, message) {
    this.#write({ id, error: { code, message } });
  }

  async startThread({ cwd = this.cwd, ephemeral = false } = {}) {
    await this.connect();
    const response = await this.request("thread/start", { cwd, ephemeral, threadSource: "threadline" });
    return {
      threadId: response.thread.id,
      model: response.model,
      cwd: response.cwd,
      raw: response
    };
  }

  async resumeThread(threadId, { cwd = this.cwd } = {}) {
    await this.connect();
    const response = await this.request("thread/resume", { threadId, cwd, threadSource: "threadline" });
    return { threadId: response.thread.id, raw: response };
  }

  async forkThread(threadId, lastTurnId, { cwd = this.cwd, ephemeral = false } = {}) {
    await this.connect();
    const params = { threadId, cwd, ephemeral, threadSource: "threadline" };
    if (lastTurnId) params.lastTurnId = lastTurnId;
    const response = await this.request("thread/fork", params);
    return { threadId: response.thread.id, raw: response };
  }

  async send(threadId, text) {
    await this.connect();
    const response = await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }]
    });
    return { turnId: response.turn.id, raw: response };
  }

  async interrupt(threadId, turnId) {
    if (!turnId) return;
    await this.request("turn/interrupt", { threadId, turnId });
  }

  resolveServerRequest(request, accepted) {
    const { id, method, params = {} } = request;
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      this.respond(id, { decision: accepted ? "accept" : "decline" });
      return;
    }
    if (method === "item/permissions/requestApproval") {
      this.respond(id, { permissions: accepted ? (params.permissions ?? {}) : {}, scope: "turn" });
      return;
    }
    this.respondError(id, -32601, `Threadline cannot answer ${method} yet`);
  }

  resolveUserInput(request, answers) {
    this.respond(request.id, { answers });
  }

  rejectServerRequest(request) {
    if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval" || request.method === "item/permissions/requestApproval") {
      this.resolveServerRequest(request, false);
      return;
    }
    if (request.method === "item/tool/requestUserInput") {
      const answers = Object.fromEntries((request.params?.questions ?? []).map((question) => [question.id, { answers: [] }]));
      this.resolveUserInput(request, answers);
      return;
    }
    this.respondError(request.id, -32601, `Threadline cannot answer ${request.method} yet`);
  }

  async close() {
    this.closing = true;
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 1_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #write(message) {
    if (!this.child?.stdin?.writable) throw new Error("Codex app-server stdin is closed");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  #consume(chunk) {
    this.stdoutBytes += Buffer.byteLength(chunk, "utf8");
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.emit("protocol-error", {
          message: `Codex emitted malformed JSON after ${this.stdoutBytes} stdout bytes; the line was not interpreted as conversation data`,
          line,
          error,
        });
        continue;
      }
      this.#message(message);
    }
  }

  #message(message) {
    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || `Codex request failed: ${pending.method}`);
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (Object.hasOwn(message, "id") && message.method) {
      this.emit("server-request", message);
      return;
    }

    const params = message.params ?? {};
    switch (message.method) {
      case "item/agentMessage/delta":
        this.emit("delta", {
          threadId: params.threadId,
          turnId: params.turnId,
          itemId: params.itemId,
          text: params.delta ?? ""
        });
        break;
      case "item/completed":
        this.emit("item-complete", {
          threadId: params.threadId,
          turnId: params.turnId,
          item: params.item
        });
        break;
      case "item/started":
        this.emit("item-start", { threadId: params.threadId, turnId: params.turnId, item: params.item });
        break;
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
        this.emit("item-output", { threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, text: params.delta ?? "" });
        break;
      case "item/mcpToolCall/progress":
        this.emit("item-progress", { threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, text: params.message ?? "" });
        break;
      case "item/plan/delta":
      case "item/reasoning/summaryTextDelta":
        this.emit("item-output", { threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, text: params.delta ?? "" });
        break;
      case "item/commandExecution/terminalInteraction":
        this.emit("item-interaction", { threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, text: params.stdin ?? "" });
        break;
      case "item/fileChange/patchUpdated":
        this.emit("item-update", { threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, patch: { changes: params.changes } });
        break;
      case "turn/completed":
        this.emit("turn-complete", {
          threadId: params.threadId,
          turnId: params.turn?.id,
          status: params.turn?.status,
          error: params.turn?.error
        });
        break;
      case "error":
        this.emit("provider-error", {
          threadId: params.threadId, turnId: params.turnId, willRetry: params.willRetry,
          message: params.error?.message || "Codex turn error", error: params.error
        });
        break;
      default:
        this.emit("notification", message);
    }
  }

  #fail(error, quiet = false) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!quiet) this.emit("provider-error", { message: error.message, error });
  }
}
