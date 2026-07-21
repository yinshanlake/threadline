import test from "node:test";
import assert from "node:assert/strict";
import { addBranch, addTurn, createConversation, createDemoConversation, makeAnchor, rootScope, segmentsForTurn } from "../src/model.mjs";
import { buildConversationView, overviewView, renderLine, renderSnapshot, threadColorIndex } from "../src/render.mjs";
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
  const child = conversation.scopes.find((scope) => scope.parentId);
  assert.ok(view.selectables.some((item) => item.kind === "segment" && item.scopeId === child.id));
});

test("every wrapped row in an inline thread answer remains selectable for another thread", () => {
  const conversation = createDemoConversation();
  const child = conversation.scopes.find((scope) => scope.parentId);
  const childTurn = child.turns[0];
  const view = buildConversationView(conversation, { width: 38 });
  const childSelections = new Set(view.selectables
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.kind === "segment" && item.scopeId === child.id)
    .map(({ index }) => index));
  const answerRows = view.lines.filter((line) => line.parts?.some((part) =>
    childSelections.has(part.selectableIndex) && view.selectables[part.selectableIndex]?.turnId === childTurn.id));

  assert.ok(answerRows.length > 1);
  assert.ok(answerRows.every((line) => line.parts.some((part) => childSelections.has(part.selectableIndex))));
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

test("threads receive distinct stable colors without changing no-color output", () => {
  const conversation = createDemoConversation();
  const root = rootScope(conversation);
  const source = root.turns[0];
  const second = addBranch(conversation, root.id, makeAnchor(source, segmentsForTurn(source)[1]), "provider-second");
  const turn = addTurn(conversation, second.id, "A second colored question");
  turn.assistant.text = "A second answer.";
  turn.assistant.status = "complete";
  const branches = conversation.scopes.filter((scope) => scope.parentId);

  const secondColor = threadColorIndex(conversation, second.id);
  const comparison = branches.find((branch) => branch.id !== second.id && threadColorIndex(conversation, branch.id) !== secondColor);
  const firstColor = threadColorIndex(conversation, comparison.id);
  assert.notEqual(firstColor, secondColor);
  assert.equal(threadColorIndex(conversation, second.id), secondColor);

  const narrow = buildConversationView(conversation, { width: 48 });
  const wide = buildConversationView(conversation, { width: 100 });
  const narrowPart = narrow.lines.flatMap((line) => line.parts).find((part) => part.text.includes("A second colored question"));
  const widePart = wide.lines.flatMap((line) => line.parts).find((part) => part.text.includes("A second colored question"));
  assert.equal(narrowPart.accent, secondColor);
  assert.equal(widePart.accent, secondColor);

  const colored = renderLine(wide.lines.find((line) => line.text.includes("A second colored question")), -1, { colors: true });
  const plain = renderLine(wide.lines.find((line) => line.text.includes("A second colored question")), -1, { colors: false });
  assert.match(colored, /\x1b\[38;5;/u);
  assert.doesNotMatch(plain, /\x1b\[/u);
});

test("thread overview carries each thread color into its label", () => {
  const conversation = createDemoConversation();
  const branch = conversation.scopes.find((scope) => scope.parentId);
  const view = overviewView(conversation, 80);
  const label = view.lines.find((line) => line.text.includes(branch.anchor.exactQuote));
  assert.equal(label.parts.find((part) => part.selectableIndex !== undefined)?.accent, threadColorIndex(conversation, branch.id));
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
