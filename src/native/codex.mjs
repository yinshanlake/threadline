import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { CodexProvider } from "../providers/codex.mjs";

const require = createRequire(import.meta.url);

export function nativeEnvironment(env = process.env) {
  const result = { ...env };
  for (const key of ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_DAEMON_SHUTDOWN_FILE", "CODEX_DAEMON_SHUTDOWN_SOCKET"]) delete result[key];
  return result;
}

// Use the same installed CLI for the terminal and session operations. In
// particular, do not pair a new user config with an older bundled app-server.
export function resolveCodexCommand({ env = process.env, platform = process.platform } = {}) {
  const explicit = env.THREADLINE_CODEX_PATH;
  const commandFor = (file) => /\.[cm]?js$/iu.test(file)
    ? { file: process.execPath, args: [file] }
    : { file, args: [] };
  if (explicit) {
    const file = path.resolve(explicit);
    if (!existsSync(file)) throw new Error(`THREADLINE_CODEX_PATH does not exist: ${file}`);
    return commandFor(file);
  }
  for (const directory of (env.Path || env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidates = platform === "win32"
      ? [path.join(directory, "codex.exe"), path.join(directory, "node_modules", "@openai", "codex", "bin", "codex.js")]
      : [path.join(directory, "codex")];
    for (const file of candidates) if (existsSync(file)) return commandFor(file);
  }
  if (platform === "win32" && env.APPDATA) {
    const file = path.join(env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(file)) return commandFor(file);
  }
  try { return commandFor(require.resolve("@openai/codex/bin/codex.js")); } catch {}
  throw new Error("Could not locate Codex. Install Codex or set THREADLINE_CODEX_PATH.");
}

export class CodexSessions {
  constructor({ command = resolveCodexCommand(), cwd = process.cwd() } = {}) {
    this.command = command;
    this.cwd = cwd;
    this.pending = Promise.resolve();
  }

  // Each operation closes its app-server before a native terminal takes over.
  // Reading history never resumes or sends a turn to the parent's session.
  operation(run) {
    const result = this.pending.catch(() => {}).then(async () => {
      const provider = new CodexProvider({
        command: { file: this.command.file, args: [...this.command.args, "app-server", "--stdio"] },
        cwd: this.cwd,
        env: nativeEnvironment(),
      });
      const logs = [];
      provider.on("log", (message) => { logs.push(message); if (logs.length > 8) logs.shift(); });
      provider.on("server-request", (request) => provider.rejectServerRequest(request));
      try {
        await provider.connect();
        return await run(provider);
      } catch (error) {
        if (/app-server exited/u.test(error.message) && logs.length) {
          throw new Error(`${error.message}: ${logs.at(-1)}`, { cause: error });
        }
        throw error;
      } finally { await provider.close(); }
    });
    this.pending = result;
    return result;
  }

  read(threadId) {
    return this.operation(async (provider) => {
      const result = await provider.request("thread/read", { threadId, includeTurns: true });
      return result.thread;
    });
  }

  fork(threadId, lastTurnId) {
    return this.operation((provider) => provider.forkThread(threadId, lastTurnId, { cwd: this.cwd }));
  }

  notifyCommand() {
    return this.operation(async (provider) => {
      const result = await provider.request("config/read", { includeLayers: false });
      return Array.isArray(result.config?.notify) ? result.config.notify : [];
    });
  }
}
