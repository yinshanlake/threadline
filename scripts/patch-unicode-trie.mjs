import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const manifest = require.resolve("@xterm/addon-unicode-graphemes/package.json");
const metadata = JSON.parse(await readFile(manifest, "utf8"));
if (metadata.version !== "0.4.0") {
  throw new Error("Review the Unicode trie byte-offset fix before changing @xterm/addon-unicode-graphemes.");
}

// 0.4.0 decodes base64 to a pooled Buffer but reads its backing allocation
// from byte zero. A nonzero byteOffset corrupts the header and can hang inflate.
const original = /new DataView\(([A-Za-z_$][\w$]*)\.buffer\)/gu;
const corrected = /new DataView\(([A-Za-z_$][\w$]*)\.buffer,\1\.byteOffset,\1\.byteLength\)/gu;
for (const file of ["lib/addon-unicode-graphemes.js", "lib/addon-unicode-graphemes.mjs"]) {
  const target = path.join(path.dirname(manifest), file);
  const source = await readFile(target, "utf8");
  const matches = [...source.matchAll(original)];
  const patched = [...source.matchAll(corrected)];
  if (matches.length === 0 && patched.length === 1) continue;
  if (matches.length !== 1 || patched.length !== 0) {
    throw new Error(`Unexpected Unicode trie constructor in ${file}; the dependency was not modified.`);
  }
  const result = source.replace(original, (_, value) =>
    `new DataView(${value}.buffer,${value}.byteOffset,${value}.byteLength)`);
  await writeFile(target, result, "utf8");
  console.log(`Applied Unicode trie byte-offset fix: ${file}`);
}
