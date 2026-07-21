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
