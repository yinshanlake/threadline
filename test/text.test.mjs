import test from "node:test";
import assert from "node:assert/strict";
import { contentBlocks, displayWidth, sanitizeTerminalText, terminalDocumentText, terminalMarkup, terminalPlainText, textSegments, wrapAnnotatedText, wrapDisplayText, wrapText } from "../src/text.mjs";

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
  assert.equal(sanitizeTerminalText("safe\x9b2J"), "safe�2J");
});

test("Markdown rendering normalizes CRLF without exposing carriage returns", () => {
  assert.equal(terminalPlainText("**first**\r\nsecond"), "first\nsecond");
  assert.equal(terminalPlainText("```text\r\nfirst\r\nsecond\r\n```", "code"), "first\nsecond\n");
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

test("terminal markup renders common Markdown without changing source spans", () => {
  const source = "## **Mapping** with `short_id` and [docs](https://example.com)";
  const block = contentBlocks(source)[0];
  const entries = terminalMarkup(block.text, { sourceStart: block.start, type: block.type });
  const visible = entries.map((entry) => entry.newline ? "\n" : entry.text).join("");
  assert.equal(visible, "Mapping with short_id and docs <https://example.com>");
  assert.ok(entries.every((entry) => entry.sourceStart >= 0 && entry.sourceEnd <= source.length));
  assert.ok(entries.some((entry) => entry.tone === "strong"));
  assert.ok(entries.some((entry) => entry.tone === "inlineCode"));
  assert.ok(entries.some((entry) => entry.tone === "link"));
});

test("display math renders the screenshot case and stays selectable by raw offsets", () => {
  const source = "$$\n\\text{aB3x9K} \\rightarrow \\text{https://example.com/very/long/url}\n$$";
  const block = contentBlocks(source)[0];
  assert.equal(block.type, "math");
  const lines = wrapAnnotatedText(block.text, 80, { sourceStart: block.start, type: block.type, ranges: [{ start: 0, end: source.length, selectableIndex: 4 }] });
  const parts = lines.flatMap((line) => line.parts);
  assert.equal(parts.map((part) => part.text).join(""), "aB3x9K → https://example.com/very/long/url");
  assert.ok(parts.every((part) => part.selectableIndex === 4));
  assert.ok(parts.some((part) => part.tone === "math"));
});

test("common formula notation has a readable terminal fallback", () => {
  const source = "$x_i^2 \\leq \\frac{1}{2} \\times \\sqrt{n}$";
  const entries = terminalMarkup(source);
  assert.equal(entries.map((entry) => entry.newline ? "\n" : entry.text).join(""), "xᵢ² ≤ (1)/(2) × √(n)");
});

test("currency and nested URL parentheses are not mistaken for math delimiters", () => {
  assert.equal(terminalPlainText("Cost is $5 and $10."), "Cost is $5 and $10.");
  assert.equal(terminalPlainText("[docs](https://example.com/a_(b))"), "docs <https://example.com/a_(b)>");
});

test("tables render inline markup and align columns by terminal cell width", () => {
  const source = "| Name | Value |\n|:---|---:|\n| **中文** | `x` |\n| a | longer |";
  const visible = terminalPlainText(source, "table");
  assert.equal(visible, [
    "Name │  Value",
    "─────┼───────",
    "中文 │      x",
    "a    │ longer",
  ].join("\n"));
  assert.doesNotMatch(visible, /\*\*|`/u);
  const rows = visible.split("\n").filter((_, index) => index !== 1);
  assert.ok(rows.every((row) => displayWidth(row) === displayWidth(rows[0])));
});

test("table parsing keeps escaped pipes and pipes inside code spans in their cells", () => {
  const source = "| A | B |\n|---|---|\n| a\\|b | `x|y` |";
  const visible = terminalPlainText(source, "table");
  assert.match(visible, /a\|b/u);
  assert.match(visible, /x\|y/u);
  assert.equal(visible.split("\n").at(-1).match(/ │ /gu)?.length, 1);
});

test("headings and quotes do not style following plain lines", () => {
  assert.deepEqual(contentBlocks("# Heading\nplain").map((block) => block.type), ["heading", "paragraph"]);
  assert.equal(terminalDocumentText("# Heading\nplain"), "Heading\n\nplain");
  assert.deepEqual(contentBlocks("> quoted\nplain").map((block) => block.type), ["quote", "paragraph"]);
  assert.equal(terminalDocumentText("> quoted\nplain"), "quoted\n\nplain");
  assert.deepEqual(contentBlocks("plain\n> quoted").map((block) => block.type), ["paragraph", "quote"]);
});

test("backslash-delimited inline math is parsed before Markdown escapes", () => {
  assert.equal(terminalPlainText("Inline \\(x_i \\rightarrow y\\) done."), "Inline xᵢ → y done.");
  assert.equal(terminalPlainText("Inline \\[x_i \\rightarrow y\\] done."), "Inline xᵢ → y done.");
  assert.equal(terminalPlainText("Literal \\(parentheses\\) stay literal."), "Literal parentheses stay literal.");
});

test("fenced code closes only with the matching marker and sufficient length", () => {
  const nested = "````markdown\n```js\nconst value = 1;\n```\n````";
  const [block] = contentBlocks(nested);
  assert.equal(block.type, "code");
  assert.equal(contentBlocks(nested).length, 1);
  assert.equal(terminalPlainText(block.text, block.type), "```js\nconst value = 1;\n```\n");

  const mismatched = "```text\n~~~\nstill code\n```";
  assert.equal(contentBlocks(mismatched).length, 1);
  assert.equal(terminalPlainText(mismatched, "code"), "~~~\nstill code\n");
});

test("shell variables are not mistaken for inline math", () => {
  assert.equal(terminalPlainText("Use $HOME and $PATH."), "Use $HOME and $PATH.");
  assert.equal(terminalPlainText("Use ${HOME} and ${PATH}."), "Use ${HOME} and ${PATH}.");
  assert.equal(terminalPlainText("Compare $foo/$bar."), "Compare $foo/$bar.");
  assert.equal(terminalPlainText("Math $x + y$ remains readable."), "Math x + y remains readable.");
});

test("document rendering handles mixed Markdown blocks for line mode", () => {
  const source = "**mapping**\n\n$$\n\\text{a} \\rightarrow \\text{b}\n$$";
  assert.equal(terminalDocumentText(source), "mapping\n\na → b");
});

test("Markdown delimiter boundaries preserve list bullets and identifier underscores", () => {
  assert.equal(terminalPlainText("* first\n* second", "list"), "* first\n* second");
  assert.equal(terminalPlainText("foo__bar__baz"), "foo__bar__baz");
  assert.equal(terminalPlainText("_emphasis_ and __strong__"), "emphasis and strong");
});

test("triple emphasis and optional heading closers do not leak delimiters", () => {
  assert.equal(terminalPlainText("***important***"), "important");
  assert.equal(terminalPlainText("### Heading ###", "heading"), "Heading");
});
