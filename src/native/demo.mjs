import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createConversation, rootScope } from "../model.mjs";
import { importNativeThread } from "./workspace.mjs";

export function nativeDemo() {
  const conversation = createConversation({ title: "Expandable conversation demo" });
  const scope = rootScope(conversation);
  scope.providerThreadId = randomUUID();
  const thread = {
    id: scope.providerThreadId, name: "Main conversation", turns: [{
      id: randomUUID(), status: "completed", items: [
        { type: "userMessage", content: [{ type: "text", text: "How should Threadline work alongside Codex?" }] },
        { type: "agentMessage", id: randomUUID(), text: "Keep the native CLI responsible for execution. Its slash commands, completion, and approvals run in the terminal, which you can hide while reading.\n\nSelect an exact passage and open a separate conversation. The follow-up appears under its source; the parent and earlier replies stay visible. Expand a question to read its history, or return to the parent to continue from the same reading position.\n\n中文、emoji 🌱 and terminal resizing do not change the source offsets stored by Threadline." },
      ],
    }],
  };
  importNativeThread(scope, thread);
  const threads = new Map([[thread.id, thread]]);
  const sessions = {
    async create() {
      const thread = { id: randomUUID(), name: "New conversation", turns: [] };
      threads.set(thread.id, thread);
      return structuredClone(thread);
    },
    async read(id) {
      if (!threads.has(id)) throw new Error("Unknown demo conversation.");
      return structuredClone(threads.get(id));
    },
    async fork(id, lastTurnId) {
      const parent = threads.get(id);
      const index = parent.turns.findIndex((turn) => turn.id === lastTurnId);
      if (index < 0) throw new Error("Unknown demo turn.");
      const child = { id: randomUUID(), turns: structuredClone(parent.turns.slice(0, index + 1)) };
      threads.set(child.id, child);
      return { threadId: child.id, raw: { thread: structuredClone(child) } };
    },
    record(id, { question, answer }) {
      const target = threads.get(id);
      if (!target) throw new Error("Unknown demo conversation.");
      target.turns.push({
        id: randomUUID(), status: "completed", items: [
          { type: "userMessage", content: [{ type: "text", text: question }] },
          { type: "agentMessage", id: randomUUID(), text: answer },
        ],
      });
    },
  };
  return { conversation, sessions, command: { file: process.execPath, args: [fileURLToPath(new URL("./demo-cli.mjs", import.meta.url))] } };
}
