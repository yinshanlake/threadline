const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

const sentenceSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "sentence" })
  : null;

const TAB_SIZE = 8;

function tabAdvance(column) {
  return TAB_SIZE - (column % TAB_SIZE);
}

export function graphemes(text) {
  if (!segmenter) return Array.from(text);
  return Array.from(segmenter.segment(text), (entry) => entry.segment);
}

export function graphemeEntries(text) {
  if (segmenter) return Array.from(segmenter.segment(text), (entry) => ({ segment: entry.segment, index: entry.index }));
  const entries = [];
  let index = 0;
  for (const item of Array.from(text)) { entries.push({ segment: item, index }); index += item.length; }
  return entries;
}

export function sanitizeTerminalText(text) {
  return String(text)
    .replace(/\x1b/g, "␛")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (char) => {
      const code = char.codePointAt(0);
      return code === 0x7f ? "␡" : String.fromCodePoint(0x2400 + code);
    });
}

function isWide(grapheme) {
  const cp = grapheme.codePointAt(0) ?? 0;
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(grapheme)) return true;
  return (
    cp >= 0x1100 && (
      cp <= 0x115f ||
      cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    )
  );
}

export function displayWidth(text) {
  let width = 0;
  for (const item of graphemes(text)) {
    if (item === "\t") { width += tabAdvance(width); continue; }
    if (/^[\p{Mark}\u200d\ufe0e\ufe0f]+$/u.test(item)) continue;
    const cp = item.codePointAt(0) ?? 0;
    if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) continue;
    width += isWide(item) ? 2 : 1;
  }
  return width;
}

export function wrapText(text, width) {
  const limit = Math.max(1, width);
  const output = [];
  for (const sourceLine of String(text).replace(/\r/g, "").split("\n")) {
    if (sourceLine.length === 0) {
      output.push("");
      continue;
    }
    let line = "";
    let lineWidth = 0;
    for (const item of graphemes(sourceLine)) {
      let visible = item;
      let itemWidth = item === "\t" ? tabAdvance(lineWidth) : displayWidth(item);
      if (line && lineWidth + itemWidth > limit) {
        output.push(line);
        line = "";
        lineWidth = 0;
        itemWidth = item === "\t" ? tabAdvance(lineWidth) : itemWidth;
      }
      if (item === "\t") visible = " ".repeat(itemWidth);
      line += visible;
      lineWidth += itemWidth;
    }
    output.push(line);
  }
  return output.length ? output : [""];
}

function breakOpportunity(previous, current) {
  if (!previous) return false;
  if (/\s/u.test(previous)) return true;
  if (/[-_/.:,;!?，。；！？、）】》]/u.test(previous)) return true;
  if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(previous)) return true;
  return /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(current);
}

function wrapEntries(entries, width) {
  const limit = Math.max(1, width);
  const lines = [];
  let line = [];
  let lineWidth = 0;
  let lastBreak = 0;
  const recalculateBreak = () => {
    lastBreak = 0;
    for (let index = 1; index < line.length; index += 1) {
      if (breakOpportunity(line[index - 1].text, line[index].text)) lastBreak = index;
    }
  };
  const pushLine = (split = line.length) => {
    lines.push(line.slice(0, split));
    line = line.slice(split);
    lineWidth = line.reduce((sum, entry) => sum + entry.width, 0);
    recalculateBreak();
  };

  for (const entry of entries) {
    if (entry.newline) { pushLine(); continue; }
    if (line.length && breakOpportunity(line.at(-1).text, entry.text)) lastBreak = line.length;
    if (line.length && lineWidth + entry.width > limit) {
      if (lastBreak > 0) pushLine(lastBreak);
      else pushLine();
    }
    line.push(entry);
    lineWidth += entry.width;
  }
  if (line.length || !lines.length) lines.push(line);
  return lines;
}

export function wrapDisplayText(text, width) {
  const entries = [];
  let column = 0;
  for (const item of graphemes(String(text).replace(/\r/g, ""))) {
    if (item === "\n") { entries.push({ newline: true }); column = 0; continue; }
    const itemWidth = item === "\t" ? tabAdvance(column) : displayWidth(item);
    entries.push({ text: item === "\t" ? " ".repeat(itemWidth) : item, width: itemWidth });
    column += itemWidth;
  }
  return wrapEntries(entries, width).map((line) => line.map((entry) => entry.text).join(""));
}

function blockType(text, code) {
  if (code) return "code";
  const lines = text.split("\n");
  if (/^#{1,6}\s/u.test(text)) return "heading";
  if (lines.some((line) => /^\s*(?:[-+*]|\d+[.)])\s+/u.test(line))) return "list";
  if (lines.some((line) => /^\s*>/u.test(line))) return "quote";
  if (lines.length > 1 && lines.some((line) => /\|/u.test(line)) && lines.some((line) => /^\s*\|?\s*:?-{3,}/u.test(line))) return "table";
  return "paragraph";
}

export function contentBlocks(text) {
  const blocks = [];
  const lines = text.split(/(?<=\n)/);
  let offset = 0;
  let start = 0;
  let buffer = "";
  let codeFence = false;
  let bufferCode = false;

  const flush = () => {
    const raw = buffer;
    const leading = raw.match(/^\s*/u)?.[0].length ?? 0;
    const trailing = raw.match(/\s*$/u)?.[0].length ?? 0;
    const value = raw.slice(leading, Math.max(leading, raw.length - trailing));
    if (value) {
      blocks.push({ text: value, start: start + leading, end: start + leading + value.length, type: blockType(value, bufferCode) });
    }
    buffer = "";
    bufferCode = false;
  };

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!buffer) start = offset;
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      if (!codeFence && buffer.trim()) flush();
      if (!buffer) { start = offset; bufferCode = true; }
      codeFence = !codeFence;
      buffer += line;
      offset += line.length;
      if (!codeFence) flush();
      continue;
    }
    if (!codeFence && line.trim() === "") {
      flush();
      offset += line.length;
      start = offset;
      continue;
    }
    buffer += line;
    offset += line.length;
  }
  flush();
  return blocks;
}

function fallbackSentences(text) {
  const results = [];
  const pattern = /[^.!?。！？；;\n]+(?:[.!?。！？；;]+|$)/gu;
  for (const match of text.matchAll(pattern)) {
    results.push({ segment: match[0], index: match.index ?? 0 });
  }
  return results.length ? results : [{ segment: text, index: 0 }];
}

export function textSegments(text) {
  const result = [];
  const blocks = contentBlocks(String(text));
  blocks.forEach((block, blockIndex) => {
    const source = block.type === "code" || block.type === "table" || block.type === "heading"
      ? [{ segment: block.text, index: 0 }]
      : sentenceSegmenter
        ? Array.from(sentenceSegmenter.segment(block.text))
        : fallbackSentences(block.text);
    let segmentIndex = 0;
    for (const entry of source) {
      const raw = entry.segment;
      const leading = raw.match(/^\s*/u)?.[0].length ?? 0;
      const value = raw.trim();
      if (!value) continue;
      const start = block.start + entry.index + leading;
      result.push({
        text: value,
        start,
        end: start + value.length,
        blockIndex,
        segmentIndex: segmentIndex++,
        blockType: block.type
      });
    }
  });
  return result;
}

export function wrapAnnotatedText(text, width, { sourceStart = 0, ranges = [] } = {}) {
  const limit = Math.max(1, width);
  const entries = [];
  let column = 0;
  const toParts = (line) => {
    const parts = [];
    const append = (value, selectableIndex) => {
      const last = parts.at(-1);
      if (last && last.selectableIndex === selectableIndex) last.text += value;
      else parts.push({ text: value, selectableIndex });
    };
    for (const entry of line) append(entry.text, entry.selectableIndex);
    return { parts };
  };
  const append = (value, itemWidth, selectableIndex) => {
    entries.push({ text: value, width: itemWidth, selectableIndex });
  };

  for (const entry of graphemeEntries(String(text).replace(/\r/g, ""))) {
    const item = entry.segment;
    if (item === "\n") { entries.push({ newline: true }); column = 0; continue; }
    let visible = sanitizeTerminalText(item);
    let itemWidth = item === "\t" ? tabAdvance(column) : displayWidth(visible);
    if (item === "\t") visible = " ".repeat(itemWidth);
    const start = sourceStart + entry.index;
    const end = start + item.length;
    const range = ranges.find((candidate) => candidate.start < end && candidate.end > start);
    append(visible, itemWidth, range?.selectableIndex);
    column += itemWidth;
  }
  return wrapEntries(entries, limit).map(toParts);
}

export function truncate(text, width) {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  const suffix = "…";
  const limit = Math.max(0, width - displayWidth(suffix));
  let value = "";
  let current = 0;
  for (const item of graphemes(text)) {
    const next = current + displayWidth(item);
    if (next > limit) break;
    value += item;
    current = next;
  }
  return value + suffix;
}
