import test from "node:test";
import assert from "node:assert/strict";
import { nativeSelectionSources, resolveNativeSelection } from "../src/native/selection.mjs";

function scope(id, text, { parentId = null, inheritedTurnIds = [], status = "complete" } = {}) {
  return {
    id, parentId, inheritedTurnIds, threadId: `session-${id}`,
    turns: [{ id: `turn-${id}`, providerTurnId: `provider-${id}`, assistant: { text, status } }],
  };
}

test("native rendered and literal selections map Markdown, wrapping, CJK and emoji to raw offsets", () => {
  const text = "# **Context**\n\nA **bold 中文 🌱 passage** with `literal()` and $x_i^2$.\n\n```js\nconst answer = 42;\n```";
  const root = scope("root", text);
  for (const [visible, raw] of [
    ["bold 中文\r\n   🌱 passage", "bold 中文 🌱 passage"],
    ["A bold 中文 🌱 passage with literal()", "A **bold 中文 🌱 passage** with `literal()"],
    ["xᵢ²", "x_i^2"],
    ["x_i^2", "x_i^2"],
    ["const answer = 42;", "const answer = 42;"],
    ["Context", "Context"],
  ]) {
    const result = resolveNativeSelection([root], root.id, visible);
    assert.equal(result.quote, raw);
    assert.equal(result.start, text.indexOf(raw));
    assert.equal(result.end, text.indexOf(raw) + raw.length);
    assert.equal(result.sourceThreadId, root.threadId);
    assert.equal(result.providerTurnId, root.turns[0].providerTurnId);
  }
});

test("native mapping never anchors only part of a grapheme", () => {
  const root = scope("root", "A family 👨‍👩‍👧‍👦 and e\u0301.");
  assert.equal(resolveNativeSelection([root], root.id, "👨‍👩‍👧‍👦").quote, "👨‍👩‍👧‍👦");
  assert.equal(resolveNativeSelection([root], root.id, "e\u0301").quote, "e\u0301");
  for (const selected of ["👨", "\u0301"]) {
    assert.throws(() => resolveNativeSelection([root], root.id, selected), /could not be mapped/u);
  }
});

test("native row context distinguishes a completed answer from an echoed input or tool line", () => {
  const root = scope("root", "A **unique native passage** with more context.");
  const selected = "unique native passage";
  assert.equal(resolveNativeSelection([root], root.id, selected, { context: "• A unique native passage with more context." }).quote, selected);
  assert.equal(resolveNativeSelection([root], root.id, selected, { context: "  A unique native\n  passage with more context." }).quote, selected);
  for (const context of ["› unique native passage", "You: unique native passage", "tool output: unique native passage", "unrelated line", ""]) {
    assert.throws(() => resolveNativeSelection([root], root.id, selected, { context }), /could not be mapped/u);
  }
});

test("duplicate passages and duplicate completed turns are ambiguous, never latest-wins", () => {
  const root = scope("root", "Repeated passage. More detail. Repeated passage.");
  assert.throws(() => resolveNativeSelection([root], root.id, "Repeated passage"), /more than one/u);
  root.turns[0].assistant.text = "A repeated answer.";
  root.turns.push({ ...root.turns[0], id: "another-turn", providerTurnId: "another-provider-turn" });
  assert.throws(() => resolveNativeSelection([root], root.id, "A repeated answer"), /more than one/u);
});

test("native selection is restricted to the displayed session, not the viewed or latest scope", () => {
  const first = scope("first", "The original source.");
  const other = scope("other", "The original source. Unrelated latest answer.");
  assert.equal(resolveNativeSelection([first, other], first.id, "original source").scopeId, first.id);
  assert.throws(() => resolveNativeSelection([first, other], first.id, "Unrelated latest answer"), /could not be mapped/u);
  assert.throws(() => resolveNativeSelection([first, other], "missing", "source"), /no longer/u);
});

test("inherited turns resolve to their actual owner and exclude later parent history", () => {
  const root = scope("root", "An inherited source.");
  root.turns.push({ id: "later", providerTurnId: "later-provider", assistant: { text: "Later parent answer.", status: "complete" } });
  const child = scope("child", "The child's own answer.", { parentId: root.id, inheritedTurnIds: ["provider-root"] });
  assert.equal(nativeSelectionSources([root, child], child.id).length, 2);
  const inherited = resolveNativeSelection([root, child], child.id, "inherited source");
  assert.equal(inherited.scopeId, root.id);
  assert.equal(inherited.sourceThreadId, root.threadId);
  assert.equal(resolveNativeSelection([root, child], child.id, "child's own answer").scopeId, child.id);
  assert.throws(() => resolveNativeSelection([root, child], child.id, "Later parent answer"), /could not be mapped/u);
  child.turns[0].assistant.text = "An inherited source.";
  assert.throws(() => resolveNativeSelection([root, child], child.id, "inherited source"), /more than one/u);
});

test("incomplete, unknown, empty and oversized native selections do not invent history", () => {
  for (const status of ["streaming", "failed", "interrupted"]) {
    const root = scope("root", "An unfinished answer.", { status });
    assert.throws(() => resolveNativeSelection([root], root.id, "unfinished answer"), /completed answer/u);
  }
  const root = scope("root", "A completed answer.");
  for (const text of ["", " \r\n ", null, "x".repeat(16001)]) {
    assert.throws(() => resolveNativeSelection([root], root.id, text), /16,000/u);
  }
  assert.throws(() => resolveNativeSelection([root], root.id, "Native approval dialog"), /could not be mapped/u);
  root.threadId = null;
  assert.throws(() => resolveNativeSelection([root], root.id, "completed answer"), /completed answer/u);
});
