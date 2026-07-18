import test from "node:test";
import assert from "node:assert/strict";
import { createDemoConversation } from "../src/model.mjs";
import { displayWidth, graphemes } from "../src/text.mjs";
import { TuiApp } from "../src/tui.mjs";

function makeApp() {
  const controller = {
    conversation: createDemoConversation(),
    status: "Ready",
    pendingApproval: null,
    pendingUserInput: null,
  };
  const app = new TuiApp({ controller, colors: false });
  app.terminal = { size: () => ({ columns: 100, rows: 30 }), draw: () => {} };
  app.draw();
  return app;
}

function makeFrame({ columns = 100, rows = 30, setup } = {}) {
  const app = makeApp();
  let frame = [];
  app.terminal = { size: () => ({ columns, rows }), draw: (lines) => { frame = lines; } };
  setup?.(app);
  app.draw();
  return { app, frame };
}

test("up from an empty composer inspects the most recent selectable answer", async () => {
  const app = makeApp();
  await app.handleInputKey({ name: "up", text: "" });
  assert.equal(app.mode, "browse");
  assert.equal(app.selection, app.view.selectables.length - 1);
});

test("typing on a selected excerpt starts a focused follow-up", async () => {
  const app = makeApp();
  const lastSegment = app.view.selectables.findLastIndex((item) => item.kind === "segment");
  app.mode = "browse";
  app.setSelection(lastSegment);

  await app.handleBrowseKey({ name: "w", text: "w", ctrl: false, meta: false });
  assert.equal(app.mode, "dive-input");
  assert.equal(app.input, "w");
  assert.equal(app.pendingDive.kind, "segment");
});

test("a blocked excerpt does not enter the focused follow-up composer", async () => {
  const app = makeApp();
  const lastSegment = app.view.selectables.findLastIndex((item) => item.kind === "segment");
  app.controller.threadCapacity = () => ({
    allowed: false,
    code: "thread-total-limit",
    message: "This conversation has reached its 32-thread limit. Continue in an existing thread.",
  });
  app.mode = "browse";
  app.setSelection(lastSegment);

  await app.handleBrowseKey({ name: "enter", text: "", ctrl: false, meta: false });

  assert.equal(app.mode, "browse");
  assert.equal(app.pendingDive, null);
  assert.match(app.controller.status, /32-thread limit/);
});

test("header shows current thread capacity", () => {
  const { frame } = makeFrame({
    setup: (app) => { app.controller.threadLimits = { maxTotal: 32 }; },
  });
  assert.match(frame[0], /1\/32 thread/);
});

test("an identical focused follow-up opens the existing thread", async () => {
  const app = makeApp();
  const existing = app.controller.conversation.scopes.find((scope) => scope.parentId);
  const source = app.view.selectables.find((item) => item.kind === "segment");
  app.controller.dive = async () => {
    const error = new Error("duplicate");
    error.code = "duplicate-thread";
    error.scopeId = existing.id;
    throw error;
  };
  app.controller.setActiveScope = (scopeId) => { app.controller.conversation.activeScopeId = scopeId; };
  app.controller.send = async () => { throw new Error("unexpected main-scope send"); };
  app.controller.pendingUserInput = null;
  app.mode = "dive-input";
  app.pendingDive = source;
  app.input = existing.turns[0].user.text;
  app.cursor = graphemes(app.input).length;
  app.mode = "dive-input";
  app.pendingDive = source;

  await app.handleInputKey({ name: "enter", text: "" });

  assert.equal(app.controller.conversation.activeScopeId, existing.id);
  assert.equal(app.controller.status, "Opened the existing matching thread");
});

test("selection follows its source anchor when earlier items are inserted", () => {
  const app = makeApp();
  const selectedIndex = app.view.selectables.findLastIndex((item) => item.kind === "segment");
  app.mode = "browse";
  app.setSelection(selectedIndex);
  const selectedKey = app.selected().segment.key;

  const turn = app.controller.conversation.scopes[0].turns[0];
  turn.assistant.activities.push({ id: "inserted-tool", type: "webSearch", status: "completed", item: { query: "terminal UI" }, expanded: false });
  turn.assistant.timeline.unshift({ kind: "activity", id: "inserted-tool" });
  app.draw();

  assert.equal(app.selected().segment.key, selectedKey);
  assert.equal(app.selection, selectedIndex + 1);
});

test("compact composer leaves only two footer rows", () => {
  const { frame } = makeFrame({ columns: 80, rows: 18 });
  assert.equal(frame.length, 18);
  assert.match(frame.at(-2), /› .*▌/);
  assert.match(frame.at(-1), /Enter send/);
});

test("narrow approval and requested-input states remain bounded and explicit", () => {
  const approval = makeFrame({
    columns: 32, rows: 10,
    setup: (app) => { app.controller.pendingApproval = { method: "item/commandExecution/requestApproval", params: { command: "a very long command that must be clipped" } }; },
  }).frame;
  assert.match(approval.at(-2), /Approval required/);
  assert.match(approval.at(-1), /approve/);
  assert.ok(approval.every((line) => displayWidth(line.replace(/\x1b\[[0-9;]*m/g, "")) <= 32));

  const requested = makeFrame({
    columns: 32, rows: 10,
    setup: (app) => {
      app.controller.pendingUserInput = { questions: [{ id: "region", question: "Which deployment region should be used?" }], index: 0 };
      app.controller.currentUserQuestion = () => app.controller.pendingUserInput.questions[0];
    },
  }).frame;
  assert.match(requested.at(-2), /Which deploym/);
  assert.match(requested.at(-1), /Enter answer/);
  assert.ok(requested.every((line) => displayWidth(line.replace(/\x1b\[[0-9;]*m/g, "")) <= 32));
});
