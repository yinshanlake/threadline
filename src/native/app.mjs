import { createConversation } from "../model.mjs";
import { defaultSessionPath, loadConversation, sessionIdPath, SessionWriter } from "../store.mjs";
import { resolveCodexCommand, nativeCommandCapabilities, CodexSessions } from "./codex.mjs";
import { nativeDemo } from "./demo.mjs";
import { startNativeServer } from "./server.mjs";
import { NativeWorkspace } from "./workspace.mjs";

export async function runNativeApp(options) {
  if (options.provider !== "codex") throw new Error("Native sidebar currently supports Codex only.");
  if (options.line || options.probe || options.snapshot || options.noAltScreen) {
    throw new Error("--native cannot be combined with --line, --probe, --snapshot, or --no-alt-screen.");
  }
  if (options.demo && (options.resume || options.session)) throw new Error("The native demo starts fresh; --resume and --session are unavailable in demo mode.");
  const demo = options.demo ? nativeDemo() : null;
  const providerName = options.demo ? "native-demo" : "native-codex";
  const requested = options.resume ? sessionIdPath(options.resume, providerName) : options.session || defaultSessionPath(options.cwd, providerName);
  let conversation = demo?.conversation ?? (!options.fresh ? await loadConversation(requested) : null);
  if (options.resume && !conversation) throw new Error(`No saved native sidebar session found for ${options.resume}`);
  conversation ??= createConversation({ cwd: options.cwd });
  if (options.cwdExplicit) conversation.cwd = options.cwd;
  const command = demo?.command ?? nativeCommandCapabilities(resolveCodexCommand());
  const sessions = demo?.sessions ?? new CodexSessions({ command, cwd: conversation.cwd });
  const writer = options.demo ? null : new SessionWriter([
    sessionIdPath(conversation.sessionId, providerName), options.session || defaultSessionPath(conversation.cwd, providerName),
  ], () => conversation, (error) => { workspace.notice = `Session save failed: ${error.message}`; workspace.emit("change"); });
  const workspace = new NativeWorkspace({ conversation, command, sessions, writer, yolo: options.yolo, threadLimits: options.threadLimits, demo: options.demo });
  const app = await startNativeServer({ workspace, port: options.port });
  const stop = new Promise((resolve) => {
    process.once("SIGINT", resolve); process.once("SIGTERM", resolve);
  });
  try {
    await workspace.initialize();
    console.log(`Threadline native sidebar: ${app.url}`);
    console.log(`Workspace: ${conversation.cwd}`);
    console.log("Open the local link in a browser. Press Ctrl+C here to stop.");
    await stop;
  } finally {
    await app.close();
    await workspace.close();
  }
  if (!options.demo) {
    console.log(`Session saved: ${conversation.sessionId}`);
    console.log(`To continue, run: threadline resume ${conversation.sessionId} --native`);
  }
}
