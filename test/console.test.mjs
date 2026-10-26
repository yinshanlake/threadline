import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { ConsoleInput } from "../src/native/console-input.mjs";
import { ConsoleApp } from "../src/native/console.mjs";
import { conversationLayout } from "../src/native/console-screen.mjs";
import { terminalViewport } from "../src/native/console-grid.mjs";
import { historyView, sourceAt, selectedSource } from "../src/native/console-history.mjs";
import { NativeWorkspace, importNativeThread } from "../src/native/workspace.mjs";
import { nativeDemo } from "../src/native/demo.mjs";
import { startNotificationServer } from "../src/native/notification-server.mjs";
import { displayWidth } from "../src/text.mjs";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless");
const { UnicodeGraphemesAddon } = require("@xterm/addon-unicode-graphemes");
const strip = (text) => text.replace(/\x1b\[[\d;:]*m/gu, "");
const key = (name, text = "", data = text) => ({ type: "key", name, text, data });

class FakeTerminal extends EventEmitter {
  constructor(options) { super(); this.options = options; this.exited = false; this.writes = []; this.cols = options.cols; this.rows = options.rows; this.headless = { modes: { mouseTrackingMode: "none" } }; }
  write(data) { this.writes.push(data); }
  resize(cols, rows) { this.cols = cols; this.rows = rows; }
  viewport({ columns, rows }) { return { lines: Array.from({ length: rows }, (_, row) => row ? "" : "Native Codex ready"), cursor: { x: 2, y: 3, visible: true } }; }
  activityStatus() { return { kind: "idle", activity: "可继续输入", row: null, elapsedSeconds: null }; }
  close() { this.exited = true; }
  async stop() { this.close(); }
}

async function fixture({ columns = 150, rows = 35 } = {}) {
  const demo = nativeDemo();
  const workspace = new NativeWorkspace({ ...demo, demo: true, terminalFactory: (options) => new FakeTerminal(options) });
  const screen = { size: () => ({ columns, rows }), draw: (frame) => { screen.frame = frame; } };
  const app = new ConsoleApp({ workspace, screen, colors: false });
  await workspace.initialize(); app.draw();
  return { app, workspace, demo, screen, setSize: (width, height) => { columns = width; rows = height; } };
}

test("console input preserves literal native bytes, split escape sequences and pasted prefix keys", () => {
  const decoder = new ConsoleInput(); const events = [];
  decoder.on("input", (event) => events.push(event));
  decoder.feed("中文🌱\r\x03");
  decoder.feed("\x1b["); decoder.feed("A");
  decoder.feed("\x1b[200~literal\x02\r"); decoder.feed("\ntext\x1b[201~");
  decoder.feed("\x1b[<0;12;7M");
  decoder.feed("\x1b[13;2u");
  assert.equal(events.map((event) => event.data).join(""), "中文🌱\r\x03\x1b[A\x1b[200~literal\x02\r\ntext\x1b[201~\x1b[<0;12;7M\x1b[13;2u");
  assert.equal(events.find((event) => event.name === "up").data, "\x1b[A");
  assert.equal(events.find((event) => event.type === "paste").text, "literal\x02\r\ntext");
  assert.equal(events.find((event) => event.type === "mouse").x, 11);
  assert.equal(events.at(-1).shift, true);
  decoder.close();
});

test("conversation-first layout keeps full-width transcript and native input at every size", () => {
  for (const [columns, rows] of [[40, 12], [80, 24], [119, 35], [120, 30], [160, 45]]) {
    const layout = conversationLayout(columns, rows);
    assert.equal(layout.wide, false);
    assert.equal(layout.runtime.rows, layout.main.height);
    assert.equal(layout.runtime.cols, layout.main.width);
    assert.equal(layout.panel.width, columns); assert.equal(layout.main.width, columns);
    assert.equal(layout.main.y, layout.separatorY + 1);
    assert.equal(layout.panel.height + layout.main.height + 1, rows - 4);
  }
});

test("terminal viewport retains cell styling, CJK width and child cursor without cursor escapes", async () => {
  const terminal = new Terminal({ cols: 30, rows: 8, allowProposedApi: true });
  terminal.loadAddon(new UnicodeGraphemesAddon());
  try {
    await new Promise((resolve) => terminal.write("\x1b[2J\x1b[H\x1b[31m中文🌱\x1b[0m ready\x1b[4;7H", resolve));
    const viewport = terminalViewport({ headless: terminal, cols: 30, rows: 8, cursorVisible: true });
    assert.match(strip(viewport.lines[0]), /^中文🌱 ready/u);
    assert.equal(displayWidth(strip(viewport.lines[0])), 30);
    assert.match(viewport.lines[0], /38;5;1/u);
    assert.equal(viewport.cursor.x, 6); assert.equal(viewport.cursor.y, 3);
    assert.doesNotMatch(viewport.lines.join(""), /\x1b\[\d+;\d+H/u);
  } finally { terminal.dispose(); }
});

test("history mouse mapping keeps raw source offsets for Chinese and formatted text at multiple widths", async () => {
  const { workspace, demo } = await fixture();
  try {
    const scope = workspace.scope(); const thread = await demo.sessions.read(scope.providerThreadId);
    const raw = "Before.\n\nA **中文🌱** point, followed by another sentence.";
    thread.turns[0].items.find((item) => item.type === "agentMessage").text = raw;
    importNativeThread(scope, thread);
    for (const width of [25, 48, 88]) {
      const view = historyView(workspace.conversation, { width, scopeId: scope.id });
      const found = [];
      for (let row = 0; row < view.lines.length; row++) {
        let column = 0;
        for (const part of view.lines[row].parts || []) {
          if (part.text === "中" || part.text === "🌱") found.push(sourceAt(view, row, column));
          column += displayWidth(part.text);
        }
      }
      const selection = selectedSource(workspace.conversation, found[0], found[1]);
      assert.equal(selection.quote, "中文🌱"); assert.equal(raw.slice(selection.start, selection.end), selection.quote);
    }
  } finally { await workspace.close(); }
});

test("ordinary keys stay native and panel focus never sends approval or navigation keys to Codex", async () => {
  const { app, workspace } = await fixture();
  try {
    const terminal = workspace.terminalFor(workspace.scope().id).terminal;
    await app.onInput(key("enter", "", "\r")); await app.onInput(key("c", "", "\x03"));
    await app.onInput({ type: "paste", text: "literal\x02", data: "\x1b[200~literal\x02\x1b[201~" });
    assert.deepEqual(terminal.writes, ["\r", "\x03", "\x1b[200~literal\x02\x1b[201~"]);
    const originalView = app.frame.lines.slice(0, app.layout.separatorY).map(strip).join("\n");
    assert.match(originalView, /主问题/u);
    await app.onInput(key("b", "", "\x02")); app.draw();
    assert.equal(app.mode, "panel"); assert.equal(app.layout.wide, false);
    await app.onInput(key("up", "", "\x1b[A"));
    assert.equal(terminal.writes.length, 3);
    await app.onInput(key("escape", "", "\x1b")); assert.equal(app.mode, "terminal");
    assert.equal(app.panelVisible, true);
    app.draw(); assert.equal(app.frame.cursor.visible, true);
    assert.ok(app.frame.lines.every((line) => displayWidth(strip(line)) === 150));
  } finally { clearTimeout(app.drawTimer); await workspace.close(); }
});

test("native menus are painted completely even when the cursor is below the menu", async () => {
  const { app, workspace } = await fixture();
  try {
    const native = app.activeEntry().terminal;
    native.activityStatus = () => ({ kind: "unknown", activity: "Unrecognized native screen", row: null });
    native.viewport = ({ columns, rows }) => ({
      lines: Array.from({ length: rows }, (_, row) => row === 0 ? "Future native command panel"
        : row === 2 ? "> 1. Keep existing settings" : row === 4 ? "Enter confirms, Esc cancels" : ""),
      cursor: { x: columns - 1, y: rows - 1, visible: true },
    });
    app.draw();
    const visible = app.frame.lines.slice(app.layout.main.y, app.layout.main.y + app.layout.main.height).map(strip).join("\n");
    assert.match(visible, /^Future native command panel/u);
    assert.match(visible, /Keep existing settings/u);
    assert.equal(native.rows, app.layout.main.height);
    assert.equal(app.nativeStart, 0);
  } finally { clearTimeout(app.drawTimer); await workspace.close(); }
});

test("native slash commands need no registry and extended prefix variants remain native", async () => {
  const { app, workspace } = await fixture();
  const decoder = new ConsoleInput();
  const events = [];
  decoder.on("input", (event) => events.push(event));
  const input = "/model\t\r/keymap\r/future-command-2030 --flag=value\r/自定义技能 参数\r\x1b[A\x1b[B\x1b[98;6u\x1b[98;7u\x1b[200~/pasted-command \x02\x1b[201~";
  try {
    decoder.feed(input.slice(0, 15)); decoder.feed(input.slice(15));
    for (const event of events) await app.onInput(event);
    assert.equal(app.mode, "terminal");
    assert.equal(app.activeEntry().terminal.writes.join(""), input);
    assert.equal(workspace.conversation.scopes.length, 1);
  } finally { decoder.close(); clearTimeout(app.drawTimer); await workspace.close(); }
});

test("scrolling history does not steal native input or turn slash text into navigation", async () => {
  const { app, workspace } = await fixture();
  try {
    const selection = app.selectedKey;
    await app.onMouse({ action: "wheel", button: 1, code: 65, x: 3, y: app.layout.panel.y + 1 });
    assert.equal(app.mode, "terminal");
    assert.equal(app.selectedKey, selection);
    await app.onInput(key("/", "/", "/"));
    assert.deepEqual(app.activeEntry().terminal.writes, ["/"]);
  } finally { clearTimeout(app.drawTimer); await workspace.close(); }
});

test("two nested branches inherit exact turns and returning restores the original history selection", async () => {
  const { app, workspace, demo } = await fixture();
  try {
    const root = workspace.scope(); app.openPanel(); app.draw();
    app.selection = app.view.selectables.findIndex((item) => item.kind === "segment");
    app.selectedKey = null; app.ensureSelectedVisible();
    const beforeScroll = app.scroll; const beforeSource = app.view.selectables[app.selection].segment.text;
    await app.activateSelection(); assert.equal(app.mode, "question");
    app.insertQuestion("第一层追问。"); await app.questionInput(key("enter"));
    const child = workspace.scope(); assert.equal(child.parentId, root.id); assert.equal(child.anchor.exactQuote, beforeSource);
    demo.sessions.record(child.providerThreadId, { question: "第一层追问。", answer: "子问题的回复可以再次展开。" }); await workspace.sync(child.id);
    app.openPanel(); app.draw();
    app.selection = app.view.selectables.findIndex((item) => item.kind === "segment" && item.scopeId === child.id);
    app.selectedKey = null; await app.activateSelection(); app.insertQuestion("第二层追问。"); await app.questionInput(key("enter"));
    const nested = workspace.scope(); assert.equal(nested.parentId, child.id);
    await app.back(); assert.equal(workspace.scope().id, child.id);
    await app.back(); assert.equal(workspace.scope().id, root.id); assert.equal(app.mode, "panel");
    assert.equal(app.scroll, beforeScroll); app.draw();
    assert.equal(app.view.selectables[app.selection].segment.text, beforeSource);
    assert.equal(child.collapsed, true);
  } finally { clearTimeout(app.drawTimer); await workspace.close(); }
});

test("narrow views keep transcript visible when returning to input or starting a new conversation", async () => {
  const { app, workspace, setSize } = await fixture({ columns: 80, rows: 24 });
  try {
    app.openPanel(); app.draw(); assert.equal(app.layout.overlay, false);
    await app.onInput(key("escape", "", "\x1b")); app.draw();
    assert.equal(app.panelVisible, true); assert.equal(app.mode, "terminal");
    setSize(155, 40); app.openPanel(); app.draw();
    assert.equal(app.layout.wide, false); assert.equal(app.activeEntry().terminal.cols, app.layout.main.width);
    const original = workspace.scope().id;
    await app.onInput(key("escape", "", "\x1b"));
    await app.onInput(key("b", "", "\x02")); await app.onInput(key("n", "n")); app.draw();
    assert.notEqual(workspace.scope().id, original); assert.equal(workspace.conversation.scopes.length, 2);
    assert.equal(app.mode, "terminal");
  } finally { clearTimeout(app.drawTimer); await workspace.close(); }
});

test("mouse drag selects raw Chinese quote and horizontal divider adjusts input height", async () => {
  const { app, workspace } = await fixture();
  try {
    app.openPanel(); app.draw();
    const scope = workspace.scope(); const raw = scope.turns[0].assistant.text;
    const desiredStart = raw.indexOf("中文"); const desiredEnd = desiredStart + "中文、emoji 🌱".length;
    const positions = [];
    for (let row = 0; row < app.view.lines.length; row++) {
      let column = 0;
      for (const part of app.view.lines[row].parts || []) {
        if (part.sourceStart >= desiredStart && part.sourceEnd <= desiredEnd) positions.push({ row, column });
        column += displayWidth(part.text);
      }
    }
    const first = positions[0]; const last = positions.at(-1);
    app.scroll = Math.max(0, first.row - 4); app.draw();
    const mouse = (position, action) => ({ type: "mouse", action, button: 0, code: action === "move" ? 32 : 0,
      x: app.layout.panel.x + position.column, y: app.layout.panel.y + position.row - app.scroll });
    app.onMouse(mouse(first, "press")); app.onMouse(mouse(last, "move")); app.onMouse(mouse(last, "release"));
    assert.equal(app.range.quote, "中文、emoji 🌱");
    await app.activateSelection(); assert.equal(app.questionSource.quote, "中文、emoji 🌱");
    app.mode = "panel";
    const border = app.layout.separatorY;
    const previousHeight = app.layout.main.height;
    await app.onMouse({ action: "press", button: 0, x: 5, y: border });
    await app.onMouse({ action: "move", button: 0, x: 5, y: border - 3 });
    await app.onMouse({ action: "release", button: 0, x: 5, y: border - 3 }); app.draw();
    assert.equal(app.layout.main.height, Math.min(16, previousHeight + 3));
    assert.equal(app.layout.main.width, 150);
  } finally { clearTimeout(app.drawTimer); await workspace.close(); }
});

test("console view persists source selection and parent return stack without persisting native screen rows", async () => {
  const { app, workspace } = await fixture();
  try {
    app.openPanel(); app.draw(); app.scroll = 3; app.nativeRows = 6;
    app.returnViews.set("child", { historyScopeId: app.historyScopeId, selectedKey: app.selectedKey, scroll: 3 });
    app.saveView();
    const restored = new ConsoleApp({ workspace, screen: app.screen, colors: false }); restored.draw();
    assert.equal(restored.nativeRows, 6); assert.equal(restored.panelVisible, true);
    assert.equal(restored.returnViews.get("child").selectedKey, app.selectedKey);
    assert.equal(restored.workspace.conversation.native.consoleView.screen, undefined);
    assert.equal(restored.workspace.conversation.native.consoleView.cursor, undefined);
  } finally { clearTimeout(app.drawTimer); await workspace.close(); }
});

test("primary questions, branch questions, quoted sources and new replies have distinct labels and folding", async () => {
  const { app, workspace, demo } = await fixture();
  try {
    const root = workspace.scope(); const source = root.turns[0];
    const quote = "separate conversation"; const start = source.assistant.text.indexOf(quote);
    const child = await workspace.branch({ scopeId: root.id, turnId: source.id, start, end: start + quote.length, quote, question: "具体追问" });
    demo.sessions.record(child.providerThreadId, { question: "具体追问", answer: "新的分支回答。" }); await workspace.sync(child.id);
    app.newTurns.add(child.turns[0].id); app.viewCacheKey = null; app.draw();
    const text = app.view.lines.map((line) => line.text).join("\n");
    assert.match(text, /你 · 主问题/u); assert.match(text, /Codex · 主回答/u);
    assert.match(text, /追问.*当前输入/u); assert.match(text, /原文引用：separate conversation/u);
    assert.match(text, /Codex · 追问回答  \[新\]/u);
    app.openPanel(); app.draw();
    app.selection = app.view.selectables.findIndex((item) => item.kind === "turn");
    app.selectedKey = null; await app.foldSelection(key("left")); app.viewCacheKey = null; app.draw();
    assert.equal(root.turns[0].collapsed, true);
    assert.doesNotMatch(app.view.lines.map((line) => line.text).join("\n"), /新的分支回答/u);
    await workspace.sync(root.id); assert.equal(root.turns[0].collapsed, true);
    app.selection = app.view.selectables.findIndex((item) => item.kind === "turn"); await app.foldSelection(key("right")); app.viewCacheKey = null; app.draw();
    assert.match(app.view.lines.map((line) => line.text).join("\n"), /新的分支回答/u);
    await workspace.sync(root.id); assert.equal(root.turns[0].collapsed, false);
  } finally { clearTimeout(app.drawTimer); await workspace.close(); }
});

test("one wake key scopes arrows and commands; Esc preserves the transcript and native draft", async () => {
  const { app, workspace } = await fixture();
  try {
    const native = app.activeEntry().terminal;
    await app.onInput(key("up", "", "\x1b[A")); await app.onInput(key("n", "n"));
    assert.deepEqual(native.writes, ["\x1b[A", "n"]);
    await app.onInput(key("b", "", "\x02")); assert.equal(app.mode, "panel");
    const count = workspace.conversation.scopes.length;
    await app.onInput(key("up", "", "\x1b[A")); assert.equal(native.writes.length, 2);
    await app.onInput(key("escape", "", "\x1b")); app.draw();
    assert.equal(app.mode, "terminal"); assert.equal(app.panelVisible, true); assert.match(app.view.lines.map((line) => line.text).join("\n"), /主问题/u);
    await app.onInput(key("b", "", "\x02")); await app.onInput(key("b", "", "\x02"));
    assert.equal(native.writes.at(-1), "\x02"); assert.equal(workspace.conversation.scopes.length, count);
    await app.onInput(key("b", "", "\x02")); await app.onInput(key("d", "d")); app.draw();
    assert.equal(app.nativeExpanded, true); assert.equal(app.panelVisible, true);
  } finally { clearTimeout(app.drawTimer); await workspace.close(); }
});

test("collapsed native details still show progress during history browsing without moving its selection", async () => {
  const { app, workspace } = await fixture();
  try {
    const native = app.activeEntry().terminal;
    native.activityStatus = () => ({ kind: "working", activity: "Running focused tests", row: native.rows - 5, elapsedSeconds: 17 });
    native.viewport = ({ rows }) => ({ lines: Array.from({ length: rows }, (_, row) => row === rows - 5 ? "• Running focused tests (17s • esc to interrupt)"
      : row === rows - 3 ? "› Ask Codex to do anything" : row === rows - 1 ? "GPT-6.1-Sol max · Working · Context 85% left" : ""), cursor: { x: 2, y: rows - 3, visible: true } });
    app.openPanel(); app.draw(); const selection = app.selectedKey; const scroll = app.scroll;
    const text = app.frame.lines.map(strip).join("\n");
    assert.match(text, /工作中 17s/u); assert.match(text, /Running focused tests/u);
    assert.match(text, /to interrupt/u); assert.equal(app.nativeExpanded, false);
    assert.equal(app.mode, "panel"); assert.equal(app.panelVisible, true);
    app.draw(); assert.equal(app.scroll, scroll); assert.equal(app.selectedKey, selection);
    native.activityStatus = () => ({ kind: "idle", activity: "可继续输入", row: native.rows - 1, elapsedSeconds: null });
    app.draw(); assert.match(strip(app.frame.lines[app.layout.separatorY]), /就绪/u);
    assert.doesNotMatch(strip(app.frame.lines[app.layout.separatorY]), /工作中/u);
  } finally { clearTimeout(app.drawTimer); await workspace.close(); }
});

test("console-only notification endpoint rejects unauthenticated calls and updates canonical demo history", async () => {
  const { workspace } = await fixture(); const server = await startNotificationServer(workspace);
  try {
    const entry = workspace.terminalFor(workspace.scope().id); const before = workspace.scope().turns.length;
    const payload = { terminalId: entry.id, threadId: workspace.scope().providerThreadId, question: "next", answer: "new reply" };
    assert.equal((await fetch(workspace.notify.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })).status, 401);
    assert.equal((await fetch(workspace.notify.url, { method: "POST", headers: { "Content-Type": "application/json", "X-Threadline-Notify": workspace.notify.token }, body: JSON.stringify(payload) })).status, 200);
    assert.equal(workspace.scope().turns.length, before + 1);
    assert.equal(workspace.scope().turns.at(-1).assistant.text, "new reply");
  } finally { await server.close(); await workspace.close(); }
});
