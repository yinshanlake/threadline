import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDemoConversation } from "../src/model.mjs";
import { loadConversation, normalizeSessionId, saveConversation, sessionIdPath, SessionWriter } from "../src/store.mjs";

test("session survives a save/load cycle", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "threadline-test-"));
  const file = path.join(dir, "session.json");
  try {
    const original = createDemoConversation();
    await saveConversation(file, original);
    const loaded = await loadConversation(file);
    assert.equal(loaded.id, original.id);
    assert.equal(loaded.scopes[1].anchor.exactQuote, original.scopes[1].anchor.exactQuote);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("session GUID paths are stable and reject malformed identifiers", () => {
  const session = createDemoConversation();
  assert.equal(normalizeSessionId(`conversation_${session.sessionId}`), session.sessionId);
  assert.match(sessionIdPath(session.sessionId, "demo"), new RegExp(`demo-${session.sessionId}\\.json$`));
  assert.throws(() => normalizeSessionId("not-a-guid"), /Invalid Threadline session GUID/);
});

test("session writer keeps both the GUID archive and latest-session alias", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "threadline-multi-save-"));
  const archive = path.join(dir, "archive.json");
  const latest = path.join(dir, "latest.json");
  try {
    const conversation = createDemoConversation();
    const writer = new SessionWriter([archive, latest], () => conversation);
    await writer.flush();
    assert.equal((await loadConversation(archive)).sessionId, conversation.sessionId);
    assert.equal((await loadConversation(latest)).sessionId, conversation.sessionId);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("version 1 sessions migrate without pretending legacy event order is exact", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "threadline-migrate-"));
  const file = path.join(dir, "session.json");
  try {
    const legacy = createDemoConversation();
    legacy.version = 1;
    delete legacy.sessionId;
    const turn = legacy.scopes[0].turns[0];
    delete turn.assistant.messages; delete turn.assistant.timeline;
    turn.assistant.activities = [{ id: "old-tool", type: "commandExecution", status: "complete", output: "ok", item: {}, expanded: false }];
    await saveConversation(file, legacy);
    const loaded = await loadConversation(file);
    assert.equal(loaded.version, 2);
    assert.equal(loaded.sessionId, legacy.id.replace(/^conversation_/u, ""));
    assert.equal(loaded.scopes[0].turns[0].assistant.legacyTimeline, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
