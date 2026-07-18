import test from "node:test";
import assert from "node:assert/strict";
import { addTurn, createConversation, rootScope, upsertActivity, upsertAssistantMessage } from "../src/model.mjs";
import { buildConversationView, renderSnapshot } from "../src/render.mjs";

test("assistant messages and tools retain event order", () => {
  const conversation = createConversation();
  const scope = rootScope(conversation);
  const turn = addTurn(conversation, scope.id, "inspect the repo");
  turn.assistant.status = "complete";
  upsertAssistantMessage(conversation, scope.id, turn.id, "m1", { text: "I will inspect it.", phase: "commentary" });
  upsertActivity(conversation, scope.id, turn.id, { id: "tool1", type: "commandExecution", command: "rg --files", status: "completed" });
  upsertAssistantMessage(conversation, scope.id, turn.id, "m2", { text: "There are three files.", phase: "final_answer" });
  const snapshot = renderSnapshot(conversation, 100);
  assert.ok(snapshot.indexOf("I will inspect it.") < snapshot.indexOf("rg --files"));
  assert.ok(snapshot.indexOf("rg --files") < snapshot.indexOf("There are three files."));
});

test("streamed tool output is not replaced by a shorter aggregate", () => {
  const conversation = createConversation();
  const scope = rootScope(conversation);
  const turn = addTurn(conversation, scope.id, "run it");
  turn.assistant.status = "complete";
  const full = "line one\nline two\nline three";
  upsertActivity(conversation, scope.id, turn.id, { id: "tool1", type: "commandExecution", command: "test" }, { appendOutput: full });
  const activity = upsertActivity(conversation, scope.id, turn.id, { id: "tool1", type: "commandExecution", command: "test", aggregatedOutput: "line three", status: "completed" });
  activity.expanded = true;
  assert.equal(activity.output, full);
  const snapshot = renderSnapshot(conversation, 100);
  assert.match(snapshot, /line one/);
  assert.match(snapshot, /line two/);
  assert.match(snapshot, /line three/);
  assert.match(snapshot, /complete payload received/);
});

test("large activity output is not duplicated inside item metadata", () => {
  const conversation = createConversation();
  const scope = rootScope(conversation);
  const turn = addTurn(conversation, scope.id, "run it");
  const output = "x".repeat(10_000);
  const activity = upsertActivity(conversation, scope.id, turn.id, { id: "tool1", type: "commandExecution", aggregatedOutput: output });
  assert.equal(activity.output.length, 10_000);
  assert.equal(Object.hasOwn(activity.item, "aggregatedOutput"), false);
});

test("expanded large activity output is paged without shortening stored data", () => {
  const conversation = createConversation();
  const scope = rootScope(conversation);
  const turn = addTurn(conversation, scope.id, "run it");
  const output = `${"A".repeat(8_192)}${"B".repeat(8_192)}tail`;
  const activity = upsertActivity(conversation, scope.id, turn.id, { id: "tool1", type: "commandExecution" }, { appendOutput: output });
  activity.expanded = true;
  const pages = new Map([[`${scope.id}:${turn.id}:${activity.id}`, 1]]);
  const view = buildConversationView(conversation, { width: 80, activityPages: pages });
  const text = view.lines.map((line) => line.text).join("\n");
  assert.equal(activity.output, output);
  assert.match(text, /page 2\/3/);
  assert.match(text, /BBBB/);
  assert.doesNotMatch(text, /AAAA/);
  const selected = view.selectables.find((item) => item.kind === "activity");
  assert.deepEqual({ page: selected.page, pages: selected.pages }, { page: 1, pages: 3 });
});
