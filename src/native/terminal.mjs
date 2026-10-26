import { EventEmitter, once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import pty from "node-pty";
import { WindowsPty } from "./windows-pty.mjs";
import { terminalViewport } from "./console-grid.mjs";
import { inspectNativeStatus, NativeStatus } from "./console-status.mjs";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize");
const { UnicodeGraphemesAddon } = require("@xterm/addon-unicode-graphemes");
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
  if (notify && command.supportsNoDaemon) args.push("--no-daemon");
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
    this.statusMonitor = new NativeStatus();
    this.statusRevision = -1;
    this.headless = new Terminal({ cols, rows, scrollback: 3000, allowProposedApi: true });
    this.headless.loadAddon(new UnicodeGraphemesAddon());
    this.serializer = new SerializeAddon();
    this.headless.loadAddon(this.serializer);
    this.cursorVisible = true;
    this.cursorStyle = 2;
    this.title = "";
    for (const command of [0, 2]) this.headless.parser.registerOscHandler(command, (title) => { this.title = title; return false; });
    this.headless.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => { if (params.includes(25)) this.cursorVisible = true; return false; });
    this.headless.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => { if (params.includes(25)) this.cursorVisible = false; return false; });
    this.headless.parser.registerCsiHandler({ intermediates: " ", final: "q" }, (params) => { this.cursorStyle = params[0] || 2; return false; });
    const options = {
      name: "xterm-256color", cols, rows, cwd,
      env: Object.fromEntries(Object.entries({ ...env, TERM: "xterm-256color", COLORTERM: "truecolor" }).filter(([, value]) => typeof value === "string")),
    };
    this.process = process.platform === "win32"
      ? new WindowsPty(command.file, args, options)
      : pty.spawn(command.file, args, options);
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
        this.emit("parsed", { sequence });
      });
      this.emit("data", { data, sequence });
    });
    this.process.onExit((event) => {
      this.exited = true;
      this.emit("exit", event);
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

  viewport(options) { return terminalViewport(this, options); }

  activityStatus(now = Date.now()) {
    if (this.exited || this.closed) return { kind: "exited", activity: "终端已退出", row: null, elapsedSeconds: null };
    if (!this.parsedSequence) return this.statusMonitor.current(now);
    if (this.statusRevision !== this.parsedSequence) {
      const buffer = this.headless.buffer.active;
      const lines = Array.from({ length: this.rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) || "");
      this.statusMonitor.observe(inspectNativeStatus(lines, this.title), now);
      this.statusRevision = this.parsedSequence;
    }
    return this.statusMonitor.current(now);
  }

  needsAttention() {
    return this.activityStatus().kind === "blocked";
  }

  async submit(text, { demo = false } = {}) {
    if (this.exited || this.closed) throw new Error("This terminal has exited. Reopen it before sending.");
    await this.snapshot();
    const buffer = this.headless.buffer.active;
    const lines = Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) || "");
    const screen = lines.slice(-this.rows).join("\n");
    if (!demo) {
      const prompt = [...lines].reverse().find((line) => /^\s*›/u.test(line));
      if (!prompt || !/^\s*›\s*(?:Ask Codex to do anything)?\s*$/u.test(prompt) || /esc to interrupt/iu.test(screen)) {
        throw new Error("Codex is busy or its terminal contains unfinished input. Open Terminal to continue.");
      }
      this.write("\x1b[200~" + text + "\x1b[201~");
      // Codex coalesces pasted input. Keep submit separate from the paste burst.
      await new Promise((resolve) => setTimeout(resolve, 250));
    } else this.write(text.replace(/\r?\n/gu, " "));
    this.write("\r");
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    // Windows PTYs are isolated; only their own helper receives this close.
    if (!this.exited) { try { this.process.kill(); } catch {} }
    this.headless.dispose();
    this.removeAllListeners();
  }

  async stop({ input = "\x03" } = {}) {
    if (!this.exited) {
      const exited = once(this, "exit");
      this.process.write(input);
      let timer;
      await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 1800); })]);
      clearTimeout(timer);
      if (!this.exited) {
        this.process.write("\x03");
        await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 1800); })]);
        clearTimeout(timer);
      }
    }
    this.close();
    await this.process.dispose?.();
  }
}
