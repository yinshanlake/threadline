import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NativeTerminal } from "../src/native/terminal.mjs";
import { nativeEnvironment } from "../src/native/codex.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(project, "src", "cli.mjs");
const PREFIX = "\x02";

async function text(terminal) {
  await terminal.snapshot();
  const buffer = terminal.headless.buffer.active;
  return Array.from({ length: terminal.rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) || "").join("\n");
}

async function waitScreen(terminal, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const screen = await text(terminal);
    if (predicate(screen)) return screen;
    if (terminal.exited) throw new Error("Terminal exited before the requested state: " + screen);
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
  throw new Error("Timed out waiting for terminal state:\n" + await text(terminal));
}

test("terminal shell runs a real child PTY, forks twice, restores sources, resizes and exits", { timeout: 35000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadline-console-demo-"));
  const terminal = new NativeTerminal({ command: { file: process.execPath }, args: [cli, "demo", "--terminal"],
    cwd: project, env: { ...nativeEnvironment(), THREADLINE_HOME: directory }, cols: 150, rows: 38 });
  try {
    await waitScreen(terminal, (screen) => screen.includes("可折叠对话") && screen.includes("中文"));
    terminal.write(PREFIX);
    await waitScreen(terminal, (screen) => screen.includes("[浏览]") && screen.includes("中文"));
    terminal.write("\x1b[F"); await new Promise((resolve) => setTimeout(resolve, 80));
    terminal.write("\r");
    await waitScreen(terminal, (screen) => screen.includes("Follow-up on selected source"));
    terminal.write("Explain this source.");
    await new Promise((resolve) => setTimeout(resolve, 150)); terminal.write("\r");
    await waitScreen(terminal, (screen) => screen.includes("追问已打开"));
    await waitScreen(terminal, (screen) => screen.includes("This answer belongs"));
    terminal.write(PREFIX);
    await waitScreen(terminal, (screen) => screen.includes("[浏览]"));
    terminal.write("\x1b[F");
    await new Promise((resolve) => setTimeout(resolve, 80)); terminal.write("\r");
    await waitScreen(terminal, (screen) => screen.includes("Follow-up on selected source"));
    terminal.write("Second level question.");
    await new Promise((resolve) => setTimeout(resolve, 150)); terminal.write("\r");
    await waitScreen(terminal, (screen) => screen.includes("Second level question."));
    terminal.write(PREFIX + "b");
    await waitScreen(terminal, (screen) => screen.includes("已回到原段落"));
    terminal.write("b");
    await waitScreen(terminal, (screen) => screen.split("\n")[0].includes("main") && screen.includes("中文"));
    terminal.resize(80, 24);
    await waitScreen(terminal, (screen) => screen.includes("可折叠对话") && screen.includes("[浏览]"));
    terminal.write("\x1b");
    await waitScreen(terminal, (screen) => screen.includes("[输入]") && screen.includes("可折叠对话"));
    terminal.write("/literal-native-command\r");
    terminal.write(PREFIX + "d");
    await waitScreen(terminal, (screen) => screen.includes("Received literally: /literal-native-command"));
    terminal.write("q");
    const deadline = Date.now() + 8000;
    while (!terminal.exited && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(terminal.exited, true);
  } finally { await terminal.stop(); await rm(directory, { recursive: true, force: true }); }
});

// Real model smoke is opt-in to keep normal tests offline and deterministic.
test("real Codex terminal replies, forks and resumes a saved console session", {
  skip: !process.env.THREADLINE_LIVE_CONSOLE_TESTS, timeout: 120000,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadline-console-live-"));
  let terminal;
  const launch = (args) => new NativeTerminal({ command: { file: process.execPath }, args: [cli, ...args],
    cwd: project, env: { ...nativeEnvironment(), THREADLINE_HOME: directory }, cols: 150, rows: 38 });
  try {
    terminal = launch(["--terminal", "--new"]);
    await waitScreen(terminal, (screen) => screen.includes("Ask Codex to do anything") && screen.includes("Ready"), 25000);
    terminal.write("\x1b[200~Do not use tools or edit files. Reply exactly CONSOLE_LIVE_OK.\x1b[201~");
    await new Promise((resolve) => setTimeout(resolve, 1200)); terminal.write("\r");
    await waitScreen(terminal, (screen) => screen.includes("Codex · 主回答") && /(?:^|\n)\s*│\s*CONSOLE_LIVE_OK\s*(?:\n|$)/u.test(screen), 50000);
    terminal.write(PREFIX);
    await waitScreen(terminal, (screen) => screen.includes("[浏览]"), 15000);
    terminal.write("\x1b[F"); await new Promise((resolve) => setTimeout(resolve, 80));
    terminal.write("\r");
    await waitScreen(terminal, (screen) => screen.includes("Follow-up on selected source"));
    terminal.write("Do not use tools or edit files. Reply exactly CONSOLE_BRANCH_OK.");
    await new Promise((resolve) => setTimeout(resolve, 150)); terminal.write("\r");
    await waitScreen(terminal, (screen) => screen.includes("Codex · 追问回答") && /(?:^|\n)\s*(?:│\s*)+CONSOLE_BRANCH_OK\s*(?:\n|$)/u.test(screen), 50000);
    terminal.write(PREFIX);
    await waitScreen(terminal, (screen) => screen.includes("[浏览]"), 15000);
    terminal.write("\x1b[F");
    await new Promise((resolve) => setTimeout(resolve, 80)); terminal.write("\r");
    await waitScreen(terminal, (screen) => screen.includes("Follow-up on selected source"));
    terminal.write("Do not use tools or edit files. Reply exactly CONSOLE_NESTED_OK.");
    await new Promise((resolve) => setTimeout(resolve, 150)); terminal.write("\r");
    await waitScreen(terminal, (screen) => screen.includes("Codex · 追问回答") && /(?:^|\n)\s*(?:│\s*)+CONSOLE_NESTED_OK\s*(?:\n|$)/u.test(screen), 50000);
    terminal.write(PREFIX + "b");
    await waitScreen(terminal, (screen) => screen.includes("已回到原段落"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    terminal.write("b");
    await waitScreen(terminal, (screen) => screen.split("\n")[0].includes("Codex  main") && screen.includes("已回到原段落"));
    terminal.write("q");
    const deadline = Date.now() + 10000;
    while (!terminal.exited && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(terminal.exited);
    const files = await readdir(path.join(directory, "sessions"));
    const records = await Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(directory, "sessions", file), "utf8"))));
    const session = records.find((record) => record.scopes.some((scope) => scope.parentId));
    assert.ok(session);
    assert.equal(session.scopes.length, 3);
    assert.equal(session.native.consoleView.panelVisible, true);
    await terminal.stop();
    terminal = launch(["resume", session.sessionId, "--terminal"]);
    await waitScreen(terminal, (screen) => screen.includes("CONSOLE_LIVE_OK") && screen.includes("可折叠对话"), 25000);
    terminal.write(PREFIX + "q");
  } finally { await terminal?.stop(); await rm(directory, { recursive: true, force: true }); }
});
