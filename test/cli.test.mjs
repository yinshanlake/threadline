import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(project, "src", "cli.mjs");

test("CLI documents configurable thread limits", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cli, "--help"], { cwd: project });
  assert.match(stdout, /--max-threads N/);
  assert.match(stdout, /--max-depth N/);
  assert.match(stdout, /--max-per-anchor N/);
});

test("CLI rejects invalid thread limits before starting a provider", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [cli, "--max-threads", "0", "--snapshot"], { cwd: project }),
    (error) => error.code === 1 && /requires a positive integer/.test(error.stderr),
  );
});
