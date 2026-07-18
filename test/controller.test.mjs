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
