import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDemoConversation } from "../src/model.mjs";
import { loadConversation, saveConversation } from "../src/store.mjs";

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

test("version 1 sessions migrate without pretending legacy event order is exact", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "threadline-migrate-"));
  const file = path.join(dir, "session.json");
  try {
    const legacy = createDemoConversation();
    legacy.version = 1;
    const turn = legacy.scopes[0].turns[0];
    delete turn.assistant.messages; delete turn.assistant.timeline;
    turn.assistant.activities = [{ id: "old-tool", type: "commandExecution", status: "complete", output: "ok", item: {}, expanded: false }];
    await saveConversation(file, legacy);
    const loaded = await loadConversation(file);
    assert.equal(loaded.version, 2);
    assert.equal(loaded.scopes[0].turns[0].assistant.legacyTimeline, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
