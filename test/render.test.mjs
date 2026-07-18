import test from "node:test";
import assert from "node:assert/strict";
import { addTurn, createConversation, createDemoConversation, rootScope } from "../src/model.mjs";
import { buildConversationView, renderLine, renderSnapshot } from "../src/render.mjs";
import { displayWidth } from "../src/text.mjs";

test("demo renders an inline collapsible thread", () => {
  const conversation = createDemoConversation();
  const snapshot = renderSnapshot(conversation, 72);
  assert.match(snapshot, /1 thread\s+1 reply/);
  assert.equal((snapshot.match(/\bAI\b|◆ assistant/g) ?? []).length, 0);
  assert.ok(snapshot.includes("threadline  demo  main"));
  assert.match(snapshot, /为什么不能保存 terminal/);
  const view = buildConversationView(conversation, { width: 72 });
  assert.ok(view.selectables.some((item) => item.kind === "segment"));
  assert.ok(view.selectables.some((item) => item.kind === "branch-group"));
});

test("resize changes wrapping without changing anchors", () => {
  const conversation = createDemoConversation();
  const anchor = structuredClone(conversation.scopes[1].anchor);
  assert.notEqual(renderSnapshot(conversation, 48), renderSnapshot(conversation, 100));
  assert.deepEqual(conversation.scopes[1].anchor, anchor);
});

test("inspect styling is local and does not rewrite transcript text", () => {
  const conversation = createDemoConversation();
  const view = buildConversationView(conversation, { width: 88 });
  const segmentIndex = view.selectables.findIndex((item) => item.kind === "segment");
  assert.ok(segmentIndex >= 0);
  const plain = view.lines.map((line) => renderLine(line, segmentIndex, { colors: false, inspect: false })).join("\n");
  const inspected = view.lines.map((line) => renderLine(line, segmentIndex, { colors: false, inspect: true })).join("\n");
  const stripAnsi = (value) => value.replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(stripAnsi(inspected), plain);
  assert.notEqual(inspected, plain);
});

test("assistant rail and no-color rendering preserve a quiet readable hierarchy", () => {
  const conversation = createDemoConversation();
  const view = buildConversationView(conversation, { width: 42 });
  const plain = view.lines.map((line) => renderLine(line, -1, { colors: false })).join("\n");
  assert.match(plain, /^  │ /m);
  assert.match(plain, /│ ▾ 1 thread  1 reply/);
  assert.doesNotMatch(plain, /thread 1|╰─|├─|◌|\bAI\b/);
  assert.ok(view.lines.every((line) => displayWidth(line.text) <= 42));
});

test("empty, working, and failed states share the transcript hierarchy", () => {
  const conversation = createConversation();
  assert.match(buildConversationView(conversation).lines.map((line) => line.text).join("\n"), /Ask a question/);

  const scope = rootScope(conversation);
  const turn = addTurn(conversation, scope.id, "Will this work?");
  let view = buildConversationView(conversation);
  assert.match(view.lines.map((line) => line.text).join("\n"), /│ working\.\.\./);

  turn.assistant.status = "failed";
  turn.assistant.text = "Provider unavailable";
  view = buildConversationView(conversation);
  const failure = view.lines.find((line) => line.text.includes("Provider unavailable"));
  assert.ok(failure.parts.some((part) => part.tone === "error"));
});
