import { findScope } from "../model.mjs";
import { applyTone, breadcrumb, lineContainsSelection } from "../render.mjs";
import { displayWidth, graphemes, truncate, wrapDisplayText } from "../text.mjs";
import { ConsoleScreen, fitAnsi, conversationLayout } from "./console-screen.mjs";
import { historyRoot, historyView, oneLine, paintHistoryLine, selectedSource, selectionKey, sourceAt } from "./console-history.mjs";
import { formatNativeStatus } from "./console-status.mjs";

const PREFIX = "\x02";

export class ConsoleApp {
  constructor({ workspace, screen = new ConsoleScreen(), colors = true }) {
    this.workspace = workspace; this.screen = screen; this.colors = colors;
    this.mode = "terminal"; this.panelVisible = true; this.panelTab = "history"; this.nativeExpanded = false; this.nativeRows = 12;
    this.historyScopeId = historyRoot(workspace.conversation, workspace.conversation.activeScopeId);
    this.selection = 0; this.selectedKey = null; this.scroll = 0; this.range = null; this.drag = null;
    this.granularity = "sentence"; this.activityGroups = new Map(); this.returnViews = new Map(); this.followTail = true;
    this.newTurns = new Set(); this.knownTurns = new Set(workspace.conversation.scopes.flatMap((scope) => scope.turns.map((turn) => turn.id)));
    this.focusedScope = workspace.conversation.activeScopeId;
    this.view = { lines: [], selectables: [] }; this.question = ""; this.questionCursor = 0; this.questionSource = null;
    this.closed = false; this.busy = false; this.localNotice = ""; this.prefixFrom = null; this.bound = new Map();
    this.drawTimer = null; this.statusTimer = null; this.lastSize = null; this.draggingDivider = false; this.viewCacheKey = null; this.viewVersion = 0; this.clickedItem = null;
    const saved = workspace.conversation.native?.consoleView;
    if (saved) {
      this.nativeRows = Math.max(5, Math.min(16, saved.nativeRows || 12));
      this.historyScopeId = findScope(workspace.conversation, saved.historyScopeId)?.id || this.historyScopeId;
      this.selectedKey = saved.selectedKey || null; this.scroll = saved.scroll || 0;
      this.granularity = saved.granularity || "sentence";
      this.returnViews = new Map(saved.returnViews || []);
      this.panelTab = saved.panelTab === "tree" ? "tree" : "history";
      if (saved.version === 2) this.followTail = saved.followTail !== false;
    }
    this.inputPending = Promise.resolve();
    this.handleInput = (event) => {
      this.inputPending = this.inputPending.then(() => this.onInput(event)).catch((error) => {
        this.localNotice = error.message; this.busy = false; this.schedule();
      });
    };
    this.onChange = () => {
      for (const scope of workspace.conversation.scopes) for (const turn of scope.turns) {
        if (!this.knownTurns.has(turn.id)) { this.knownTurns.add(turn.id); this.newTurns.clear(); this.newTurns.add(turn.id); }
      }
      if (this.focusedScope !== workspace.conversation.activeScopeId) { this.focusedScope = workspace.conversation.activeScopeId; this.followTail = true; }
      this.viewVersion += 1; this.bindTerminals(); this.schedule();
    };
    this.onResize = () => { this.drag = null; this.range = null; this.draggingDivider = false; this.lastSize = null; this.schedule(); };
  }

  activeEntry() { return this.workspace.terminalFor(this.workspace.conversation.activeScopeId); }

  bindTerminals() {
    for (const entry of this.workspace.terminals.values()) {
      if (this.bound.has(entry.id)) continue;
      const onParsed = () => this.schedule();
      const onExit = () => this.schedule();
      entry.terminal.on("parsed", onParsed); entry.terminal.on("exit", onExit);
      this.bound.set(entry.id, { entry, onParsed, onExit });
    }
  }

  async run() {
    const done = new Promise((resolve) => { this.resolve = resolve; });
    this.screen.start(); this.screen.on("input", this.handleInput); this.screen.on("resize", this.onResize);
    const end = () => this.resolve(); this.screen.on("close", end);
    this.workspace.on("change", this.onChange);
    try {
      const size = this.screen.size(); const layout = conversationLayout(size.columns, size.rows);
      await this.workspace.initialize(layout.runtime);
      this.bindTerminals(); this.draw();
      this.statusTimer = setInterval(() => {
        const status = this.activeEntry()?.terminal.activityStatus?.();
        if (["starting", "working"].includes(status?.kind)) this.schedule();
      }, 250);
      this.statusTimer.unref?.();
      await done;
    } finally {
      this.closed = true; clearTimeout(this.drawTimer); clearInterval(this.statusTimer);
      this.screen.off("input", this.handleInput); this.screen.off("resize", this.onResize); this.workspace.off("change", this.onChange);
      this.screen.off("close", end);
      for (const { entry, onParsed, onExit } of this.bound.values()) { entry.terminal.off("parsed", onParsed); entry.terminal.off("exit", onExit); }
      this.saveView();
      try { await this.workspace.close(); } finally { this.screen.stop(); }
    }
  }

  saveView() {
    this.workspace.conversation.native.consoleView = {
      version: 2, panelVisible: true, nativeRows: this.nativeRows, panelTab: this.panelTab,
      historyScopeId: this.historyScopeId, selectedKey: this.selectedKey, scroll: this.scroll,
      granularity: this.granularity, followTail: this.followTail, returnViews: [...this.returnViews],
    };
  }

  schedule() {
    if (this.closed || this.drawTimer) return;
    this.drawTimer = setTimeout(() => { this.drawTimer = null; try { this.draw(); } catch (error) { this.localNotice = error.message; } }, 16);
  }

  syncSize(layout) {
    const key = [layout.runtime.cols, layout.runtime.rows, this.workspace.conversation.activeScopeId].join(":");
    if (key === this.lastSize) return;
    this.lastSize = key;
    const entry = this.activeEntry();
    if (entry && !entry.terminal.exited) entry.terminal.resize(layout.runtime.cols, layout.runtime.rows);
  }

  updateView(width) {
    const key = [width, this.historyScopeId, this.panelTab, this.granularity, this.viewVersion, this.workspace.conversation.updatedAt, JSON.stringify([...this.activityGroups]), this.workspace.conversation.activeScopeId].join("|");
    if (key === this.viewCacheKey) return false;
    this.viewCacheKey = key;
    const previouslyReady = this.view.selectables.length > 0;
    const previous = this.selectedKey || selectionKey(this.view.selectables[this.selection]);
    this.view = historyView(this.workspace.conversation, { width, scopeId: this.historyScopeId, tree: this.panelTab === "tree", granularity: this.granularity, activityGroups: this.activityGroups, newTurns: this.newTurns });
    const restored = previous ? this.view.selectables.findIndex((item) => selectionKey(item) === previous) : -1;
    this.selection = Math.max(0, Math.min(restored >= 0 ? restored : this.selection, this.view.selectables.length - 1));
    this.selectedKey = selectionKey(this.view.selectables[this.selection]);
    if (!previouslyReady && this.view.selectables.length) { this.selection = this.view.selectables.length - 1; this.selectedKey = selectionKey(this.view.selectables[this.selection]); }
    return true;
  }

  draw() {
    const size = this.screen.size();
    if (size.columns < 20 || size.rows < 12) {
      this.screen.draw({ lines: ["Threadline", "Resize to at least 20 columns and 12 rows."], cursor: { visible: false } });
      return;
    }
    const runtime = this.activeEntry()?.terminal;
    const nativeStatus = runtime?.activityStatus?.() || { kind: runtime ? "unknown" : "exited", activity: "", row: null };
    const blocked = nativeStatus.kind === "blocked" || runtime?.needsAttention?.() || false;
    this.layout = conversationLayout(size.columns, size.rows, { expanded: this.nativeExpanded || blocked, nativeRows: this.nativeRows });
    this.syncSize(this.layout);
    const { columns, rows, main, panel } = this.layout;
    const lines = Array.from({ length: rows }, () => " ".repeat(columns));
    const title = " Threadline  " + (this.workspace.demo ? "Offline demo" : "Codex") + "  " + breadcrumb(this.workspace.conversation, this.workspace.conversation.activeScopeId, Math.max(10, columns - 40));
    lines[0] = fitAnsi(applyTone(truncate(title, columns), "heading", false, this.colors), columns);
    const reading = this.mode === "panel" || this.mode === "question";
    lines[1] = fitAnsi(applyTone(this.panelTab === "tree" ? " 对话树  [浏览]  Enter 继续 · Esc 输入" : reading ? " 可折叠对话  [浏览]  ↑↓ 选句 · ←→ 折叠展开 · Enter 追问" : " 可折叠对话  [输入]  Ctrl+B 浏览 · 原生 ↑↓ 保持不变", "thread", false, this.colors), columns);
    const updated = this.updateView(panel.width);
    const maxScroll = Math.max(0, this.view.lines.length - panel.height);
    if (this.followTail && this.mode === "terminal") {
      const activeId = this.workspace.conversation.activeScopeId;
      const lastLine = this.view.lines.findLastIndex((line) => line.scopeId === activeId);
      const branchIndex = this.view.selectables.findIndex((item) => item.kind === "branch" && item.scopeId === activeId);
      const branchLine = branchIndex >= 0 ? this.view.lines.findIndex((line) => lineContainsSelection(line, branchIndex)) : -1;
      this.scroll = activeId === this.historyScopeId ? maxScroll : Math.min(maxScroll, Math.max(0, (lastLine >= 0 ? lastLine : branchLine) - panel.height + 4));
    }
    else if (updated && this.mode === "panel" && !this.range) this.ensureSelectedVisible();
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    for (let row = 0; row < panel.height; row++) {
      const item = this.view.lines[this.scroll + row];
      lines[panel.y + row] = fitAnsi(item ? paintHistoryLine(item, this.selection, { colors: this.colors, focused: reading, range: this.range }) : "", panel.width);
    }
    const scope = this.workspace.scope();
    const target = scope.native?.question || scope.native?.title || "主对话";
    const stateLabel = blocked && nativeStatus.kind !== "blocked" ? "等待确认" : formatNativeStatus(nativeStatus);
    const separator = "─ " + stateLabel + "  │ " + (scope.parentId ? "当前追问" : "主对话") + "：" + oneLine(target);
    lines[this.layout.separatorY] = fitAnsi(applyTone(truncate(separator, columns), blocked ? "warning" : nativeStatus.kind === "working" ? "activity" : "dim", false, this.colors), columns);
    const native = runtime?.viewport?.({ columns: main.width, rows: main.height, colors: this.colors }) || { lines: [], cursor: { visible: false } };
    // The child must see the same viewport we paint. Cropping a larger virtual
    // terminal hides menus whose cursor is parked at the bottom of the screen.
    this.nativeStart = 0;
    for (let row = 0; row < main.height; row++) lines[main.y + row] = fitAnsi(native.lines[row] || "", main.width);
    if (!runtime) lines[main.y] = fitAnsi(applyTone(" 终端已关闭。Ctrl+B 后 r 重开；n 新对话。", "warning", false, this.colors), columns);
    let cursor = { visible: false };
    if (this.mode === "terminal" && native.cursor.visible && native.cursor.y < main.height) cursor = { ...native.cursor, x: main.x + native.cursor.x, y: main.y + native.cursor.y };
    if (this.mode === "question") cursor = this.drawQuestion(lines);
    else if (this.mode === "help") this.drawHelp(lines);
    const status = this.busy ? " 正在开启对话…" : this.workspace.notice ||
      (nativeStatus.kind === "working" ? " 当前活动：" + oneLine(nativeStatus.activity) +
        (this.mode === "terminal" ? "  ·  Esc 中断；Ctrl+B 后 d 查看详情" : "  ·  d 查看详情；Esc 回到输入") : this.localNotice || "");
    lines[rows - 2] = fitAnsi(applyTone(truncate(oneLine(status), columns), status ? "hint" : "dim", false, this.colors), columns);
    const hint = this.mode === "terminal" ? " Ctrl+B 浏览对话  ·  输入和 ↑↓ 交给 Codex"
      : this.mode === "question" ? " Enter 开启追问  ·  Esc 回原文  ·  Ctrl+Enter 换行"
        : this.mode === "panel" ? " Esc 输入  ↑↓ 选句  Enter 追问  ←→/Space 折叠  b 返回  t 对话树  n 新建  d 详情  ? 帮助  q 退出"
          : " Esc 返回  ·  浏览后 q 保存退出";
    lines[rows - 1] = fitAnsi(applyTone(truncate(hint, columns), "dim", false, this.colors), columns);
    this.saveView(); this.frame = { lines, cursor }; this.screen.draw(this.frame);
  }

  drawQuestion(lines) {
    const { columns, rows } = this.layout;
    const height = Math.max(4, Math.min(rows - 4, 12));
    const width = Math.max(6, Math.min(columns - 4, 94));
    const x = Math.max(0, Math.floor((columns - width) / 2)); const y = Math.max(2, Math.floor((rows - height) / 2));
    this.questionRect = { x, y, width, height };
    const contentWidth = width - 4;
    const source = truncate(oneLine(this.questionSource?.quote || ""), contentWidth);
    const before = graphemes(this.question).slice(0, this.questionCursor).join("");
    const after = graphemes(this.question).slice(this.questionCursor).join("");
    const beforeLines = wrapDisplayText(before, contentWidth);
    const inputLines = wrapDisplayText(before + after, contentWidth);
    const inputRows = Math.max(1, height - 6);
    const firstInputLine = Math.max(0, Math.min(inputLines.length - inputRows, beforeLines.length - inputRows));
    const visible = inputLines.slice(firstInputLine, firstInputLine + inputRows);
    for (let row = 0; row < height; row++) {
      const label = row === 0 ? "┌" + "─".repeat(width - 2) + "┐" : row === height - 1 ? "└" + "─".repeat(width - 2) + "┘"
        : "│ " + fitAnsi(row === 1 ? "Follow-up on selected source" : row === 2 ? source : row >= 4 ? visible[row - 4] || "" : "", contentWidth) + " │";
      this.overlayLine(lines, y + row, x, width, applyTone(label, row === 0 ? "thread" : null, false, this.colors));
    }
    const cursorRow = Math.max(0, beforeLines.length - 1 - firstInputLine);
    const cursorColumn = displayWidth(beforeLines.at(-1) || "");
    return { visible: cursorRow < height - 5, x: Math.min(x + width - 3, x + 2 + cursorColumn), y: y + 4 + cursorRow, style: 6 };
  }

  drawHelp(lines) {
    const { columns, rows } = this.layout;
    const entries = ["Threadline：Ctrl+B 唤醒浏览，Esc 回到输入", "", "↑/↓       选择句子或对话标题", "Enter      对选句追问 / 继续选中对话", "←/→/Space  折叠、展开主问题和分支", "b          回到父问题和原段落", "t / Tab    对话树 / 历史", "n          新对话", "d          展开/收起原生工具与审批详情", "q          保存退出", "V          句子 / 整段选择", "", "鼠标拖选原文后 Enter 追问", "普通输入模式的方向键、Enter、Ctrl+C 交给 Codex", "Ctrl+B 连按两次发送原生 Ctrl+B", "Esc 关闭帮助"];
    const width = Math.min(columns, 80); const height = Math.min(rows - 2, entries.length + 2);
    const x = Math.floor((columns - width) / 2); const y = 1;
    for (let row = 0; row < height; row++) this.overlayLine(lines, y + row, x, width, fitAnsi(" " + (entries[row] || ""), width));
  }

  overlayLine(lines, row, x, width, text) {
    // Panels/popups replace cells after layout; never forward child cursor moves.
    const strip = (value) => value.replace(/\x1b\[[\d;:]*m/gu, "");
    const plain = strip(lines[row] || ""); const graphemeList = graphemes(plain);
    let left = ""; let right = ""; let cells = 0;
    for (const character of graphemeList) {
      const next = cells + displayWidth(character);
      if (next <= x) left += character;
      else if (cells >= x + width) right += character;
      cells = next;
    }
    lines[row] = fitAnsi(left, x) + fitAnsi(text, width) + fitAnsi(right, Math.max(0, this.layout.columns - x - width));
  }

  ensureSelectedVisible() {
    const visibleRows = this.layout?.panel.height || 20;
    const indices = this.view.lines.flatMap((line, index) => lineContainsSelection(line, this.selection) ? [index] : []);
    if (!indices.length) return;
    if (indices[0] < this.scroll) this.scroll = indices[0];
    else if (indices[0] >= this.scroll + visibleRows) this.scroll = Math.max(0, indices[0] - visibleRows + 2);
  }

  openPanel(tab = "history") {
    const hadSelection = Boolean(this.selectedKey);
    this.panelVisible = true; this.panelTab = tab; this.mode = "panel"; this.range = null; this.followTail = false;
    if (!findScope(this.workspace.conversation, this.historyScopeId)) this.historyScopeId = historyRoot(this.workspace.conversation, this.workspace.conversation.activeScopeId);
    this.draw();
    if (!hadSelection && tab === "history") this.selection = Math.max(0, this.view.selectables.length - 1);
    this.selectedKey = selectionKey(this.view.selectables[this.selection]); this.ensureSelectedVisible(); this.schedule();
  }

  async onInput(event) {
    if (this.closed) return;
    if (event.type === "mouse") { this.justAwakened = false; await this.onMouse(event); return; }
    if (event.release) { if (this.mode === "terminal") this.forward(event.data); return; }
    if (event.type === "paste") {
      this.justAwakened = false;
      if (this.mode === "terminal") this.forward(event.data);
      else if (this.mode === "question") this.insertQuestion(event.text.replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, ""));
      return;
    }
    if (event.data === PREFIX || event.ctrl && !event.alt && !event.shift && event.name === "b") {
      if (this.mode === "terminal") { this.openPanel("history"); this.justAwakened = true; }
      else if (this.mode === "panel" && this.justAwakened) { this.mode = "terminal"; this.justAwakened = false; this.forward(PREFIX); }
      else if (this.mode === "question") this.mode = "panel";
      else { this.mode = "terminal"; this.panelTab = "history"; this.range = null; }
      this.schedule(); return;
    }
    this.justAwakened = false;
    if (this.mode === "help") { if (event.name === "escape" || event.text === "q") { this.mode = this.prefixFrom || "terminal"; this.schedule(); } return; }
    if (this.mode === "terminal") { this.forward(event.data); return; }
    if (this.busy) return;
    if (this.mode === "question") { await this.questionInput(event); return; }
    await this.panelInput(event);
  }

  forward(data) {
    const runtime = this.activeEntry()?.terminal;
    if (!runtime) { this.localNotice = "Terminal closed. Ctrl+B, r reopens it."; this.schedule(); return; }
    if (data === "\r" || data === "\n") this.followTail = true;
    runtime.write(data);
  }

  async prefixAction(event) {
    const key = event.text || event.name;
    if (event.name === "escape") { this.schedule(); return; }
    if (this.busy && key !== "q" && key !== "?") return;
    if (key === "h") {
      this.panelTab = "history"; this.openPanel();
    } else if (key === "t") this.openPanel("tree");
    else if (key === "p") { this.mode = "terminal"; this.panelTab = "history"; }
    else if (key === "b") await this.back();
    else if (key === "n") { this.busy = true; try { await this.workspace.newConversation(); this.historyScopeId = this.workspace.conversation.activeScopeId; this.selection = 0; this.selectedKey = null; this.scroll = 0; this.range = null; this.mode = "terminal"; this.panelTab = "history"; this.followTail = true; this.bindTerminals(); } finally { this.busy = false; } }
    else if (key === "r") { await this.workspace.transaction(() => this.workspace.activate(this.workspace.conversation.activeScopeId)); this.bindTerminals(); }
    else if (key === "d") { this.nativeExpanded = !this.nativeExpanded; this.lastSize = null; }
    else if (key === "+" || key === "=") this.nativeRows = Math.min(16, this.nativeRows + 2);
    else if (key === "-") this.nativeRows = Math.max(5, this.nativeRows - 2);
    else if (key === "?") { this.prefixFrom = "panel"; this.mode = "help"; }
    else if (key === "q") { this.closed = true; this.resolve?.(); }
    else this.localNotice = "浏览模式按 ? 查看帮助。";
    this.schedule();
  }

  async panelInput(event) {
    this.localNotice = "";
    this.followTail = false;
    if (event.name === "escape" || event.ctrl && event.name === "c") {
      this.range = null; this.mode = "terminal"; this.panelTab = "history";
    } else if (event.name === "tab") { this.panelTab = this.panelTab === "history" ? "tree" : "history"; this.selectedKey = null; this.selection = 0; this.scroll = 0; this.range = null; }
    else if (event.name === "up" || event.name === "down") { this.range = null; this.selection = Math.max(0, Math.min(this.view.selectables.length - 1, this.selection + (event.name === "up" ? -1 : 1))); this.selectedKey = selectionKey(this.view.selectables[this.selection]); this.ensureSelectedVisible(); }
    else if (event.name === "pageup" || event.name === "pagedown") this.scroll += (event.name === "pageup" ? -1 : 1) * Math.max(1, this.layout.panel.height - 2);
    else if (event.name === "home" || event.name === "end") { this.selection = event.name === "home" ? 0 : Math.max(0, this.view.selectables.length - 1); this.selectedKey = selectionKey(this.view.selectables[this.selection]); this.ensureSelectedVisible(); }
    else if (event.text === "V") { this.granularity = this.granularity === "block" ? "sentence" : "block"; this.selectedKey = null; this.range = null; }
    else if (["b", "B", "t", "n", "d", "r", "q", "?", "h", "p", "+", "=", "-"].includes(event.text)) await this.prefixAction(event.text === "B" ? { ...event, text: "b" } : event);
    else if (event.name === "enter") await this.activateSelection();
    else if (event.name === "space" || event.name === "left" || event.name === "right") await this.foldSelection(event);
    this.schedule();
  }

  async activateSelection() {
    const item = this.view.selectables[this.selection];
    if (!item && !this.range) { this.localNotice = "No completed passage yet. History updates when the native turn finishes."; return; }
    if (this.range || item?.kind === "segment") { this.beginQuestion(); return; }
    if (item?.kind === "scope" || item?.kind === "branch") {
      await this.workspace.transaction(() => this.workspace.activate(item.scopeId));
      this.historyScopeId = historyRoot(this.workspace.conversation, item.scopeId); this.panelTab = "history"; this.selectedKey = null;
      this.mode = "terminal"; this.followTail = true;
      this.bindTerminals();
    } else await this.foldSelection({ name: "space" });
  }

  async foldSelection(event) {
    const item = this.view.selectables[this.selection];
    if (item?.kind === "turn") {
      const turn = findScope(this.workspace.conversation, item.scopeId)?.turns.find((turn) => turn.id === item.turnId);
      if (turn) { turn.collapsed = event.name === "left" || event.name === "space" && !turn.collapsed; this.workspace.changed(); }
    } else if (item?.kind === "scope") {
      const scope = findScope(this.workspace.conversation, item.scopeId);
      await this.workspace.collapse({ scopeId: item.scopeId, collapsed: event.name === "left" || event.name === "space" && !scope.collapsed });
    } else if (item?.kind === "branch-group") {
      const collapsed = event.name === "left" || event.name === "space" && item.scopeIds.some((id) => !findScope(this.workspace.conversation, id).collapsed);
      for (const scopeId of item.scopeIds) await this.workspace.collapse({ scopeId, collapsed });
    } else if (item?.kind === "branch") {
      const scope = findScope(this.workspace.conversation, item.scopeId);
      await this.workspace.collapse({ scopeId: item.scopeId, collapsed: event.name === "left" || event.name === "space" && !scope.collapsed });
    }
    else if (item?.kind === "activity-group") this.activityGroups.set(item.groupId, !this.activityGroups.get(item.groupId));
    else if (item?.kind === "activity") { const turn = findScope(this.workspace.conversation, item.scopeId)?.turns.find((turn) => turn.id === item.turnId); const activity = turn?.assistant.activities.find((activity) => activity.id === item.activityId); if (activity) { activity.expanded = !activity.expanded; this.workspace.changed(); } }
  }

  beginQuestion() {
    const item = this.view.selectables[this.selection];
    this.questionSource = this.range || (item?.kind === "segment" ? { scopeId: item.scopeId, turnId: item.turnId, start: item.segment.start, end: item.segment.end, quote: item.segment.text } : null);
    if (!this.questionSource) { this.localNotice = "Select a completed answer passage first."; return; }
    this.question = ""; this.questionCursor = 0; this.mode = "question"; this.schedule();
  }

  insertQuestion(text) {
    text = text.replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, "");
    const items = graphemes(this.question); items.splice(this.questionCursor, 0, ...graphemes(text));
    const next = items.join(""); if (next.length > 16000) { this.localNotice = "A follow-up can contain at most 16,000 characters."; return; }
    const beforeCursor = graphemes(this.question).slice(0, this.questionCursor).join("");
    this.question = next; this.questionCursor = graphemes(beforeCursor + text).length; this.schedule();
  }

  async questionInput(event) {
    const items = graphemes(this.question);
    if (event.name === "escape") { this.mode = "panel"; this.questionSource = null; }
    else if (event.name === "enter" && (event.shift || event.ctrl || event.alt)) this.insertQuestion("\n");
    else if (event.name === "enter") {
      if (!this.question.trim()) return;
      const saved = { historyScopeId: this.historyScopeId, panelTab: this.panelTab, selectedKey: this.selectedKey, selection: this.selection, scroll: this.scroll, panelVisible: true, followTail: false };
      this.busy = true; this.draw();
      try {
        const child = await this.workspace.branch({ ...this.questionSource, question: this.question });
        this.returnViews.set(child.id, saved); this.range = null; this.drag = null; this.mode = "terminal";
        this.followTail = true;
        this.bindTerminals(); this.lastSize = null; this.localNotice = "追问已打开。Ctrl+B 浏览，b 回到原段落。";
      } finally { this.busy = false; }
    } else if (event.name === "left") this.questionCursor = Math.max(0, this.questionCursor - 1);
    else if (event.name === "right") this.questionCursor = Math.min(items.length, this.questionCursor + 1);
    else if (event.name === "home" || event.ctrl && event.name === "a") this.questionCursor = 0;
    else if (event.name === "end" || event.ctrl && event.name === "e") this.questionCursor = items.length;
    else if (event.name === "backspace" && this.questionCursor > 0) { items.splice(--this.questionCursor, 1); this.question = items.join(""); }
    else if (event.name === "delete") { items.splice(this.questionCursor, 1); this.question = items.join(""); }
    else if (event.ctrl && event.name === "u") { this.question = ""; this.questionCursor = 0; }
    else if (event.text) this.insertQuestion(event.text);
    this.schedule();
  }

  async back() {
    const child = this.workspace.scope();
    if (!child.parentId) { this.localNotice = "Already in the main conversation."; return; }
    await this.workspace.transaction(() => this.workspace.back());
    const saved = this.returnViews.get(child.id);
    if (saved) Object.assign(this, saved);
    else {
      this.historyScopeId = historyRoot(this.workspace.conversation, child.parentId); this.panelTab = "history"; this.panelVisible = true;
      this.updateView(this.layout?.panel.width || 80);
      this.selection = this.view.selectables.findIndex((item) => item.kind === "segment" && item.scopeId === child.parentId && item.turnId === child.anchor.turnId && item.segment.start <= child.anchor.sourceStart && item.segment.end >= child.anchor.sourceEnd);
      this.selection = Math.max(0, this.selection); this.selectedKey = selectionKey(this.view.selectables[this.selection]); this.ensureSelectedVisible();
    }
    this.panelVisible = true;
    this.range = null; this.drag = null; this.mode = "panel"; this.followTail = false; this.lastSize = null; this.bindTerminals(); this.localNotice = "已回到原段落。Esc 继续输入。"; this.schedule();
  }

  async onMouse(event) {
    if (!this.layout || this.busy || this.mode === "question" || this.mode === "help") return;
    const panel = this.layout.panel; const main = this.layout.main;
    if (event.action === "press" && event.y === this.layout.separatorY && event.button === 0) { this.draggingDivider = true; return; }
    if (this.draggingDivider) {
      this.nativeRows = Math.max(5, Math.min(16, this.layout.rows - event.y - 3)); this.lastSize = null; this.range = null;
      if (event.action === "release") this.draggingDivider = false;
      this.schedule(); return;
    }
    const insidePanel = event.x >= panel.x && event.y >= panel.y && event.y < panel.y + panel.height;
    if (insidePanel) {
      this.followTail = false;
      if (event.action === "wheel") { this.scroll += event.button === 0 ? -3 : 3; this.schedule(); return; }
      this.mode = "panel";
      const row = this.scroll + event.y - panel.y; const x = event.x - panel.x;
      const source = sourceAt(this.view, row, x);
      if (source && this.drag && (source.scopeId !== this.drag.scopeId || source.turnId !== this.drag.turnId)) this.range = null;
      if (event.action === "press" && event.button === 0) {
        this.drag = source; this.range = null;
        const line = this.view.lines[row]; let column = 0;
        let index = line?.selectableIndex;
        for (const part of line?.parts || []) { const end = column + displayWidth(part.text); if (x >= column && x < end && part.selectableIndex !== undefined) index = part.selectableIndex; column = end; }
        if (index === undefined) index = line?.parts?.find((part) => part.selectableIndex !== undefined)?.selectableIndex;
        if (index !== undefined) { this.selection = index; this.selectedKey = selectionKey(this.view.selectables[index]); }
        this.clickedItem = { index, row, column: x };
      }
      if ((event.action === "move" || event.action === "release") && this.drag && source) this.range = selectedSource(this.workspace.conversation, this.drag, source);
      if (event.action === "release") {
        this.drag = null;
        if (this.range) this.localNotice = "Quote selected. Press Enter to ask.";
        else if (this.clickedItem?.row === row && Math.abs(this.clickedItem.column - x) <= 1) {
          const item = this.view.selectables[this.clickedItem.index];
          if (item?.kind === "scope" || item?.kind === "branch") await this.activateSelection();
          else if (item?.kind === "turn" || item?.kind === "branch-group" || item?.kind === "activity-group" || item?.kind === "activity") await this.foldSelection({ name: "space" });
        }
        this.clickedItem = null;
      }
      this.schedule(); return;
    }
    if (event.x < main.width && event.y >= main.y && event.y < main.y + main.height) {
      if (event.action === "press") this.mode = "terminal";
      const terminal = this.activeEntry()?.terminal;
      if (terminal && terminal.headless?.modes.mouseTrackingMode !== "none") this.forward("\x1b[<" + event.code + ";" + (event.x - main.x + 1) + ";" + (event.y - main.y + this.nativeStart + 1) + (event.action === "release" ? "m" : "M"));
      this.schedule();
    }
  }
}
