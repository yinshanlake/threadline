import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Controller } from "../src/controller.mjs";
import { addBranch, addTurn, createConversation, makeAnchor, rootScope, segmentsForTurn } from "../src/model.mjs";

class FakeProvider extends EventEmitter {
  async connect() { return { platformFamily: "test" }; }
  async startThread() { return { threadId: "provider-root" }; }
  async resumeThread(threadId) { return { threadId }; }
  async send() { return { turnId: "provider-turn" }; }
  async forkThread() { this.forkCalls = (this.forkCalls ?? 0) + 1; return { threadId: `provider-fork-${this.forkCalls}` }; }
  resolveServerRequest(request, accepted) { this.lastDecision = { request, accepted }; }
  resolveUserInput(request, answers) { this.lastInput = { request, answers }; }
  rejectServerRequest(request) { this.rejected = request; }
  async interrupt() {}
  async close() {}
}

test("slash commands are dispatched locally instead of becoming model prompts", async () => {
  const provider = new FakeProvider();
  provider.request = async (method) => method === "model/list" ? { data: [{ id: "test-model", model: "test-model", displayName: "Test", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "medium" }], defaultReasoningEffort: "medium" }] } : {};
  provider.updateThreadSettings = async (threadId, settings) => { provider.settingsCall = { threadId, settings }; };
  const conversation = createConversation();
  const controller = new Controller({ conversation, provider });

  const result = await controller.executeSlashCommand("/model test-model medium");

  assert.equal(result.handled, true);
  assert.deepEqual(provider.settingsCall, { threadId: "provider-root", settings: { model: "test-model", effort: "medium" } });
  assert.equal(rootScope(conversation).turns.length, 0);
});

test("model listing includes structured picker data for the full-screen TUI", async () => {
  const provider = new FakeProvider();
  const models = [{ id: "test-model", model: "test-model", displayName: "Test", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "medium" }], defaultReasoningEffort: "medium" }];
  provider.request = async () => ({ data: models });
  const conversation = createConversation();
  const controller = new Controller({ conversation, provider });
  await controller.ensureScope(rootScope(conversation).id);
  rootScope(conversation).providerState = { model: "test-model", effort: "medium" };

  const result = await controller.executeSlashCommand("/model");

  assert.equal(result.output.includes("test-model"), true);
  assert.deepEqual(result.picker, { kind: "model", models, currentModel: "test-model", currentEffort: "medium" });
});

test("Codex-TUI-only slash commands fail explicitly and are not sent", async () => {
  const provider = new FakeProvider();
  const controller = new Controller({ conversation: createConversation(), provider });
  const result = await controller.executeSlashCommand("/theme");
  assert.match(result.output, /original Codex TUI/);
  assert.equal(provider.sendCalls, undefined);
});

test("Claude Code rejects unsupported slash commands without calling the provider", async () => {
  const provider = new FakeProvider();
  provider.displayName = "Claude Code";
  provider.request = async () => { provider.requestCalls = (provider.requestCalls ?? 0) + 1; return {}; };
  const conversation = createConversation({ provider: "claude" });
  const controller = new Controller({ conversation, provider });

  const result = await controller.executeSlashCommand("/model");

  assert.equal(result.handled, true);
  assert.match(result.output, /not exposed by the Claude Code stream-json adapter/);
  assert.equal(provider.requestCalls, undefined);
  assert.equal(rootScope(conversation).turns.length, 0);
});

test("Claude Code rejects init instead of sending its expansion as a prompt", async () => {
  const provider = new FakeProvider();
  provider.displayName = "Claude Code";
  const conversation = createConversation({ provider: "claude" });
  const controller = new Controller({ conversation, provider });

  const result = await controller.executeSlashCommand("/init");

  assert.equal(result.handled, true);
  assert.match(result.output, /not exposed by the Claude Code stream-json adapter/);
  assert.equal(rootScope(conversation).turns.length, 0);
});

test("unknown Claude Code slash commands stay unknown instead of becoming prompts", async () => {
  const provider = new FakeProvider();
  provider.displayName = "Claude Code";
  const conversation = createConversation({ provider: "claude" });
  const controller = new Controller({ conversation, provider });

  const result = await controller.executeSlashCommand("/not-a-command");

  assert.equal(result.handled, false);
  assert.equal(rootScope(conversation).turns.length, 0);
});

test("Claude Code status uses provider-neutral session labels", async () => {
  const provider = new FakeProvider();
  provider.displayName = "Claude Code";
  const conversation = createConversation({ provider: "claude" });
  const controller = new Controller({ conversation, provider });

  const result = await controller.executeSlashCommand("/status");

  assert.match(result.output, /Claude Code session: provider-root/);
  assert.doesNotMatch(result.output, /Codex thread/);
});

test("Claude Code native slash commands are discovered and forwarded locally", async () => {
  const provider = new FakeProvider();
  provider.displayName = "Claude Code";
  provider.slashCommands = new Set(["compact", "code-review"]);
  provider.send = async (threadId, text) => {
    provider.sendCall = { threadId, text };
    return { turnId: "provider-turn" };
  };
  const conversation = createConversation({ provider: "claude" });
  const scope = rootScope(conversation);
  scope.providerState.slashCommands = ["compact", "code-review"];
  const controller = new Controller({ conversation, provider });

  assert.deepEqual(
    controller.slashCommands().filter((command) => ["model", "compact", "code-review"].includes(command.name)).map((command) => command.name),
    ["compact", "code-review"],
  );
  const result = await controller.executeSlashCommand("/code-review high");

  assert.equal(result.handled, true);
  assert.deepEqual(provider.sendCall, { threadId: "provider-root", text: "/code-review high" });
  assert.equal(scope.turns.at(-1).user.text, "/code-review high");
});

test("a first-turn Claude native command is discovered before dispatch", async () => {
  const provider = new FakeProvider();
  provider.displayName = "Claude Code";
  provider.slashCommands = new Set();
  provider.discoverSlashCommands = async () => {
    provider.discoveryCalls = (provider.discoveryCalls ?? 0) + 1;
    provider.slashCommands = new Set(["context"]);
    return ["context"];
  };
  provider.send = async (threadId, text) => { provider.sendCall = { threadId, text }; return { turnId: "provider-turn" }; };
  const conversation = createConversation({ provider: "claude" });
  const controller = new Controller({ conversation, provider });

  const result = await controller.executeSlashCommand("/context");

  assert.equal(result.handled, true);
  assert.equal(provider.discoveryCalls, 1);
  assert.deepEqual(provider.sendCall, { threadId: "provider-root", text: "/context" });
  assert.deepEqual(rootScope(conversation).providerState.slashCommands, ["context"]);
});

test("Claude Code command names that overlap Codex commands use Claude dispatch", async () => {
  const provider = new FakeProvider();
  provider.displayName = "Claude Code";
  provider.slashCommands = new Set(["compact"]);
  provider.send = async (_threadId, text) => { provider.sent = text; return { turnId: "provider-turn" }; };
  const conversation = createConversation({ provider: "claude" });
  rootScope(conversation).providerState.slashCommands = ["compact"];
  const controller = new Controller({ conversation, provider });

  const result = await controller.executeSlashCommand("/compact");

  assert.equal(result.handled, true);
  assert.equal(provider.sent, "/compact");
  assert.equal(provider.compactThread, undefined);
});

test("Threadline-local commands keep precedence over Claude names", async () => {
  const provider = new FakeProvider();
  provider.displayName = "Claude Code";
  provider.slashCommands = new Set(["diff"]);
  provider.send = async (_threadId, text) => { provider.sent = text; return { turnId: "provider-turn" }; };
  const conversation = createConversation({ provider: "claude" });
  rootScope(conversation).providerState.slashCommands = ["diff"];
  const controller = new Controller({ conversation, provider });

  const result = await controller.executeSlashCommand("/diff");

  assert.equal(result.handled, true);
  assert.equal(result.title, "Git diff");
  assert.equal(provider.sent, undefined);
});

test("Claude command discovery is scoped to the active provider session", () => {
  const provider = new FakeProvider();
  provider.displayName = "Claude Code";
  provider.slashCommands = new Set(["child-only"]);
  const conversation = createConversation({ provider: "claude" });
  const root = rootScope(conversation);
  root.providerState.slashCommands = ["root-only"];
  const child = addBranch(conversation, root.id, makeAnchor(completedSource(conversation).turn, { start: 0, end: 7, text: "A focuse", blockType: "paragraph" }), "child");
  child.providerState = { slashCommands: ["child-only"] };
  const controller = new Controller({ conversation, provider });

  conversation.activeScopeId = root.id;
  assert.equal(controller.slashCommands().some((command) => command.name === "root-only"), true);
  assert.equal(controller.slashCommands().some((command) => command.name === "child-only"), false);
  conversation.activeScopeId = child.id;
  assert.equal(controller.slashCommands().some((command) => command.name === "root-only"), false);
  assert.equal(controller.slashCommands().some((command) => command.name === "child-only"), true);
});

test("turn started notification binds protocol-driven command turns", () => {
  const provider = new FakeProvider();
  const conversation = createConversation();
  const scope = rootScope(conversation);
  scope.providerThreadId = "provider-root";
  const controller = new Controller({ conversation, provider });
  const turn = controller.addCommandTurn(scope.id, "/review");
  provider.emit("turn-start", { threadId: "provider-root", turnId: "review-turn" });
  assert.equal(turn.providerTurnId, "review-turn");
});

function completedSource(conversation) {
  const scope = rootScope(conversation);
  scope.providerThreadId = "provider-root";
  const turn = addTurn(conversation, scope.id, "source question");
  turn.providerTurnId = "source-provider-turn";
  turn.assistant.text = "A focused source excerpt.";
  turn.assistant.status = "complete";
  return { scope, turn, segment: segmentsForTurn(turn)[0] };
}

test("server approvals are explicit and queued", () => {
  const provider = new FakeProvider();
  const controller = new Controller({ conversation: createConversation(), provider });
  const first = { id: 1, method: "item/commandExecution/requestApproval", params: { command: "echo ok" } };
  const second = { id: 2, method: "item/fileChange/requestApproval", params: {} };
  provider.emit("server-request", first); provider.emit("server-request", second);
  assert.equal(controller.pendingApproval.id, 1);
  controller.answerApproval(false);
  assert.deepEqual(provider.lastDecision, { request: first, accepted: false });
  assert.equal(controller.pendingApproval.id, 2);
});

test("request_user_input is not treated as an approval", () => {
  const provider = new FakeProvider();
  const controller = new Controller({ conversation: createConversation(), provider });
  const request = { id: 7, method: "item/tool/requestUserInput", params: { questions: [{ id: "region", question: "Which region?" }] } };
  provider.emit("server-request", request);
  assert.equal(controller.currentUserQuestion().id, "region");
  controller.answerUserInput("eastus");
  assert.deepEqual(provider.lastInput.answers, { region: { answers: ["eastus"] } });
});

test("a scope cannot start two concurrent turns", async () => {
  const provider = new FakeProvider();
  const conversation = createConversation();
  const controller = new Controller({ conversation, provider });
  const scope = rootScope(conversation);
  await controller.send(scope.id, "first");
  await assert.rejects(controller.send(scope.id, "second"), /Wait for the current operation/);
});

test("interrupt stops the active turn and releases the scope even without a completion event", async () => {
  const provider = new FakeProvider();
  provider.interrupt = async (threadId, turnId) => { provider.interruptCall = { threadId, turnId }; };
  const conversation = createConversation();
  const controller = new Controller({ conversation, provider });
  const scope = rootScope(conversation);
  const turn = await controller.send(scope.id, "a stalled question");

  const interrupted = await controller.interrupt();

  assert.equal(interrupted, true);
  assert.deepEqual(provider.interruptCall, { threadId: "provider-root", turnId: "provider-turn" });
  assert.equal(turn.assistant.status, "interrupted");
  assert.equal(controller.busyScopes.has(scope.id), false);
  assert.equal(controller.status, "Turn interrupted");
});

test("user message lifecycle items are not shown as tool activities", async () => {
  const provider = new FakeProvider();
  const conversation = createConversation();
  const controller = new Controller({ conversation, provider });
  const scope = rootScope(conversation);
  const turn = await controller.send(scope.id, "hello");
  provider.emit("item-start", { threadId: scope.providerThreadId, turnId: turn.providerTurnId, item: { id: "user-item", type: "userMessage" } });
  assert.equal(turn.assistant.activities.length, 0);
});

test("provider protocol errors are visible instead of silently becoming transcript text", () => {
  const provider = new FakeProvider();
  const controller = new Controller({ conversation: createConversation(), provider });
  provider.emit("protocol-error", { message: "Malformed provider JSON after 42 bytes" });
  assert.equal(controller.status, "Malformed provider JSON after 42 bytes");
});

test("thread limits are enforced before the provider is forked", async () => {
  const provider = new FakeProvider();
  const conversation = createConversation();
  const { scope, turn, segment } = completedSource(conversation);
  addBranch(conversation, scope.id, { ...makeAnchor(turn, segment), sourceStart: 1 }, "existing-provider-thread");
  const controller = new Controller({
    conversation,
    provider,
    threadLimits: { maxTotal: 1, maxDepth: 4, maxPerAnchor: 3 },
  });

  await assert.rejects(controller.dive(scope.id, turn.id, segment, "new question"), (error) => error.code === "thread-total-limit");
  assert.equal(provider.forkCalls ?? 0, 0);
});

test("depth and per-excerpt limits are enforced before the provider is forked", async () => {
  const provider = new FakeProvider();
  const conversation = createConversation();
  const { scope, turn, segment } = completedSource(conversation);
  const anchor = makeAnchor(turn, segment);
  const existing = addBranch(conversation, scope.id, anchor, "existing-provider-thread");
  const nestedTurn = addTurn(conversation, existing.id, "nested source");
  nestedTurn.providerTurnId = "nested-provider-turn";
  nestedTurn.assistant.text = "Nested answer.";
  nestedTurn.assistant.status = "complete";
  const nestedSegment = segmentsForTurn(nestedTurn)[0];
  const controller = new Controller({ conversation, provider, threadLimits: { maxTotal: 8, maxDepth: 1, maxPerAnchor: 1 } });

  await assert.rejects(controller.dive(scope.id, turn.id, segment, "another angle"), (error) => error.code === "thread-anchor-limit");
  await assert.rejects(controller.dive(existing.id, nestedTurn.id, nestedSegment, "go deeper"), (error) => error.code === "thread-depth-limit");
  assert.equal(provider.forkCalls ?? 0, 0);
});

test("an identical follow-up does not create another provider thread", async () => {
  const provider = new FakeProvider();
  const conversation = createConversation();
  const { scope, turn, segment } = completedSource(conversation);
  const child = addBranch(conversation, scope.id, makeAnchor(turn, segment), "existing-provider-thread");
  addTurn(conversation, child.id, "Why exactly?");
  const controller = new Controller({ conversation, provider });

  await assert.rejects(controller.dive(scope.id, turn.id, segment, "  why   exactly?  "), (error) => error.code === "duplicate-thread" && error.scopeId === child.id);
  assert.equal(provider.forkCalls ?? 0, 0);
});

test("a nested thread forks from the selected child answer context", async () => {
  const provider = new FakeProvider();
  provider.forkThread = async (threadId, turnId) => {
    provider.forkArguments = { threadId, turnId };
    return { threadId: "nested-provider-thread" };
  };
  const conversation = createConversation();
  const root = rootScope(conversation);
  root.providerThreadId = "provider-root";
  const rootTurn = addTurn(conversation, root.id, "root question");
  rootTurn.providerTurnId = "root-provider-turn";
  rootTurn.assistant.text = "Root answer.";
  rootTurn.assistant.status = "complete";
  const child = addBranch(conversation, root.id, makeAnchor(rootTurn, segmentsForTurn(rootTurn)[0]), "provider-child");
  const childTurn = addTurn(conversation, child.id, "child question");
  childTurn.providerTurnId = "child-provider-turn";
  childTurn.assistant.text = "Child answer with another idea.";
  childTurn.assistant.status = "complete";
  const controller = new Controller({ conversation, provider });

  const nested = await controller.dive(child.id, childTurn.id, segmentsForTurn(childTurn)[0], "go deeper");

  assert.deepEqual(provider.forkArguments, { threadId: "provider-child", turnId: "child-provider-turn" });
  assert.equal(nested.parentId, child.id);
});

test("tail-only providers reject old answers before creating a provider fork", async () => {
  const provider = new FakeProvider();
  provider.forkMode = "tail-only";
  provider.displayName = "Tail Provider";
  const conversation = createConversation({ provider: "claude" });
  const scope = rootScope(conversation);
  scope.providerThreadId = "provider-root";
  const oldTurn = addTurn(conversation, scope.id, "old question");
  oldTurn.providerTurnId = "old-turn";
  oldTurn.assistant.text = "Old answer.";
  oldTurn.assistant.status = "complete";
  const latestTurn = addTurn(conversation, scope.id, "latest question");
  latestTurn.providerTurnId = "latest-turn";
  latestTurn.assistant.text = "Latest answer.";
  latestTurn.assistant.status = "complete";
  const controller = new Controller({ conversation, provider });
  const segment = segmentsForTurn(oldTurn)[0];

  assert.deepEqual(controller.threadCapacity(scope.id, oldTurn.id, segment), {
    allowed: false,
    code: "provider-tail-fork-only",
    message: "Tail Provider can create a deep dive only from the latest completed answer in this scope.",
  });
  await assert.rejects(
    controller.dive(scope.id, oldTurn.id, segment, "follow up"),
    (error) => error.code === "provider-tail-fork-only",
  );
  assert.equal(provider.forkCalls ?? 0, 0);
});

test("tail-only providers reject a completed answer when a newer turn is unfinished", () => {
  const provider = new FakeProvider();
  provider.forkMode = "tail-only";
  provider.displayName = "Tail Provider";
  const conversation = createConversation({ provider: "claude" });
  const scope = rootScope(conversation);
  const complete = addTurn(conversation, scope.id, "complete question");
  complete.providerTurnId = "complete-turn";
  complete.assistant.text = "Complete answer.";
  complete.assistant.status = "complete";
  addTurn(conversation, scope.id, "still running");
  const controller = new Controller({ conversation, provider });

  assert.equal(
    controller.threadCapacity(scope.id, complete.id, segmentsForTurn(complete)[0]).code,
    "provider-tail-fork-only",
  );
});
