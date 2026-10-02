import { EventEmitter, once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import pty from "node-pty";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize");
const notifyScript = fileURLToPath(new URL("./notify.mjs", import.meta.url));

export function terminalSize(cols = 100, rows = 30) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 400 || rows < 5 || rows > 160) {
    throw new Error("Terminal size must be 20–400 columns and 5–160 rows.");
  }
  return { cols, rows };
}

export function nativeArgs({ command, threadId, prompt, cwd, yolo = false, notify = true }) {
  const args = [...command.args];
  if (threadId) args.push("resume");
  args.push("--cd", cwd);
  if (notify) args.push("-c", `notify=${JSON.stringify([process.execPath, notifyScript])}`);
  if (yolo) args.push("--sandbox", "danger-full-access", "--ask-for-approval", "never");
  if (threadId) args.push(threadId);
  if (prompt) args.push(prompt);
  return args;
}

export class NativeTerminal extends EventEmitter {
  constructor({ command, args, cwd, env = process.env, cols = 100, rows = 30 }) {
    super();
    Object.assign(this, terminalSize(cols, rows));
    this.sequence = 0;
    this.parsedSequence = 0;
    this.exited = false;
    this.closed = false;
    this.viewers = 0;
    this.writesPending = 0;
    this.snapshotWaiters = [];
    this.headless = new Terminal({ cols, rows, scrollback: 3000, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.headless.loadAddon(this.serializer);
    this.process = pty.spawn(command.file, args, {
      name: "xterm-256color", cols, rows, cwd,
      env: Object.fromEntries(Object.entries({ ...env, TERM: "xterm-256color", COLORTERM: "truecolor" }).filter(([, value]) => typeof value === "string")),
    });
    // Answer terminal queries when a pane is hidden. With a viewer connected,
    // the browser terminal supplies the replies, so they are never duplicated.
    this.headless.onData((data) => { if (!this.viewers && !this.exited) this.process.write(data); });
    this.process.onData((data) => {
      if (this.closed) return;
      const sequence = ++this.sequence;
      this.writesPending += 1;
      this.headless.write(data, () => {
        this.parsedSequence = sequence;
        this.writesPending -= 1;
        if (!this.writesPending) for (const resolve of this.snapshotWaiters.splice(0)) resolve();
      });
      this.emit("data", { data, sequence });
    });
    this.process.onExit((event) => {
      this.exited = true;
      this.emit("exit", event);
      // ConPTY's output worker can survive a natural child exit in node-pty
      // 1.1.0. Release that worker after its output has drained.
      if (process.platform === "win32") this.process._agent?._conoutSocketWorker?.dispose();
    });
  }

  write(data) {
    if (this.exited) throw new Error("This terminal has exited. Reopen the conversation to continue.");
    if (typeof data !== "string" || data.length > 64 * 1024) throw new Error("Invalid terminal input.");
    this.process.write(data);
  }

  resize(cols, rows) {
    const size = terminalSize(cols, rows);
    if (size.cols === this.cols && size.rows === this.rows) return;
    Object.assign(this, size);
    this.headless.resize(cols, rows);
    if (!this.exited) this.process.resize(cols, rows);
  }

  async snapshot() {
    if (this.writesPending) await new Promise((resolve) => this.snapshotWaiters.push(resolve));
    return { data: this.serializer.serialize({ scrollback: 1000 }), cols: this.cols, rows: this.rows, sequence: this.parsedSequence };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    // node-pty owns handles even after the child process reports exit.
    if (!this.exited) { try { this.process.kill(); } catch {} }
    this.headless.dispose();
    this.removeAllListeners();
  }

  async stop() {
    if (!this.exited) {
      const exited = once(this, "exit");
      this.process.write("\x03");
      let timer;
      await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 800); })]);
      clearTimeout(timer);
      if (!this.exited) {
        this.process.write("\x03");
        await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 800); })]);
        clearTimeout(timer);
      }
    }
    this.close();
  }
}
