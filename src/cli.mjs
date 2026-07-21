#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { Controller } from "./controller.mjs";
import { LineApp } from "./line.mjs";
import { createConversation, createDemoConversation } from "./model.mjs";
import { CodexProvider } from "./providers/codex.mjs";
import { DemoProvider } from "./providers/demo.mjs";
import { renderSnapshot } from "./render.mjs";
import { defaultSessionPath, loadConversation, normalizeSessionId, saveConversation, sessionIdPath, SessionWriter } from "./store.mjs";
import { supportsFullscreen } from "./terminal.mjs";
import { TuiApp } from "./tui.mjs";

function usage() {
  return [
    "Usage: threadline [options]",
    "       threadline demo [options]",
    "       threadline resume SESSION_GUID [options]", "",
    "  demo               Open a fresh interactive feature showcase (no Codex)",
    "  --demo             Run without Codex using a resumable demo session",
    "  --snapshot         Print the current/demo transcript and exit",
    "  --probe            Verify the Codex app-server handshake and exit",
    "  --line             Force portable line mode",
    "  --no-alt-screen    Keep terminal scrollback instead of alternate screen",
    "  --new              Ignore the saved conversation",
    "  --resume GUID      Resume a saved session (alias for `resume GUID`)",
    "  --yolo             Disable approvals and sandboxing (dangerous)",
    "  --session FILE     Use an explicit Threadline session file",
    "  --cwd DIR          Workspace passed to the LLM CLI",
    "  --max-threads N    Maximum deep-dive threads per session (default: 32)",
    "  --max-depth N      Maximum thread nesting depth (default: 4)",
    "  --max-per-anchor N Maximum threads on one excerpt (default: 3)",
    "  --no-color         Disable ANSI colors",
    "  -h, --help         Show this help"
  ].join("\n");
}

function positiveIntegerOption(arg, value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${arg} requires a positive integer`);
  return number;
}

function parseArgs(argv) {
  const options = { demo: false, snapshot: false, probe: false, line: false, noAltScreen: false, fresh: false, resume: null, yolo: false, session: null, cwd: process.cwd(), cwdExplicit: false, colors: !process.env.NO_COLOR, threadLimits: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "demo") { options.demo = true; options.fresh = true; }
    else if (arg === "--demo") options.demo = true;
    else if (arg === "--snapshot") options.snapshot = true;
    else if (arg === "--probe") options.probe = true;
    else if (arg === "--line") options.line = true;
    else if (arg === "--no-alt-screen") options.noAltScreen = true;
    else if (arg === "--new") options.fresh = true;
    else if (arg === "--yolo") options.yolo = true;
    else if (arg === "--no-color") options.colors = false;
    else if (["--max-threads", "--max-depth", "--max-per-anchor"].includes(arg)) {
      const value = argv[++index];
      const key = arg === "--max-threads" ? "maxTotal" : arg === "--max-depth" ? "maxDepth" : "maxPerAnchor";
      options.threadLimits[key] = positiveIntegerOption(arg, value);
    }
    else if (arg === "resume" || arg === "--resume") {
      const value = argv[++index]; if (!value) throw new Error(`${arg} requires a session GUID`); options.resume = normalizeSessionId(value);
    }
    else if (arg === "--session" || arg === "--cwd") {
      const value = argv[++index]; if (!value) throw new Error(`${arg} requires a value`); options[arg === "--session" ? "session" : "cwd"] = path.resolve(value);
      if (arg === "--cwd") options.cwdExplicit = true;
    } else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.resume && options.fresh) throw new Error("resume and --new cannot be used together");
  if (options.resume && options.session) throw new Error("resume and --session cannot be used together");
  return options;
}

function resumeCommand(options, sessionId) {
  return ["threadline", "resume", sessionId, options.demo ? "--demo" : null, options.yolo ? "--yolo" : null].filter(Boolean).join(" ");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  const providerName = options.demo ? "demo" : "codex";
  const provider = options.demo ? new DemoProvider() : new CodexProvider({ cwd: options.cwd, yolo: options.yolo });
  if (options.probe) {
    const info = await provider.connect(); console.log(`Codex app-server OK: ${info.userAgent}`); await provider.close(); return;
  }
  const initialLatestFile = defaultSessionPath(options.cwd, providerName);
  const requestedFile = options.resume ? sessionIdPath(options.resume, providerName) : (options.session || initialLatestFile);
  if (options.fresh) {
    const previous = await loadConversation(options.session || initialLatestFile);
    if (previous) await saveConversation(sessionIdPath(previous.sessionId, previous.provider ?? providerName), previous);
  }
  let conversation = options.fresh ? null : await loadConversation(requestedFile);
  if (options.resume && !conversation) throw new Error(`No saved Threadline session found for ${options.resume}`);
  if (!conversation) conversation = options.demo ? createDemoConversation() : createConversation({ provider: "codex", cwd: options.cwd });
  if (options.cwdExplicit) conversation.cwd = options.cwd;
  const runtimeCwd = conversation.cwd || options.cwd;
  if (!options.demo) provider.cwd = runtimeCwd;
  if (options.snapshot) { console.log(renderSnapshot(conversation).trimEnd()); return; }
  const archiveFile = sessionIdPath(conversation.sessionId, providerName);
  const latestFile = defaultSessionPath(runtimeCwd, providerName);
  const sessionFiles = [archiveFile, options.session || latestFile];
  let controller;
  const writer = new SessionWriter(sessionFiles, () => conversation, (error) => { if (controller) { controller.status = `Session save failed: ${error.message}`; controller.changed(); } });
  controller = new Controller({ conversation, provider, writer, threadLimits: options.threadLimits });
  if (options.line || !supportsFullscreen()) await new LineApp({ controller }).run();
  else await new TuiApp({ controller, noAltScreen: options.noAltScreen, colors: options.colors }).run();
  console.log(`Session saved: ${conversation.sessionId}`);
  console.log(`To continue, run: ${resumeCommand(options, conversation.sessionId)}`);
}

main().catch((error) => { console.error(`threadline: ${error.message}`); process.exitCode = 1; });
