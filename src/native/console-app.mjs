import { createConversation } from "../model.mjs";
import { defaultSessionPath, loadConversation, sessionIdPath, SessionWriter } from "../store.mjs";
import { supportsFullscreen } from "../terminal.mjs";
import { resolveCodexCommand, nativeCommandCapabilities, CodexSessions } from "./codex.mjs";
import { nativeDemo } from "./demo.mjs";
import { NativeWorkspace } from "./workspace.mjs";
import { startNotificationServer } from "./notification-server.mjs";
import { ConsoleApp } from "./console.mjs";

export async function runConsoleApp(options) {
  if (options.provider !== "codex") throw new Error("--terminal currently supports Codex only.");
  if (options.line || options.probe || options.snapshot || options.noAltScreen || options.native || options.portExplicit) {
    throw new Error("--terminal cannot be combined with browser, line, probe, snapshot or scrollback modes.");
  }
  if (!supportsFullscreen()) throw new Error("--terminal needs an interactive terminal. Run it in Windows Terminal or VS Code's terminal.");
  if (options.demo && (options.resume || options.session)) throw new Error("The terminal demo starts fresh; --resume and --session are unavailable.");
  const demo = options.demo ? nativeDemo() : null;
  const namespace = "terminal-codex";
  const requested = options.resume ? sessionIdPath(options.resume, namespace) : options.session || defaultSessionPath(options.cwd, namespace);
  const conversation = demo?.conversation ?? (!options.fresh ? await loadConversation(requested) : null) ?? createConversation({ cwd: options.cwd });
  if (options.resume && conversation.sessionId !== options.resume) throw new Error("No saved terminal session found for " + options.resume);
  if (options.cwdExplicit) conversation.cwd = options.cwd;
  const command = demo?.command ?? nativeCommandCapabilities(resolveCodexCommand());
  const sessions = demo?.sessions ?? new CodexSessions({ command, cwd: conversation.cwd });
  let workspace;
  const writer = demo ? null : new SessionWriter([
    sessionIdPath(conversation.sessionId, namespace), options.session || defaultSessionPath(conversation.cwd, namespace),
  ], () => conversation, (error) => { workspace.notice = "Session save failed: " + error.message; workspace.emit("change"); });
  workspace = new NativeWorkspace({ conversation, command, sessions, writer, yolo: options.yolo, threadLimits: options.threadLimits, demo: options.demo });
  const notifications = await startNotificationServer(workspace);
  const app = new ConsoleApp({ workspace, colors: options.colors });
  const stop = () => app.resolve?.();
  process.on("SIGTERM", stop); process.on("SIGHUP", stop);
  try { await app.run(); }
  finally { process.off("SIGTERM", stop); process.off("SIGHUP", stop); await notifications.close(); }
  if (!demo) {
    console.log("Session saved: " + conversation.sessionId);
    console.log("To continue, run: threadline resume " + conversation.sessionId + " --terminal");
  }
}
