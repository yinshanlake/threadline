import test from "node:test";
import assert from "node:assert/strict";
import { addBranch, branchCapacity, branchesAt, createDemoConversation, duplicateBranchAt, findScope, makeAnchor, rootScope, segmentsForTurn } from "../src/model.mjs";

test("anchors refer to source text, not terminal rows", () => {
  const conversation = createDemoConversation();
  const root = rootScope(conversation);
  const turn = root.turns[0];
  const segment = segmentsForTurn(turn)[0];
  const anchor = makeAnchor(turn, segment);
  assert.equal(turn.assistant.text.slice(anchor.sourceStart, anchor.sourceEnd), anchor.exactQuote);
});

test("multiple branches may share one anchor", () => {
  const conversation = createDemoConversation();
  const root = rootScope(conversation);
  const turn = root.turns[0];
  const segment = segmentsForTurn(turn)[0];
  const anchor = makeAnchor(turn, segment);
  addBranch(conversation, root.id, anchor, "second-provider-thread");
  addBranch(conversation, root.id, anchor, "third-provider-thread");
  assert.equal(branchesAt(conversation, root.id, anchor.messageId, anchor.sourceStart, anchor.sourceEnd).length, 2);
  assert.ok(findScope(conversation, conversation.rootScopeId));
});

test("branch capacity bounds total threads, nesting, and one anchor", () => {
  const conversation = createDemoConversation();
  conversation.scopes.splice(1);
  const root = rootScope(conversation);
  const turn = root.turns[0];
  const anchor = makeAnchor(turn, segmentsForTurn(turn)[0]);
  const limits = { maxTotal: 2, maxDepth: 1, maxPerAnchor: 1, warningAt: 1 };

  assert.equal(branchCapacity(conversation, root.id, anchor, limits).allowed, true);
  const child = addBranch(conversation, root.id, anchor, "limited-child");
  assert.equal(branchCapacity(conversation, root.id, anchor, limits).code, "thread-anchor-limit");
  assert.equal(branchCapacity(conversation, child.id, anchor, limits).code, "thread-depth-limit");
  addBranch(conversation, root.id, { ...anchor, sourceStart: anchor.sourceStart + 1 }, "other-child");
  assert.equal(branchCapacity(conversation, root.id, { ...anchor, sourceStart: anchor.sourceStart + 2 }, limits).code, "thread-total-limit");
});

test("duplicate follow-ups are matched with normalized whitespace and case", () => {
  const conversation = createDemoConversation();
  const root = rootScope(conversation);
  const child = conversation.scopes[1];
  assert.equal(duplicateBranchAt(conversation, root.id, child.anchor, `  ${child.turns[0].user.text.toUpperCase()}  `)?.id, child.id);
});
