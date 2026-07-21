import { findScope, findStreamingTurn } from "./model.mjs";
import { ansi, applyTone, approvalText, breadcrumb, buildConversationView, conversationStats, lineContainsSelection, overviewView, renderLine } from "./render.mjs";
import { displayWidth, graphemes, sanitizeTerminalText, terminalPlainText, truncate, wrapDisplayText } from "./text.mjs";
import { Terminal } from "./terminal.mjs";

function selectableKey(item) {
  if (!item) return null;
  if (item.kind === "segment") {
    const segment = item.segment ?? {};
    return `segment:${item.scopeId}:${item.turnId}:${segment.messageId}:${segment.start}:${segment.end}`;
  }
  if (item.kind === "branch-group") {
    const anchor = item.anchor ?? {};
    return `branch-group:${item.parentScopeId}:${anchor.messageId}:${anchor.sourceStart}:${anchor.sourceEnd}`;
  }
  if (item.kind === "branch") return `branch:${item.scopeId}`;
  if (item.kind === "activity") return `activity:${item.scopeId}:${item.turnId}:${item.activityId}`;
  if (item.kind === "activity-group") return `activity-group:${item.groupId}`;
  return null;
}

function tailToWidth(text, width) {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  const marker = width >= 3 ? "..." : ".".repeat(width);
  const limit = Math.max(0, width - displayWidth(marker));
  const items = graphemes(text);
  let value = "";
  let used = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const itemWidth = displayWidth(items[index]);
    if (used + itemWidth > limit) break;
    value = items[index] + value;
    used += itemWidth;
  }
  return marker + value;
}

function composerLine(prefix, before, after, width, tone, colors) {
  const available = Math.max(1, width - displayWidth(prefix));
  const cursor = "▌";
  let value = before + cursor + after;
  if (displayWidth(value) > available) {
    const afterBudget = Math.min(displayWidth(after), Math.max(0, Math.floor((available - 1) / 3)));
    const visibleAfter = truncate(after, afterBudget);
    const beforeBudget = Math.max(0, available - displayWidth(cursor) - displayWidth(visibleAfter));
    value = tailToWidth(before, beforeBudget) + cursor + visibleAfter;
  }
  return applyTone(prefix, tone, false, colors) + value;
}

function commandName(command) {
  return String(command?.name ?? command?.command ?? "").replace(/^\//u, "");
}

function commandDescription(command) {
  return String(command?.description ?? command?.purpose ?? "");
}

function modelEfforts(model) {
  return Array.isArray(model?.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [];
}

const workingFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class TuiApp {
  constructor({ controller, noAltScreen = false, colors = true }) {
    this.controller = controller;
    this.terminal = new Terminal({ alternateScreen: !noAltScreen });
    this.colors = colors;
    this.mode = "input";
    this.input = "";
    this.cursor = 0;
    this.selection = 0;
    this.inspectGranularity = "block";
    this.scroll = 0;
    this.view = { lines: [], selectables: [] };
    this.pendingDive = null;
    this.savedDraft = null;
    this.closed = false;
    this.resolve = null;
    this.drawTimer = null;
    this.workingTimer = null;
    this.selectionKey = null;
    this.activityPages = new Map();
    this.activityGroups = new Map();
    this.commandSelection = 0;
    this.commandOutput = null;
    this.commandPicker = null;
    this.onChange = () => this.scheduleDraw();
    this.followTail = true;
    this.onKey = (key) => this.handleKey(key).catch((error) => { this.controller.status = error.message; this.draw(); });
    this.onResize = () => this.draw();
  }

  async run() {
    const completion = new Promise((resolve) => { this.resolve = resolve; });
    this.terminal.start();
    this.controller.on("change", this.onChange);
    this.terminal.on("key", this.onKey);
    this.terminal.on("resize", this.onResize);
    this.workingTimer = setInterval(() => { if (this.activeStreamingTurn()) this.draw(); }, 250);
    this.workingTimer.unref?.();
    this.draw();
    try { await this.controller.start(); } catch (error) { this.controller.status = error.message; this.draw(); }
    return completion;
  }

  selected() { return this.view.selectables[this.selection] ?? null; }

  activeStreamingTurn() {
    const scope = findScope(this.controller.conversation, this.controller.conversation.activeScopeId);
    return scope ? findStreamingTurn(this.controller.conversation, scope.id) : null;
  }

  workingText(turn) {
    const started = Date.parse(turn?.createdAt ?? "");
    const elapsed = Number.isFinite(started) ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0;
    const frame = workingFrames[Math.floor(Date.now() / 250) % workingFrames.length];
    return `${frame} ${elapsed >= 15 ? "still waiting" : "working"} ${elapsed}s`;
  }

  capacityFor(item) {
    if (item?.kind !== "segment" || typeof this.controller.threadCapacity !== "function") return null;
    try {
      return this.controller.threadCapacity(item.scopeId, item.turnId, item.segment);
    } catch (error) {
      return { allowed: false, code: "thread-capacity-error", message: error.message };
    }
  }

  startDive(item, initialText = "") {
    const capacity = this.capacityFor(item);
    if (capacity && !capacity.allowed) {
      this.controller.status = capacity.message;
      this.draw();
      return false;
    }
    this.pendingDive = item;
    this.mode = "dive-input";
    this.input = initialText;
    this.cursor = graphemes(initialText).length;
    this.draw();
    return true;
  }

  scheduleDraw() {
    if (this.closed || this.drawTimer) return;
    this.drawTimer = setTimeout(() => {
      this.drawTimer = null;
      this.draw();
    }, 16);
  }

  setSelection(index) {
    const last = Math.max(0, this.view.selectables.length - 1);
    this.selection = Math.min(Math.max(0, index), last);
    this.selectionKey = selectableKey(this.selected());
  }

  enterBrowse() {
    if (!this.view.selectables.length) {
      this.controller.status = "Nothing to inspect yet";
      this.draw();
      return false;
    }
    this.mode = "browse";
    this.selectLast();
    this.draw();
    return true;
  }

  async handleKey(key) {
    if (key.name === "ctrl+c" || key.name === "ctrl+d") { await this.quit(); return; }
    if (this.commandPicker) { await this.handleCommandPickerKey(key); return; }
    if (this.commandOutput) {
      if (["escape", "enter", "q"].includes(key.name.toLowerCase())) { this.commandOutput = null; this.draw(); return; }
      if (["up", "pageup"].includes(key.name)) { this.commandOutput.scroll = Math.max(0, this.commandOutput.scroll - (key.name === "pageup" ? 8 : 1)); this.draw(); return; }
      if (["down", "pagedown"].includes(key.name)) { this.commandOutput.scroll += key.name === "pagedown" ? 8 : 1; this.draw(); return; }
      return;
    }
    if (this.controller.pendingApproval) {
      if (key.name.toLowerCase() === "y") this.controller.answerApproval(true);
      else if (["n", "escape"].includes(key.name.toLowerCase())) this.controller.answerApproval(false);
      return;
    }
    if (this.controller.pendingUserInput) {
      if (key.name === "escape") { this.controller.answerUserInput(""); if (!this.controller.pendingUserInput) this.restoreDraft(); return; }
      await this.handleInputKey(key);
      return;
    }
    if (key.name === "escape" && ["input", "dive-input"].includes(this.mode) && this.activeStreamingTurn()) {
      await this.controller.interrupt();
      this.mode = "input"; this.pendingDive = null; this.followTail = true;
      this.draw(); return;
    }
    if (this.mode === "input" || this.mode === "dive-input") { await this.handleInputKey(key); return; }
    await this.handleBrowseKey(key);
  }

  openCommandPicker(picker, title) {
    if (picker?.kind !== "model" || !Array.isArray(picker.models) || !picker.models.length) return false;
    const current = picker.models.findIndex((model) => model.model === picker.currentModel || model.id === picker.currentModel);
    const fallback = picker.models.findIndex((model) => model.isDefault);
    this.commandPicker = {
      ...picker,
      title: title || "Models",
      step: "model",
      modelSelection: current >= 0 ? current : Math.max(0, fallback),
      effortSelection: 0,
      scroll: 0,
    };
    this.commandOutput = null;
    return true;
  }

  commandPickerItems() {
    if (!this.commandPicker) return [];
    if (this.commandPicker.step === "effort") return modelEfforts(this.commandPicker.models[this.commandPicker.modelSelection]);
    return this.commandPicker.models;
  }

  commandPickerSelection() {
    return this.commandPicker?.step === "effort" ? this.commandPicker.effortSelection : this.commandPicker?.modelSelection ?? 0;
  }

  setCommandPickerSelection(index) {
    const items = this.commandPickerItems();
    const selection = Math.min(Math.max(0, index), Math.max(0, items.length - 1));
    if (this.commandPicker.step === "effort") this.commandPicker.effortSelection = selection;
    else this.commandPicker.modelSelection = selection;
  }

  async handleCommandPickerKey(key) {
    const name = key.name.toLowerCase();
    if (name === "escape") {
      if (this.commandPicker.step === "effort") {
        this.commandPicker.step = "model";
        this.commandPicker.scroll = 0;
      } else this.commandPicker = null;
      this.draw(); return;
    }
    const items = this.commandPickerItems();
    const current = this.commandPickerSelection();
    const page = Math.max(1, this.terminal.size().rows - 5);
    if (name === "up") this.setCommandPickerSelection(current - 1);
    else if (name === "down") this.setCommandPickerSelection(current + 1);
    else if (name === "home") this.setCommandPickerSelection(0);
    else if (name === "end") this.setCommandPickerSelection(items.length - 1);
    else if (name === "pageup") this.setCommandPickerSelection(current - page);
    else if (name === "pagedown") this.setCommandPickerSelection(current + page);
    else if (name === "enter") {
      const model = this.commandPicker.models[this.commandPicker.modelSelection];
      if (this.commandPicker.step === "model") {
        const efforts = modelEfforts(model);
        if (!efforts.length) {
          const result = await this.controller.executeSlashCommand(`/model ${model.model}`);
          if (result?.message) this.controller.status = result.message;
          this.commandPicker = null;
        } else {
          const preferred = model.model === this.commandPicker.currentModel ? this.commandPicker.currentEffort : model.defaultReasoningEffort;
          const selected = efforts.findIndex((effort) => effort.reasoningEffort === preferred);
          this.commandPicker.effortSelection = selected >= 0 ? selected : 0;
          this.commandPicker.step = "effort";
          this.commandPicker.scroll = 0;
        }
      } else {
        const effort = modelEfforts(model)[this.commandPicker.effortSelection];
        const suffix = effort?.reasoningEffort ? ` ${effort.reasoningEffort}` : "";
        const result = await this.controller.executeSlashCommand(`/model ${model.model}${suffix}`);
        if (result?.message) this.controller.status = result.message;
        this.commandPicker = null;
      }
      this.draw(); return;
    } else return;
    this.draw();
  }

  async handleInputKey(key) {
    if (key.name === "escape") {
      if (this.mode === "dive-input") { this.mode = "browse"; this.pendingDive = null; }
      else { this.mode = "browse"; this.selectLast(); }
      this.draw(); return;
    }
    const commandItems = this.commandItems();
    if (commandItems.length && ["up", "down"].includes(key.name)) {
      const direction = key.name === "down" ? 1 : -1;
      this.commandSelection = (this.commandSelection + direction + commandItems.length) % commandItems.length;
      this.draw(); return;
    }
    if (commandItems.length && key.name === "tab") {
      const name = commandName(commandItems[this.commandSelection]);
      this.input = `/${name} `; this.cursor = graphemes(this.input).length; this.draw(); return;
    }
    if (key.name === "tab") { this.enterBrowse(); return; }
    if (key.name === "up" && !this.input) { this.enterBrowse(); return; }
    if (key.name === "left") { this.cursor = Math.max(0, this.cursor - 1); this.draw(); return; }
    if (key.name === "right") { this.cursor = Math.min(graphemes(this.input).length, this.cursor + 1); this.draw(); return; }
    if (key.name === "home") { this.cursor = 0; this.draw(); return; }
    if (key.name === "end") { this.cursor = graphemes(this.input).length; this.draw(); return; }
    if (key.name === "backspace") {
      const chars = graphemes(this.input);
      if (this.cursor > 0) { chars.splice(this.cursor - 1, 1); this.cursor -= 1; this.input = chars.join(""); }
      this.draw(); return;
    }
    if (key.name === "delete") {
      const chars = graphemes(this.input); chars.splice(this.cursor, 1); this.input = chars.join(""); this.draw(); return;
    }
    if (key.name === "enter") {
      let text = this.input.trim();
      if (!text && !this.controller.pendingUserInput) return;
      if (this.controller.pendingUserInput) {
        this.input = ""; this.cursor = 0; this.controller.answerUserInput(text);
        if (!this.controller.pendingUserInput) this.restoreDraft();
        this.draw(); return;
      }
      const mode = this.mode; const dive = this.pendingDive;
      if (mode === "input" && commandItems.length) {
        const typed = text.slice(1).toLowerCase();
        const exact = commandItems.find((command) => commandName(command).toLowerCase() === typed);
        if (!exact) text = `/${commandName(commandItems[this.commandSelection])}`;
      }
      if (mode === "input" && text.startsWith("/") && typeof this.controller.executeSlashCommand === "function") {
        this.input = ""; this.cursor = 0; this.commandSelection = 0; this.followTail = true;
        try {
          const result = await this.controller.executeSlashCommand(text);
          if (result?.handled === false) this.controller.status = `Unknown command: ${text.split(/\s/u, 1)[0]}. Type /help.`;
          else if (result?.message) this.controller.status = result.message;
          if (result?.picker && this.openCommandPicker(result.picker, result.title)) this.commandOutput = null;
          else if (result?.output) this.commandOutput = { title: result.title || text.split(/\s/u, 1)[0], text: result.output, scroll: 0 };
          if (result?.action === "threads") { this.mode = "overview"; this.selection = 0; this.scroll = 0; }
          if (result?.quit) await this.quit();
        } catch (error) { this.controller.status = error.message; }
        this.draw(); return;
      }
      this.input = ""; this.cursor = 0; this.mode = "input"; this.pendingDive = null; this.followTail = true;
      this.draw();
      if (mode === "dive-input" && dive) {
        try {
          await this.controller.dive(dive.scopeId, dive.turnId, dive.segment, text);
        } catch (error) {
          if (error.code === "duplicate-thread" && error.scopeId) {
            this.controller.setActiveScope(error.scopeId);
            this.controller.status = "Opened the existing matching thread";
          } else {
            this.controller.status = error.message;
          }
          this.draw();
        }
      } else await this.controller.send(this.controller.conversation.activeScopeId, text);
      return;
    }
    if (key.text) {
      const chars = graphemes(this.input); const incoming = graphemes(key.text); chars.splice(this.cursor, 0, ...incoming); this.cursor += incoming.length; this.input = chars.join(""); this.draw();
      this.commandSelection = 0;
    }
  }

  commandItems() {
    if (this.controller.pendingApproval || this.controller.pendingUserInput) return [];
    if (this.mode !== "input" || !this.input.startsWith("/") || this.input.slice(1).includes(" ")) return [];
    const commands = typeof this.controller.slashCommands === "function" ? this.controller.slashCommands() : [];
    const filter = this.input.slice(1).toLowerCase();
    const visibleLimit = Math.max(0, Math.min(8, (this.terminal.size?.().rows ?? 24) - 3));
    return commands.filter((command) => commandName(command).toLowerCase().startsWith(filter)).slice(0, visibleLimit);
  }

  async handleBrowseKey(key) {
    const name = key.name.toLowerCase();
    if (["tab", "escape"].includes(name)) { this.mode = "input"; this.followTail = true; this.draw(); return; }
    if (key.text === "T") { this.mode = "overview"; this.selection = 0; this.selectionKey = null; this.scroll = 0; this.draw(); return; }
    if (key.text === "V" && this.mode === "browse") {
      this.inspectGranularity = this.inspectGranularity === "block" ? "sentence" : "block";
      this.selection = 0; this.selectionKey = null; this.scroll = 0; this.draw(); return;
    }
    if (key.text === "B") { this.controller.goToParent(); this.mode = "browse"; this.selection = 0; this.selectionKey = null; this.scroll = 0; return; }
    if (name === "down") { this.setSelection(this.selection + 1); this.ensureSelectionVisible(); this.draw(); return; }
    if (name === "up") { this.setSelection(this.selection - 1); this.ensureSelectionVisible(); this.draw(); return; }
    if (name === "home") { this.setSelection(0); this.ensureSelectionVisible(); this.draw(); return; }
    if (name === "end") { this.setSelection(this.view.selectables.length - 1); this.ensureSelectionVisible(); this.draw(); return; }
    if (name === "pageup") { this.followTail = false; this.scroll = Math.max(0, this.scroll - 8); this.draw(); return; }
    if (name === "pagedown") { this.followTail = false; this.scroll += 8; this.draw(); return; }
    const selected = this.selected();
    if (selected?.kind === "activity" && ["[", "]"].includes(key.text)) {
      const page = Math.min(Math.max(0, selected.page + (key.text === "]" ? 1 : -1)), selected.pages - 1);
      this.activityPages.set(`${selected.scopeId}:${selected.turnId}:${selected.activityId}`, page);
      this.draw();
      return;
    }
    if (["left", "right"].includes(name)) {
      if (selected?.kind === "branch-group") {
        const scopes = selected.scopeIds.map((id) => findScope(this.controller.conversation, id)).filter(Boolean);
        const collapsed = scopes.every((scope) => scope.collapsed);
        if ((name === "right" && collapsed) || (name === "left" && !collapsed)) this.controller.toggleBranches(selected.parentScopeId, selected.anchor);
      } else if (selected?.kind === "activity") {
        const turn = findScope(this.controller.conversation, selected.scopeId)?.turns.find((candidate) => candidate.id === selected.turnId);
        const activity = turn?.assistant.activities?.find((candidate) => candidate.id === selected.activityId);
        if (activity && ((name === "right" && !activity.expanded) || (name === "left" && activity.expanded))) {
          this.controller.toggleActivity(selected.scopeId, selected.turnId, selected.activityId);
        }
      } else if (selected?.kind === "activity-group") {
        if ((name === "right" && !selected.expanded) || (name === "left" && selected.expanded)) {
          this.activityGroups.set(selected.groupId, !selected.expanded);
          this.draw();
        }
      }
      return;
    }
    if (name === "space" || key.text === " ") {
      if (selected?.kind === "branch-group") this.controller.toggleBranches(selected.parentScopeId, selected.anchor);
      else if (selected?.kind === "branch") { const scope = findScope(this.controller.conversation, selected.scopeId); if (scope?.anchor) this.controller.toggleBranches(scope.parentId, scope.anchor); }
      else if (selected?.kind === "activity") this.controller.toggleActivity(selected.scopeId, selected.turnId, selected.activityId);
      else if (selected?.kind === "activity-group") { this.activityGroups.set(selected.groupId, !selected.expanded); this.draw(); }
      return;
    }
    if (name === "enter") {
      if (selected?.kind === "segment") { this.startDive(selected); return; }
      if (selected?.kind === "branch") { this.controller.setActiveScope(selected.scopeId); this.mode = "input"; this.selection = 0; this.scroll = 0; return; }
      if (selected?.kind === "branch-group") { this.controller.toggleBranches(selected.parentScopeId, selected.anchor); return; }
      if (selected?.kind === "activity") { this.controller.toggleActivity(selected.scopeId, selected.turnId, selected.activityId); return; }
      if (selected?.kind === "activity-group") { this.activityGroups.set(selected.groupId, !selected.expanded); this.draw(); return; }
    }
    if (this.mode === "browse" && selected?.kind === "segment" && key.text && !key.ctrl && !key.meta) {
      this.startDive(selected, key.text);
    }
  }

  ensureSelectionVisible() {
    const row = this.view.lines.findIndex((line) => lineContainsSelection(line, this.selection));
    if (row < 0) return;
    const viewport = Math.max(4, this.terminal.size().rows - 3);
    if (row < this.scroll) this.scroll = row;
    if (row >= this.scroll + viewport) this.scroll = row - viewport + 1;
  }

  selectLast() {
    this.setSelection(this.view.selectables.length - 1);
    this.ensureSelectionVisible();
    this.followTail = false;
  }

  restoreDraft() {
    if (!this.savedDraft) return;
    this.input = this.savedDraft.input; this.cursor = this.savedDraft.cursor; this.mode = this.savedDraft.mode; this.pendingDive = this.savedDraft.pendingDive; this.savedDraft = null;
  }

  draw() {
    if (this.closed) return;
    if (this.drawTimer) { clearTimeout(this.drawTimer); this.drawTimer = null; }
    const { columns, rows } = this.terminal.size();
    const width = Math.max(1, columns);
    if (columns < 24 || rows < 8) {
      this.terminal.draw(["Threadline", "Window too small", "Resize or press Ctrl+C"]);
      return;
    }
    const conversation = this.controller.conversation;
    const stats = conversationStats(conversation);
    const activeScope = findScope(conversation, conversation.activeScopeId);
    const contentWidth = Math.min(104, width - 2);
    const contentInset = Math.max(1, Math.floor((width - contentWidth) / 2));
    const headerLeft = ` threadline  ${conversation.provider}  ${breadcrumb(conversation, activeScope?.id, Math.max(8, width - 48))}`;
    const maxThreads = this.controller.threadLimits?.maxTotal;
    const threadCount = maxThreads ? `${stats.threads}/${maxThreads}` : String(stats.threads);
    const nearLimit = maxThreads && stats.threads >= (this.controller.threadLimits.warningAt ?? maxThreads);
    const headerRight = `${threadCount} ${stats.threads === 1 ? "thread" : "threads"}${nearLimit ? " !" : ""} `;
    const gap = Math.max(1, width - displayWidth(headerLeft) - displayWidth(headerRight));
    const headerText = truncate(headerLeft + " ".repeat(gap) + headerRight, width);
    const header = this.colors ? ansi.bold + headerText + ansi.reset : headerText;
    if (this.commandPicker) {
      const picker = this.commandPicker;
      const items = this.commandPickerItems();
      const selection = this.commandPickerSelection();
      const bodyHeight = Math.max(1, rows - 3);
      const maxScroll = Math.max(0, items.length - bodyHeight);
      if (selection < picker.scroll) picker.scroll = selection;
      if (selection >= picker.scroll + bodyHeight) picker.scroll = selection - bodyHeight + 1;
      picker.scroll = Math.min(Math.max(0, picker.scroll), maxScroll);
      const selectedModel = picker.models[picker.modelSelection];
      const title = picker.step === "effort" ? `Reasoning effort · ${selectedModel.displayName ?? selectedModel.model}` : picker.title;
      const body = items.slice(picker.scroll, picker.scroll + bodyHeight).map((item, offset) => {
        const index = picker.scroll + offset;
        let label;
        let description;
        let badge = "";
        if (picker.step === "effort") {
          label = item.reasoningEffort;
          description = item.description ?? "";
          if (item.reasoningEffort === selectedModel.defaultReasoningEffort) badge = "  default";
          if (selectedModel.model === picker.currentModel && item.reasoningEffort === picker.currentEffort) badge = "  current";
        } else {
          label = item.displayName && item.displayName !== item.model ? `${item.displayName} (${item.model})` : item.model;
          description = item.description ?? "";
          if (item.model === picker.currentModel || item.id === picker.currentModel) badge = "  current";
          else if (item.isDefault) badge = "  default";
        }
        const marker = index === selection ? " › " : "   ";
        const detail = description ? ` — ${description}` : "";
        const line = " ".repeat(Math.max(0, contentInset - 1)) + truncate(`${marker}${label}${badge}${detail}`, Math.max(1, width - contentInset));
        return index === selection ? applyTone(line, "thread", true, this.colors) : applyTone(line, "dim", false, this.colors);
      });
      while (body.length < bodyHeight) body.push("");
      const step = picker.step === "effort" ? "2/2" : "1/2";
      this.terminal.draw([header, applyTone(` ${title}  ${step}`, "thread", false, this.colors), ...body, applyTone(` ↑↓ choose   Enter ${picker.step === "effort" ? "apply" : "continue"}   Esc ${picker.step === "effort" ? "back" : "close"}`, "dim", false, this.colors)]);
      return;
    }
    if (this.commandOutput) {
      const panelWidth = Math.max(10, contentWidth - 2);
      const lines = wrapDisplayText(sanitizeTerminalText(this.commandOutput.text), panelWidth);
      const bodyHeight = Math.max(1, rows - 4);
      const maxScroll = Math.max(0, lines.length - bodyHeight);
      this.commandOutput.scroll = Math.min(Math.max(0, this.commandOutput.scroll), maxScroll);
      const body = lines.slice(this.commandOutput.scroll, this.commandOutput.scroll + bodyHeight).map((line) => " ".repeat(contentInset) + line);
      while (body.length < bodyHeight) body.push("");
      const position = lines.length > bodyHeight ? `  ${this.commandOutput.scroll + 1}-${Math.min(lines.length, this.commandOutput.scroll + bodyHeight)}/${lines.length}` : "";
      this.terminal.draw([header, applyTone(` ${this.commandOutput.title}${position}`, "thread", false, this.colors), ...body, applyTone(" ↑↓ scroll   Esc / Enter close", "dim", false, this.colors)]);
      return;
    }
    const previousKey = this.selectionKey;
    this.view = this.mode === "overview" ? overviewView(conversation, contentWidth) : buildConversationView(conversation, { width: contentWidth, scopeId: activeScope?.id, granularity: this.inspectGranularity, activityPages: this.activityPages, activityGroups: this.activityGroups });
    const stableIndex = previousKey ? this.view.selectables.findIndex((item) => selectableKey(item) === previousKey) : -1;
    if (stableIndex >= 0) this.selection = stableIndex;
    else this.selection = Math.min(this.selection, Math.max(0, this.view.selectables.length - 1));
    this.selectionKey = selectableKey(this.selected());

    const commandItems = this.commandItems();
    if (this.commandSelection >= commandItems.length) this.commandSelection = Math.max(0, commandItems.length - 1);
    const footerCount = 2 + commandItems.length;
    const bodyHeight = Math.max(0, rows - 1 - footerCount);
    const maxScroll = Math.max(0, this.view.lines.length - bodyHeight);
    if (this.mode === "input" && this.followTail) this.scroll = maxScroll;
    this.scroll = Math.min(Math.max(0, this.scroll), maxScroll);
    const inspect = this.mode === "browse" || this.mode === "overview";
    const body = this.view.lines.slice(this.scroll, this.scroll + bodyHeight).map((line) => " ".repeat(contentInset) + renderLine(line, this.selection, { colors: this.colors, inspect }));
    while (body.length < bodyHeight) body.push("");

    let prompt; let helpText; let helpTone = "dim";
    const streamingTurn = this.activeStreamingTurn();
    if (this.controller.pendingUserInput && !this.savedDraft) {
      this.savedDraft = { input: this.input, cursor: this.cursor, mode: this.mode, pendingDive: this.pendingDive };
      this.input = ""; this.cursor = 0; this.mode = "input"; this.pendingDive = null;
    }
    if (this.controller.pendingApproval) {
      prompt = applyTone(` Approval required  ${approvalText(this.controller.pendingApproval, width - 21)}`, "warning", false, this.colors);
      helpText = truncate(" y approve   n decline", width);
      helpTone = "warning";
    } else if (this.controller.pendingUserInput) {
      const question = this.controller.currentUserQuestion();
      const label = ` ${truncate(sanitizeTerminalText(question?.question || "Input requested"), Math.max(12, Math.floor(width * 0.45)))}  › `;
      const before = graphemes(this.input).slice(0, this.cursor).join("");
      const after = graphemes(this.input).slice(this.cursor).join("");
      prompt = truncate(label + before + "▌" + after, width);
      helpText = truncate(" Enter answer   Esc skip", width);
      helpTone = "warning";
    } else if (this.mode === "browse" || this.mode === "overview") {
      const selected = this.selected();
      const capacity = this.capacityFor(selected);
      const action = selected?.kind === "segment"
        ? capacity && !capacity.allowed
          ? capacity.code === "thread-total-limit" ? "thread limit reached"
            : capacity.code === "thread-depth-limit" ? "maximum depth reached"
              : capacity.code === "thread-anchor-limit" ? "excerpt limit reached"
                : "thread unavailable"
          : capacity?.nearTotalLimit ? `type to ask here (${capacity.remainingTotal} left)`
            : "type to ask here"
        : selected?.kind === "activity"
          ? `Enter details${selected.pages > 1 ? "   [ ] page" : ""}`
          : selected?.kind === "activity-group"
            ? "Enter activities"
          : selected?.kind === "branch-group"
            ? "←→ fold"
            : "Enter open";
      const modeLabel = this.mode === "overview" ? "threads" : `inspect ${this.inspectGranularity}`;
      const position = this.view.selectables.length ? `  ${this.selection + 1}/${this.view.selectables.length}` : "";
      prompt = applyTone(` ${modeLabel}${position}`, "thread", false, this.colors);
      helpText = truncate(` Esc back to input   ↑↓ move   ${action}   V detail   T threads`, width);
    } else {
      const context = this.mode === "dive-input" ? truncate(terminalPlainText(this.pendingDive?.segment?.text || "selection", this.pendingDive?.segment?.blockType).replace(/\s+/gu, " "), 24) : "";
      const label = context ? ` ask here  ${context}  › ` : `${" ".repeat(contentInset)}› `;
      const before = graphemes(this.input).slice(0, this.cursor).join("");
      const after = graphemes(this.input).slice(this.cursor).join("");
      prompt = composerLine(label, before, after, width, context ? "thread" : "dim", this.colors);
      helpText = truncate(streamingTurn
        ? ` Esc stop   ${this.workingText(streamingTurn)}   Ctrl+C quit`
        : this.view.selectables.length
          ? " Enter send   ↑ / Tab inspect   Ctrl+C quit"
          : " Enter send   Type / for commands   Ctrl+C quit", width);
    }
    const safeStatus = sanitizeTerminalText(this.controller.status);
    const statusTone = safeStatus.toLowerCase().includes("error") || safeStatus.toLowerCase().includes("failed") ? "error" : "dim";
    const statusText = truncate(safeStatus, Math.max(0, width - displayWidth(helpText) - 2));
    const footerGap = Math.max(0, width - displayWidth(helpText) - displayWidth(statusText));
    const footer = applyTone(helpText, helpTone, false, this.colors) + " ".repeat(footerGap) + applyTone(statusText, statusTone, false, this.colors);
    const commandMenu = commandItems.map((command, index) => {
      const marker = index === this.commandSelection ? " › " : "   ";
      const usage = command.usage ? ` ${command.usage}` : "";
      const name = `/${commandName(command)}${usage}`;
      const gap = Math.max(1, 24 - displayWidth(name));
      const line = truncate(`${marker}${name}${" ".repeat(gap)}${commandDescription(command)}`, width);
      return index === this.commandSelection ? applyTone(line, "thread", true, this.colors) : applyTone(line, "dim", false, this.colors);
    });
    this.terminal.draw([header, ...body, ...commandMenu, prompt, footer]);
  }

  async quit() {
    if (this.closed) return;
    this.closed = true;
    if (this.drawTimer) { clearTimeout(this.drawTimer); this.drawTimer = null; }
    if (this.workingTimer) { clearInterval(this.workingTimer); this.workingTimer = null; }
    this.controller.off("change", this.onChange); this.terminal.off("key", this.onKey); this.terminal.off("resize", this.onResize);
    this.terminal.stop();
    try { await this.controller.close(); } finally { this.resolve?.(); }
  }
}
