import test from "node:test";
import assert from "node:assert/strict";
import { addBranch, addTurn, createConversation, makeAnchor, rootScope, segmentsForTurn, upsertActivity, upsertAssistantMessage } from "../src/model.mjs";
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

test("consecutive activities collapse into one summary and expand on demand", () => {
  const conversation = createConversation();
  const scope = rootScope(conversation);
  const turn = addTurn(conversation, scope.id, "do several things");
  turn.assistant.status = "complete";
  upsertActivity(conversation, scope.id, turn.id, { id: "tool-1", type: "mcpToolCall", server: "azure-devops", tool: "repo_file", status: "completed" });
  upsertActivity(conversation, scope.id, turn.id, { id: "tool-2", type: "subAgentActivity", status: "inProgress" });
  upsertActivity(conversation, scope.id, turn.id, { id: "tool-3", type: "commandExecution", command: "a very long command that should never occupy multiple collapsed rows ".repeat(4), status: "completed" });

  const collapsed = buildConversationView(conversation, { width: 60 });
  const group = collapsed.selectables.find((item) => item.kind === "activity-group");
  const collapsedText = collapsed.lines.map((line) => line.text).join("\n");
  assert.ok(group);
  assert.match(collapsedText, /▸ 3 activities  1 running  2 complete/);
  assert.doesNotMatch(collapsedText, /azure-devops/);
  assert.doesNotMatch(collapsedText, /very long command/);

  const expanded = buildConversationView(conversation, { width: 60, activityGroups: new Map([[group.groupId, true]]) });
  const expandedText = expanded.lines.map((line) => line.text).join("\n");
  assert.match(expandedText, /▾ 3 activities/);
  assert.ok(expandedText.includes("azure-devops / repo_file"));
  assert.equal(expanded.lines.filter((line) => line.text.includes("very long command")).length, 1);
  assert.equal(expanded.selectables.filter((item) => item.kind === "activity").length, 3);
});

test("assistant messages split activity groups without losing event order", () => {
  const conversation = createConversation();
  const scope = rootScope(conversation);
  const turn = addTurn(conversation, scope.id, "mixed work");
  turn.assistant.status = "complete";
  upsertActivity(conversation, scope.id, turn.id, { id: "before-1", type: "webSearch", query: "one", status: "completed" });
  upsertActivity(conversation, scope.id, turn.id, { id: "before-2", type: "webSearch", query: "two", status: "completed" });
  upsertAssistantMessage(conversation, scope.id, turn.id, "message", { text: "Between groups." });
  upsertActivity(conversation, scope.id, turn.id, { id: "after-1", type: "webSearch", query: "three", status: "completed" });
  upsertActivity(conversation, scope.id, turn.id, { id: "after-2", type: "webSearch", query: "four", status: "completed" });

  const view = buildConversationView(conversation);
  assert.equal(view.selectables.filter((item) => item.kind === "activity-group").length, 2);
  const text = view.lines.map((line) => line.text).join("\n");
  assert.ok(text.indexOf("2 activities") < text.indexOf("Between groups."));
  assert.ok(text.lastIndexOf("2 activities") > text.indexOf("Between groups."));
});

test("an activity group inside an inline thread uses the same expansion state", () => {
  const conversation = createConversation();
  const root = rootScope(conversation);
  const source = addTurn(conversation, root.id, "source question");
  source.assistant.text = "Source answer.";
  source.assistant.status = "complete";
  const branch = addBranch(conversation, root.id, makeAnchor(source, segmentsForTurn(source)[0]));
  const childTurn = addTurn(conversation, branch.id, "inspect from here");
  childTurn.assistant.status = "complete";
  upsertActivity(conversation, branch.id, childTurn.id, { id: "inline-tool-1", type: "webSearch", query: "first", status: "completed" });
  upsertActivity(conversation, branch.id, childTurn.id, { id: "inline-tool-2", type: "webSearch", query: "second", status: "completed" });

  const collapsed = buildConversationView(conversation, { width: 80 });
  const group = collapsed.selectables.find((item) => item.kind === "activity-group" && item.scopeId === branch.id);
  assert.ok(group);
  assert.doesNotMatch(collapsed.lines.map((line) => line.text).join("\n"), /search  first/);

  const expanded = buildConversationView(conversation, {
    width: 80,
    activityGroups: new Map([[group.groupId, true]]),
  });
  const text = expanded.lines.map((line) => line.text).join("\n");
  assert.match(text, /▾ 2 activities  2 complete/);
  assert.match(text, /search  first/);
  assert.match(text, /search  second/);
});
