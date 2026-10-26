import { EventEmitter } from "node:events";
import { ConsoleInput } from "./console-input.mjs";
import { displayWidth, graphemes } from "../text.mjs";

export function fitAnsi(text, width, pad = true) {
  const tokens = String(text).split(/(\x1b\[[\d;:]*m)/u);
  let result = ""; let used = 0;
  for (const token of tokens) {
    if (/^\x1b\[/u.test(token)) { result += token; continue; }
    for (const character of graphemes(token)) {
      const cells = displayWidth(character);
      if (used + cells > width) return result + "\x1b[0m" + (pad ? " ".repeat(Math.max(0, width - used)) : "");
      result += character; used += cells;
    }
  }
  return result + (pad ? " ".repeat(Math.max(0, width - used)) : "");
}

export function conversationLayout(columns, rows, { expanded = false, nativeRows = 12 } = {}) {
  const available = Math.max(2, rows - 4);
  const inputHeight = Math.max(2, Math.min(available - 3, expanded ? Math.floor(available * .6) : nativeRows));
  const historyHeight = Math.max(1, available - inputHeight - 1);
  return {
    columns, rows, wide: false, overlay: false,
    panel: { x: 0, y: 2, width: columns, height: historyHeight },
    main: { x: 0, y: 3 + historyHeight, width: columns, height: inputHeight },
    separatorY: 2 + historyHeight,
    runtime: { cols: Math.min(400, Math.max(20, columns)), rows: Math.min(160, Math.max(5, inputHeight)) },
  };
}

export class ConsoleScreen extends EventEmitter {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    super(); this.input = input; this.output = output; this.decoder = new ConsoleInput();
    this.active = false; this.previous = null; this.pending = null; this.blocked = false;
    this.onData = (data) => this.decoder.feed(data);
    this.onResize = () => { this.previous = null; this.emit("resize"); };
    this.onEnd = () => this.emit("close");
    this.onDrain = () => { this.blocked = false; const frame = this.pending; this.pending = null; if (frame) { this.previous = null; this.draw(frame); } };
    this.decoder.on("input", (event) => this.emit("input", event));
  }
  size() { return { columns: this.output.columns || 80, rows: this.output.rows || 24 }; }
  start() {
    if (this.active) return;
    this.wasRaw = Boolean(this.input.isRaw);
    this.active = true; this.input.setEncoding("utf8"); this.input.setRawMode?.(true); this.input.resume();
    this.input.on("data", this.onData); this.output.on("resize", this.onResize); this.output.on("drain", this.onDrain);
    this.input.on("end", this.onEnd); this.input.on("close", this.onEnd);
    this.output.write("\x1b[?1049h\x1b[?7l\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[2J\x1b[H");
  }
  draw(frame) {
    if (!this.active) return;
    if (this.blocked) { this.pending = frame; return; }
    let output = "";
    frame.lines.forEach((line, row) => {
      if (this.previous?.lines[row] !== line) output += "\x1b[" + (row + 1) + ";1H\x1b[0m" + line;
    });
    const cursor = frame.cursor;
    if (cursor?.visible) output += "\x1b[" + (cursor.y + 1) + ";" + (cursor.x + 1) + "H\x1b[" + (cursor.style || 2) + " q\x1b[?25h";
    else output += "\x1b[?25l";
    this.previous = frame; this.blocked = !this.output.write(output);
  }
  stop() {
    if (!this.active) return;
    this.active = false; this.input.off("data", this.onData); this.output.off("resize", this.onResize); this.output.off("drain", this.onDrain);
    this.input.off("end", this.onEnd); this.input.off("close", this.onEnd);
    this.decoder.close(); this.input.setRawMode?.(this.wasRaw); this.input.pause();
    this.output.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?7h\x1b[0m\x1b[2 q\x1b[?25h\x1b[?1049l");
  }
}
