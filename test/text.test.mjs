import test from "node:test";
import assert from "node:assert/strict";
import { contentBlocks, displayWidth, sanitizeTerminalText, textSegments, wrapAnnotatedText, wrapDisplayText, wrapText } from "../src/text.mjs";

test("displayWidth handles Latin, CJK, and emoji", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("缓存"), 4);
  assert.equal(displayWidth("🙂"), 2);
});

test("wrapText respects terminal cell width", () => {
  assert.deepEqual(wrapText("缓存abc", 5), ["缓存a", "bc"]);
});

test("tabs expand at stable stops instead of behaving as zero-width text", () => {
  assert.equal(displayWidth("a\tb"), 9);
  assert.deepEqual(wrapText("a\tb", 8), ["a       ", "b"]);
});

test("display wrapping prefers word and CJK boundaries", () => {
  assert.deepEqual(wrapDisplayText("inspect transcript layout", 18), ["inspect ", "transcript layout"]);
  assert.deepEqual(wrapDisplayText("中文和 terminal words", 12), ["中文和 ", "terminal ", "words"]);
});

test("textSegments produces source-stable sentence offsets", () => {
  const source = "第一句。第二句！\n\nThird sentence.";
  const segments = textSegments(source);
  assert.deepEqual(segments.map((item) => item.text), ["第一句。", "第二句！", "Third sentence."]);
  for (const segment of segments) assert.equal(source.slice(segment.start, segment.end), segment.text);
});

test("terminal control sequences are made inert", () => {
  assert.equal(sanitizeTerminalText("safe\x1b[2J\x07"), "safe␛[2J␇");
});

test("fenced code is one selectable source block", () => {
  const source = "Before.\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\nAfter.";
  const segments = textSegments(source);
  assert.equal(segments.length, 3);
  assert.equal(segments[1].text, "```js\nconst a = 1;\nconst b = 2;\n```");
  assert.equal(source.slice(segments[1].start, segments[1].end), segments[1].text);
});

test("markdown lists and tables remain intact blocks", () => {
  const source = "- first item\n- second item\n\n| a | b |\n|---|---|\n| 1 | 2 |";
  assert.deepEqual(contentBlocks(source).map((block) => block.type), ["list", "table"]);
  assert.equal(contentBlocks(source).map((block) => block.text).join("\n\n"), source);
});

test("annotated wrapping preserves text while marking only source ranges", () => {
  const lines = wrapAnnotatedText("First sentence. Second sentence.", 18, { sourceStart: 10, ranges: [{ start: 26, end: 42, selectableIndex: 3 }] });
  assert.equal(lines.flatMap((line) => line.parts).map((part) => part.text).join(""), "First sentence. Second sentence.");
  assert.ok(lines.flatMap((line) => line.parts).some((part) => part.selectableIndex === 3));
});

test("terminal sanitization does not move source annotations", () => {
  const lines = wrapAnnotatedText("a\x1bb", 20, { ranges: [{ start: 2, end: 3, selectableIndex: 5 }] });
  const parts = lines.flatMap((line) => line.parts);
  assert.equal(parts.map((part) => part.text).join(""), "a␛b");
  assert.equal(parts.find((part) => part.selectableIndex === 5)?.text, "b");
});

test("tab expansion keeps annotations tied to raw source offsets", () => {
  const lines = wrapAnnotatedText("a\tb", 20, { ranges: [{ start: 2, end: 3, selectableIndex: 7 }] });
  const parts = lines.flatMap((line) => line.parts);
  assert.equal(parts.map((part) => part.text).join(""), "a       b");
  assert.equal(parts.find((part) => part.selectableIndex === 7)?.text, "b");
});
