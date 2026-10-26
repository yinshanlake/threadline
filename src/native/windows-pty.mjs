import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const helperFile = fileURLToPath(new URL("./pty-host.mjs", import.meta.url));

// node-pty 1.1.0 mutates its process-wide Windows baton list from exit threads.
// One PTY per helper process prevents concurrent exits from sharing that list.
export class WindowsPty extends EventEmitter {
  constructor(file, args, options) {
    super();
    this.exited = false;
    this.closed = false;
    this.error = null;
    this.helper = fork(helperFile, [], {
      cwd: options.cwd, env: options.env, execArgv: [], windowsHide: true,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    this.finished = new Promise((resolve) => { this.resolveFinished = resolve; });
    let diagnostic = "";
    this.helper.stderr.on("data", (data) => { diagnostic = (diagnostic + data).slice(-2048); });
    this.helper.on("message", (message) => {
      if (message.type === "ready") this.pid = message.pid;
      else if (message.type === "data" && !this.closed) this.emit("data", message.data);
      else if (message.type === "error") this.error = message.error;
      else if (message.type === "exit") this.ended(message.event);
    });
    this.helper.on("error", (error) => {
      this.error = error.message;
      this.ended({ exitCode: 1, error: error.message });
    });
    this.helper.on("exit", (exitCode, signal) => {
      this.ended({ exitCode: exitCode ?? 1, signal,
        ...(this.error || diagnostic ? { error: this.error || diagnostic.trim() } : {}) });
      this.resolveFinished();
    });
    this.send({ type: "start", file, args, options });
  }

  ended(event) {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", event);
  }

  send(message) {
    if (!this.helper.connected) return;
    this.helper.send(message, (error) => {
      if (error && !this.exited) this.ended({ exitCode: 1, error: error.message });
    });
  }

  onData(callback) { this.on("data", callback); }
  onExit(callback) { this.on("exit", callback); }
  write(data) { if (!this.exited) this.send({ type: "input", data }); }
  resize(cols, rows) { if (!this.exited) this.send({ type: "resize", cols, rows }); }
  kill() { if (!this.exited) this.send({ type: "close" }); }

  async dispose() {
    if (!this.closed) {
      this.closed = true;
      if (!this.exited) this.send({ type: "close" });
    }
    let timer;
    await Promise.race([this.finished, new Promise((resolve) => { timer = setTimeout(resolve, 5000); })]);
    clearTimeout(timer);
    if (this.helper.exitCode === null && this.helper.signalCode === null) {
      this.helper.kill(); // Only this terminal's helper process.
      await this.finished;
    }
  }
}
