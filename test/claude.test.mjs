import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeProvider } from "../src/providers/claude.mjs";

const SESSION = "11111111-1111-4111-8111-111111111111";

async function fakeClaude(directory, { mode = "normal" } = {}) {
  const file = path.join(directory, "fake-claude.mjs");
  const log = path.join(directory, "args.jsonl");
  await writeFile(file, `#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.207 (Claude Code)"); process.exit(0); }
await appendFile(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
let input = "";
for await (const chunk of process.stdin) input += chunk;
if (${JSON.stringify(mode)} === "hang") await new Promise(() => {});
const session = args.includes("--session-id")
  ? args[args.indexOf("--session-id") + 1]
  : args[args.indexOf("--resume") + 1];
const messageId = "msg-" + input.trim().replace(/\W+/g, "-");
const out = [
  { type: "system", subtype: "init", session_id: session, cwd: process.cwd(), model: "claude-sonnet-test", permissionMode: "dontAsk", slash_commands: ["compact", "code-review"] },
  { type: "stream_event", event: { type: "message_start", message: { id: messageId } } },
  { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: input.trim() } } },
  { type: "assistant", session_id: session, message: { id: messageId, role: "assistant", model: "claude-sonnet-test", usage: { input_tokens: 4, output_tokens: 2 }, content: [{ type: "text", text: "Hello " + input.trim() }] } },
  { type: "result", subtype: "success", is_error: false, session_id: session, result: "Hello " + input.trim() },
];
for (const value of out) console.log(JSON.stringify(value));
await new Promise(() => {});
`, "utf8");
  return { command: { file: process.execPath, args: [file] }, log };
}

async function assistantOnlyClaude(directory) {
  const file = path.join(directory, "assistant-only-claude.mjs");
  await writeFile(file, `
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.207 (Claude Code)"); process.exit(0); }
for await (const _chunk of process.stdin) {}
const session = args.includes("--session-id")
  ? args[args.indexOf("--session-id") + 1]
  : args[args.indexOf("--resume") + 1];
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: session }));
console.log(JSON.stringify({ type: "assistant", message: { id: "msg-final", stop_reason: "end_turn", usage: { output_tokens: 1 }, content: [{ type: "text", text: "done" }] } }));
await new Promise(() => {});
`, "utf8");
  return { file: process.execPath, args: [file] };
}

async function localCommandClaude(directory) {
  const file = path.join(directory, "local-command-claude.mjs");
  await writeFile(file, `
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.207 (Claude Code)"); process.exit(0); }
for await (const _chunk of process.stdin) {}
const session = args.includes("--session-id")
  ? args[args.indexOf("--session-id") + 1]
  : args[args.indexOf("--resume") + 1];
console.log(JSON.stringify({
  type: "system", subtype: "init", session_id: session,
  slash_commands: ["Compact", "bad command", "compact"],
}));
console.log(JSON.stringify({
  type: "system", subtype: "commands_changed", session_id: session,
  commands: [{ name: "code-review", description: "Review code" }, { name: "MCP__server__prompt" }],
}));
console.log(JSON.stringify({
  type: "system", subtype: "local_command_output", session_id: session,
  uuid: "local-output", content: "Local command result",
}));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: session, result: "" }));
await new Promise(() => {});
`, "utf8");
  return { file: process.execPath, args: [file] };
}

async function unavailableCommandClaude(directory) {
  const file = path.join(directory, "unavailable-command-claude.mjs");
  await writeFile(file, `
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.207 (Claude Code)"); process.exit(0); }
for await (const _chunk of process.stdin) {}
const session = args.includes("--session-id")
  ? args[args.indexOf("--session-id") + 1]
  : args[args.indexOf("--resume") + 1];
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: session, slash_commands: ["plan"] }));
console.log(JSON.stringify({
  type: "assistant", session_id: session,
  message: { id: "synthetic", model: "<synthetic>", stop_reason: "stop_sequence", content: [
    { type: "text", text: "/plan isn't available in this environment." },
  ] },
}));
console.log(JSON.stringify({
  type: "result", subtype: "success", is_error: false, session_id: session,
  result: "/plan isn't available in this environment.",
}));
await new Promise(() => {});
`, "utf8");
  return { file: process.execPath, args: [file] };
}

async function discoveryClaude(directory) {
  const file = path.join(directory, "discovery-claude.mjs");
  const log = path.join(directory, "discovery-args.jsonl");
  await writeFile(file, `
import { appendFile } from "node:fs/promises";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.207 (Claude Code)"); process.exit(0); }
await appendFile(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
for await (const _chunk of process.stdin) {}
console.log(JSON.stringify({
  type: "system", subtype: "init", slash_commands: ["Context", "code-review", "bad command", "context"],
}));
await new Promise(() => {});
`, "utf8");
  return { command: { file: process.execPath, args: [file] }, log };
}

function completed(provider, threadId) {
  return new Promise((resolve) => {
    const handler = (event) => {
      if (event.threadId !== threadId) return;
      provider.off("turn-complete", handler);
      resolve(event);
    };
    provider.on("turn-complete", handler);
  });
}

async function argumentsLog(log) {
  return (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("Claude provider probes, streams once, and reaps a CLI that stays open after result", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadline-claude-"));
  try {
    const { command, log } = await fakeClaude(directory);
    const provider = new ClaudeProvider({ command, cwd: directory, stopTimeout: 200 });
    assert.match((await provider.connect()).userAgent, /2\.1\.207/);
    await provider.resumeThread(SESSION);

    const deltas = [];
    const messages = [];
    let slashCommands;
    let usage;
    provider.on("delta", (event) => deltas.push(event.text));
    provider.on("item-complete", (event) => messages.push(event.item.text));
    provider.on("thread-settings", (event) => { slashCommands = event.settings.slashCommands; });
    provider.on("token-usage", (event) => { usage = event.tokenUsage; });

    const done = completed(provider, SESSION);
    const turn = await provider.send(SESSION, "Claude");
    assert.notEqual(turn.turnId, SESSION);
    assert.equal((await done).status, "completed");
    const secondDone = completed(provider, SESSION);
    await provider.send(SESSION, "again");
    assert.equal((await secondDone).status, "completed");
    await provider.close();
    assert.equal(deltas.join(""), "Hello ClaudeHello again");
    assert.deepEqual(messages, ["Hello Claude", "Hello again"]);
    assert.equal(usage.last.totalTokens, 6);
    assert.deepEqual(slashCommands, ["compact", "code-review"]);
    assert.deepEqual([...provider.slashCommands], ["compact", "code-review"]);

    const [args, secondArgs] = await argumentsLog(log);
    for (const invocation of [args, secondArgs]) {
      assert.deepEqual(invocation.slice(-2), ["--resume", SESSION]);
      assert.equal(invocation.includes("--fork-session"), false);
      assert.deepEqual(invocation.slice(invocation.indexOf("--permission-mode"), invocation.indexOf("--permission-mode") + 2), ["--permission-mode", "dontAsk"]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("new and forked Claude sessions use stable session IDs without mutating the parent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadline-claude-fork-"));
  try {
    const { command, log } = await fakeClaude(directory);
    const provider = new ClaudeProvider({ command, cwd: directory, stopTimeout: 200 });

    const fresh = await provider.startThread();
    let done = completed(provider, fresh.threadId);
    await provider.send(fresh.threadId, "root");
    assert.equal((await done).status, "completed");

    const fork = await provider.forkThread(fresh.threadId, "not-a-claude-session-id");
    done = completed(provider, fork.threadId);
    await provider.send(fork.threadId, "branch");
    assert.equal((await done).status, "completed");
    await provider.close();

    const [freshArgs, forkArgs] = await argumentsLog(log);
    assert.deepEqual(freshArgs.slice(-2), ["--session-id", fresh.threadId]);
    assert.deepEqual(forkArgs.slice(-5), ["--resume", fresh.threadId, "--fork-session", "--session-id", fork.threadId]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a pending Claude fork can be restored after Threadline restarts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadline-claude-restore-"));
  try {
    const { command, log } = await fakeClaude(directory);
    const first = new ClaudeProvider({ command, cwd: directory, stopTimeout: 200 });
    await first.resumeThread(SESSION);
    const fork = await first.forkThread(SESSION, "opaque-turn-id");
    const savedState = fork.state;
    await first.close();

    const restored = new ClaudeProvider({ command, cwd: directory, stopTimeout: 200 });
    await restored.resumeThread(fork.threadId, { state: savedState });
    const done = completed(restored, fork.threadId);
    await restored.send(fork.threadId, "restored branch");
    assert.equal((await done).status, "completed");
    await restored.close();

    const [args] = await argumentsLog(log);
    assert.deepEqual(args.slice(-5), ["--resume", SESSION, "--fork-session", "--session-id", fork.threadId]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude turns time out and their child process is reclaimed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadline-claude-timeout-"));
  try {
    const { command } = await fakeClaude(directory, { mode: "hang" });
    const provider = new ClaudeProvider({ command, cwd: directory, turnTimeout: 40, stopTimeout: 200 });
    await provider.resumeThread(SESSION);
    const done = completed(provider, SESSION);
    await provider.send(SESSION, "wait");
    const result = await done;
    assert.equal(result.status, "failed");
    assert.match(result.error.message, /timed out/);
    await provider.close();
    assert.equal(provider.active.size, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a terminal assistant message completes when Claude omits the result event", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadline-claude-assistant-only-"));
  try {
    const provider = new ClaudeProvider({
      command: await assistantOnlyClaude(directory),
      cwd: directory,
      assistantCompletionGrace: 10,
      stopTimeout: 200,
    });
    await provider.resumeThread(SESSION);
    const done = completed(provider, SESSION);
    await provider.send(SESSION, "finish");
    assert.equal((await done).status, "completed");
    await provider.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an assistant API error stays failed even if Claude later reports success", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadline-claude-api-error-"));
  try {
    const { command } = await fakeClaude(directory);
    const file = command.args[0];
    let source = await readFile(file, "utf8");
    source = source.replace(
      '{ type: "assistant", session_id: session, message:',
      '{ type: "assistant", isApiErrorMessage: true, error: "API 500", session_id: session, message:',
    );
    await writeFile(file, source, "utf8");
    const provider = new ClaudeProvider({ command, cwd: directory, stopTimeout: 200 });
    await provider.resumeThread(SESSION);
    const done = completed(provider, SESSION);
    await provider.send(SESSION, "fail");
    const result = await done;
    assert.equal(result.status, "failed");
    assert.match(result.error.message, /API 500/);
    await provider.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude forwards local command output and replaces dynamically changed commands", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadline-claude-command-"));
  try {
    const provider = new ClaudeProvider({
      command: await localCommandClaude(directory),
      cwd: directory,
      assistantCompletionGrace: 10,
      stopTimeout: 200,
    });
    await provider.resumeThread(SESSION);
    const settings = [];
    const messages = [];
    provider.on("thread-settings", (event) => settings.push(event.settings));
    provider.on("item-complete", (event) => messages.push(event.item));
    const done = completed(provider, SESSION);
    await provider.send(SESSION, "/usage");
    assert.equal((await done).status, "completed");
    assert.deepEqual(settings.map((entry) => entry.slashCommands), [
      ["compact"],
      ["code-review", "mcp__server__prompt"],
    ]);
    assert.deepEqual([...provider.slashCommands], ["code-review", "mcp__server__prompt"]);
    assert.deepEqual(messages, [{
      id: "local-output", type: "agentMessage", text: "Local command result", phase: "final_answer",
    }]);
    await provider.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude native commands unavailable in print mode complete as failed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadline-claude-command-failure-"));
  try {
    const provider = new ClaudeProvider({
      command: await unavailableCommandClaude(directory), cwd: directory, stopTimeout: 200,
    });
    await provider.resumeThread(SESSION);
    const done = completed(provider, SESSION);
    await provider.send(SESSION, "/plan");
    const result = await done;
    assert.equal(result.status, "failed");
    assert.match(result.error.message, /isn't available/);
    await provider.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude discovers native slash commands without creating or resuming a session", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadline-claude-discovery-"));
  try {
    const { command, log } = await discoveryClaude(directory);
    const provider = new ClaudeProvider({ command, cwd: directory, stopTimeout: 100 });
    assert.deepEqual(await provider.discoverSlashCommands(), ["context", "code-review"]);
    assert.deepEqual(await provider.discoverSlashCommands(), ["context", "code-review"]);
    await provider.close();

    const [args] = await argumentsLog(log);
    assert.equal(args.includes("--no-session-persistence"), true);
    assert.equal(args.includes("--session-id"), false);
    assert.equal(args.includes("--resume"), false);
    assert.deepEqual(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2), ["--permission-mode", "dontAsk"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
