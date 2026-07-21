import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeConversation } from "./model.mjs";

function dataHome() {
  if (process.env.THREADLINE_HOME) return path.resolve(process.env.THREADLINE_HOME);
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "threadline");
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "threadline");
}

export function normalizeSessionId(value) {
  const sessionId = String(value ?? "").trim().replace(/^conversation_/u, "").toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(sessionId)) {
    throw new Error(`Invalid Threadline session GUID: ${value}`);
  }
  return sessionId;
}

export function sessionIdPath(sessionId, provider = "codex") {
  return path.join(dataHome(), "sessions", `${provider}-${normalizeSessionId(sessionId)}.json`);
}

export function defaultSessionPath(cwd = process.cwd(), provider = "codex") {
  const resolved = path.resolve(cwd);
  const keySource = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const key = createHash("sha256").update(keySource).digest("hex").slice(0, 16);
  return path.join(dataHome(), "sessions", `${provider}-${key}.json`);
}

export async function loadConversation(file) {
  try {
    return normalizeConversation(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Could not load session ${file}: ${error.message}`, { cause: error });
  }
}

export async function saveConversation(file, conversation) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(conversation, null, 2) + "\n", "utf8");
  try {
    await rename(temporary, file);
  } catch (error) {
    if (process.platform !== "win32" || !["EEXIST", "EPERM"].includes(error?.code)) throw error;
    await writeFile(file, JSON.stringify(conversation, null, 2) + "\n", "utf8");
    await rm(temporary, { force: true });
  }
}

export class SessionWriter {
  constructor(files, readConversation, onError = null) {
    const values = (Array.isArray(files) ? files : [files]).filter(Boolean).map((file) => path.resolve(file));
    this.files = [...new Set(values)];
    this.file = this.files[0] ?? null;
    this.readConversation = readConversation;
    this.onError = onError;
    this.timer = null;
    this.pending = Promise.resolve();
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush().catch((error) => this.onError?.(error)); }, 120);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const snapshot = structuredClone(this.readConversation());
    this.pending = this.pending.catch(() => {}).then(() => Promise.all(this.files.map((file) => saveConversation(file, snapshot))));
    return this.pending;
  }
}
