import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CodexProvider } from "../src/providers/codex.mjs";

const execFileAsync = promisify(execFile);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(project, "src", "cli.mjs");

test("CLI documents configurable thread limits", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cli, "--help"], { cwd: project });
  assert.match(stdout, /--max-threads N/);
  assert.match(stdout, /--max-depth N/);
  assert.match(stdout, /--max-per-anchor N/);
  assert.match(stdout, /--yolo/);
  assert.match(stdout, /--provider NAME/);
  assert.match(stdout, /--claude/);
  assert.match(stdout, /resume SESSION_GUID/);
  assert.match(stdout, /threadline demo/);
});

test("CLI probes the selected Claude Code executable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadline-cli-claude-"));
  const fake = path.join(directory, "fake-claude.mjs");
  try {
    await import("node:fs/promises").then(({ writeFile }) => writeFile(fake, "console.log('2.1.207 (Claude Code)');\n", "utf8"));
    const { stdout } = await execFileAsync(process.execPath, [cli, "--provider", "claude", "--probe"], {
      cwd: project, env: { ...process.env, THREADLINE_CLAUDE_PATH: fake },
    });
    assert.match(stdout, /Claude Code OK: 2\.1\.207/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("demo subcommand always starts the interactive showcase", () => {
  const result = spawnSync(process.execPath, [cli, "demo", "--snapshot"], { cwd: project, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /3 threads/);
  assert.match(result.stdout, /4 activities  4 complete/);
  assert.match(result.stdout, /嵌套 thread/);
});

test("CLI rejects invalid thread limits before starting a provider", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [cli, "--max-threads", "0", "--snapshot"], { cwd: project }),
    (error) => error.code === 1 && /requires a positive integer/.test(error.stderr),
  );
});

test("CLI rejects conflicting provider modes before starting a provider", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [cli, "--demo", "--claude", "--snapshot"], { cwd: project }),
    (error) => error.code === 1 && /cannot be used together/.test(error.stderr),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [cli, "--demo", "--yolo", "--snapshot"], { cwd: project }),
    (error) => error.code === 1 && /cannot be used together/.test(error.stderr),
  );
});

test("probe starts Codex with the legacy ado MCP disabled", async () => {
  const provider = new CodexProvider({ cwd: project });
  assert.deepEqual(provider.command.args.slice(-2), ["-c", "mcp_servers.ado.enabled=false"]);
  assert.equal(provider.command.args.includes("mcp_servers.azure-devops.enabled=false"), false);
});

test("yolo maps to Codex full access without approvals", () => {
  const provider = new CodexProvider({ cwd: project, yolo: true });
  assert.equal(provider.command.args.includes('approval_policy="never"'), true);
  assert.equal(provider.command.args.includes('sandbox_mode="danger-full-access"'), true);
});

test("new sessions print distinct GUIDs and older sessions remain resumable", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "threadline-cli-session-"));
  const run = (args, input = null) => spawnSync(process.execPath, [cli, ...args], {
    cwd: project,
    env: { ...process.env, THREADLINE_HOME: state },
    encoding: "utf8",
    input,
  });
  const sessionId = (output) => output.match(/Session saved: ([0-9a-f-]{36})/u)?.[1];
  try {
    const first = run(["--demo", "--new", "--line"], "/quit\n");
    assert.equal(first.status, 0, first.stderr);
    const firstId = sessionId(first.stdout);
    assert.ok(firstId);
    assert.match(first.stdout, new RegExp(`threadline resume ${firstId} --demo`));

    const second = run(["--demo", "--new", "--line"], "/quit\n");
    assert.equal(second.status, 0, second.stderr);
    const secondId = sessionId(second.stdout);
    assert.ok(secondId);
    assert.notEqual(secondId, firstId);

    const resumed = run(["resume", firstId, "--demo", "--snapshot"]);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /为什么很多 LLM terminal/);

    const alias = run(["--resume", firstId, "--demo", "--snapshot"]);
    assert.equal(alias.status, 0, alias.stderr);
    assert.match(alias.stdout, /为什么很多 LLM terminal/);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
