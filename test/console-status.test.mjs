import test from "node:test";
import assert from "node:assert/strict";
import { inspectNativeStatus, NativeStatus, formatNativeStatus } from "../src/native/console-status.mjs";

test("live native progress has a work state, activity and native elapsed evidence", () => {
  const status = inspectNativeStatus([
    "• Earlier answer.", "", "• Running tests (12s • esc to interrupt)", "", "› Ask Codex to do anything",
    "GPT-6.1-Sol max · Working · Context 92% left",
  ]);
  assert.equal(status.kind, "working"); assert.equal(status.row, 2);
  assert.equal(status.activity, "Running tests"); assert.equal(status.elapsedSeconds, 12);
  assert.equal(inspectNativeStatus(["› Ask Codex to do anything"], "⠋ Thinking · project").kind, "working");
});

test("ready state and a completed answer override historical spinners and working words", () => {
  assert.equal(inspectNativeStatus([
    "• Running tests (12s • esc to interrupt)", "• All tests passed.", "Worked for 12s", "› Ask Codex to do anything",
    "GPT-6.1-Sol max · Ready · Context 92% left",
  ]).kind, "idle");
  assert.equal(inspectNativeStatus(["• This paragraph says Working and asks: Do you want to proceed?", "› Ask Codex to do anything", "GPT-6.1-Sol max · Ready · Context 92% left"]).kind, "idle");
  assert.equal(inspectNativeStatus(["• Running tests (12s • esc to interrupt)", "• Complete.", "› Ask Codex to do anything"]).kind, "unknown");
});

test("native approval and startup states remain distinct from work and readiness", () => {
  assert.equal(inspectNativeStatus(["Do you want to proceed?", "1. Yes", "2. No"]).kind, "blocked");
  assert.equal(inspectNativeStatus(["› Ask Codex to do anything"], "Action Required · repository").kind, "blocked");
  assert.equal(inspectNativeStatus(["GPT-6.1-Sol max · Starting · Context 100% left"]).kind, "starting");
  assert.equal(inspectNativeStatus(["GPT-6.1-Sol max · Waiting · Context 80% left"]).kind, "waiting");
  assert.equal(inspectNativeStatus(["• Answer", "Working", "› Ask Codex to do anything"]).kind, "unknown");
});

test("elapsed time advances during silence and freezes at completion without counting idle time", () => {
  const monitor = new NativeStatus(1000);
  monitor.observe({ kind: "idle", activity: "可继续输入", row: null }, 1500);
  monitor.observe({ kind: "working", activity: "Running tests", row: 2, elapsedSeconds: 3 }, 7000);
  assert.equal(monitor.current(14000).elapsedSeconds, 10);
  const label = formatNativeStatus(monitor.current(14000), 14000);
  assert.match(label, /工作中 10s/u); assert.match(label, /Running tests/u);
  monitor.observe({ kind: "idle", activity: "可继续输入", row: 5 }, 16000);
  assert.equal(monitor.current(60000).elapsedSeconds, null);
  assert.equal(monitor.current(60000).lastDuration, 12);
  monitor.observe({ kind: "working", activity: "Second turn", row: 3 }, 61000);
  assert.equal(monitor.current(63000).elapsedSeconds, 2);
});
