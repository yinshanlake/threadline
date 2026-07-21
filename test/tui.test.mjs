import test from "node:test";
import assert from "node:assert/strict";
import { addTurn, createConversation, createDemoConversation, rootScope, upsertActivity } from "../src/model.mjs";
import { displayWidth, graphemes } from "../src/text.mjs";
import { TuiApp } from "../src/tui.mjs";

function makeApp(conversation = createDemoConversation()) {
  const controller = {
    conversation,
    status: "Ready",
    pendingApproval: null,
    pendingUserInput: null,
  };
  const app = new TuiApp({ controller, colors: false });
  app.terminal = { size: () => ({ columns: 100, rows: 30 }), draw: () => {} };
  app.draw();
  return app;
}

function makeCommandApp() {
  const app = makeApp();
  app.controller.slashCommands = () => [
    { name: "compact", description: "Summarize the current chat" },
    { name: "status", description: "Show session configuration" },
  ];
  app.controller.executeSlashCommand = async (input) => {
    app.controller.executedCommand = input;
    return { handled: true, message: "Command complete" };
  };
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

test("the demo walkthrough reaches the collapsed tool group with two up presses", async () => {
  const app = makeApp();
  await app.handleInputKey({ name: "up", text: "" });
  await app.handleBrowseKey({ name: "up", text: "" });

  assert.equal(app.selected().kind, "activity-group");
  assert.equal(app.selected().activityIds.length, 4);
});

test("up and tab stay in the composer when an empty conversation has nothing to inspect", async () => {
  const app = makeApp(createConversation());
  assert.equal(app.view.selectables.length, 0);

  await app.handleInputKey({ name: "up", text: "" });
  assert.equal(app.mode, "input");
  assert.equal(app.controller.status, "Nothing to inspect yet");

  await app.handleInputKey({ name: "tab", text: "" });
  assert.equal(app.mode, "input");
});

test("inspect mode shows its escape route before other keyboard hints", () => {
  const app = makeApp();
  let frame = [];
  app.terminal = { size: () => ({ columns: 64, rows: 18 }), draw: (lines) => { frame = lines; } };
  app.mode = "browse";
  app.draw();

  assert.match(frame.at(-1), /^ Esc back to input/);
});

test("empty composer does not advertise inspect mode", () => {
  const app = makeApp(createConversation());
  let frame = [];
  app.terminal = { size: () => ({ columns: 80, rows: 18 }), draw: (lines) => { frame = lines; } };
  app.draw();

  assert.ok(frame.at(-1).includes("Type / for commands"));
  assert.doesNotMatch(frame.at(-1), /inspect/);
});

test("a silent turn shows elapsed progress and an explicit stop key", () => {
  const conversation = createConversation();
  const turn = addTurn(conversation, rootScope(conversation).id, "a question");
  turn.createdAt = new Date(Date.now() - 20_000).toISOString();
  const app = makeApp(conversation);
  let frame = [];
  app.terminal = { size: () => ({ columns: 80, rows: 18 }), draw: (lines) => { frame = lines; } };
  app.draw();

  assert.match(frame.at(-1), /^ Esc stop/);
  assert.match(frame.at(-1), /still waiting 20s/);
});

test("escape interrupts a streaming turn without quitting Threadline", async () => {
  const conversation = createConversation();
  const turn = addTurn(conversation, rootScope(conversation).id, "a question");
  turn.providerTurnId = "provider-turn";
  const app = makeApp(conversation);
  app.controller.interrupt = async () => { app.controller.interrupted = true; turn.assistant.status = "interrupted"; };

  await app.handleKey({ name: "escape", text: "" });

  assert.equal(app.controller.interrupted, true);
  assert.equal(app.closed, false);
  assert.equal(app.mode, "input");
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
  assert.match(frame[0], /3\/32 threads/);
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

test("activity groups expand and collapse with enter, space, and arrow keys", async () => {
  const conversation = createConversation();
  const scope = rootScope(conversation);
  const turn = addTurn(conversation, scope.id, "run tools");
  turn.assistant.status = "complete";
  upsertActivity(conversation, scope.id, turn.id, { id: "tool-1", type: "webSearch", query: "one", status: "completed" });
  upsertActivity(conversation, scope.id, turn.id, { id: "tool-2", type: "webSearch", query: "two", status: "completed" });
  const app = makeApp(conversation);
  app.mode = "browse";
  app.setSelection(app.view.selectables.findIndex((item) => item.kind === "activity-group"));
  const groupId = app.selected().groupId;

  await app.handleBrowseKey({ name: "enter", text: "" });
  assert.equal(app.activityGroups.get(groupId), true);
  assert.equal(app.selected().expanded, true);

  await app.handleBrowseKey({ name: "left", text: "" });
  assert.equal(app.activityGroups.get(groupId), false);
  assert.equal(app.selected().expanded, false);

  await app.handleBrowseKey({ name: "right", text: "" });
  assert.equal(app.activityGroups.get(groupId), true);
  assert.equal(app.selected().expanded, true);

  await app.handleBrowseKey({ name: "space", text: " " });
  assert.equal(app.activityGroups.get(groupId), false);
  assert.equal(app.selected().expanded, false);
});

test("compact composer leaves only two footer rows", () => {
  const { frame } = makeFrame({ columns: 80, rows: 18 });
  assert.equal(frame.length, 18);
  assert.match(frame.at(-2), /› .*▌/);
  assert.match(frame.at(-1), /Enter send/);
});

test("slash input opens a filtered local command menu", async () => {
  const app = makeCommandApp();

  await app.handleInputKey({ name: "/", text: "/" });
  assert.deepEqual(app.commandItems().map((item) => item.name), ["compact", "status"]);

  await app.handleInputKey({ name: "s", text: "s" });
  assert.deepEqual(app.commandItems().map((item) => item.name), ["status"]);
});

test("tab completes and enter dispatches slash commands locally", async () => {
  const app = makeCommandApp();
  app.input = "/c";
  app.cursor = 2;

  await app.handleInputKey({ name: "tab", text: "" });
  assert.equal(app.input, "/compact " );

  await app.handleInputKey({ name: "enter", text: "" });
  assert.equal(app.controller.executedCommand, "/compact");
  assert.equal(app.controller.status, "Command complete");
  assert.equal(app.controller.send, undefined);
});

test("enter chooses the highlighted command for a unique prefix", async () => {
  const app = makeCommandApp();
  app.input = "/sta";
  app.cursor = 4;

  await app.handleInputKey({ name: "enter", text: "" });
  assert.equal(app.controller.executedCommand, "/status");
});

test("slash command output opens a scrollable result panel", async () => {
  const app = makeCommandApp();
  app.controller.executeSlashCommand = async () => ({ handled: true, title: "Status", output: "model: test\npermissions: workspace" });
  app.input = "/status"; app.cursor = app.input.length;
  await app.handleInputKey({ name: "enter", text: "" });
  assert.equal(app.commandOutput.title, "Status");
  await app.handleKey({ name: "escape", text: "" });
  assert.equal(app.commandOutput, null);
});

test("model picker uses arrow keys to choose a model and reasoning effort", async () => {
  const app = makeCommandApp();
  const models = [
    { id: "model-1", model: "model-1", displayName: "Model One", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }] },
    { id: "model-2", model: "model-2", displayName: "Model Two", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] },
  ];
  const calls = [];
  app.controller.executeSlashCommand = async (input) => {
    calls.push(input);
    if (input === "/model") return { handled: true, title: "Models", output: "model list", picker: { kind: "model", models, currentModel: "model-1", currentEffort: "medium" } };
    return { handled: true, message: "Model updated", output: "updated" };
  };
  app.input = "/model"; app.cursor = app.input.length;

  await app.handleInputKey({ name: "enter", text: "" });
  assert.equal(app.commandPicker.modelSelection, 0);
  assert.equal(app.commandOutput, null);

  await app.handleKey({ name: "down", text: "" });
  assert.equal(app.commandPicker.modelSelection, 1);
  await app.handleKey({ name: "enter", text: "" });
  assert.equal(app.commandPicker.step, "effort");
  assert.equal(app.commandPicker.effortSelection, 0);

  await app.handleKey({ name: "down", text: "" });
  await app.handleKey({ name: "enter", text: "" });
  assert.deepEqual(calls, ["/model", "/model model-2 high"]);
  assert.equal(app.commandPicker, null);
  assert.equal(app.controller.status, "Model updated");
});

test("escape returns from effort selection before closing the model picker", async () => {
  const app = makeCommandApp();
  app.openCommandPicker({
    kind: "model",
    models: [{ id: "model-1", model: "model-1", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }],
  }, "Models");

  await app.handleKey({ name: "enter", text: "" });
  assert.equal(app.commandPicker.step, "effort");
  await app.handleKey({ name: "escape", text: "" });
  assert.equal(app.commandPicker.step, "model");
  await app.handleKey({ name: "escape", text: "" });
  assert.equal(app.commandPicker, null);
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
