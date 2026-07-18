import { EventEmitter } from "node:events";
import { emitKeypressEvents } from "node:readline";

export function supportsFullscreen() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== "dumb");
}

function decodeKey(value, key = {}) {
  if (key.ctrl && key.name === "c") return { name: "ctrl+c", text: "", ctrl: true, meta: false, shift: false };
  if (key.ctrl && key.name === "d") return { name: "ctrl+d", text: "", ctrl: true, meta: false, shift: false };
  const aliases = { return: "enter", enter: "enter", escape: "escape", backspace: "backspace", delete: "delete", space: "space" };
  const name = aliases[key.name] || key.name;
  if (name) return {
    name,
    text: name === "space" ? " " : (key.sequence && !key.ctrl && !key.meta && key.sequence >= " " ? key.sequence : ""),
    ctrl: Boolean(key.ctrl),
    meta: Boolean(key.meta),
    shift: Boolean(key.shift),
  };
  const text = String(value ?? "").replace(/[\x00-\x1f\x7f]/g, "");
  return { name: text.length === 1 ? text : "text", text, ctrl: false, meta: false, shift: false };
}

export class Terminal extends EventEmitter {
  constructor({ alternateScreen = true, input = process.stdin, output = process.stdout } = {}) {
    super();
    this.alternateScreen = alternateScreen;
    this.input = input;
    this.output = output;
    this.active = false;
    this.lastFrame = null;
    this.pendingFrame = null;
    this.blocked = false;
    this.onKeypress = (value, key) => this.emit("key", decodeKey(value, key));
    this.onResize = () => { this.lastFrame = null; this.emit("resize", this.size()); };
    this.onDrain = () => {
      this.blocked = false;
      const frame = this.pendingFrame;
      this.pendingFrame = null;
      if (frame && this.active) {
        // The blocked write may only be partially flushed. Repaint the newest
        // logical frame instead of diffing it against an uncertain screen.
        this.lastFrame = null;
        this.draw(frame);
      }
    };
  }

  size() { return { columns: this.output.columns || 80, rows: this.output.rows || 24 }; }

  start() {
    if (this.active) return;
    this.active = true;
    this.lastFrame = null;
    this.pendingFrame = null;
    this.blocked = false;
    this.input.setEncoding("utf8");
    emitKeypressEvents(this.input, this);
    this.input.setRawMode?.(true);
    this.input.resume();
    this.input.on("keypress", this.onKeypress);
    this.output.on("resize", this.onResize);
    this.output.on("drain", this.onDrain);
    if (this.alternateScreen) this.output.write("\x1b[?1049h");
    this.output.write("\x1b[?25l\x1b[2J\x1b[H");
  }

  draw(lines) {
    if (!this.active) return;
    const { rows } = this.size();
    const frame = Array.from({ length: rows }, (_, index) => lines[index] ?? "");
    if (this.blocked) {
      this.pendingFrame = frame;
      return;
    }

    let output = this.lastFrame ? "" : "\x1b[2J";
    for (let index = 0; index < rows; index += 1) {
      if (this.lastFrame?.[index] === frame[index]) continue;
      output += `\x1b[${index + 1};1H\x1b[2K${frame[index]}`;
    }
    if (!output) return;
    this.lastFrame = frame;
    this.blocked = !this.output.write(output);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.pendingFrame = null;
    this.input.off("keypress", this.onKeypress);
    this.output.off("resize", this.onResize);
    this.output.off("drain", this.onDrain);
    if (this.input.isTTY) this.input.setRawMode?.(false);
    this.input.pause();
    this.output.write("\x1b[?25h\x1b[0m");
    if (this.alternateScreen) this.output.write("\x1b[?1049l");
  }
}
