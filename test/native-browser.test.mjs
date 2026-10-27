import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { nativeDemo } from "../src/native/demo.mjs";
import { NativeWorkspace } from "../src/native/workspace.mjs";
import { startNativeServer } from "../src/native/server.mjs";
import { CodexSessions, nativeCommandCapabilities, resolveCodexCommand } from "../src/native/codex.mjs";
import { loadConversation, SessionWriter } from "../src/store.mjs";

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
async function waitConnected(page) { await page.waitForFunction(() => document.querySelector("#connection").textContent === "Connected"); }

async function fixture({ answer } = {}) {
  const demo = nativeDemo();
  const workspace = new NativeWorkspace({ ...demo, demo: true });
  const root = workspace.scope();
  if (answer) {
    const read = demo.sessions.read.bind(demo.sessions);
    demo.sessions.read = async (id) => {
      const thread = await read(id);
      if (id === root.providerThreadId) thread.turns[0].items.find((item) => item.type === "agentMessage").text = answer;
      return thread;
    };
  }
  const app = await startNativeServer({ workspace });
  let browser;
  try {
    await workspace.initialize();
    browser = await chromium.launch({ headless: true });
  } catch (error) { await app.close(); await workspace.close(); throw error; }
  const errors = [];
  const connections = [];
  return {
    demo, workspace, root, app, browser, errors, connections,
    async page(options = {}) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", ...options });
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("websocket", (socket) => connections.push(socket.url()));
      await page.goto(app.url);
      await waitConnected(page);
      return page;
    },
    async close() { await browser.close(); await app.close(); await workspace.close(); },
  };
}

// Inspect the public buffer/cell API, then select in the real xterm instance.
// The mouse path uses actual grid coordinates, not a DOM Range or a fake pane.
async function nativeSelect(page, text, { mouse = false, occurrence = 0 } = {}) {
  await page.evaluate(async () => { window.nativeTerminalUnderTest = (await import("/app.js")).terminal; });
  await page.waitForFunction(({ text, occurrence }) => {
    const terminal = window.nativeTerminalUnderTest;
    const buffer = terminal.buffer.active;
    let visible = "";
    for (let row = 0; row < buffer.length; row += 1) visible += buffer.getLine(row).translateToString(true);
    visible = visible.replace(/\s/gu, "");
    const needle = text.replace(/\s/gu, "");
    let index = -1;
    for (let count = 0; count <= Math.max(0, occurrence); count += 1) {
      index = visible.indexOf(needle, index + 1);
      if (index < 0) return false;
    }
    return true;
  }, { text, occurrence });
  const points = await page.evaluate(({ text, mouse, occurrence }) => {
    const terminal = window.nativeTerminalUnderTest;
    const buffer = terminal.buffer.active;
    const cells = [];
    let visible = "";
    for (let y = 0; y < buffer.length; y += 1) {
      const line = buffer.getLine(y);
      for (let x = 0; x < terminal.cols; x += 1) {
        const cell = line.getCell(x);
        const chars = cell.getChars().replace(/\s/gu, "");
        visible += chars;
        for (let index = 0; index < chars.length; index += 1) cells.push({ x, y, width: cell.getWidth() });
      }
    }
    const needle = text.replace(/\s/gu, "");
    let index = occurrence < 0 ? visible.lastIndexOf(needle) : visible.indexOf(needle);
    for (let count = 0; count < occurrence && index >= 0; count += 1) index = visible.indexOf(needle, index + 1);
    if (index < 0) throw new Error("Native text is not in the xterm buffer.");
    const first = cells[index];
    const last = cells[index + needle.length - 1];
    terminal.clearSelection();
    terminal.scrollToLine(first.y);
    terminal.focus();
    if (!mouse) terminal.select(first.x, first.y, (last.y - first.y) * terminal.cols + last.x + last.width - first.x);
    const rect = terminal.element.querySelector(".xterm-screen").getBoundingClientRect();
    const width = rect.width / terminal.cols;
    const height = rect.height / terminal.rows;
    return {
      start: { x: rect.left + (first.x + .2) * width, y: rect.top + (first.y - buffer.viewportY + .5) * height },
      end: { x: rect.left + (last.x + last.width + .2) * width, y: rect.top + (last.y - buffer.viewportY + .5) * height },
    };
  }, { text, mouse, occurrence });
  if (mouse) {
    await page.mouse.move(points.start.x, points.start.y);
    await page.mouse.down();
    await page.mouse.move(points.end.x, points.end.y, { steps: 8 });
    await page.mouse.up();
  }
  await page.waitForFunction((quote) => {
    const terminal = window.nativeTerminalUnderTest;
    return terminal.getSelection().replace(/\s/gu, "") === quote.replace(/\s/gu, "");
  }, text);
  return points;
}

async function askNative(page, text, { mouse = false, keyboard = false, occurrence = 0 } = {}) {
  const points = await nativeSelect(page, text, { mouse, occurrence });
  if (keyboard) await page.keyboard.press("Shift+F10");
  else await page.mouse.click(points.start.x + 2, points.start.y, { button: "right" });
  try { await page.locator("#native-menu").waitFor({ state: "visible", timeout: 5000 }); }
  catch (error) {
    const details = await page.evaluate(async () => {
      const { terminal } = await import("/app.js");
      return {
        selection: terminal.getSelection(), mode: terminal.modes.mouseTrackingMode,
        message: document.querySelector("#message").textContent, focus: document.activeElement?.className,
      };
    });
    throw new Error("Native selection menu did not stay open: " + JSON.stringify(details), { cause: error });
  }
  await page.locator("#native-menu-ask").click();
  await waitAction(page);
}

async function submitBranch(page, workspace, question) {
  await page.locator("#question").fill(question);
  await page.locator("#question").press("Control+Enter");
  await waitAction(page);
  const child = workspace.scope();
  await part(page, child.id, "separate conversation").waitFor();
  return child;
}

const enabled = { skip: !process.env.THREADLINE_BROWSER_TESTS, timeout: 60000 };

test("native mouse selection opens an on-demand branch workspace and never replaces the main terminal or draft", enabled, async () => {
  const f = await fixture();
  try {
    const page = await f.page();
    const parent = f.workspace.terminalFor(f.root.id);
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("unsent main draft");
    assert.equal(await page.locator("#sidebar").isVisible(), false);
    assert.equal(await page.locator(".answer-text").count(), 0);
    await page.evaluate(() => { window.savedTreeNode = document.querySelector(".tree-node"); });
    const points = await nativeSelect(page, "中文、emoji 🌱", { mouse: true });
    assert.equal(await page.locator("#sidebar").isVisible(), false);
    assert.equal(f.workspace.conversation.scopes.length, 1);
    assert.equal(await page.locator(".xterm-helper-textarea").evaluate((element) => element === document.activeElement), true);
    await page.mouse.click(points.start.x + 2, points.start.y, { button: "right" });
    assert.match(await page.locator("#native-menu-ask").innerText(), /追问.*Ask about selection/u);
    assert.equal(await page.locator("#native-menu-copy").isVisible(), true);
    await page.locator("#native-menu-ask").click(); await waitAction(page);
    assert.equal(await page.locator("#selected-quote").innerText(), "中文、emoji 🌱");
    assert.equal(await page.evaluate(async () => (await import("/app.js")).terminal.getSelection()), "");
    assert.match(await page.locator("#selection-source").innerText(), /Main conversation.*Answer 1.*Session/u);
    assert.equal(f.workspace.conversation.scopes.length, 1);
    await page.locator("#question").fill("Explain why the anchor survives resizing.");
    await page.locator("#close-panel").click();
    assert.equal(await page.locator("#sidebar").isVisible(), false);
    await page.locator("#toggle-panel").click();
    assert.equal(await page.locator("#question").inputValue(), "Explain why the anchor survives resizing.");
    assert.equal(await page.locator("#selected-quote").innerText(), "中文、emoji 🌱");
    const child = await submitBranch(page, f.workspace, "Explain why the anchor survives resizing.");
    assert.equal(child.parentId, f.root.id);
    assert.equal(child.anchor.exactQuote, "中文、emoji 🌱");
    assert.equal(child.turns.length, 1);
    assert.equal(await page.locator(`.answer-text[data-scope="${f.root.id}"]`).count(), 0);
    assert.equal(await branch(page, child.id).locator(":scope > .scope-body > .branch-source blockquote").innerText(), child.anchor.exactQuote);
    assert.equal(await page.locator("#terminal-pane").getAttribute("data-terminal"), parent.id);
    assert.equal(f.workspace.terminalFor(f.root.id), parent);
    assert.match((await parent.terminal.snapshot()).data, /unsent main draft/u);
    assert.equal(f.connections.length, 1);

    await page.locator("#prompt").fill("Continue with another ordinary question.");
    await page.locator("#send").click(); await waitAction(page);
    await part(page, child.id, "another ordinary question").waitFor();
    assert.equal(f.workspace.scope().id, child.id);
    assert.equal(child.turns.length, 2);
    assert.equal(f.workspace.conversation.scopes.length, 2);
    await selectText(part(page, child.id, "separate conversation"), "separate conversation");
    const nested = await submitBranch(page, f.workspace, "Explain the nested context.");
    assert.equal(nested.parentId, child.id);
    await page.locator("#back").click(); await waitAction(page);
    assert.equal(f.workspace.scope().id, child.id);
    assert.equal(await branch(page, nested.id).getAttribute("open"), null);
    assert.equal(await page.locator(".source-return").getAttribute("data-scope"), child.id);
    await page.locator("#back").click(); await waitAction(page);
    assert.equal(await page.locator("#sidebar").isVisible(), false);
    assert.equal(f.connections.length, 1);
    assert.equal(await page.evaluate(() => window.savedTreeNode === document.querySelector(".tree-node")), true);

    await page.locator("#toggle-panel").click();
    await page.locator("#history-menu > summary").click();
    await page.locator(`.tree-node[data-scope="${child.id}"]`).click(); await waitAction(page);
    assert.equal(f.connections.length, 1, "Browsing a branch must not reconnect xterm.");
    await page.locator("#continue-conversation").click(); await waitAction(page); await waitConnected(page);
    assert.equal(await page.locator("#terminal-pane").getAttribute("data-scope"), child.id);
    await page.locator("#main-terminal").click(); await waitAction(page); await waitConnected(page);
    assert.equal(await page.locator("#terminal-pane").getAttribute("data-terminal"), parent.id);
    assert.match((await parent.terminal.snapshot()).data, /unsent main draft/u);
    assert.equal(f.workspace.terminalFor(f.root.id), parent);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("wrapped native Markdown, CJK, emoji and math keep canonical quotes; prose and code have distinct reading styles", enabled, async () => {
  const formatted = "# **Context**\n\nA **bold 中文 🌱 passage** with `literal()` and $x_i^2$.\n\n" +
    "This paragraph deliberately wraps across terminal rows. ".repeat(3) +
    "A unique wrapped 中文句子 🌱 keeps its exact source even after the visible line ends.\n\n<script>window.__injected = true</script>";
  const f = await fixture({ answer: formatted });
  try {
    const page = await f.page({ viewport: { width: 800, height: 900 }, colorScheme: "light" });
    await askNative(page, "A unique wrapped 中文句子 🌱 keeps its exact source even after the visible line ends.", { mouse: true });
    assert.equal(await page.locator("#selected-quote").innerText(), "A unique wrapped 中文句子 🌱 keeps its exact source even after the visible line ends.");
    await page.locator("#question").fill("保留我的追问草稿。");
    f.demo.sessions.record(f.root.providerThreadId, { question: "Later question", answer: "A later completed answer." });
    await f.workspace.sync(f.root.id);
    await page.waitForTimeout(1400);
    assert.equal(await page.locator("#question").inputValue(), "保留我的追问草稿。");
    await page.locator("#cancel-selection").click();
    await askNative(page, "bold 中文 🌱 passage", { keyboard: true });
    assert.equal(await page.locator("#selected-quote").innerText(), "bold 中文 🌱 passage");
    await page.locator("#cancel-selection").click();
    await askNative(page, "xᵢ²");
    assert.equal(await page.locator("#selected-quote").innerText(), "x_i^2");
    const child = await submitBranch(page, f.workspace, "Explain the formula.");
    assert.equal(child.anchor.exactQuote, "x_i^2");
    assert.equal(child.anchor.sourceStart, formatted.indexOf("x_i^2"));
    f.demo.sessions.record(child.providerThreadId, {
      question: "Show code",
      answer: "Readable paragraph.\n\n```js\nconst example = 'code stays code';\n```\n\n<script>window.__injected = true</script>",
    });
    await f.workspace.sync(child.id);
    await part(page, child.id, "code stays code").waitFor();
    assert.equal(await part(page, child.id, "code stays code").evaluate((element) => getComputedStyle(element).whiteSpace), "pre");
    assert.match(await part(page, child.id, "code stays code").evaluate((element) => getComputedStyle(element).fontFamily), /Consolas|monospace/u);
    assert.doesNotMatch(await part(page, child.id, "Readable paragraph").evaluate((element) => getComputedStyle(element).fontFamily), /Consolas|monospace/u);
    assert.equal(await page.evaluate(() => window.__injected), undefined);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("ambiguous, unknown and stale selections fail visibly; confirmed quotes are editable during source checks and resize", enabled, async () => {
  const f = await fixture({ answer: "Repeated passage. More detail. Repeated passage.\n\nUnique original passage." });
  try {
    const page = await f.page();
    await askNative(page, "Repeated passage");
    assert.match(await page.locator("#message").innerText(), /more than one/u);
    assert.equal(await page.locator("#sidebar").isVisible(), false);
    await askNative(page, "No model connection is made.");
    assert.match(await page.locator("#message").innerText(), /could not be mapped/u);
    assert.equal(f.workspace.conversation.scopes.length, 1);
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("Unique original passage");
    await nativeSelect(page, "Unique original passage", { occurrence: 1 });
    await page.keyboard.press("Control+Shift+A"); await waitAction(page);
    assert.match(await page.locator("#message").innerText(), /could not be mapped/u);
    assert.equal(f.workspace.conversation.scopes.length, 1);

    let release;
    let requested;
    const gate = new Promise((resolve) => { release = resolve; });
    const arrived = new Promise((resolve) => { requested = resolve; });
    await page.route("**/api/selection", async (route) => { requested(); await gate; await route.continue(); });
    const points = await nativeSelect(page, "Unique original passage");
    await page.mouse.click(points.start.x + 2, points.start.y, { button: "right" });
    await page.locator("#native-menu-ask").click();
    await arrived;
    assert.equal(await page.locator("#follow-up").isVisible(), true);
    assert.equal(await page.locator("#ask").isDisabled(), true);
    await page.locator("#question").fill("Typed while the canonical source is being checked.");
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.waitForFunction(() => innerWidth === 1100);
    release();
    await waitAction(page);
    await page.unroute("**/api/selection");
    assert.equal(await page.locator("#ask").isDisabled(), false);
    assert.equal(await page.locator("#selected-quote").innerText(), "Unique original passage");
    assert.equal(await page.locator("#question").inputValue(), "Typed while the canonical source is being checked.");
    assert.equal(f.workspace.conversation.scopes.length, 1);
    await page.locator("#question").fill("Do not lose this draft.");
    const read = f.demo.sessions.read.bind(f.demo.sessions);
    f.demo.sessions.read = async (id) => {
      const thread = await read(id);
      if (id === f.root.providerThreadId) thread.turns[0].items.find((item) => item.type === "agentMessage").text = "Changed source answer.";
      return thread;
    };
    await f.workspace.sync(f.root.id);
    await page.waitForFunction(() => document.querySelector("#ask").disabled);
    assert.match(await page.locator("#message").innerText(), /source changed/u);
    assert.equal(await page.locator("#question").inputValue(), "Do not lose this draft.");
    assert.equal(f.workspace.conversation.scopes.length, 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("native session rebinding follows terminalId without caching the original root or losing a pending question", enabled, async () => {
  const f = await fixture();
  try {
    const page = await f.page();
    const native = f.workspace.terminalFor(f.root.id);
    await askNative(page, "中文、emoji 🌱");
    await page.locator("#question").fill("Keep this question through a native session switch.");
    const fresh = await f.demo.sessions.create();
    f.demo.sessions.record(fresh.id, { question: "New native question", answer: f.root.turns[0].assistant.text });
    await f.workspace.notification({ terminalId: native.id, threadId: fresh.id });
    const rebound = f.workspace.scope(native.scopeId);
    await page.waitForFunction((id) => document.querySelector("#terminal-pane").dataset.scope === id, rebound.id);
    assert.equal(await page.locator("#ask").isDisabled(), true);
    assert.equal(await page.locator("#question").inputValue(), "Keep this question through a native session switch.");
    assert.equal(f.connections.length, 1);
    await page.locator("#cancel-selection").click();
    await askNative(page, "中文、emoji 🌱");
    assert.ok((await page.locator("#selection-source").innerText()).includes(fresh.id.slice(0, 8)));
    const child = await submitBranch(page, f.workspace, "Ask about the new source.");
    assert.equal(child.parentId, rebound.id);
    assert.equal(f.workspace.terminalFor(rebound.id), native);
    assert.equal(f.connections.length, 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("native menu supports keyboard, copying, bounded coordinates, dismissal and native mouse ownership", enabled, async () => {
  const f = await fixture();
  try {
    const page = await f.page({ viewport: { width: 700, height: 800 } });
    await nativeSelect(page, "中文、emoji 🌱");
    await page.keyboard.press("Shift+F10");
    assert.equal(await page.locator("#native-menu-ask").evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.locator("#native-menu-copy").evaluate((element) => element === document.activeElement), true);
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async () => { throw new Error("Clipboard permission denied"); },
    } }));
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#message").textContent.includes("Could not copy"));
    assert.match(await page.locator("#message").innerText(), /Clipboard permission denied/u);
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text) => { window.copiedNativeSelection = text; },
    } }));
    await page.keyboard.press("Shift+F10");
    await page.keyboard.press("End"); await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.copiedNativeSelection === "中文、emoji 🌱");
    assert.equal(await page.locator("#sidebar").isVisible(), false);
    await page.keyboard.press("Shift+F10"); await page.keyboard.press("Escape");
    assert.equal(await page.locator("#native-menu").isVisible(), false);
    assert.equal(await page.locator(".xterm-helper-textarea").evaluate((element) => element === document.activeElement), true);
    await page.locator("#terminal").evaluate((element) => element.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: 699, clientY: 799,
    })));
    const menu = await page.locator("#native-menu").boundingBox();
    assert.ok(menu.x >= 0 && menu.y >= 0 && menu.x + menu.width <= 700 && menu.y + menu.height <= 800);
    await page.setViewportSize({ width: 690, height: 800 });
    await page.locator("#native-menu").waitFor({ state: "hidden" });

    await nativeSelect(page, "中文、emoji 🌱");
    await page.keyboard.press("Shift+F10");
    // Native focus-out redraws can clear xterm's highlight without changing
    // any captured source cells. The menu must retain that frozen selection.
    await page.evaluate(async () => { const { terminal } = await import("/app.js"); terminal.clearSelection(); });
    assert.equal(await page.locator("#native-menu").isVisible(), true);
    await page.locator("#native-menu-ask").click(); await waitAction(page);
    assert.equal(await page.locator("#selected-quote").innerText(), "中文、emoji 🌱");
    await page.locator("#cancel-selection").click();

    await page.evaluate(async () => { const { terminal } = await import("/app.js"); terminal.clearSelection(); });
    assert.equal(await page.locator("#terminal").evaluate((element) => {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      element.dispatchEvent(event); return event.defaultPrevented;
    }), false);
    await page.evaluate(async () => { const { terminal } = await import("/app.js"); await new Promise((resolve) => terminal.write("\x1b[?1000h\x1b[?1006h", resolve)); });
    await page.keyboard.down("Shift");
    const points = await nativeSelect(page, "中文、emoji 🌱", { mouse: true });
    await page.keyboard.up("Shift");
    await page.dispatchEvent("#terminal", "contextmenu", { clientX: 50, clientY: 100 });
    assert.equal(await page.locator("#native-menu").isVisible(), false);
    const ownership = await page.evaluate(async () => {
      const { terminal } = await import("/app.js");
      return { text: terminal.getSelection(), mode: terminal.modes.mouseTrackingMode, connected: document.querySelector("#connection").textContent };
    });
    assert.equal(ownership.text, "中文、emoji 🌱", JSON.stringify(ownership));
    assert.notEqual(ownership.mode, "none");
    await page.keyboard.down("Shift");
    await page.mouse.click(points.start.x + 2, points.start.y, { button: "right" });
    await page.keyboard.up("Shift");
    assert.equal(await page.locator("#native-menu").isVisible(), true);
    await page.keyboard.press("Escape");
    await page.evaluate(async () => { const { terminal } = await import("/app.js"); await new Promise((resolve) => terminal.write("\x1b[?1000l\x1b[?1006l", resolve)); terminal.focus(); });
    await nativeSelect(page, "中文、emoji 🌱");
    await page.keyboard.press("Control+Shift+A"); await waitAction(page);
    assert.equal(await page.locator("#follow-up").isVisible(), true);
    assert.equal(f.workspace.conversation.scopes.length, 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("gentle reveal is immediately editable, fits the PTY once at the boundary, and respects reduced motion", enabled, async () => {
  const f = await fixture();
  try {
    const page = await f.page({ reducedMotion: "no-preference", viewport: { width: 1440, height: 1000 } });
    await nativeSelect(page, "中文、emoji 🌱");
    const native = f.workspace.terminalFor(f.root.id).terminal;
    const sizes = [];
    const resize = native.resize.bind(native);
    native.resize = (cols, rows) => { sizes.push([cols, rows]); resize(cols, rows); };
    await page.evaluate(() => { window.savedTreeNode = document.querySelector(".tree-node"); });
    await page.keyboard.press("Shift+F10");
    await page.locator("#native-menu-ask").click(); await waitAction(page);
    const opening = await page.locator("#follow-up").evaluate((form) => ({
      height: form.getBoundingClientRect().height,
      durations: form.getAnimations().map((animation) => animation.effect.getTiming().duration),
      panelDurations: document.querySelector("#sidebar").getAnimations().map((animation) => animation.effect.getTiming().duration),
    }));
    assert.ok(opening.durations.includes(480));
    assert.ok(opening.panelDurations.includes(480));
    await page.keyboard.type("An immediate draft.");
    await page.waitForTimeout(150);
    const middle = await page.locator("#follow-up").evaluate((form) => form.getBoundingClientRect().height);
    assert.equal(sizes.length, 0, "Opening must not continuously resize the native CLI.");
    await page.waitForTimeout(450);
    const end = await page.locator("#follow-up").evaluate((form) => form.getBoundingClientRect().height);
    assert.ok(opening.height < middle && middle < end);
    assert.equal(await page.locator("#question").inputValue(), "An immediate draft.");
    assert.equal(sizes.length, 1);
    assert.equal(f.connections.length, 1);
    await page.locator("#close-panel").click();
    assert.ok(await page.locator("#sidebar").evaluate((element) => element.getAnimations().some((animation) => animation.effect.getTiming().duration === 240)));
    await page.locator("#sidebar").waitFor({ state: "hidden" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator("#toggle-panel").click();
    assert.equal(await page.locator("#sidebar").evaluate((element) => element.getAnimations().length), 0);
    assert.equal(await page.locator("#question").inputValue(), "An immediate draft.");
    await page.locator("#cancel-selection").click();
    await askNative(page, "中文、emoji 🌱");
    assert.equal(await page.locator("#follow-up").evaluate((element) => element.getAnimations().length), 0);
    assert.equal(await page.evaluate(() => window.savedTreeNode === document.querySelector(".tree-node")), true);
    await page.locator("#question").press("Escape");
    assert.equal(await page.locator("#follow-up").isVisible(), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("branch scroll, drafts and tree survive close/reopen, root updates and reload; hidden child approvals stay reachable", enabled, async () => {
  const f = await fixture();
  try {
    const page = await f.page();
    await askNative(page, "中文、emoji 🌱");
    const child = await submitBranch(page, f.workspace, "Start a reading thread.");
    const longAnswer = Array.from({ length: 28 }, (_, index) =>
      `Paragraph ${index}: this is a readable branch answer. Its surrounding context stays available while exploring details.`).join("\n\n");
    f.demo.sessions.record(child.providerThreadId, { question: "A long answer", answer: longAnswer });
    await f.workspace.sync(child.id);
    const source = part(page, child.id, "Paragraph 9:");
    await source.waitFor();
    await page.locator("#history-menu > summary").click();
    await source.evaluate((element) => element.scrollIntoView({ block: "center" }));
    const relativeTop = () => source.evaluate((element) => element.getBoundingClientRect().top - document.querySelector("#answers").getBoundingClientRect().top);
    const before = await relativeTop();
    await page.locator("#prompt").fill("A continuing branch draft.");
    await page.locator("#close-panel").click();
    await page.locator("#toggle-panel").click();
    assert.equal(await page.locator("#prompt").inputValue(), "A continuing branch draft.");
    assert.ok(Math.abs((await relativeTop()) - before) < 3);
    const reading = await relativeTop();
    await page.reload(); await waitConnected(page); await source.waitFor();
    assert.equal(await page.locator("#prompt").inputValue(), "A continuing branch draft.");
    assert.ok(Math.abs((await relativeTop()) - reading) < 3);
    assert.equal(await page.locator("#history-menu").getAttribute("open"), "");
    f.demo.sessions.record(f.root.providerThreadId, { question: "New main question", answer: "New main answer must not appear in the branch." });
    await f.workspace.sync(f.root.id);
    await page.waitForTimeout(1400);
    assert.ok(Math.abs((await relativeTop()) - reading) < 3);
    assert.equal(await page.locator(`.answer-text[data-scope="${f.root.id}"]`).count(), 0);

    const native = f.workspace.terminalFor(child.id);
    native.terminal.activityStatus = () => ({ kind: "working", activity: "Working", elapsedSeconds: 2 });
    f.workspace.changed();
    await page.locator("#close-panel").click();
    const attention = page.locator(`#terminal-alerts button[data-scope="${child.id}"]`);
    await attention.waitFor();
    assert.match(await attention.innerText(), /Running/u);
    native.terminal.activityStatus = () => ({ kind: "blocked", activity: "Approval required" });
    f.workspace.changed();
    await page.waitForFunction(() => document.querySelector("#terminal-alerts").textContent.includes("Needs attention"));
    assert.match(await attention.innerText(), /Needs attention/u);
    await attention.click(); await waitAction(page); await waitConnected(page);
    assert.equal(await page.locator("#terminal-pane").getAttribute("data-terminal"), native.id);
    assert.equal(await page.locator("#sidebar").isVisible(), false);
    await page.locator("#main-terminal").click(); await waitAction(page); await waitConnected(page);
    assert.equal(await page.locator("#terminal-pane").getAttribute("data-scope"), f.root.id);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("active reading overrides inline reveal and delayed reply scrolling", enabled, async () => {
  const f = await fixture();
  try {
    const page = await f.page({ reducedMotion: "no-preference" });
    await askNative(page, "中文、emoji 🌱");
    const child = await submitBranch(page, f.workspace, "A thread for reading.");
    f.demo.sessions.record(child.providerThreadId, {
      question: "More context",
      answer: Array.from({ length: 28 }, (_, index) => `Reading paragraph ${index}: the surrounding explanation remains available while exploring a specific passage.`).join("\n\n"),
    });
    await f.workspace.sync(child.id);
    const source = part(page, child.id, "Reading paragraph 15:");
    await source.waitFor();
    await source.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await selectText(source, "Reading paragraph 15");
    assert.equal(await page.locator("#follow-up").evaluate((element) => element.parentElement.className), "answer-part");
    await page.locator("#answers").hover();
    await page.mouse.wheel(0, -450);
    await page.waitForTimeout(200);
    const during = await page.locator("#answers").evaluate((element) => element.scrollTop);
    await page.waitForTimeout(450);
    assert.ok(Math.abs((await page.locator("#answers").evaluate((element) => element.scrollTop)) - during) < 3);
    await page.locator("#cancel-selection").click();
    await page.locator("#follow-up").waitFor({ state: "hidden" });
    await source.evaluate((element) => element.scrollIntoView({ block: "center" }));

    const record = f.demo.sessions.record.bind(f.demo.sessions);
    let reply;
    let received;
    const notified = new Promise((resolve) => { received = resolve; });
    f.demo.sessions.record = (id, value) => {
      if (id === child.providerThreadId) { reply = value; received(); }
      else record(id, value);
    };
    await page.locator("#prompt").fill("A deliberately deferred new reply.");
    await page.locator("#send").click(); await waitAction(page);
    let timer;
    try {
      await Promise.race([notified, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("The native fixture did not report its reply.")), 5000);
      })]);
    } finally { clearTimeout(timer); }
    await page.locator("#answers").hover();
    await page.mouse.wheel(0, -350);
    await page.waitForTimeout(200);
    const reading = await page.locator("#answers").evaluate((element) => element.scrollTop);
    f.demo.sessions.record = record;
    record(child.providerThreadId, reply);
    await f.workspace.sync(child.id);
    await part(page, child.id, "deliberately deferred new reply").waitFor();
    assert.ok(Math.abs((await page.locator("#answers").evaluate((element) => element.scrollTop)) - reading) < 3);
    assert.equal(child.turns.length, 3);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("native slash commands, arguments and completion bytes pass through unchanged; new main sessions preserve the branch workspace", enabled, async () => {
  const f = await fixture();
  try {
    const page = await f.page();
    const native = f.workspace.terminalFor(f.root.id).terminal;
    let incoming = "";
    const write = native.write.bind(native);
    native.write = (data) => { incoming += data; write(data); };
    await page.locator(".xterm-helper-textarea").focus();
    const command = '/brand-new-upstream-command --flag "quoted value"';
    await page.keyboard.type(command);
    await page.keyboard.press("Tab");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);
    assert.ok(incoming.includes(command + "\t\x1b[A\x1b\r"));
    assert.equal(f.workspace.conversation.scopes.length, 1);
    assert.equal(await page.locator("#sidebar").isVisible(), false);
    await askNative(page, "中文、emoji 🌱");
    await page.locator("#question").fill("/a-future-command --arg value");
    await page.locator("#ask").click(); await waitAction(page);
    assert.match(await page.locator("#message").innerText(), /native terminal/u);
    assert.equal(f.workspace.conversation.scopes.length, 1);
    const child = await submitBranch(page, f.workspace, "A separate right-hand conversation.");
    await page.locator("#prompt").fill("Keep this branch draft.");
    await page.locator("#new-conversation").click(); await waitAction(page); await waitConnected(page);
    const fresh = f.workspace.scope();
    assert.equal(fresh.parentId, null);
    assert.notEqual(fresh.id, f.root.id);
    assert.equal(await page.locator("#terminal-pane").getAttribute("data-scope"), fresh.id);
    assert.equal(await branch(page, child.id).isVisible(), true);
    assert.equal(await page.locator("#prompt").inputValue(), "Keep this branch draft.");
    assert.equal(f.workspace.terminalFor(f.root.id).terminal, native);
    assert.equal(await page.locator("details.conversation-root").count(), 0);
    await page.locator("#prompt").fill("/new"); await page.locator("#send").click(); await waitAction(page);
    assert.match(await page.locator("#message").innerText(), /native terminal/u);
    assert.equal(child.turns.length, 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("real Codex browser replies and forks from the native selection without tools or file edits", {
  skip: !process.env.THREADLINE_LIVE_BROWSER_TESTS, timeout: 180000,
}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadline-browser-live-"));
  const command = nativeCommandCapabilities(resolveCodexCommand());
  const sessions = new CodexSessions({ command });
  const workspace = new NativeWorkspace({ command, sessions });
  const file = path.join(directory, "session.json");
  workspace.writer = new SessionWriter(file, () => workspace.conversation);
  const app = await startNativeServer({ workspace });
  let browser;
  try {
    await workspace.initialize();
    const root = workspace.scope();
    const native = workspace.terminalFor(root.id);
    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline) {
      await native.terminal.snapshot();
      const buffer = native.terminal.headless.buffer.active;
      const screen = Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row).translateToString(true)).join("\n");
      if (/trust (?:this|the)|do you trust|sign in|log in|authenticate|choose.*account/iu.test(screen)) {
        t.skip("Native Codex requires an interactive trust or sign-in decision; no approval or model prompt was sent.");
        return;
      }
      if (/^\s*›\s*(?:Ask Codex to do anything)?\s*$/mu.test(screen)) { ready = true; break; }
      if (native.terminal.exited) throw new Error(workspace.notice || "Native Codex exited before reaching its prompt.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, "Codex did not reach a ready prompt within 20 seconds; no startup dialog was bypassed.");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(app.url); await waitConnected(page);
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.insertText("Do not use tools, inspect the workspace, run commands, or create or edit any files. Reply exactly THREADLINE_NATIVE_SELECTION_LIVE_OK and nothing else.");
    await page.waitForTimeout(500);
    await page.keyboard.press("Enter");
    const completedBy = Date.now() + 60000;
    while (!root.turns.some((turn) => turn.assistant.status === "complete" && turn.assistant.text.includes("THREADLINE_NATIVE_SELECTION_LIVE_OK"))) {
      assert.ok(Date.now() < completedBy, workspace.notice || "The native completion callback did not deliver the expected root answer.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    t.diagnostic("Live source thread: " + root.providerThreadId);
    await page.waitForFunction((id) => document.querySelector("#terminal-pane").dataset.thread === id, root.providerThreadId);
    await page.evaluate(async () => { window.nativeTerminalUnderTest = (await import("/app.js")).terminal; });
    await page.waitForFunction(() => {
      const terminal = window.nativeTerminalUnderTest;
      const buffer = terminal.buffer.active;
      return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row).translateToString(true))
        .some((line) => line.replace(/^\s*\u2022\s*/u, "").trim() === "THREADLINE_NATIVE_SELECTION_LIVE_OK");
    }, null, { timeout: 20000 });
    await askNative(page, "THREADLINE_NATIVE_SELECTION_LIVE_OK", { keyboard: true, occurrence: -1 });
    assert.equal(await page.locator("#selected-quote").innerText(), "THREADLINE_NATIVE_SELECTION_LIVE_OK");
    await page.locator("#question").fill("Do not use tools, inspect the workspace, run commands, or create or edit any files. Reply exactly THREADLINE_NATIVE_BRANCH_LIVE_OK and nothing else.");
    await page.locator("#ask").click(); await waitAction(page);
    const child = workspace.scope();
    assert.equal(child.parentId, root.id);
    await part(page, child.id, "THREADLINE_NATIVE_BRANCH_LIVE_OK").waitFor({ timeout: 60000 });
    assert.equal(workspace.terminalFor(root.id), native);
    assert.equal(await page.locator("#terminal-pane").getAttribute("data-terminal"), native.id);
    assert.equal(await page.locator(`.answer-text[data-scope="${root.id}"]`).count(), 0);
    for (const scope of [root, child]) {
      const thread = await sessions.read(scope.providerThreadId);
      const kinds = thread.turns.flatMap((turn) => turn.items || []).map((item) => item.type);
      assert.ok(kinds.every((kind) => ["userMessage", "agentMessage", "reasoning"].includes(kind)), `Unexpected live item types: ${kinds.join(", ")}`);
    }
    await workspace.writer.flush();
    const saved = await loadConversation(file);
    assert.equal(saved.scopes.find((scope) => scope.id === child.id).anchor.exactQuote, "THREADLINE_NATIVE_SELECTION_LIVE_OK");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await app.close();
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  }
});
