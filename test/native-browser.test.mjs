import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { chromium } from "playwright";
import { nativeDemo } from "../src/native/demo.mjs";
import { NativeWorkspace } from "../src/native/workspace.mjs";
import { startNativeServer } from "../src/native/server.mjs";

test("browser selects source text, forks, nests, returns, and reconnects", { skip: !process.env.THREADLINE_BROWSER_TESTS, timeout: 60000 }, async () => {
  const demo = nativeDemo();
  const workspace = new NativeWorkspace({ ...demo, demo: true });
  const app = await startNativeServer({ workspace });
  let browser;
  try {
    await workspace.initialize();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(app.url);
    await page.waitForFunction(() => document.querySelector("#connection").textContent === "Connected");
    await page.waitForSelector(".answer-text");
    const rootId = workspace.conversation.activeScopeId;
    const parentTerminal = workspace.terminalFor(rootId);
    const answer = page.locator(".answer-text");
    const original = await answer.innerText();
    const select = async (locator, excerpt) => {
      await locator.evaluate((element, quote) => {
        const start = element.textContent.indexOf(quote);
        const range = document.createRange();
        range.setStart(element.firstChild, start); range.setEnd(element.firstChild, start + quote.length);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      }, excerpt);
    };
    await select(answer, "中文、emoji 🌱");
    assert.equal(await page.locator("#selected-quote").innerText(), "中文、emoji 🌱");
    await page.locator("#question").fill("Explain why the anchor survives resizing.");
    await page.locator("#ask").click();
    await page.waitForFunction(() => document.querySelectorAll(".tree-node").length === 2);
    await page.waitForFunction(() => document.querySelector(".answer-text")?.textContent.includes("separate conversation"));
    const childId = workspace.conversation.activeScopeId;
    assert.equal(workspace.scope().anchor.exactQuote, "中文、emoji 🌱");
    assert.equal(workspace.scope().turns.length, 1);
    assert.equal(workspace.terminalFor(rootId), parentTerminal);

    await select(page.locator(".answer-text"), "separate conversation");
    await page.locator("#question").fill("Explain the nested context.");
    await page.locator("#ask").click();
    await page.waitForFunction(() => document.querySelectorAll(".tree-node").length === 3);
    await page.waitForFunction(() => document.querySelector(".answer-text")?.textContent.includes("nested context"));
    assert.equal(workspace.scope().parentId, childId);
    await page.locator("#back").click();
    await page.waitForFunction(() => document.querySelector("#active-title").textContent.includes("anchor survives"));
    await page.locator("#back").click();
    await page.waitForFunction(() => document.querySelector("#active-title").textContent === "Main conversation");
    assert.equal(await page.locator(".answer-text").innerText(), original);

    await page.reload();
    await page.waitForFunction(() => document.querySelector("#connection").textContent === "Connected");
    assert.equal(await page.locator(".tree-node").count(), 3);
    assert.equal(workspace.terminalFor(rootId), parentTerminal);
    assert.ok((await page.locator(".xterm-screen").innerText()).includes("native sidebar demo"));

    const terminal = parentTerminal.terminal;
    let incoming = "";
    const write = terminal.write.bind(terminal);
    terminal.write = (data) => { incoming += data; write(data); };
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("/brand-new-native-command");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".xterm-screen").textContent.includes("Received literally: /brand-new-native-command"));
    assert.ok(incoming.includes("/brand-new-native-command"));
    assert.equal(workspace.conversation.scopes.length, 3);

    await page.setViewportSize({ width: 980, height: 720 });
    await page.locator("#toggle-panel").click();
    assert.equal(await page.locator("#sidebar").isVisible(), false);
    await page.locator("#toggle-panel").click();
    assert.equal(await page.locator("#sidebar").isVisible(), true);
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("Control+Shift+B");
    assert.equal(await page.locator("#sidebar").isVisible(), false);
    await page.keyboard.press("Control+Shift+B");
    await page.setViewportSize({ width: 520, height: 720 });
    assert.equal(await page.locator("#sidebar").isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

    const exit = once(terminal, "exit");
    terminal.write("/quit\r");
    await exit;
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await app.close();
    await workspace.close();
  }
});
