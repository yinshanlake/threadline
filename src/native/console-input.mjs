import { EventEmitter } from "node:events";

const keyNames = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "tab" };
const tildeNames = { 1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end" };

function keyEvent(data) {
  if (data === "\x1b") return { type: "key", data, name: "escape", text: "" };
  if (data === "\r" || data === "\n") return { type: "key", data, name: "enter", text: "" };
  if (data === "\t") return { type: "key", data, name: "tab", text: "" };
  if (data === "\x7f" || data === "\x08") return { type: "key", data, name: "backspace", text: "" };
  const code = data.codePointAt(0);
  if (data.length === 1 && code >= 1 && code <= 26) return { type: "key", data, name: String.fromCharCode(code + 96), text: "", ctrl: true };
  const csi = data.match(/^\x1b\[(?:1;([2-8]))?([ABCDHFZ])$/u);
  if (csi) {
    const modifiers = Number(csi[1] || 1) - 1;
    return { type: "key", data, name: keyNames[csi[2]], text: "", shift: csi[2] === "Z" || Boolean(modifiers & 1), alt: Boolean(modifiers & 2), ctrl: Boolean(modifiers & 4) };
  }
  const tilde = data.match(/^\x1b\[(\d+)(?:;([2-8]))?~$/u);
  if (tilde) return { type: "key", data, name: tildeNames[tilde[1]] || "special", text: "", ctrl: Boolean((Number(tilde[2] || 1) - 1) & 4) };
  const kitty = data.match(/^\x1b\[(\d+)(?:;([\d:]+))?(?:;[^u]*)?u$/u);
  if (kitty) {
    const point = Number(kitty[1]); const modifiers = Number((kitty[2] || "1").split(":")[0]) - 1;
    const names = { 13: "enter", 27: "escape", 127: "backspace", 9: "tab", 57352: "up", 57353: "down", 57350: "left", 57351: "right" };
    return { type: "key", data, name: names[point] || (point <= 0x10ffff ? String.fromCodePoint(point).toLowerCase() : "special"),
      text: point >= 32 && point <= 0x10ffff && point < 57344 && !(modifiers & 6) ? String.fromCodePoint(point) : "",
      shift: Boolean(modifiers & 1), alt: Boolean(modifiers & 2), ctrl: Boolean(modifiers & 4), release: kitty[2]?.split(":")[1] === "3" };
  }
  if (/^\x1bO[ABCDHF]$/u.test(data)) return { type: "key", data, name: keyNames[data.at(-1)], text: "" };
  if (data.startsWith("\x1b")) return { type: "key", data, name: "special", text: "" };
  return { type: "key", data, name: data === " " ? "space" : data, text: code >= 32 ? data : "" };
}

// Keep native bytes intact. Only the shell's prefix, mouse and owned panel keys
// are interpreted; pasted Ctrl+B/escape bytes never become shell commands.
export class ConsoleInput extends EventEmitter {
  constructor({ escapeDelay = 35 } = {}) {
    super(); this.buffer = ""; this.paste = false; this.escapeDelay = escapeDelay; this.timer = null;
  }

  feed(data) {
    clearTimeout(this.timer); this.timer = null; this.buffer += data;
    while (this.buffer) {
      if (this.buffer.length === 1 && this.buffer.charCodeAt(0) >= 0xd800 && this.buffer.charCodeAt(0) <= 0xdbff) break;
      if (this.paste) {
        const end = this.buffer.indexOf("\x1b[201~");
        if (end < 0) break;
        const text = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 6); this.paste = false;
        this.emit("input", { type: "paste", text, data: "\x1b[200~" + text + "\x1b[201~" });
        continue;
      }
      if (this.buffer.startsWith("\x1b[200~")) { this.buffer = this.buffer.slice(6); this.paste = true; continue; }
      const mouse = this.buffer.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/u);
      if (mouse) {
        this.buffer = this.buffer.slice(mouse[0].length);
        const code = Number(mouse[1]);
        this.emit("input", { type: "mouse", data: mouse[0], code, x: Number(mouse[2]) - 1, y: Number(mouse[3]) - 1,
          button: code & 3, shift: Boolean(code & 4), alt: Boolean(code & 8), ctrl: Boolean(code & 16),
          action: code & 64 ? "wheel" : mouse[4] === "m" ? "release" : code & 32 ? "move" : "press" });
        continue;
      }
      if (this.buffer[0] === "\x1b") {
        if (this.buffer === "\x1b") break;
        if (this.buffer.startsWith("\x1b[")) {
          const sequence = this.buffer.match(/^\x1b\[[0-?]*[ -/]*[@-~]/u);
          if (!sequence) break;
          this.buffer = this.buffer.slice(sequence[0].length); this.emit("input", keyEvent(sequence[0])); continue;
        }
        if (this.buffer.startsWith("\x1bO") && this.buffer.length < 3) break;
        const length = this.buffer.startsWith("\x1bO") ? 3 : 1 + String.fromCodePoint(this.buffer.codePointAt(1)).length;
        const sequence = this.buffer.slice(0, length); this.buffer = this.buffer.slice(length);
        this.emit("input", keyEvent(sequence)); continue;
      }
      const value = String.fromCodePoint(this.buffer.codePointAt(0));
      this.buffer = this.buffer.slice(value.length); this.emit("input", keyEvent(value));
    }
    if (this.buffer && !this.paste && !(this.buffer.length === 1 && this.buffer.charCodeAt(0) >= 0xd800 && this.buffer.charCodeAt(0) <= 0xdbff)) this.timer = setTimeout(() => this.flush(), this.escapeDelay);
  }

  flush() {
    clearTimeout(this.timer); this.timer = null;
    if (!this.buffer || this.paste) return;
    const value = this.buffer; this.buffer = "";
    this.emit("input", keyEvent(value));
  }

  close() { clearTimeout(this.timer); this.buffer = ""; this.removeAllListeners(); }
}
