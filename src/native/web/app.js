import { Terminal } from "/vendor/xterm.mjs";
import { FitAddon } from "/vendor/fit.mjs";

const $ = (id) => document.getElementById(id);
const terminal = new Terminal({
  fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace', fontSize: 13,
  cursorBlink: true, scrollback: 3000, theme: { background: "#101215", foreground: "#e4e6e9" },
});
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open($("terminal"));
let state;
let socket;
let terminalId;
let selection;
let lastAnswers = "";
let busy = false;
let refreshing = false;
let reconnectTimer;
let hasSnapshot = false;
let treeKey = "";

function message(text) { $("message").textContent = text || ""; $("message").hidden = !text; }

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
  if ($("terminal").clientWidth < 40) return;
  fit.fit();
  send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
}

terminal.onData((data) => { if (hasSnapshot) send({ type: "input", data }); });
terminal.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
new ResizeObserver(resize).observe($("terminal"));
terminal.attachCustomKeyEventHandler((event) => {
  if (event.type === "keydown" && event.ctrlKey && event.shiftKey && event.code === "KeyB") {
    togglePanel(); event.preventDefault(); return false;
  }
  return true;
});

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
      terminal.write(event.data, () => { if (socket === current) { hasSnapshot = true; resize(); terminal.focus(); } });
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
  const visit = (scope, depth) => { result.push({ scope, depth }); for (const child of state.scopes.filter((item) => item.parentId === scope.id)) visit(child, depth + 1); };
  for (const root of state.scopes.filter((scope) => !scope.parentId)) visit(root, 0);
  return result;
}

function render(next) {
  const changedScope = state?.activeScopeId !== next.activeScopeId;
  state = next;
  const scope = state.scopes.find((item) => item.id === state.activeScopeId);
  $("workspace-path").textContent = state.cwd;
  $("active-title").textContent = scope.title;
  $("back").disabled = busy || !scope.parentId;
  $("refresh").disabled = busy;
  const nextTreeKey = JSON.stringify([scope.id, busy, state.scopes.map((item) => [item.id, item.parentId, item.title])]);
  if (treeKey !== nextTreeKey) {
    treeKey = nextTreeKey;
    $("tree").replaceChildren(...orderedScopes().map(({ scope: item, depth }) => {
    const button = document.createElement("button");
    button.className = "tree-node";
    button.style.paddingLeft = `${10 + depth * 14}px`;
    button.setAttribute("aria-current", String(item.id === scope.id));
    button.title = item.title;
    button.textContent = `${depth ? "↳ " : ""}${item.title}`;
    button.disabled = busy;
    button.onclick = () => action("activate", { scopeId: item.id });
    return button;
    }));
  }
  $("source-anchor").hidden = !scope.anchor;
  $("source-anchor").textContent = scope.anchor ? `From parent: ${scope.anchor.exactQuote}` : "";
  const key = JSON.stringify([scope.id, scope.turns.map((turn) => [turn.id, turn.assistant.text, turn.assistant.status])]);
  if (key !== lastAnswers) {
    lastAnswers = key;
    const answers = scope.turns.filter((turn) => turn.assistant.text);
    const nodes = answers.map((turn) => {
      const article = document.createElement("article"); article.className = "answer";
      const prompt = document.createElement("p"); prompt.className = "answer-question";
      prompt.textContent = turn.user.text;
      const text = document.createElement("pre"); text.className = "answer-text"; text.tabIndex = 0;
      text.dataset.turn = turn.id; text.dataset.complete = String(turn.assistant.status === "complete");
      text.textContent = turn.assistant.text;
      article.append(prompt, text); return article;
    });
    if (!nodes.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = scope.parentId ? "The follow-up is open in Codex. Its answer will appear here when the turn finishes." : "Completed answers appear here. Select any passage to start a follow-up."; nodes.push(empty); }
    const atBottom = $("answers").scrollHeight - $("answers").scrollTop - $("answers").clientHeight < 40;
    $("answers").replaceChildren(...nodes);
    if (atBottom || changedScope) $("answers").scrollTop = $("answers").scrollHeight;
  }
  if (changedScope) clearSelection();
  if (state.notice) message(state.notice);
  connect(scope.terminalId);
}

async function refreshState() {
  if (refreshing || busy) return; refreshing = true;
  try { const next = await api("state"); if (!busy) render(next); } catch (error) { message(error.message); } finally { refreshing = false; }
}

async function action(path, input = {}) {
  if (busy) return; busy = true; message("");
  if (state) render(state);
  $("ask").disabled = true;
  if (path === "branch") $("ask").textContent = "Opening branch…";
  try {
    render(await api(path, input));
    if (path === "branch") { clearSelection(); $("question").value = ""; }
  } catch (error) { message(error.message); }
  finally { busy = false; $("ask").disabled = false; $("ask").textContent = "Open branch"; if (state) render(state); }
}

function clearSelection() { selection = null; $("follow-up").hidden = true; $("selected-quote").textContent = ""; }

function captureSelection() {
  const selected = window.getSelection();
  if (!selected?.rangeCount || selected.isCollapsed) return;
  const range = selected.getRangeAt(0);
  const container = (range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement)?.closest(".answer-text");
  if (!container || !container.contains(range.endContainer) || container.dataset.complete !== "true") return;
  const prefix = document.createRange(); prefix.selectNodeContents(container); prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length;
  const quote = range.toString();
  if (!quote.trim()) return;
  selection = { scopeId: state.activeScopeId, turnId: container.dataset.turn, start, end: start + quote.length, quote };
  $("selected-quote").textContent = quote; $("follow-up").hidden = false;
}

$("answers").addEventListener("pointerup", captureSelection);
$("answers").addEventListener("mouseup", captureSelection);
$("answers").addEventListener("keyup", captureSelection);
$("cancel-selection").onclick = clearSelection;
$("follow-up").onsubmit = (event) => { event.preventDefault(); if (selection) void action("branch", { ...selection, question: $("question").value }); };
$("question").addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); $("follow-up").requestSubmit(); } });
$("back").onclick = () => action("back");
$("refresh").onclick = () => action("refresh");
function togglePanel() {
  const hidden = !$("sidebar").hidden; $("sidebar").hidden = hidden;
  $("layout").classList.toggle("panel-hidden", hidden); $("toggle-panel").setAttribute("aria-expanded", String(!hidden));
  resize(); if (hidden) terminal.focus();
}
$("toggle-panel").onclick = togglePanel;
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.shiftKey && event.code === "KeyB" && !$("terminal").contains(event.target)) { event.preventDefault(); togglePanel(); }
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
