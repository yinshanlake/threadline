import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { createConversation, rootScope } from "../src/model.mjs";
import { loadConversation, SessionWriter } from "../src/store.mjs";
import { startNativeServer } from "../src/native/server.mjs";
import { NativeTerminal, nativeArgs } from "../src/native/terminal.mjs";
import { nativeEnvironment, nativeCommandCapabilities } from "../src/native/codex.mjs";
import { importNativeThread, NativeWorkspace } from "../src/native/workspace.mjs";

class FakeTerminal extends EventEmitter {
  constructor(options) { super(); this.options = options; this.viewers = 0; this.sequence = 0; this.exited = false; this.writes = []; }
  write(data) { this.writes.push(data); }
  resize(cols, rows) { this.size = { cols, rows }; }
  async snapshot() { return { data: "parent screen", sequence: 0, cols: 100, rows: 30 }; }
  async submit(text) { this.write(text + "\r"); }
  close() { this.exited = true; }
}

function fixture() {
  const conversation = createConversation();
  const root = rootScope(conversation);
  root.providerThreadId = randomUUID();
  const turnId = randomUUID();
  const text = "中文 🌱 stays anchored. Another sentence follows.";
  const thread = { id: root.providerThreadId, turns: [{
    id: turnId, status: "completed", items: [
      { type: "userMessage", content: [{ type: "text", text: "parent question" }] },
      { type: "agentMessage", id: "answer-item", text },
    ],
  }] };
  const threads = new Map([[thread.id, thread]]);
  const forks = [];
  const sessions = {
    async notifyCommand() { return []; },
    async read(id) { if (!threads.has(id)) throw new Error("thread not loaded: " + id); return structuredClone(threads.get(id)); },
    async fork(id, at) {
      forks.push({ id, at });
      const source = threads.get(id);
      const child = { id: randomUUID(), turns: structuredClone(source.turns.slice(0, source.turns.findIndex((turn) => turn.id === at) + 1)) };
      threads.set(child.id, child);
      return { threadId: child.id, raw: { thread: structuredClone(child) } };
    },
  };
  importNativeThread(root, thread);
  const workspace = new NativeWorkspace({ conversation, sessions, command: { file: "codex", args: [] }, terminalFactory: (options) => new FakeTerminal(options) });
  const passage = () => ({ scopeId: root.id, turnId: root.turns[0].id, start: 0, end: 21, quote: text.slice(0, 21), question: "Explain the context" });
  return { workspace, root, thread, threads, sessions, forks, passage };
}

test("native fork preserves the parent, exact UTF-16 anchor, and native startup prompt", async () => {
  const { workspace, root, thread, passage, forks } = fixture();
  try {
    await workspace.initialize();
    const original = JSON.stringify(root.turns);
    const parentTerminal = workspace.terminalFor(root.id);
    const child = await workspace.branch(passage());
    assert.deepEqual(forks, [{ id: root.providerThreadId, at: thread.turns[0].id }]);
    assert.equal(child.anchor.exactQuote, passage().quote);
    assert.equal(JSON.stringify(root.turns), original);
    assert.equal(workspace.terminalFor(root.id), parentTerminal);
    const native = workspace.terminalFor(child.id).terminal.options;
    assert.ok(native.args.includes("resume"));
    assert.ok(native.args.includes(child.providerThreadId));
    assert.match(native.args.at(-1), /中文 🌱/u);
    assert.match(native.args.at(-1), /Explain the context/u);
    await workspace.back();
    assert.equal(workspace.conversation.activeScopeId, root.id);
    assert.equal(workspace.terminalFor(root.id), parentTerminal);
  } finally { await workspace.close(); }
});

test("a stale or invalid selection fails before any provider fork", async () => {
  const { workspace, passage, forks } = fixture();
  try {
    for (const change of [{ quote: "stale" }, { start: -1 }, { end: 1000 }, { question: " " }, { question: "/future-command --arg value" }]) {
      await assert.rejects(workspace.branch({ ...passage(), ...change }));
    }
    assert.equal(forks.length, 0);
  } finally { await workspace.close(); }
});

test("view navigation does not reopen a terminal or disturb another native draft", async () => {
  const { workspace, root, passage } = fixture();
  try {
    await workspace.initialize();
    const parent = workspace.terminalFor(root.id);
    parent.terminal.write("unfinished main input");
    const child = await workspace.branch(passage());
    const native = workspace.terminalFor(child.id);
    native.terminal.close();
    workspace.view(root.id);
    workspace.view(child.id);
    assert.equal(workspace.terminalFor(child.id), undefined);
    workspace.viewParent(child.id);
    assert.equal(workspace.scope().id, root.id);
    assert.equal(child.collapsed, true);
    await workspace.ensureTerminal(child.id);
    assert.equal(workspace.scope().id, root.id);
    assert.notEqual(workspace.terminalFor(child.id).id, native.id);
    assert.equal(workspace.terminalFor(root.id), parent);
    assert.deepEqual(parent.terminal.writes, ["unfinished main input"]);
  } finally { await workspace.close(); }
});

test("native selection validates the live terminal binding and rejects stale source identities before forking", async () => {
  const { workspace, root, threads, forks } = fixture();
  try {
    await workspace.initialize();
    const terminal = workspace.terminalFor(root.id);
    const input = { terminalId: terminal.id, scopeId: root.id, threadId: root.providerThreadId, text: "中文 🌱 stays anchored." };
    const selected = await workspace.resolveSelection(input);
    assert.equal(forks.length, 0);
    assert.equal(selected.quote, input.text);
    await assert.rejects(workspace.resolveSelection({ ...input, threadId: randomUUID() }), /session changed/u);
    await assert.rejects(workspace.branch({ ...selected, sourceThreadId: randomUUID(), question: "Why?" }), /source session changed/u);
    await assert.rejects(workspace.branch({ ...selected, providerTurnId: "wrong-turn", question: "Why?" }), /source turn changed/u);
    const next = { id: randomUUID(), name: "Native switched session", turns: [] };
    threads.set(next.id, next);
    await workspace.notification({ terminalId: terminal.id, threadId: next.id });
    assert.notEqual(terminal.scopeId, root.id);
    assert.equal(workspace.terminalFor(terminal.scopeId), terminal);
    await assert.rejects(workspace.branch({ ...selected, question: "Preserve my draft" }), /native source session changed/u);
    assert.equal(forks.length, 0);
    assert.equal(root.turns.length, 1);
  } finally { await workspace.close(); }
});

test("inherited native selections retain source identity and cannot claim an unrelated turn", async () => {
  const { workspace, root, passage, forks } = fixture();
  try {
    const child = await workspace.branch(passage());
    const entry = workspace.terminalFor(child.id);
    const inherited = await workspace.resolveSelection({
      terminalId: entry.id, scopeId: child.id, threadId: child.providerThreadId, text: "中文 🌱 stays anchored.",
    });
    assert.equal(inherited.scopeId, root.id);
    assert.equal(inherited.origin.scopeId, child.id);
    assert.equal(forks.length, 1);
    child.native.inheritedTurnIds = [];
    await assert.rejects(workspace.branch({ ...inherited, question: "Another angle" }), /does not belong/u);
    assert.equal(forks.length, 1);
  } finally { await workspace.close(); }
});

test("concurrent identical follow-ups reuse one fork and respect limits", async () => {
  const { workspace, passage, forks } = fixture();
  try {
    workspace.limits.maxTotal = 1;
    const [first, second] = await Promise.all([workspace.branch(passage()), workspace.branch(passage())]);
    assert.equal(first.id, second.id);
    assert.equal(forks.length, 1);
    await assert.rejects(workspace.branch({ ...passage(), question: "Another angle" }), /limit/u);
    assert.equal(forks.length, 1);
  } finally { await workspace.close(); }
});

test("child history omits inherited turns and nested forks use the child turn", async () => {
  const { workspace, passage, threads, forks } = fixture();
  try {
    const child = await workspace.branch(passage());
    const reply = { id: randomUUID(), status: "completed", items: [
      { type: "userMessage", content: [{ type: "text", text: "Explain the context" }] },
      { type: "agentMessage", id: "child-answer", text: "A child answer." },
    ] };
    threads.get(child.providerThreadId).turns.push(reply);
    await workspace.sync(child.id);
    assert.equal(child.turns.length, 1);
    const nested = await workspace.branch({ scopeId: child.id, turnId: child.turns[0].id, start: 0, end: 7, quote: "A child", question: "Go deeper" });
    assert.equal(nested.parentId, child.id);
    assert.deepEqual(forks.at(-1), { id: child.providerThreadId, at: reply.id });
  } finally { await workspace.close(); }
});

test("collapse persists in native state and opening a descendant restores its path", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadline-inline-"));
  const { workspace, root, passage } = fixture();
  const file = path.join(directory, "session.json");
  workspace.writer = new SessionWriter(file, () => workspace.conversation);
  try {
    const child = await workspace.branch(passage());
    await workspace.collapse({ scopeId: child.id, collapsed: true });
    await workspace.collapse({ scopeId: root.id, collapsed: true });
    await workspace.writer.flush();
    const saved = await loadConversation(file);
    assert.equal(saved.scopes.find((scope) => scope.id === child.id).collapsed, true);
    assert.equal(workspace.state().scopes.find((scope) => scope.id === root.id).collapsed, true);
    await workspace.activate(child.id);
    assert.equal(root.collapsed, false);
    assert.equal(child.collapsed, false);
    await workspace.back();
    assert.equal(child.collapsed, true);
    assert.equal(workspace.scope().id, root.id);
    await assert.rejects(workspace.collapse({ scopeId: root.id, collapsed: "true" }), /explicit/u);
    await assert.rejects(workspace.collapse({ scopeId: "missing", collapsed: true }), /no longer/u);
  } finally { await workspace.close(); await rm(directory, { recursive: true, force: true }); }
});

test("new conversations retain the entire previous tree without forking its model history", async () => {
  const { workspace, root, passage, forks } = fixture();
  try {
    await workspace.initialize();
    const parentTerminal = workspace.terminalFor(root.id);
    const child = await workspace.branch(passage());
    const original = structuredClone(root.turns);
    const fresh = await workspace.newConversation();
    assert.equal(workspace.scope().id, fresh.id);
    assert.equal(fresh.parentId, null);
    assert.equal(fresh.providerThreadId, null);
    assert.equal(fresh.turns.length, 0);
    assert.equal(workspace.state().scopes.length, 3);
    assert.deepEqual(root.turns, original);
    assert.equal(workspace.terminalFor(root.id), parentTerminal);
    assert.equal(workspace.scope(child.id).parentId, root.id);
    assert.equal(forks.length, 1);
    assert.equal(workspace.terminalFor(fresh.id).terminal.options.args.includes("resume"), false);
  } finally { await workspace.close(); }
});

test("unnamed native conversations get a stable title from their first question", async () => {
  const { workspace, root, thread } = fixture();
  try {
    root.native.title = "New conversation";
    importNativeThread(root, thread);
    assert.equal(root.native.title, "parent question");
    thread.turns[0].items[0].content[0].text = "updated input";
    importNativeThread(root, thread);
    assert.equal(root.native.title, "parent question");
    importNativeThread(root, { ...thread, name: "User title" });
    assert.equal(root.native.title, "User title");
  } finally { await workspace.close(); }
});

test("a new conversation's first message starts native Codex with a literal startup prompt", async () => {
  const { workspace, root } = fixture();
  try {
    const fresh = await workspace.newConversation();
    const idle = workspace.terminalFor(fresh.id);
    const prompt = '第一行。\nSecond line: $HOME $(example) "quoted"';
    await workspace.sendMessage({ scopeId: fresh.id, text: prompt });
    assert.equal(idle.terminal.exited, true);
    assert.notEqual(workspace.terminalFor(fresh.id).id, idle.id);
    assert.equal(workspace.terminalFor(fresh.id).terminal.options.args.at(-1), prompt);
    assert.equal(fresh.native.pendingPrompt, prompt);
    assert.equal(fresh.native.submission.text, prompt);
    assert.equal(workspace.state().scopes.find((scope) => scope.id === fresh.id).pendingSubmission, true);
    assert.equal(root.turns.length, 1);
    await assert.rejects(workspace.sendMessage({ scopeId: fresh.id, text: "duplicate" }), /still running/u);
  } finally { await workspace.close(); }
});

test("page messages append to their own native session and complete only when a new turn arrives", async () => {
  const { workspace, root, threads } = fixture();
  try {
    await workspace.initialize();
    const terminal = workspace.terminalFor(root.id).terminal;
    await workspace.sendMessage({ scopeId: root.id, text: "继续同一对话。" });
    assert.equal(terminal.writes.at(-1), "继续同一对话。\r");
    await workspace.sync(root.id);
    assert.ok(root.native.submission); // An old read must not unlock a pending turn.
    threads.get(root.providerThreadId).turns.push({ id: randomUUID(), status: "completed", items: [
      { type: "userMessage", content: [{ type: "text", text: "继续同一对话。" }] },
      { type: "agentMessage", id: "continued-answer", text: "继续成功。" },
    ] });
    await workspace.sync(root.id);
    assert.equal(root.native.submission, undefined);
    assert.equal(root.turns.length, 2);
    for (const text of ["", " ", "/new", "contains\x1b[2J", "x".repeat(16001)]) {
      await assert.rejects(workspace.sendMessage({ scopeId: root.id, text }));
    }
    assert.equal(terminal.writes.length, 1);
  } finally { await workspace.close(); }
});

test("transient notification IDs never replace a persisted conversation", async () => {
  const { workspace, root } = fixture();
  try {
    await workspace.initialize();
    const entry = workspace.terminalFor(root.id);
    await workspace.notification({ terminalId: entry.id, threadId: randomUUID() });
    assert.equal(workspace.conversation.scopes.length, 1);
    assert.equal(entry.scopeId, root.id);
    assert.equal(root.turns.length, 1);
  } finally { await workspace.close(); }
});

test("native session switches preserve existing anchors and update the same terminal binding", async () => {
  const { workspace, root, threads } = fixture();
  try {
    await workspace.initialize();
    const entry = workspace.terminalFor(root.id);
    const id = randomUUID();
    threads.set(id, { id, name: "Native /new session", turns: [] });
    await workspace.notification({ terminalId: entry.id, threadId: id });
    assert.equal(workspace.conversation.scopes.length, 2);
    assert.equal(root.turns.length, 1);
    assert.notEqual(entry.scopeId, root.id);
    assert.equal(workspace.scope().providerThreadId, id);
  } finally { await workspace.close(); }
});

test("a failed terminal launch leaves one persisted fork and a retryable prompt", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadline-native-"));
  const { workspace, passage, forks } = fixture();
  const file = path.join(directory, "session.json");
  workspace.writer = new SessionWriter(file, () => workspace.conversation);
  workspace.terminalFactory = () => { throw new Error("launch failed"); };
  try {
    await assert.rejects(workspace.branch(passage()), /launch failed/u);
    const saved = await loadConversation(file);
    assert.equal(saved.scopes.length, 2);
    assert.match(saved.scopes[1].native.pendingPrompt, /Explain the context/u);
    workspace.terminalFactory = (options) => new FakeTerminal(options);
    await workspace.branch(passage());
    assert.equal(forks.length, 1);
  } finally { await workspace.close(); await rm(directory, { recursive: true, force: true }); }
});

test("native arguments keep the prompt literal and never opt into full access implicitly", () => {
  const prompt = 'why $HOME $(example) "quoted"?';
  const args = nativeArgs({ command: { file: "node", args: ["codex.js"], supportsNoDaemon: true }, cwd: "space dir", threadId: "session", prompt });
  assert.equal(args.at(-1), prompt);
  assert.equal(args.includes("danger-full-access"), false);
  assert.equal(args.includes("never"), false);
  assert.equal(args.includes("--no-daemon"), true);
});

test("native CLI capability detection keeps older Codex versions launchable", () => {
  const command = { file: "node", args: ["codex.js"] };
  const older = nativeCommandCapabilities(command, () => "Usage: codex [OPTIONS] [PROMPT]");
  const current = nativeCommandCapabilities(command, () => "Options:\n  --no-daemon  Run without the shared server\n");
  assert.equal(nativeArgs({ command: older, cwd: "workspace" }).includes("--no-daemon"), false);
  assert.equal(nativeArgs({ command: current, cwd: "workspace" }).includes("--no-daemon"), true);
  assert.equal(command.supportsNoDaemon, undefined);
});

test("native children do not inherit the hosting agent's session or shutdown controls", () => {
  const original = { PATH: "path", CODEX_THREAD_ID: "parent", CODEX_SESSION_ID: "parent-session", CODEX_DAEMON_SHUTDOWN_SOCKET: "parent-socket" };
  assert.deepEqual(nativeEnvironment(original), { PATH: "path" });
  assert.equal(original.CODEX_THREAD_ID, "parent");
});

test("reopening a submitted branch prompt does not submit it twice", async () => {
  const { workspace, passage, threads } = fixture();
  try {
    const child = await workspace.branch(passage());
    const prompt = child.native.pendingPrompt;
    threads.get(child.providerThreadId).turns.push({ id: randomUUID(), status: "interrupted", items: [
      { type: "userMessage", content: [{ type: "text", text: prompt }] },
    ] });
    workspace.terminalFor(child.id).terminal.exited = true;
    await workspace.activate(child.id);
    assert.equal(child.native.pendingPrompt, undefined);
    assert.equal(workspace.terminalFor(child.id).terminal.options.args.at(-1), child.providerThreadId);
  } finally { await workspace.close(); }
});

test("local API rejects unauthenticated actions and foreign origins", async () => {
  const { workspace } = fixture();
  const app = await startNativeServer({ workspace });
  try {
    await workspace.initialize();
    assert.equal((await fetch(app.origin + "/api/state")).status, 401);
    assert.equal((await fetch(app.origin + "/api/bootstrap", { method: "POST", headers: { Origin: "https://example.org", "X-Threadline-Token": app.url.split("#")[1] } })).status, 403);
    const response = await fetch(app.origin + "/api/bootstrap", { method: "POST", headers: { "X-Threadline-Token": app.url.split("#")[1] } });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie").split(";")[0];
    const state = await (await fetch(app.origin + "/api/state", { headers: { Cookie: cookie } })).json();
    assert.equal(state.sessionId, workspace.conversation.sessionId);
    assert.equal((await fetch(app.origin + "/api/activate", { method: "POST", headers: { Cookie: cookie, "Content-Type": "text/plain" }, body: "{}" })).status, 400);
    assert.equal((await fetch(app.origin + "/vendor/xterm.mjs")).status, 200);
    assert.equal((await fetch(app.origin + "/api/notify", { method: "POST" })).status, 401);
  } finally { await app.close(); await workspace.close(); }
});

test("terminal WebSocket sends slash input unchanged and restores the screen on reconnect", async () => {
  const { workspace, root } = fixture();
  const app = await startNativeServer({ workspace });
  try {
    await workspace.initialize();
    const response = await fetch(app.origin + "/api/bootstrap", { method: "POST", headers: { "X-Threadline-Token": app.url.split("#")[1] } });
    const cookie = response.headers.get("set-cookie").split(";")[0];
    const entry = workspace.terminalFor(root.id);
    for (let attempt = 0; attempt < 2; attempt++) {
      const socket = new WebSocket(app.origin.replace("http", "ws") + "/terminal/" + entry.id, { origin: app.origin, headers: { Cookie: cookie } });
      const [data] = await once(socket, "message");
      assert.equal(JSON.parse(data).data, "parent screen");
      socket.send(JSON.stringify({ type: "input", data: "/a-new-upstream-command\r" }));
      while (entry.terminal.writes.length <= attempt) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(entry.terminal.writes[attempt], "/a-new-upstream-command\r");
      socket.close(); await once(socket, "close");
    }
  } finally { await app.close(); await workspace.close(); }
});

test("a real PTY carries input, resizes, and retains output for reconnection", { timeout: 15000 }, async () => {
  const terminal = new NativeTerminal({ command: { file: process.execPath }, args: ["-e", "process.stdin.setEncoding('utf8');process.stdin.on('data', d => process.stdout.write('literal:'+d));console.log('ready');"], cwd: process.cwd() });
  try {
    let output = "";
    terminal.on("data", ({ data }) => { output += data; });
    while (!output.includes("ready")) await new Promise((resolve) => setTimeout(resolve, 10));
    terminal.resize(90, 25);
    terminal.write("/model\r");
    while (!output.includes("literal:/model")) await new Promise((resolve) => setTimeout(resolve, 10));
    const screen = await terminal.snapshot();
    assert.equal(screen.cols, 90); assert.equal(screen.rows, 25);
    assert.ok(screen.data.includes("literal:/model"));
  } finally {
    if (!terminal.exited) {
      const exited = once(terminal, "exit");
      terminal.write("\x03");
      await exited;
    }
    terminal.close();
  }
});

test("Windows PTYs survive concurrent exits and isolated helper failure", { skip: process.platform !== "win32", timeout: 25000 }, async () => {
  const terminals = [];
  try {
    for (let round = 0; round < 3; round++) {
      const batch = Array.from({ length: 5 }, () => new NativeTerminal({
        command: { file: process.execPath },
        args: ["-e", "console.log('ready');process.stdin.resume();process.stdin.on('data',()=>process.exit(0));"],
        cwd: process.cwd(),
      }));
      terminals.push(...batch);
      await Promise.all(batch.map(async (terminal) => {
        let output = "";
        terminal.on("data", ({ data }) => { output += data; });
        const deadline = Date.now() + 6000;
        while (!output.includes("ready") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(output.includes("ready"), "The isolated PTY should start.");
      }));
      const helpers = new Set(batch.map((terminal) => terminal.process.helper.pid));
      assert.equal(helpers.size, 5);
      await Promise.all(batch.map((terminal) => terminal.stop({ input: "quit\r" })));
      assert.ok(batch.every((terminal) => terminal.exited));
    }
    const first = new NativeTerminal({ command: { file: process.execPath }, args: ["-e", "console.log('ready');process.stdin.resume();"], cwd: process.cwd() });
    const second = new NativeTerminal({ command: { file: process.execPath }, args: ["-e", "console.log('ready');process.stdin.resume();"], cwd: process.cwd() });
    terminals.push(first, second);
    const failed = once(first, "exit");
    first.process.helper.kill();
    const [event] = await failed;
    assert.notEqual(event.exitCode, 0);
    assert.equal(second.exited, false);
    second.write("\x03");
    await second.stop();
  } finally { await Promise.all(terminals.map((terminal) => terminal.stop())); }
});
