import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { chromium } from "playwright";
import { nativeDemo } from "../src/native/demo.mjs";
import { importNativeThread, NativeWorkspace } from "../src/native/workspace.mjs";
import { startNativeServer } from "../src/native/server.mjs";

async function selectText(locator, excerpt) {
  await locator.evaluate((element, quote) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    let total = 0;
    while ((node = walker.nextNode())) { nodes.push({ node, start: total, end: total + node.length }); total += node.length; }
    const start = element.textContent.indexOf(quote);
    if (start < 0) throw new Error("Selection text was not rendered.");
    const end = start + quote.length;
    const first = nodes.find((entry) => entry.end > start);
    const last = nodes.find((entry) => entry.end >= end);
    const range = document.createRange();
    range.setStart(first.node, start - first.start); range.setEnd(last.node, end - last.start);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, excerpt);
}

function part(page, scopeId, excerpt) {
  return page.locator(`.answer-text[data-scope="${scopeId}"]`).filter({ hasText: excerpt }).first();
}

function branch(page, scopeId) { return page.locator(`details.branch[data-scope="${scopeId}"]`); }
async function waitAction(page) { await page.waitForFunction(() => !document.querySelector("#refresh").disabled); }

async function fixture() {
  const demo = nativeDemo();
  const workspace = new NativeWorkspace({ ...demo, demo: true });
  const app = await startNativeServer({ workspace });
  await workspace.initialize();
  const browser = await chromium.launch({ headless: true });
  return { demo, workspace, app, browser };
}

const enabled = { skip: !process.env.THREADLINE_BROWSER_TESTS, timeout: 60000 };

test("inline browser preserves parent text, forks historical selections, nests, returns, and reconnects", enabled, async () => {
  const { workspace, app, browser } = await fixture();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(app.url);
    await page.waitForFunction(() => document.querySelector("#connection").textContent === "Connected");
    const rootId = workspace.scope().id;
    const parentTerminal = workspace.terminalFor(rootId);
    const original = await page.locator(`.answer-text[data-scope="${rootId}"]`).allTextContents();
    assert.equal(await page.locator("#terminal-pane").isVisible(), true);
    assert.equal(await page.locator("#history-menu").getAttribute("open"), null);

    await selectText(part(page, rootId, "中文、emoji 🌱"), "中文、emoji 🌱");
    assert.equal(await page.locator("#selected-quote").innerText(), "中文、emoji 🌱");
    assert.equal(await page.locator("#question").evaluate((element) => element === document.activeElement), true);
    assert.equal(await page.locator("#follow-up").evaluate((element) => element.parentElement.className), "answer-part");
    await page.locator("#question").fill("Explain why the anchor survives resizing.");
    await page.locator("#question").press("Control+Enter");
    await page.waitForFunction(() => document.querySelectorAll(".tree-node").length === 2);
    await waitAction(page);
    const childId = workspace.scope().id;
    await part(page, childId, "separate conversation").waitFor();
    assert.equal(workspace.scope().anchor.exactQuote, "中文、emoji 🌱");
    assert.equal(workspace.scope().turns.length, 1);
    assert.equal(workspace.terminalFor(rootId), parentTerminal);
    assert.deepEqual(await page.locator(`.answer-text[data-scope="${rootId}"]`).allTextContents(), original);
    assert.equal(await branch(page, childId).getAttribute("open"), "");

    await selectText(part(page, childId, "separate conversation"), "separate conversation");
    await page.locator("#question").fill("Explain the nested context.");
    await page.locator("#ask").click();
    await page.waitForFunction(() => document.querySelectorAll(".tree-node").length === 3);
    await waitAction(page);
    const nestedId = workspace.scope().id;
    await part(page, nestedId, "nested context").waitFor();
    assert.equal(workspace.scope().parentId, childId);
    assert.equal(await branch(page, childId).locator(`details.branch[data-scope="${nestedId}"]`).count(), 1);
    assert.equal(await part(page, rootId, "中文、emoji").count(), 1);

    await page.locator("#back").click(); await waitAction(page);
    assert.equal(workspace.scope().id, childId);
    assert.equal(await branch(page, nestedId).getAttribute("open"), null);
    assert.equal(await page.locator(".source-return").getAttribute("data-scope"), childId);
    await page.locator("#back").click(); await waitAction(page);
    assert.equal(workspace.scope().id, rootId);
    assert.equal(await branch(page, childId).getAttribute("open"), null);
    assert.equal(await page.locator(".source-return").getAttribute("data-scope"), rootId);

    await branch(page, childId).locator(":scope > summary").click(); await waitAction(page);
    assert.equal(await part(page, childId, "separate conversation").isVisible(), true);
    assert.equal(workspace.scope().id, rootId); // Reading a branch does not activate its terminal.
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#connection").textContent === "Connected");
    assert.equal(await branch(page, childId).getAttribute("open"), "");
    assert.equal(await branch(page, nestedId).getAttribute("open"), null);
    assert.equal(workspace.terminalFor(rootId), parentTerminal);

    // A historical selection in the child must fork the child even while the root is active.
    await selectText(part(page, childId, "separate conversation"), "separate conversation");
    await page.locator("#question").fill("A second angle on the historical child answer.");
    await page.locator("#ask").click();
    await page.waitForFunction(() => document.querySelectorAll(".tree-node").length === 4);
    await waitAction(page);
    const otherNestedId = workspace.scope().id;
    assert.equal(workspace.scope().parentId, childId);
    await part(page, otherNestedId, "second angle").waitFor();

    await page.locator("#back").click(); await waitAction(page);
    await page.locator("#back").click(); await waitAction(page);
    await page.locator("#continue-conversation").click();
    const terminal = parentTerminal.terminal;
    let incoming = "";
    const write = terminal.write.bind(terminal);
    terminal.write = (data) => { incoming += data; write(data); };
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("/brand-new-native-command");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".xterm-screen").textContent.includes("Received literally: /brand-new-native-command"));
    assert.ok(incoming.includes("/brand-new-native-command"));
    assert.equal(workspace.conversation.scopes.length, 4);

    await page.setViewportSize({ width: 980, height: 720 });
    await page.locator("#toggle-panel").click();
    assert.equal(await page.locator("#sidebar").isVisible(), false);
    await page.locator("#toggle-panel").click();
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("Control+Shift+B");
    assert.equal(await page.locator("#sidebar").isVisible(), false);
    await page.keyboard.press("Control+Shift+B");
    await page.setViewportSize({ width: 520, height: 720 });
    assert.equal(await page.locator("#sidebar").isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

    const exit = once(terminal, "exit"); terminal.write("/quit\r"); await exit;
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await app.close(); await workspace.close(); }
});

test("formatted selections keep raw anchors, drafts survive refresh, and new conversations retain history", enabled, async () => {
  const { demo, workspace, app, browser } = await fixture();
  try {
    const root = workspace.scope();
    const thread = await demo.sessions.read(root.providerThreadId);
    const turn = thread.turns[0];
    const formatted = "# **Context**\n\nEarlier paragraph remains available.\n\nA **bold 中文 🌱 passage** with `literal()` and $x_i^2$.\n\n<script>window.__injected = true</script>";
    turn.items.find((item) => item.type === "agentMessage").text = formatted;
    const read = demo.sessions.read.bind(demo.sessions);
    demo.sessions.read = async (id) => {
      const result = await read(id);
      if (id === root.providerThreadId) result.turns[0].items.find((item) => item.type === "agentMessage").text = formatted;
      return result;
    };
    importNativeThread(root, thread); workspace.changed();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: "light" });
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(app.url);
    await part(page, root.id, "bold 中文").waitFor();
    assert.match(await part(page, root.id, "bold 中文").innerText(), /xᵢ²/u);
    assert.doesNotMatch(await part(page, root.id, "bold 中文").innerText(), /\*\*/u);
    assert.equal(await page.evaluate(() => window.__injected), undefined);
    await selectText(part(page, root.id, "bold 中文"), "bold 中文 🌱 passage");
    assert.equal(await page.locator("#selected-quote").innerText(), "bold 中文 🌱 passage");
    await page.locator("#question").fill("保留我的追问草稿。");
    // Simulate another completed root turn arriving while the selection form is open.
    demo.sessions.record(root.providerThreadId, { question: "A later question", answer: "A later answer." });
    const updated = await demo.sessions.read(root.providerThreadId);
    importNativeThread(root, updated); workspace.changed();
    await page.waitForTimeout(1500);
    assert.equal(await page.locator("#question").inputValue(), "保留我的追问草稿。");
    assert.equal(await page.locator("#follow-up").isVisible(), true);
    assert.equal(await page.locator("#question").evaluate((element) => element === document.activeElement), true);
    await page.locator("#cancel-selection").click();
    await part(page, root.id, "later answer").waitFor();

    await selectText(part(page, root.id, "bold 中文"), "xᵢ²");
    assert.equal(await page.locator("#selected-quote").innerText(), "x_i^2");
    await page.locator("#question").fill("Explain this formula.");
    await page.locator("#ask").click();
    await waitAction(page);
    const child = workspace.scope();
    assert.equal(child.parentId, root.id);
    assert.equal(child.anchor.exactQuote, "x_i^2");
    await part(page, child.id, "formula").waitFor();

    const earlierQuestions = await page.locator(".answer-question").allTextContents();
    await page.locator("#new-conversation").click(); await waitAction(page);
    const fresh = workspace.scope();
    assert.equal(fresh.parentId, null);
    assert.equal(await page.locator("details.conversation-root").count(), 2);
    assert.equal(await part(page, root.id, "Earlier paragraph").isVisible(), true);
    assert.equal(await branch(page, child.id).count(), 1);
    assert.equal(await page.locator("#prompt").evaluate((element) => element === document.activeElement), true);
    assert.equal(await page.locator("#runtime-mode").innerText(), "Offline demo");
    await page.locator("#prompt").fill("Start a fresh conversation");
    await page.locator("#send").click();
    await part(page, fresh.id, "fresh conversation").waitFor();
    assert.equal(fresh.turns.length, 1);
    assert.equal((await demo.sessions.read(fresh.providerThreadId)).turns.length, 1);
    await page.locator("#prompt").fill("Continue this conversation with another question");
    await page.locator("#prompt").press("Control+Enter");
    await part(page, fresh.id, "another question").waitFor();
    assert.equal(fresh.turns.length, 2);
    assert.equal(await page.locator("#prompt").inputValue(), "");
    for (const question of earlierQuestions) assert.ok((await page.locator(".answer-question").allTextContents()).includes(question));
    await page.locator("#prompt").fill("/new"); await page.locator("#send").click(); await waitAction(page);
    assert.equal(await page.locator("#prompt").inputValue(), "/new");
    assert.match(await page.locator("#message").innerText(), /native terminal/u);
    assert.equal(fresh.turns.length, 2);
    await page.locator("#prompt").fill("保留未发送的草稿。");
    await page.reload(); await part(page, fresh.id, "fresh conversation").waitFor();
    assert.equal(await page.locator("details.conversation-root").count(), 2);
    assert.equal(await page.locator("#prompt").inputValue(), "保留未发送的草稿。");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await app.close(); await workspace.close(); }
});

test("deep dives restore the original reading position and terminal visibility across reload", enabled, async () => {
  const { demo, workspace, app, browser } = await fixture();
  try {
    const root = workspace.scope();
    const longText = Array.from({ length: 22 }, (_, index) =>
      `Paragraph ${index}: this is the surrounding main conversation. It stays available while exploring details.`).join("\n\n");
    const read = demo.sessions.read.bind(demo.sessions);
    demo.sessions.read = async (id) => {
      const thread = await read(id);
      if (id === root.providerThreadId) thread.turns[0].items.find((item) => item.type === "agentMessage").text = longText;
      return thread;
    };
    await workspace.sync(root.id);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
    await page.goto(app.url);
    await page.locator("#toggle-terminal").click();
    const source = part(page, root.id, "Paragraph 9:");
    await source.waitFor();
    await source.evaluate((element) => element.scrollIntoView({ block: "center" }));
    const relativeTop = async () => source.evaluate((element) =>
      element.getBoundingClientRect().top - document.getElementById("answers").getBoundingClientRect().top);
    const before = await relativeTop();
    await selectText(source, "Paragraph 9");
    await page.locator("#question").fill("Explain paragraph nine.");
    await page.locator("#ask").click(); await waitAction(page);
    const childId = workspace.scope().id;
    await part(page, childId, "paragraph nine").waitFor();
    assert.equal(await page.locator("#terminal-pane").isVisible(), true);
    await page.reload(); await part(page, childId, "paragraph nine").waitFor();
    await page.locator("#back").click(); await waitAction(page);
    assert.equal(await page.locator("#terminal-pane").isVisible(), false);
    assert.ok(Math.abs((await relativeTop()) - before) < 3, "The selected paragraph should return to the same viewport position.");
    assert.equal(await branch(page, childId).getAttribute("open"), null);
    assert.equal(await source.evaluate((element) => element === document.activeElement), true);

    // Reading an older paragraph and receiving new work must not pull the view to the tail.
    const reading = await relativeTop();
    demo.sessions.record(root.providerThreadId, { question: "A later main question", answer: "A new main answer at the end." });
    await workspace.sync(root.id);
    await page.waitForTimeout(1500);
    assert.ok(Math.abs((await relativeTop()) - reading) < 3);
    assert.equal(await part(page, root.id, "new main answer").count(), 1);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  } finally { await browser.close(); await app.close(); await workspace.close(); }
});

test("sentence follow-up reveals gently without resizing native terminal or replacing the tree", enabled, async () => {
  const { workspace, app, browser } = await fixture();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "no-preference" });
    await page.goto(app.url);
    await page.waitForFunction(() => document.querySelector("#connection").textContent === "Connected");
    const rootId = workspace.scope().id;
    await page.locator("#history-menu > summary").click();
    const nativeBefore = await page.locator("#terminal-pane").boundingBox();
    await page.evaluate(() => { window.originalTreeNode = document.querySelector(".tree-node"); });
    await selectText(part(page, rootId, "中文、emoji 🌱"), "中文、emoji 🌱");
    const opening = await page.locator("#follow-up").evaluate((form) => ({
      height: form.getBoundingClientRect().height,
      durations: form.getAnimations().map((animation) => animation.effect.getTiming().duration),
    }));
    assert.ok(opening.durations.includes(480));
    await page.locator("#question").fill("A draft typed during the animation.");
    await page.waitForTimeout(150);
    const middle = await page.locator("#follow-up").evaluate((form) => form.getBoundingClientRect().height);
    await page.waitForTimeout(450);
    const end = await page.locator("#follow-up").evaluate((form) => form.getBoundingClientRect().height);
    assert.ok(opening.height < middle && middle < end);
    assert.equal(await page.locator("#question").inputValue(), "A draft typed during the animation.");
    assert.deepEqual(await page.locator("#terminal-pane").boundingBox(), nativeBefore);
    assert.equal(await page.evaluate(() => window.originalTreeNode === document.querySelector(".tree-node")), true);
    assert.equal(workspace.conversation.scopes.length, 1);
    await page.locator("#cancel-selection").click();
    await page.locator("#follow-up").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => window.originalTreeNode === document.querySelector(".tree-node")), true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await selectText(part(page, rootId, "中文、emoji 🌱"), "中文、emoji 🌱");
    assert.equal(await page.locator("#follow-up").evaluate((form) => form.getAnimations().length), 0);
    await page.locator("#cancel-selection").click();
    assert.equal(await page.locator("#follow-up").isVisible(), false);
  } finally { await browser.close(); await app.close(); await workspace.close(); }
});
