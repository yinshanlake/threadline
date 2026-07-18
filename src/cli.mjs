#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { Controller } from "./controller.mjs";
import { LineApp } from "./line.mjs";
import { createConversation, createDemoConversation } from "./model.mjs";
import { CodexProvider } from "./providers/codex.mjs";
import { DemoProvider } from "./providers/demo.mjs";
import { renderSnapshot } from "./render.mjs";
import { defaultSessionPath, loadConversation, SessionWriter } from "./store.mjs";
import { supportsFullscreen } from "./terminal.mjs";
import { TuiApp } from "./tui.mjs";

function usage() {
  return [
    "Usage: threadline [options]", "",
    "  --demo             Run without Codex using sample content",
    "  --snapshot         Print the current/demo transcript and exit",
    "  --probe            Verify the Codex app-server handshake and exit",
    "  --line             Force portable line mode",
    "  --no-alt-screen    Keep terminal scrollback instead of alternate screen",
    "  --new              Ignore the saved conversation",
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
  const options = { demo: false, snapshot: false, probe: false, line: false, noAltScreen: false, fresh: false, session: null, cwd: process.cwd(), colors: !process.env.NO_COLOR, threadLimits: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--demo") options.demo = true;
    else if (arg === "--snapshot") options.snapshot = true;
    else if (arg === "--probe") options.probe = true;
    else if (arg === "--line") options.line = true;
    else if (arg === "--no-alt-screen") options.noAltScreen = true;
    else if (arg === "--new") options.fresh = true;
    else if (arg === "--no-color") options.colors = false;
    else if (["--max-threads", "--max-depth", "--max-per-anchor"].includes(arg)) {
      const value = argv[++index];
      const key = arg === "--max-threads" ? "maxTotal" : arg === "--max-depth" ? "maxDepth" : "maxPerAnchor";
      options.threadLimits[key] = positiveIntegerOption(arg, value);
    }
    else if (arg === "--session" || arg === "--cwd") {
      const value = argv[++index]; if (!value) throw new Error(`${arg} requires a value`); options[arg === "--session" ? "session" : "cwd"] = path.resolve(value);
    } else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  const provider = options.demo ? new DemoProvider() : new CodexProvider({ cwd: options.cwd });
  if (options.probe) {
    const info = await provider.connect(); console.log(`Codex app-server OK: ${info.userAgent}`); await provider.close(); return;
  }
  const sessionFile = options.session || defaultSessionPath(options.cwd, options.demo ? "demo" : "codex");
  let conversation = options.fresh ? null : await loadConversation(sessionFile);
  if (!conversation) conversation = options.demo ? createDemoConversation() : createConversation({ provider: "codex", cwd: options.cwd });
  if (options.snapshot) { console.log(renderSnapshot(conversation).trimEnd()); return; }
  let controller;
  const writer = new SessionWriter(sessionFile, () => conversation, (error) => { if (controller) { controller.status = `Session save failed: ${error.message}`; controller.changed(); } });
  controller = new Controller({ conversation, provider, writer, threadLimits: options.threadLimits });
  if (options.line || !supportsFullscreen()) await new LineApp({ controller }).run();
  else await new TuiApp({ controller, noAltScreen: options.noAltScreen, colors: options.colors }).run();
}

main().catch((error) => { console.error(`threadline: ${error.message}`); process.exitCode = 1; });
