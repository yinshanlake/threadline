import { Terminal } from "/vendor/xterm.mjs";
import { FitAddon } from "/vendor/fit.mjs";
import { UnicodeGraphemesAddon } from "/vendor/unicode.mjs";
import { contentBlocks, terminalMarkup } from "/text.mjs";
import { resolveNativeSelection } from "/selection.mjs";

const $ = (id) => document.getElementById(id);
export const terminal = new Terminal({
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
const viewPositions = new Map();
let state;
let socket;
let terminalId;
let terminalScopeId;
let mainScopeId;
let mainTerminalId;
let viewScopeId;
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
let expectedReplyGesture = 0;
let selectionAnimation;
let panelAnimation;
let panelClosing = false;
let layoutAnimating = false;
let fitFrame;
let menuSelection;
let panelPosition;
let lastNotice;
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
function currentScope(id = viewScopeId) { return state?.scopes.find((scope) => scope.id === id); }
function displayedScope() { return state?.scopes.find((scope) => scope.terminalId === terminalId) || currentScope(terminalScopeId); }
function rootOf(id) {
  let scope = currentScope(id);
  const seen = new Set();
  while (scope?.parentId && !seen.has(scope.id)) { seen.add(scope.id); scope = currentScope(scope.parentId); }
  return scope?.id || state.rootScopeId;
}
function sourceDescription(scopeId, turnId) {
  const scope = currentScope(scopeId);
  const index = scope?.turns.findIndex((turn) => turn.id === turnId) ?? -1;
  return `${scope?.title || "Unavailable source"} · Answer ${index + 1} · Session ${scope?.threadId?.slice(0, 8) || "unknown"}`;
}
function validSelection(value) {
  const scope = currentScope(value.scopeId);
  const turn = scope?.turns.find((item) => item.id === value.turnId);
  const native = value.origin && state.scopes.find((item) => item.terminalId === value.origin.terminalId);
  return !value.invalidReason && scope?.threadId === value.sourceThreadId && turn?.providerTurnId === value.providerTurnId &&
    turn?.assistant.status === "complete" && turn.assistant.text.slice(value.start, value.end) === value.quote &&
    (!value.origin || (native?.id === value.origin.scopeId && native?.threadId === value.origin.threadId &&
      native?.terminalThreadId === value.origin.threadId));
}
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
  if (layoutAnimating || $("terminal-pane").hidden || $("terminal").clientWidth < 40) return;
  const dimensions = fit.proposeDimensions();
  if (!dimensions) return;
  const cols = Math.max(20, Math.min(400, dimensions.cols));
  const rows = Math.max(5, Math.min(160, dimensions.rows));
  if (cols === terminal.cols && rows === terminal.rows) return;
  // Cell-based highlights must not drift onto different text after reflow.
  terminal.clearSelection();
  terminal.resize(cols, rows);
}

function scheduleFit() {
  if (layoutAnimating) return;
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(resize);
}

terminal.onData((data) => { if (hasSnapshot) send({ type: "input", data }); });
terminal.onResize(({ cols, rows }) => {
  dismissNativeMenu();
  if (hasSnapshot) send({ type: "resize", cols, rows });
});
new ResizeObserver(scheduleFit).observe($("terminal"));
terminal.attachCustomKeyEventHandler((event) => !shortcut(event));
terminal.onSelectionChange(() => {
  $("terminal-ask").disabled = busy || !terminal.hasSelection();
  if (menuSelection && terminal.hasSelection() && terminal.getSelection() !== menuSelection.text) dismissNativeMenu();
});
terminal.onScroll(() => dismissNativeMenu());
terminal.onWriteParsed(() => {
  if (menuSelection && !nativeCaptureCurrent(menuSelection)) {
    dismissNativeMenu();
    message("The terminal changed. Select the passage again before asking.");
  }
});

function connect(id) {
  if (id === terminalId && (!id || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  const previous = socket;
  if (previous) { previous.onclose = null; previous.close(); }
  socket = null;
  terminalId = id;
  hasSnapshot = false;
  dismissNativeMenu();
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
  if (position?.viewScopeId === viewScopeId) restoreViewport(position);
  if (!currentScope()?.parentId) {
    if (!selection) setPanelVisible(false);
    terminal.focus();
    return;
  }
  const part = child?.anchor && partFor(child.parentId, child.anchor.turnId, child.anchor.sourceStart);
  if (!part) return;
  if (position?.viewScopeId !== viewScopeId) part.scrollIntoView({ block: "center" });
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
  if (scope.anchor) {
    const source = document.createElement("div"); source.className = "branch-source";
    const identity = document.createElement("p"); identity.className = "source-identity";
    identity.textContent = "Selected from " + sourceDescription(scope.parentId, scope.anchor.turnId);
    const quote = document.createElement("blockquote"); quote.textContent = scope.anchor.exactQuote;
    source.append(identity, quote); body.append(source);
  }
  const path = new Set(ancestry); path.add(scope.id);
  const children = state.scopes.filter((item) => item.parentId === scope.id && !path.has(item.id));
  const placed = new Set();
  for (const turn of scope.turns) {
    const article = document.createElement("article"); article.className = "answer";
    article.dataset.scope = scope.id; article.dataset.turn = turn.id;
    const heading = document.createElement("div"); heading.className = "answer-question-row";
    const user = document.createElement("span"); user.className = "role-label"; user.textContent = "You";
    const prompt = document.createElement("p"); prompt.className = "answer-question"; prompt.textContent = turn.user.text;
    heading.append(user, prompt);
    article.append(heading);
    const answer = document.createElement("div"); answer.className = "answer-body"; article.append(answer);
    const assistant = document.createElement("span"); assistant.className = "role-label"; assistant.textContent = state.demo ? "Demo reply" : "Codex";
    answer.append(assistant);
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
          : "The reply will appear when the turn finishes. Use Open branch terminal for tools or approvals.";
      answer.append(note);
    }
    body.append(article);
  }
  if (!scope.turns.length) {
    const empty = document.createElement("p"); empty.className = "scope-status";
    empty.textContent = scope.pendingPrompt || scope.pendingSubmission ? "Your follow-up is running. Open branch terminal for progress, tools or approvals."
      : "Continue this follow-up below.";
    body.append(empty);
  }
  if (scope.pendingText) {
    const pending = document.createElement("article"); pending.className = "answer pending-answer";
    const prompt = document.createElement("p"); prompt.className = "answer-question"; prompt.textContent = scope.pendingText;
    const note = document.createElement("p"); note.className = "scope-status"; note.textContent = "Waiting for Codex. Open branch terminal for progress or approvals.";
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
  open.textContent = "Continue this follow-up"; open.disabled = busy;
  open.onclick = () => action("view", { scopeId: scope.id }, { compose: true });
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
        button.onclick = () => action("view", { scopeId: item.id }, { reveal: true });
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
      button.onclick = () => action("view", { scopeId: item.id }, { reveal: true });
      $("breadcrumb").append(button);
    });
  }
}

function initializeView() {
  initializedView = true;
  viewScopeId = state.activeScopeId;
  mainScopeId = rootOf(viewScopeId);
  terminalScopeId = mainScopeId;
  try {
    const saved = JSON.parse(sessionStorage.getItem(`threadline-view-${state.sessionId}`) || "null");
    if (saved) {
      viewScopeId = currentScope(saved.viewScopeId)?.id || viewScopeId;
      mainScopeId = currentScope(saved.mainScopeId)?.id || mainScopeId;
      terminalScopeId = currentScope(saved.terminalScopeId)?.id || mainScopeId;
      for (const [id, position] of saved.returnPositions || []) returnPositions.set(id, position);
      for (const [id, position] of saved.viewPositions || []) viewPositions.set(id, position);
      for (const [id, draft] of saved.promptDrafts || []) promptDrafts.set(id, draft);
      if (saved.selection && typeof saved.selection.quote === "string") {
        selection = saved.selection;
        selectionPosition = saved.selectionPosition;
      }
      $("question").value = typeof saved.question === "string" ? saved.question : "";
      $("history-menu").open = Boolean(saved.historyOpen);
      panelPosition = saved.position;
      setPanelVisible(Boolean(saved.panelVisible), { animate: false });
      if (saved.panelVisible) setTerminalVisible(saved.terminalVisible !== false);
    }
  } catch (error) { message("Could not restore the browser view: " + error.message); }
  mainTerminalId = currentScope(mainScopeId)?.terminalId;
}

function renderAttention() {
  const alerts = $("terminal-alerts");
  const existing = new Map([...alerts.children].map((button) => [button.dataset.scope, button]));
  for (const scope of state.scopes.filter((item) => item.parentId && item.terminalId !== terminalId &&
    (["blocked", "working"].includes(item.activity?.kind) || item.pendingPrompt || item.pendingSubmission))) {
    let button = existing.get(scope.id);
    if (!button) {
      button = document.createElement("button"); button.dataset.scope = scope.id;
      button.onclick = () => action("terminal", { scopeId: scope.id });
      alerts.append(button);
    }
    existing.delete(scope.id);
    const label = `${scope.activity?.kind === "blocked" ? "Needs attention" : "Running"}: ${scope.title} — open native terminal`;
    if (button.textContent !== label) button.textContent = label;
    button.disabled = busy;
  }
  existing.forEach((button) => button.remove());
}

function render(next, { force = false } = {}) {
  state = next;
  const initial = !initializedView;
  if (initial) initializeView();
  if (!currentScope()) viewScopeId = state.activeScopeId;
  const scope = currentScope();
  if (!scope) return;
  // A native /new, /resume or /fork can rebind the same PTY. Follow that
  // identity, not the independently viewed branch or the original root ID.
  const rebound = state.scopes.find((item) => item.terminalId === terminalId);
  const reboundMain = state.scopes.find((item) => item.terminalId === mainTerminalId);
  if (rebound) terminalScopeId = rebound.id;
  if (reboundMain) mainScopeId = reboundMain.id;
  const native = currentScope(terminalScopeId);
  if (!mainTerminalId) mainTerminalId = currentScope(mainScopeId)?.terminalId;
  $("workspace-path").textContent = state.cwd;
  $("runtime-mode").textContent = state.demo ? "Offline demo" : "Live Codex";
  $("active-title").textContent = native?.terminalThreadId !== native?.threadId
    ? "Native session changed · history unavailable"
    : `${native?.parentId ? "Branch" : "Main"} · ${native?.title || "Native terminal"}`;
  $("terminal-pane").dataset.scope = native?.id || "";
  $("terminal-pane").dataset.thread = native?.threadId || "";
  $("terminal-pane").dataset.terminal = native?.terminalId || terminalId || "";
  $("main-terminal").hidden = terminalScopeId === mainScopeId;
  $("main-terminal").disabled = busy;
  $("terminal-ask").disabled = busy || !terminal.hasSelection();
  $("back").disabled = busy || !scope.parentId;
  $("refresh").disabled = busy;
  $("new-conversation").disabled = busy;
  $("ask").disabled = busy || Boolean(selection && !validSelection(selection));
  $("continue-conversation").disabled = busy;
  $("continue-conversation").textContent = `Open ${scope.parentId ? "branch" : "main"} terminal`;
  $("continue-label").textContent = scope.activity?.kind === "blocked"
    ? "Native input or approval needed" : "Tools, approvals and slash commands";
  $("continue-bar").hidden = Boolean(selection);
  $("composer").hidden = Boolean(selection) || !scope.parentId;
  $("follow-up").hidden = !selection;
  if (selection) {
    $("selected-quote").textContent = selection.quote;
    $("selection-source").textContent = "Selected from " + sourceDescription(selection.scopeId, selection.turnId);
    if (!validSelection(selection)) message(selection.invalidReason || "The selected source changed. Select it again before asking; your question has been kept.");
  }
  if (composerScopeId !== scope.id) {
    if (composerScopeId) promptDrafts.set(composerScopeId, $("prompt").value);
    composerScopeId = scope.id;
    $("prompt").value = promptDrafts.get(scope.id) || "";
  }
  const waiting = scope.pendingSubmission || scope.pendingPrompt || scope.turns.at(-1)?.assistant.status === "streaming";
  $("send").disabled = busy || waiting || !scope.parentId;
  $("composer-status").textContent = waiting ? "Waiting for reply. Open branch terminal for progress or approvals."
    : state.demo ? "Offline demo: replies are simulated" : "Ctrl+Enter to continue this thread";
  renderNavigation(scope);
  renderAttention();
  const key = JSON.stringify([viewScopeId, state.scopes.map((item) => item.parentId
    ? [item.id, item.parentId, item.title, item.anchor, item.collapsed, item.pendingPrompt, item.pendingText,
      item.turns.map((turn) => [turn.id, turn.user.text, turn.assistant.text, turn.assistant.status])]
    : [item.id, item.title])]);
  const selected = window.getSelection();
  const selecting = selected?.rangeCount && !selected.isCollapsed && $("transcript").contains(selected.anchorNode);
  const roots = scope.parentId ? [scope] : state.scopes.filter((item) => item.parentId === scope.id);
  $("transcript-empty").hidden = roots.length > 0 || Boolean(selection);
  if (key !== lastTranscript && (initial || force || (!selection && !selecting))) {
    const position = captureViewport();
    const focusPart = document.activeElement?.closest?.(".answer-text");
    const focusSummary = document.activeElement?.closest?.("summary");
    const focusQuestion = document.activeElement === $("question");
    const focus = focusPart ? { scopeId: focusPart.dataset.scope, turnId: focusPart.dataset.turn, start: Number(focusPart.dataset.start) }
      : focusSummary ? { scopeId: focusSummary.parentElement.dataset.scope } : null;
    $("selection-home").append($("follow-up"));
    $("transcript").replaceChildren(...roots.map((item) => renderScope(item)));
    lastTranscript = key;
    if (selection && !selection.origin) {
      const part = partFor(selection.scopeId, selection.turnId, selection.end);
      part?.closest(".answer-part").append($("follow-up"));
    }
    restoreViewport(position);
    if (focusQuestion && selection) $("question").focus({ preventScroll: true });
    else if (focus?.turnId) partFor(focus.scopeId, focus.turnId, focus.start)?.focus({ preventScroll: true });
    else if (focus?.scopeId) scopeElement(focus.scopeId)?.querySelector(":scope > summary")?.focus({ preventScroll: true });
    if (expectedReplyScope === scope.id && scope.turns.filter((turn) => turn.assistant.text).length > expectedReplyCount) {
      if (!$("sidebar").hidden && expectedReplyGesture === readingGesture) revealScope(scope.id, true);
      expectedReplyScope = null;
    }
  }
  $("transcript").querySelectorAll(".scope-action").forEach((button) => { button.disabled = busy; });
  if (initial) restoreViewport(panelPosition);
  if (menuSelection && !nativeCaptureCurrent(menuSelection)) dismissNativeMenu();
  if (state.notice && state.notice !== lastNotice) message(state.notice);
  lastNotice = state.notice;
  if (native?.terminalId) connect(native.terminalId);
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
  const oldScopeId = viewScopeId;
  const returnPosition = path === "branch" ? selectionPosition : null;
  const gesture = readingGesture;
  const replies = currentScope(input.scopeId)?.turns.filter((turn) => turn.assistant.text).length || 0;
  if (oldScopeId && !$("sidebar").hidden) viewPositions.set(oldScopeId, captureViewport());
  busy = true; message("");
  if (state) render(state);
  if (path === "branch") $("ask").textContent = "Opening branch…";
  let success = false;
  try {
    const next = await api(path, input);
    if (path === "branch") {
      viewScopeId = next.activeScopeId;
      returnPositions.set(next.activeScopeId, returnPosition);
      clearSelection();
      $("question").value = "";
      expectedReplyScope = viewScopeId; expectedReplyCount = 0; expectedReplyGesture = gesture;
    } else if (path === "view" || path === "view-back") {
      viewScopeId = next.activeScopeId;
      expectedReplyScope = null;
    } else if (path === "send") {
      $("prompt").value = ""; promptDrafts.delete(input.scopeId);
      expectedReplyScope = input.scopeId; expectedReplyCount = replies; expectedReplyGesture = gesture;
    } else if (path === "terminal" || path === "new") {
      const target = next.scopes.find((item) => item.id === (path === "new" ? next.activeScopeId : input.scopeId));
      terminalScopeId = target.id;
      if (!target.parentId) { mainScopeId = target.id; mainTerminalId = target.terminalId; }
      if (path === "new" && !selection && !currentScope()?.parentId) viewScopeId = target.id;
      connect(target.terminalId);
    }
    render(next, { force: ["branch", "view", "view-back"].includes(path) || !selection });
    success = true;
    if (path === "view-back") returnToSource(oldScopeId);
    else if (path === "view") {
      restoreViewport(viewPositions.get(viewScopeId));
      if (options.reveal && !viewPositions.has(viewScopeId)) revealScope(viewScopeId);
    } else if (path === "branch" && !$("sidebar").hidden && gesture === readingGesture) {
      revealScope(viewScopeId);
      $("prompt").focus({ preventScroll: true });
    }
    if ((path === "terminal" || path === "new") && !options.restore) setTerminalVisible(true, true);
    if ((options.compose || path === "send") && !$("composer").hidden && !$("sidebar").hidden) $("prompt").focus({ preventScroll: true });
  } catch (error) { message(error.message); }
  finally {
    busy = false; $("ask").textContent = "Ask in new thread";
    if (!success && path === "collapse") lastTranscript = "";
    if (state) render(state);
  }
}

function clearSelection() {
  stopSelectionAnimation();
  $("follow-up").inert = false;
  selection = null; selectionPosition = null; $("follow-up").hidden = true; $("selected-quote").textContent = "";
  $("selection-source").textContent = "";
  $("selection-home").append($("follow-up"));
}

function beginSelection(value) {
  selectionPosition = { ...captureViewport(), viewScopeId, panelVisible: !$("sidebar").hidden, terminalVisible: !$("terminal-pane").hidden };
  stopSelectionAnimation();
  selection = value;
  viewScopeId = value.scopeId;
  $("follow-up").inert = false;
  setPanelVisible(true);
  render(state, { force: true });
  const sourcePart = !value.origin && partFor(value.scopeId, value.turnId, value.end);
  if (sourcePart) sourcePart.closest(".answer-part").append($("follow-up"));
  else $("selection-home").append($("follow-up"));
  $("question").focus({ preventScroll: true });
  const gesture = readingGesture;
  animateSelection(true, () => {
    if (selection === value && readingGesture === gesture && !$("sidebar").hidden && document.activeElement === $("question")) revealSelection();
  });
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
  const scope = currentScope(first.dataset.scope);
  const turn = scope?.turns.find((item) => item.id === first.dataset.turn);
  if (!turn || !Number.isInteger(start) || !Number.isInteger(end) || end <= start) return;
  const quote = turn.assistant.text.slice(start, end);
  if (!quote.trim()) return;
  selected.removeAllRanges();
  message("");
  beginSelection({ scopeId: scope.id, sourceThreadId: scope.threadId, turnId: turn.id, providerTurnId: turn.providerTurnId, start, end, quote });
}

function nativeSelectionLines(position) {
  const buffer = terminal.buffer.active;
  const lines = [];
  const last = position.end.y - (position.end.x === 0 ? 1 : 0);
  for (let row = position.start.y; row <= last; row += 1) lines.push(buffer.getLine(row)?.translateToString(false));
  return lines;
}

function nativeBufferSignature(position) {
  const bounds = $("terminal").getBoundingClientRect();
  return JSON.stringify([terminal.buffer.active.type, terminal.cols, terminal.rows, innerWidth, innerHeight,
    bounds.width, bounds.height, position, nativeSelectionLines(position)]);
}

function captureNativeSelection() {
  const text = terminal.getSelection();
  const position = terminal.getSelectionPosition();
  const source = displayedScope();
  if (!hasSnapshot || !text.trim() || !position || !source) return null;
  return {
    text, position, context: nativeSelectionLines(position).join("\n"), signature: nativeBufferSignature(position),
    terminalId, scopeId: source.id, threadId: source.threadId,
  };
}

function nativeCaptureCurrent(capture) {
  const source = displayedScope();
  // A native focus-out redraw can clear the highlight. The frozen cells and
  // session binding, rather than that visual highlight, identify the source.
  return hasSnapshot && terminalId === capture.terminalId && source?.id === capture.scopeId &&
    source?.threadId === capture.threadId && (!terminal.hasSelection() || terminal.getSelection() === capture.text) &&
    nativeBufferSignature(capture.position) === capture.signature;
}

function dismissNativeMenu(focus = false) {
  $("native-menu").hidden = true;
  menuSelection = null;
  if (focus) terminal.focus();
}

function showNativeMenu(event) {
  if (busy) return false;
  const capture = captureNativeSelection();
  if (!capture) return false;
  menuSelection = capture;
  const menu = $("native-menu");
  menu.hidden = false;
  const bounds = $("terminal").getBoundingClientRect();
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(event?.clientX ?? bounds.left + 24, innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event?.clientY ?? bounds.top + 24, innerHeight - rect.height - 8))}px`;
  $("native-menu-ask").focus({ preventScroll: true });
  return true;
}

async function askNativeSelection(capture = captureNativeSelection()) {
  if (busy) return;
  if (!capture) { message("Select text in a completed native answer first. Then right-click, press Shift+F10, or use Ask about selection."); return; }
  dismissNativeMenu();
  busy = true; message("");
  render(state);
  let frozen;
  try {
    if (!nativeCaptureCurrent(capture)) throw new Error("The terminal selection changed. Select the passage again.");
    if (displayedScope()?.terminalThreadId !== capture.threadId) {
      throw new Error(state.notice || "The native session changed before its history could be linked. Reopen its source terminal before asking.");
    }
    frozen = {
      ...resolveNativeSelection(state.scopes, capture.scopeId, capture.text, { context: capture.context }),
      origin: { terminalId: capture.terminalId, scopeId: capture.scopeId, threadId: capture.threadId },
    };
    beginSelection(frozen);
    $("ask").textContent = "Checking source…";
    const result = await api("selection", {
      terminalId: capture.terminalId, scopeId: capture.scopeId, threadId: capture.threadId, text: capture.text, context: capture.context,
    });
    render(result.state);
    if (!["scopeId", "sourceThreadId", "turnId", "providerTurnId", "start", "end", "quote"]
      .every((key) => frozen[key] === result.selection[key])) throw new Error("The selected source changed. Select it again; your question has been kept.");
  } catch (error) {
    if (frozen && selection === frozen) frozen.invalidReason = error.message;
    message(error.message);
  }
  finally {
    busy = false; $("ask").textContent = "Ask in new thread";
    if (state) render(state);
  }
}

function setPanelVisible(visible, { animate = true } = {}) {
  const sidebar = $("sidebar");
  if (visible === (!sidebar.hidden && !panelClosing) && !panelAnimation) return;
  if (panelAnimation) { panelAnimation.onfinish = null; panelAnimation.cancel(); panelAnimation = null; }
  cancelAnimationFrame(fitFrame);
  layoutAnimating = true;
  panelClosing = !visible;
  dismissNativeMenu();
  if (visible) {
    sidebar.hidden = false; sidebar.inert = false;
    $("follow-up").inert = false;
    $("layout").classList.remove("panel-hidden");
    restoreViewport(panelPosition);
  } else {
    panelPosition = captureViewport();
    stopSelectionAnimation();
    sidebar.inert = true;
    setTerminalVisible(true);
    if (sidebar.contains(document.activeElement)) terminal.focus();
  }
  $("toggle-panel").setAttribute("aria-expanded", String(visible));
  const complete = () => {
    if (!visible) { sidebar.hidden = true; $("layout").classList.add("panel-hidden"); }
    panelAnimation = null; panelClosing = false; layoutAnimating = false;
    resize();
  };
  if (!animate || reducedMotion.matches) { complete(); return; }
  const expanded = { opacity: 1, transform: "translateX(0px)" };
  const collapsed = { opacity: 0, transform: "translateX(16px)" };
  const animation = sidebar.animate(visible ? [collapsed, expanded] : [expanded, collapsed], {
    duration: visible ? 480 : 240, easing: "cubic-bezier(.4,0,.25,1)", fill: "both",
  });
  panelAnimation = animation;
  animation.onfinish = () => {
    if (panelAnimation !== animation) return;
    animation.cancel(); complete();
  };
}

function setTerminalVisible(visible, focus = false) {
  if (!visible && $("sidebar").hidden) setPanelVisible(true);
  $("terminal-pane").hidden = !visible;
  $("layout").classList.toggle("terminal-hidden", !visible);
  $("toggle-terminal").setAttribute("aria-expanded", String(visible));
  scheduleFit();
  if (visible && focus) terminal.focus();
}

function togglePanel() { setPanelVisible($("sidebar").hidden || panelClosing); }

function shortcut(event) {
  if (event.type !== "keydown" || event.isComposing) return false;
  if ($("terminal").contains(event.target) && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
    if (!showNativeMenu()) return false;
    event.preventDefault(); return true;
  }
  if (!event.ctrlKey || !event.shiftKey) return false;
  if (event.code === "KeyB") { togglePanel(); event.preventDefault(); return true; }
  if (event.code === "Backquote") { setTerminalVisible($("terminal-pane").hidden, true); event.preventDefault(); return true; }
  if (event.code === "KeyA") { void askNativeSelection(); event.preventDefault(); return true; }
  return false;
}

function cancelSelection() {
  const position = selectionPosition;
  const selected = selection;
  $("follow-up").inert = true;
  if (selected?.origin) terminal.focus();
  else if (selected) partFor(selected.scopeId, selected.turnId, selected.start)?.focus({ preventScroll: true });
  animateSelection(false, () => {
    if (selection !== selected) return;
    clearSelection();
    if (currentScope(position?.viewScopeId)) viewScopeId = position.viewScopeId;
    if (state) render(state, { force: true });
    restoreViewport(position);
    if (position && !position.panelVisible) setPanelVisible(false);
    else if (selected && !selected.origin) partFor(selected.scopeId, selected.turnId, selected.start)?.focus({ preventScroll: true });
  });
}

$("terminal").addEventListener("contextmenu", (event) => {
  if (terminal.modes.mouseTrackingMode !== "none" && !event.shiftKey) return;
  if (showNativeMenu(event)) { event.preventDefault(); event.stopPropagation(); }
}, true);
$("native-menu-ask").onclick = () => askNativeSelection(menuSelection);
$("native-menu-copy").onclick = async () => {
  const capture = menuSelection;
  dismissNativeMenu(true);
  try {
    if (!capture || !nativeCaptureCurrent(capture)) throw new Error("The terminal selection changed. Select it again.");
    await navigator.clipboard.writeText(capture.text);
    message("Selection copied.");
  } catch (error) { message("Could not copy the selection: " + error.message); }
};
$("native-menu").addEventListener("keydown", (event) => {
  const items = [...$("native-menu").querySelectorAll("button")];
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    const target = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[target].focus();
  } else if (event.key === "Escape") { event.preventDefault(); dismissNativeMenu(true); }
  else if (event.key === "Tab") dismissNativeMenu(true);
});
document.addEventListener("pointerdown", (event) => { if (!$("native-menu").contains(event.target)) dismissNativeMenu(); }, true);
window.addEventListener("resize", () => dismissNativeMenu());
window.addEventListener("blur", () => dismissNativeMenu());
$("terminal-ask").onclick = () => askNativeSelection();
$("main-terminal").onclick = () => action("terminal", { scopeId: mainScopeId });
$("answers").addEventListener("pointerup", captureSelection);
$("answers").addEventListener("mouseup", captureSelection);
$("answers").addEventListener("keyup", captureSelection);
$("cancel-selection").onclick = cancelSelection;
$("follow-up").onsubmit = (event) => {
  event.preventDefault();
  if (selection && validSelection(selection)) void action("branch", { ...selection, question: $("question").value });
  else message("The selected source changed. Select it again before asking; your question has been kept.");
};
$("question").addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.isComposing) { event.preventDefault(); $("follow-up").requestSubmit(); }
  if (event.key === "Escape") { event.preventDefault(); cancelSelection(); }
});
$("back").onclick = () => action("view-back", { scopeId: viewScopeId });
$("refresh").onclick = () => action("refresh", { scopeId: viewScopeId });
$("new-conversation").onclick = () => action("new");
$("toggle-panel").onclick = togglePanel;
$("close-panel").onclick = () => setPanelVisible(false);
$("toggle-terminal").onclick = () => setTerminalVisible($("terminal-pane").hidden, true);
$("continue-conversation").onclick = () => action("terminal", { scopeId: viewScopeId });
$("composer").onsubmit = (event) => { event.preventDefault(); if (currentScope()?.parentId) void action("send", { scopeId: viewScopeId, text: $("prompt").value }); };
$("prompt").addEventListener("input", () => { if (composerScopeId) promptDrafts.set(composerScopeId, $("prompt").value); });
$("prompt").addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.isComposing) { event.preventDefault(); $("composer").requestSubmit(); }
});
document.addEventListener("keydown", (event) => { if (!$("terminal").contains(event.target)) shortcut(event); });
$("answers").addEventListener("wheel", () => { readingGesture += 1; }, { passive: true });
$("answers").addEventListener("pointerdown", () => { readingGesture += 1; }, { passive: true });
$("answers").addEventListener("keydown", (event) => { if (["PageUp", "PageDown", "Home", "End"].includes(event.key)) readingGesture += 1; });
reducedMotion.addEventListener("change", (event) => {
  if (event.matches) { selectionAnimation?.finish(); panelAnimation?.finish(); }
});
window.addEventListener("pagehide", () => {
  if (!state) return;
  try { sessionStorage.setItem(`threadline-view-${state.sessionId}`, JSON.stringify({
    position: $("sidebar").hidden ? panelPosition : captureViewport(),
    terminalVisible: !$("terminal-pane").hidden, panelVisible: !$("sidebar").hidden && !panelClosing,
    historyOpen: $("history-menu").open, mainScopeId, terminalScopeId, viewScopeId,
    returnPositions: [...returnPositions], viewPositions: [...viewPositions], promptDrafts: [...promptDrafts],
    selection, selectionPosition, question: $("question").value,
  })); } catch (error) { message("Could not save the browser view: " + error.message); }
});

try {
  if (location.hash.length > 1) {
    const response = await fetch("/api/bootstrap", { method: "POST", headers: { "X-Threadline-Token": location.hash.slice(1) } });
    if (!response.ok) throw new Error("Open the link printed by Threadline to connect.");
    history.replaceState(null, "", location.pathname);
  }
  await refreshState();
  if (state && !currentScope(terminalScopeId)?.terminalId) await action("terminal", { scopeId: terminalScopeId }, { restore: true });
  setInterval(() => { if (!busy) void refreshState(); }, 1200);
} catch (error) { message(error.message); }
