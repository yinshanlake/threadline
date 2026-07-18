import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Terminal } from "../src/terminal.mjs";

class FakeOutput extends EventEmitter {
  constructor() {
    super();
    this.columns = 80;
    this.rows = 3;
    this.writes = [];
    this.blockNext = false;
  }

  write(value) {
    this.writes.push(value);
    if (!this.blockNext) return true;
    this.blockNext = false;
    return false;
  }
}

test("terminal redraws only rows whose rendered content changed", () => {
  const output = new FakeOutput();
  const terminal = new Terminal({ output });
  terminal.active = true;

  terminal.draw(["alpha", "beta"]);
  output.writes.length = 0;
  terminal.draw(["alpha", "changed"]);

  assert.equal(output.writes.length, 1);
  assert.doesNotMatch(output.writes[0], /\x1b\[1;1H/);
  assert.match(output.writes[0], /\x1b\[2;1H\x1b\[2Kchanged/);
});

test("terminal coalesces frames while stdout applies backpressure", () => {
  const output = new FakeOutput();
  const terminal = new Terminal({ output });
  terminal.active = true;
  output.blockNext = true;

  terminal.draw(["first"]);
  terminal.draw(["intermediate"]);
  terminal.draw(["latest"]);
  assert.equal(output.writes.length, 1);

  terminal.onDrain();
  assert.equal(output.writes.length, 2);
  assert.doesNotMatch(output.writes[1], /intermediate/);
  assert.match(output.writes[1], /latest/);
});
