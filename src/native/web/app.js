import { Terminal } from "/vendor/xterm.mjs";
import { FitAddon } from "/vendor/fit.mjs";
import { UnicodeGraphemesAddon } from "/vendor/unicode.mjs";
import { contentBlocks, terminalMarkup } from "/text.mjs";

const $ = (id) => document.getElementById(id);
const terminal = new Terminal({
  allowProposedApi: true,
  fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace', fontSize: 13,
  cursorBlink: true, scrollback: 3000, theme: { background: "#101215", foreground: "#e4e6e9" },
});
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.loadAddon(new UnicodeGraphemesAddon());
terminal.open($("terminal"));
const sourceMaps = new WeakMap();
const returnPositions = new Map();
const promptDrafts = new Map();
let state;
let socket;
let terminalId;
let selection;
let selectionPosition;
let lastTranscript = "";
let treeKey = "";
let breadcrumbKey = "";
let busy = false;
let refreshing = false;
let reconnectTimer;
let hasSnapshot = false;
let initializedView = false;
let composerScopeId;
let expectedReplyScope;
let expectedReplyCount = 0;
let selectionAnimation;
let readingGesture = 0;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

function stopSelectionAnimation() {
  const animation = selectionAnimation;
  selectionAnimation = null;
  animation?.cancel();
}

function animateSelection(open, complete) {
  stopSelectionAnimation();
  const form = $("follow-up");
  if (reducedMotion.matches) { complete?.(); return; }
  const height = form.getBoundingClientRect().height;
  const expanded = { height: `${height}px`, opacity: 1, paddingTop: "12px", paddingBottom: "12px", marginTop: "16px", marginBottom: "16px", overflow: "hidden" };
  const collapsed = { height: "0px", opacity: 0, paddingTop: "0px", paddingBottom: "0px", marginTop: "0px", marginBottom: "0px", overflow: "hidden" };
  const animation = form.animate(open ? [collapsed, expanded] : [expanded, collapsed], {
    duration: open ? 480 : 240, easing: "cubic-bezier(.4,0,.25,1)", fill: "both",
  });
  selectionAnimation = animation;
  animation.onfinish = () => {
    if (selectionAnimation !== animation) return;
    selectionAnimation = null;
    animation.cancel();
    complete?.();
  };
}

function revealSelection() {
  const form = $("follow-up");
  const viewport = $("answers");
  const bounds = viewport.getBoundingClientRect();
  const rect = form.getBoundingClientRect();
  let delta = 0;
  if (rect.top < bounds.top + 12 || rect.height > bounds.height - 24) delta = rect.top - bounds.top - 12;
  else if (rect.bottom > bounds.bottom - 12) delta = rect.bottom - bounds.bottom + 12;
  if (delta) viewport.scrollTo({ top: viewport.scrollTop + delta, behavior: reducedMotion.matches ? "auto" : "smooth" });
}

function message(text) { $("message").textContent = text || ""; $("message").hidden = !text; }
function currentScope(id = state?.activeScopeId) { return state?.scopes.find((scope) => scope.id === id); }
function allParts() { return [...$("transcript").querySelectorAll(".answer-text")]; }
function partFor(scopeId, turnId, offset) {
  return allParts().find((part) => part.dataset.scope === scopeId && part.dataset.turn === turnId &&
    Number(part.dataset.start) <= offset && Number(part.dataset.end) >= offset);
}
function scopeElement(id) {
  return [...$("transcript").querySelectorAll("details[data-scope]")].find((element) => element.dataset.scope === id);
}

async function api(path, input) {
  const response = await fetch(`/api/${path}`, input === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed.");
  return result;
}

function send(value) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); }
function resize() {
  if ($("terminal-pane").hidden || $("terminal").clientWidth < 40) return;
  fit.fit();
  send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
}

terminal.onData((data) => { if (hasSnapshot) send({ type: "input", data }); });
terminal.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
new ResizeObserver(resize).observe($("terminal"));
terminal.attachCustomKeyEventHandler((event) => !shortcut(event));

function connect(id) {
  if (id === terminalId && (!id || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  const previous = socket;
  if (previous) { previous.onclose = null; previous.close(); }
  socket = null;
  terminalId = id;
  hasSnapshot = false;
  terminal.reset();
  if (!id) { $("connection").textContent = "Terminal exited"; return; }
  $("connection").textContent = "Connecting";
  const current = new WebSocket(`${location.origin.replace(/^http/, "ws")}/terminal/${id}`);
  socket = current;
  current.onmessage = ({ data }) => {
    if (socket !== current) return;
    const event = JSON.parse(data);
    if (event.type === "snapshot") {
      terminal.resize(event.cols, event.rows);
      terminal.write(event.data, () => { if (socket === current) { hasSnapshot = true; resize(); } });
      $("connection").textContent = "Connected";
    } else if (event.type === "output") terminal.write(event.data);
    else if (event.type === "error") message(event.message);
    else if (event.type === "exit") { $("connection").textContent = "Terminal exited"; void refreshState(); }
  };
  current.onclose = () => {
    if (socket !== current) return;
    hasSnapshot = false;
    $("connection").textContent = "Disconnected";
    reconnectTimer = setTimeout(() => { if (terminalId === id) { terminalId = null; connect(id); } }, 1200);
  };
}

function orderedScopes() {
  const result = [];
  const seen = new Set();
  const visit = (scope, depth) => {
    if (seen.has(scope.id)) return;
    seen.add(scope.id); result.push({ scope, depth });
    for (const child of state.scopes.filter((item) => item.parentId === scope.id)) visit(child, depth + 1);
  };
  for (const root of state.scopes.filter((scope) => !scope.parentId)) visit(root, 0);
  return result;
}

function captureViewport() {
  const viewport = $("answers");
  const top = viewport.getBoundingClientRect().top;
  const part = allParts().find((item) => item.getBoundingClientRect().bottom > top && item.getClientRects().length);
  return { scrollTop: viewport.scrollTop, part: part ? {
    scopeId: part.dataset.scope, turnId: part.dataset.turn, start: Number(part.dataset.start),
    top: part.getBoundingClientRect().top - top,
  } : null };
}

function restoreViewport(position) {
  if (!position) return;
  const viewport = $("answers");
  const part = position.part && partFor(position.part.scopeId, position.part.turnId, position.part.start);
  if (part?.getClientRects().length) {
    viewport.scrollTop += part.getBoundingClientRect().top - viewport.getBoundingClientRect().top - position.part.top;
  } else viewport.scrollTop = position.scrollTop;
}

function revealScope(id, last = false) {
  const detail = scopeElement(id);
  if (!detail) return;
  const answers = detail.querySelectorAll(":scope > .scope-body > .answer");
  const target = (last ? answers[answers.length - 1] : answers[0]) || detail;
  const viewport = $("answers");
  viewport.scrollTop += target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 24;
  target.querySelector(".answer-text")?.focus({ preventScroll: true });
}

function returnToSource(childId) {
  const child = currentScope(childId);
  const position = returnPositions.get(childId);
  if (position) restoreViewport(position);
  const part = child?.anchor && partFor(child.parentId, child.anchor.turnId, child.anchor.sourceStart);
  if (!part) return;
  if (!position) part.scrollIntoView({ block: "center" });
  allParts().forEach((item) => item.classList.remove("source-return"));
  part.classList.add("source-return");
  part.focus({ preventScroll: true });
}

function renderMappedText(element, block, anchors) {
  const entries = terminalMarkup(block.text, { sourceStart: block.start, type: block.type });
  const mappings = [];
  let run;
  let visibleOffset = 0;
  for (const entry of entries) {
    const text = entry.newline ? "\n" : entry.text;
    const anchored = anchors.some((anchor) => anchor.sourceStart < entry.sourceEnd && anchor.sourceEnd > entry.sourceStart);
    const className = [entry.tone === "strong" ? "tone-strong" : entry.tone === "emphasis" ? "tone-emphasis"
      : entry.tone === "inlineCode" ? "tone-inlineCode" : entry.tone === "link" ? "tone-link"
        : entry.tone === "strike" ? "tone-strike" : entry.tone === "math" ? "tone-math" : "",
      anchored ? "anchored" : ""].filter(Boolean).join(" ");
    if (!run || run.className !== className) {
      run = document.createElement("span"); run.className = className;
      run.append(document.createTextNode("")); element.append(run);
    }
    run.firstChild.appendData(text);
    mappings.push({ start: visibleOffset, end: visibleOffset + text.length,
      sourceStart: entry.sourceStart, sourceEnd: entry.sourceEnd });
    visibleOffset += text.length;
  }
  sourceMaps.set(element, mappings);
}

function sourceBoundary(container, node, offset, end) {
  const prefix = document.createRange();
  prefix.selectNodeContents(container); prefix.setEnd(node, offset);
  const visibleOffset = prefix.toString().length;
  const mappings = sourceMaps.get(container) || [];
  if (end) return [...mappings].reverse().find((entry) => entry.start < visibleOffset)?.sourceEnd;
  return mappings.find((entry) => entry.end > visibleOffset)?.sourceStart;
}

function branchTitle(scope, summary) {
  const title = document.createElement("span"); title.className = "branch-title-text";
  title.textContent = scope.title;
  const count = document.createElement("span"); count.className = "reply-count";
  const replies = scope.turns.filter((turn) => turn.assistant.text).length;
  count.textContent = `${replies} ${replies === 1 ? "reply" : "replies"}`;
  summary.append(title, count);
}

function renderScope(scope, ancestry = new Set()) {
  const detail = document.createElement("details");
  detail.className = scope.parentId ? "branch" : "conversation-root";
  detail.dataset.scope = scope.id; detail.open = !scope.collapsed;
  const summary = document.createElement("summary");
  summary.className = scope.parentId ? "branch-title" : "root-title";
  branchTitle(scope, summary);
  summary.onclick = (event) => {
    event.preventDefault();
    if (busy) return;
    const collapsed = detail.open;
    detail.open = !collapsed;
    void action("collapse", { scopeId: scope.id, collapsed });
  };
  detail.append(summary);
  const body = document.createElement("div"); body.className = "scope-body";
  detail.append(body);
  const path = new Set(ancestry); path.add(scope.id);
  const children = state.scopes.filter((item) => item.parentId === scope.id && !path.has(item.id));
  const placed = new Set();
  for (const turn of scope.turns) {
    const article = document.createElement("article"); article.className = "answer";
    article.dataset.scope = scope.id; article.dataset.turn = turn.id;
    const heading = document.createElement("div"); heading.className = "answer-question-row";
    const prompt = document.createElement("p"); prompt.className = "answer-question"; prompt.textContent = turn.user.text;
    heading.append(prompt);
    if (!scope.parentId || turn !== scope.turns[0] || turn.user.text.trim() !== scope.title.trim()) article.append(heading);
    const answer = document.createElement("div"); answer.className = "answer-body"; article.append(answer);
    const anchored = children.filter((child) => child.anchor?.messageId === turn.assistant.id);
    for (const block of contentBlocks(turn.assistant.text)) {
      const wrapper = document.createElement("div"); wrapper.className = "answer-part";
      const text = document.createElement("pre"); text.className = `answer-text ${block.type}`; text.tabIndex = 0;
      Object.assign(text.dataset, { scope: scope.id, turn: turn.id, start: String(block.start), end: String(block.end), complete: String(turn.assistant.status === "complete") });
      renderMappedText(text, block, anchored.map((child) => child.anchor));
      wrapper.append(text); answer.append(wrapper);
      for (const child of anchored.filter((item) => item.anchor.sourceStart >= block.start && item.anchor.sourceStart < block.end)) {
        wrapper.append(renderScope(child, path)); placed.add(child.id);
      }
    }
    if (!turn.assistant.text || turn.assistant.status !== "complete") {
      const note = document.createElement("p"); note.className = "scope-status";
      note.textContent = turn.assistant.status === "failed" ? "This turn failed. Open the terminal for details."
        : turn.assistant.status === "interrupted" ? "This turn was interrupted. Continue in the terminal."
          : "The reply will appear when the turn finishes. Tools and approvals are available in the terminal.";
      answer.append(note);
    }
    body.append(article);
  }
  if (!scope.turns.length) {
    const empty = document.createElement("p"); empty.className = "scope-status";
    empty.textContent = scope.pendingPrompt || scope.pendingSubmission ? "Your message is running. The reply will appear here; open the terminal for tools or approvals."
      : "Write your first message below to start this conversation.";
    body.append(empty);
  }
  if (scope.pendingText) {
    const pending = document.createElement("article"); pending.className = "answer pending-answer";
    const prompt = document.createElement("p"); prompt.className = "answer-question"; prompt.textContent = scope.pendingText;
    const note = document.createElement("p"); note.className = "scope-status"; note.textContent = "Waiting for Codex. Open Terminal if an approval is needed.";
    pending.append(prompt, note); body.append(pending);
  }
  const unattached = children.filter((child) => !placed.has(child.id));
  if (unattached.length) {
    const remaining = document.createElement("div"); remaining.className = "orphan-branches";
    const label = document.createElement("p"); label.className = "orphan-label";
    label.textContent = "Earlier follow-ups"; remaining.append(label);
    for (const child of unattached) remaining.append(renderScope(child, path));
    body.append(remaining);
  }
  const open = document.createElement("button"); open.className = "scope-action";
  open.textContent = "Continue here"; open.disabled = busy;
  open.onclick = () => action("activate", { scopeId: scope.id }, { compose: true });
  body.append(open);
  detail.addEventListener("toggle", () => {
    if (busy || !detail.isConnected || detail.open === !currentScope(scope.id)?.collapsed) return;
    void action("collapse", { scopeId: scope.id, collapsed: !detail.open });
  });
  return detail;
}

function renderNavigation(scope) {
  const key = JSON.stringify(state.scopes.map((item) => [item.id, item.parentId, item.title]));
  if (treeKey !== key) {
    treeKey = key;
    const tree = $("tree");
    const scroll = tree.scrollTop;
    const existing = new Map([...tree.children].map((button) => [button.dataset.scope, button]));
    let cursor = tree.firstElementChild;
    for (const { scope: item, depth } of orderedScopes()) {
      let button = existing.get(item.id);
      if (!button) {
        button = document.createElement("button"); button.className = "tree-node"; button.dataset.scope = item.id;
        button.onclick = () => action("activate", { scopeId: item.id }, { reveal: true });
      }
      existing.delete(item.id);
      button.style.paddingLeft = `${10 + depth * 14}px`;
      const label = `${depth ? "↳ " : ""}${item.title}`;
      button.title = item.title;
      if (button.textContent !== label) button.textContent = label;
      if (button !== cursor) tree.insertBefore(button, cursor);
      cursor = button.nextElementSibling;
    }
    existing.forEach((button) => button.remove());
    tree.scrollTop = scroll;
  }
  $("tree").querySelectorAll(".tree-node").forEach((button) => {
    button.setAttribute("aria-current", String(button.dataset.scope === scope.id)); button.disabled = busy;
  });
  const path = [];
  let parent = scope;
  while (parent && !path.some((item) => item.id === parent.id)) { path.unshift(parent); parent = currentScope(parent.parentId); }
  const nextBreadcrumbKey = JSON.stringify([path.map((item) => [item.id, item.title]), busy]);
  if (breadcrumbKey !== nextBreadcrumbKey) {
    breadcrumbKey = nextBreadcrumbKey;
    $("breadcrumb").replaceChildren();
    path.forEach((item, index) => {
      if (index) { const separator = document.createElement("span"); separator.className = "crumb-separator"; separator.textContent = "/"; $("breadcrumb").append(separator); }
      const button = document.createElement("button"); button.className = "crumb"; button.textContent = item.title; button.title = item.title;
      button.setAttribute("aria-current", String(item.id === scope.id)); button.disabled = busy;
      button.onclick = () => action("activate", { scopeId: item.id }, { reveal: true });
      $("breadcrumb").append(button);
    });
  }
}

function render(next, { force = false } = {}) {
  const previousScope = state?.activeScopeId;
  state = next;
  const scope = currentScope();
  if (!scope) return;
  $("workspace-path").textContent = state.cwd;
  $("runtime-mode").textContent = state.demo ? "Offline demo" : "Live Codex";
  $("active-title").textContent = scope.title;
  $("back").disabled = busy || !scope.parentId;
  $("refresh").disabled = busy;
  $("new-conversation").disabled = busy;
  $("ask").disabled = busy;
  $("continue-conversation").disabled = busy;
  $("continue-label").textContent = scope.title;
  if (composerScopeId !== scope.id) {
    if (composerScopeId) promptDrafts.set(composerScopeId, $("prompt").value);
    composerScopeId = scope.id;
    $("prompt").value = promptDrafts.get(scope.id) || "";
  }
  const waiting = scope.pendingSubmission || scope.pendingPrompt || scope.turns.at(-1)?.assistant.status === "streaming";
  $("composer-label").textContent = scope.turns.length ? "Message in this conversation" : "Start this conversation";
  $("send").disabled = busy || waiting;
  $("composer-status").textContent = waiting ? "Waiting for reply. Tools and approvals are in Terminal." : state.demo ? "Offline demo: replies are simulated" : "Ctrl+Enter to send";
  renderNavigation(scope);
  const key = JSON.stringify(state.scopes.map((item) => [item.id, item.parentId, item.title, item.anchor, item.collapsed, item.pendingPrompt, item.pendingText,
    item.turns.map((turn) => [turn.id, turn.user.text, turn.assistant.text, turn.assistant.status])]));
  const selected = window.getSelection();
  const selecting = selected?.rangeCount && !selected.isCollapsed && $("transcript").contains(selected.anchorNode);
  if (key !== lastTranscript && (force || (!selection && !selecting))) {
    const position = captureViewport();
    const focusPart = document.activeElement?.closest?.(".answer-text");
    const focusSummary = document.activeElement?.closest?.("summary");
    const focus = focusPart ? { scopeId: focusPart.dataset.scope, turnId: focusPart.dataset.turn, start: Number(focusPart.dataset.start) }
      : focusSummary ? { scopeId: focusSummary.parentElement.dataset.scope } : null;
    $("selection-home").append($("follow-up"));
    const roots = state.scopes.filter((item) => !item.parentId);
    $("transcript").replaceChildren(...roots.map((item) => renderScope(item)));
    $("transcript-empty").hidden = roots.length > 0;
    lastTranscript = key;
    restoreViewport(position);
    if (focus?.turnId) partFor(focus.scopeId, focus.turnId, focus.start)?.focus({ preventScroll: true });
    else if (focus?.scopeId) scopeElement(focus.scopeId)?.querySelector(":scope > summary")?.focus({ preventScroll: true });
    if (expectedReplyScope === scope.id && scope.turns.filter((turn) => turn.assistant.text).length > expectedReplyCount) {
      revealScope(scope.id, true); expectedReplyScope = null;
    }
  }
  $("transcript").querySelectorAll(".scope-action").forEach((button) => { button.disabled = busy; });
  if (!initializedView) {
    initializedView = true;
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem(`threadline-view-${state.sessionId}`) || "null"); } catch {}
    if (saved) {
      for (const [id, position] of saved.returnPositions || []) returnPositions.set(id, position);
      for (const [id, draft] of saved.promptDrafts || []) promptDrafts.set(id, draft);
      $("prompt").value = promptDrafts.get(scope.id) || "";
      setTerminalVisible(Boolean(saved.terminalVisible));
      $("history-menu").open = Boolean(saved.historyOpen);
      restoreViewport(saved.position);
    }
    if (!scope.turns.length && !scope.pendingPrompt) $("prompt").focus({ preventScroll: true });
  }
  if (previousScope && previousScope !== scope.id && selection) clearSelection();
  if (state.notice) message(state.notice);
  connect(scope.terminalId);
}

async function refreshState() {
  if (refreshing || busy) return;
  refreshing = true;
  try { const next = await api("state"); if (!busy) render(next); }
  catch (error) { message(error.message); }
  finally { refreshing = false; }
}

async function action(path, input = {}, options = {}) {
  if (busy) return;
  const oldScopeId = state?.activeScopeId;
  const returnPosition = path === "branch" ? selectionPosition || { ...captureViewport(), terminalVisible: !$("terminal-pane").hidden } : null;
  busy = true; message("");
  if (state) render(state);
  if (path === "branch") $("ask").textContent = "Opening branch…";
  let success = false;
  try {
    const next = await api(path, input);
    if (["branch", "activate", "back", "new", "send"].includes(path)) clearSelection();
    render(next, { force: !selection }); success = true;
    if (path === "branch") {
      returnPositions.set(next.activeScopeId, returnPosition);
      $("question").value = "";
      setTerminalVisible(true);
      revealScope(next.activeScopeId);
      expectedReplyScope = next.activeScopeId; expectedReplyCount = currentScope()?.turns.filter((turn) => turn.assistant.text).length || 0;
    } else if (path === "back") {
      const position = returnPositions.get(oldScopeId);
      if (position) setTerminalVisible(position.terminalVisible);
      returnToSource(oldScopeId);
    }
    else if (path === "new") { revealScope(next.activeScopeId); $("prompt").focus({ preventScroll: true }); }
    else if (path === "send") {
      $("prompt").value = ""; promptDrafts.delete(next.activeScopeId);
      expectedReplyScope = next.activeScopeId; expectedReplyCount = currentScope()?.turns.filter((turn) => turn.assistant.text).length || 0;
      revealScope(next.activeScopeId, true);
      $("prompt").focus({ preventScroll: true });
    }
    else if (options.reveal) revealScope(next.activeScopeId);
    if (options.terminal) setTerminalVisible(true, true);
    if (options.compose) $("prompt").focus({ preventScroll: true });
  } catch (error) { message(error.message); }
  finally {
    busy = false; $("ask").textContent = "Open branch";
    if (!success && path === "collapse") lastTranscript = "";
    if (state) render(state);
  }
}

function clearSelection() {
  stopSelectionAnimation();
  $("follow-up").inert = false;
  selection = null; selectionPosition = null; $("follow-up").hidden = true; $("selected-quote").textContent = "";
  $("selection-home").append($("follow-up"));
}

function captureSelection() {
  if (busy) return;
  const selected = window.getSelection();
  if (!selected?.rangeCount || selected.isCollapsed) return;
  const range = selected.getRangeAt(0);
  const containingPart = (node) => (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest(".answer-text");
  const first = containingPart(range.startContainer);
  const last = containingPart(range.endContainer);
  if (!first || !last || first.dataset.complete !== "true" || last.dataset.complete !== "true" ||
      first.dataset.scope !== last.dataset.scope || first.dataset.turn !== last.dataset.turn) return;
  if (allParts().some((part) => range.intersectsNode(part) && part.getClientRects().length &&
    (part.dataset.scope !== first.dataset.scope || part.dataset.turn !== first.dataset.turn))) return;
  const start = sourceBoundary(first, range.startContainer, range.startOffset, false);
  const end = sourceBoundary(last, range.endContainer, range.endOffset, true);
  const turn = currentScope(first.dataset.scope)?.turns.find((item) => item.id === first.dataset.turn);
  if (!turn || !Number.isInteger(start) || !Number.isInteger(end) || end <= start) return;
  const quote = turn.assistant.text.slice(start, end);
  if (!quote.trim()) return;
  selectionPosition = { ...captureViewport(), terminalVisible: !$("terminal-pane").hidden };
  stopSelectionAnimation();
  selection = { scopeId: first.dataset.scope, turnId: first.dataset.turn, start, end, quote };
  $("selected-quote").textContent = quote;
  $("follow-up").hidden = false;
  $("follow-up").inert = false;
  last.closest(".answer-part").insertBefore($("follow-up"), last.nextSibling);
  selected.removeAllRanges();
  $("question").focus({ preventScroll: true });
  const currentSelection = selection;
  const gesture = readingGesture;
  animateSelection(true, () => {
    if (selection === currentSelection && readingGesture === gesture && document.activeElement === $("question")) revealSelection();
  });
}

function setTerminalVisible(visible, focus = false) {
  if (visible) { $("sidebar").hidden = false; $("layout").classList.remove("panel-hidden"); $("toggle-panel").setAttribute("aria-expanded", "true"); }
  $("terminal-pane").hidden = !visible;
  $("layout").classList.toggle("terminal-hidden", !visible);
  $("toggle-terminal").setAttribute("aria-expanded", String(visible));
  resize();
  if (visible && focus) terminal.focus();
}

function togglePanel() {
  const hidden = !$("sidebar").hidden;
  if (hidden) setTerminalVisible(true);
  $("sidebar").hidden = hidden;
  $("layout").classList.toggle("panel-hidden", hidden);
  $("toggle-panel").setAttribute("aria-expanded", String(!hidden));
  resize(); if (hidden) terminal.focus();
}

function shortcut(event) {
  if (event.type !== "keydown" || !event.ctrlKey || !event.shiftKey) return false;
  if (event.code === "KeyB") { togglePanel(); event.preventDefault(); return true; }
  if (event.code === "Backquote") { setTerminalVisible($("terminal-pane").hidden, true); event.preventDefault(); return true; }
  return false;
}

$("answers").addEventListener("pointerup", captureSelection);
$("answers").addEventListener("mouseup", captureSelection);
$("answers").addEventListener("keyup", captureSelection);
function cancelSelection() {
  const position = selectionPosition;
  const selected = selection;
  $("follow-up").inert = true;
  if (selected) partFor(selected.scopeId, selected.turnId, selected.start)?.focus({ preventScroll: true });
  animateSelection(false, () => {
    if (selection !== selected) return;
    clearSelection();
    if (state) render(state);
    restoreViewport(position);
    if (selected) partFor(selected.scopeId, selected.turnId, selected.start)?.focus({ preventScroll: true });
  });
}

$("cancel-selection").onclick = cancelSelection;
$("follow-up").onsubmit = (event) => { event.preventDefault(); if (selection) void action("branch", { ...selection, question: $("question").value }); };
$("question").addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); $("follow-up").requestSubmit(); }
  if (event.key === "Escape") { event.preventDefault(); cancelSelection(); }
});
$("back").onclick = () => action("back");
$("refresh").onclick = () => action("refresh");
$("new-conversation").onclick = () => action("new");
$("toggle-panel").onclick = togglePanel;
$("toggle-terminal").onclick = () => setTerminalVisible($("terminal-pane").hidden, true);
$("continue-conversation").onclick = () => setTerminalVisible(true, true);
$("composer").onsubmit = (event) => { event.preventDefault(); if (state) void action("send", { scopeId: state.activeScopeId, text: $("prompt").value }); };
$("prompt").addEventListener("input", () => { if (composerScopeId) promptDrafts.set(composerScopeId, $("prompt").value); });
$("prompt").addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.isComposing) { event.preventDefault(); $("composer").requestSubmit(); }
});
document.addEventListener("keydown", (event) => { if (!$("terminal").contains(event.target)) shortcut(event); });
$("answers").addEventListener("wheel", () => { readingGesture += 1; }, { passive: true });
$("answers").addEventListener("pointerdown", () => { readingGesture += 1; }, { passive: true });
$("answers").addEventListener("keydown", (event) => { if (["PageUp", "PageDown", "Home", "End"].includes(event.key)) readingGesture += 1; });
reducedMotion.addEventListener("change", (event) => { if (event.matches) selectionAnimation?.finish(); });
window.addEventListener("pagehide", () => {
  if (!state) return;
  try { sessionStorage.setItem(`threadline-view-${state.sessionId}`, JSON.stringify({
    position: captureViewport(), terminalVisible: !$("terminal-pane").hidden, historyOpen: $("history-menu").open,
    returnPositions: [...returnPositions],
    promptDrafts: [...promptDrafts],
  })); } catch {}
});

try {
  if (location.hash.length > 1) {
    const response = await fetch("/api/bootstrap", { method: "POST", headers: { "X-Threadline-Token": location.hash.slice(1) } });
    if (!response.ok) throw new Error("Open the link printed by Threadline to connect.");
    history.replaceState(null, "", location.pathname);
  }
  await refreshState();
  setInterval(() => { if (!busy) void refreshState(); }, 1200);
} catch (error) { message(error.message); }
