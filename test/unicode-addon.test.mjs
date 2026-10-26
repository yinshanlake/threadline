import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../", import.meta.url));

for (const format of ["commonjs", "esm"]) {
  test(`Unicode grapheme ${format} addon initializes with a nonzero Buffer offset`, { timeout: 12000 }, () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";
      import { pathToFileURL } from "node:url";
      import path from "node:path";
      const require = createRequire(import.meta.url);
      const original = Buffer.from;
      let pooledReads = 0;
      Buffer.from = function(value, encoding, ...rest) {
        const bytes = original.call(Buffer, value, encoding, ...rest);
        if (encoding !== "base64") return bytes;
        const storage = Buffer.alloc(bytes.length + 8);
        bytes.copy(storage, 8);
        pooledReads += 1;
        return storage.subarray(8);
      };
      let addon;
      try {
        addon = ${format === "commonjs"
          ? 'require("@xterm/addon-unicode-graphemes")'
          : 'await import(pathToFileURL(path.join(path.dirname(require.resolve("@xterm/addon-unicode-graphemes/package.json")), "lib/addon-unicode-graphemes.mjs")).href)'};
      } finally { Buffer.from = original; }
      assert.ok(pooledReads > 0, "The test must exercise a nonzero byte offset.");
      const { Terminal } = require("@xterm/headless");
      const terminal = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
      try {
        terminal.loadAddon(new addon.UnicodeGraphemesAddon());
        await new Promise(resolve => terminal.write("\\u4e2d\\u6587\\u{1f469}\\u200d\\u{1f4bb}", resolve));
        assert.equal(terminal.buffer.active.getLine(0).translateToString(true), "\\u4e2d\\u6587\\u{1f469}\\u200d\\u{1f4bb}");
        assert.equal(terminal.buffer.active.cursorX, 6);
        console.log("UNICODE_OFFSET_OK");
      } finally { terminal.dispose(); }
    `], { cwd, encoding: "utf8", timeout: 8000, windowsHide: true });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /UNICODE_OFFSET_OK/u);
  });
}
