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
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (char) => {
      const code = char.codePointAt(0);
      return code === 0x7f ? "␡" : String.fromCodePoint(0x2400 + code);
    })
    .replace(/[\x80-\x9f]/g, "�");
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
  if (/^\s*(?:\$\$|\\\[)[\s\S]*(?:\$\$|\\\])\s*$/u.test(text)) return "math";
  if (/^#{1,6}\s/u.test(text)) return "heading";
  if (lines.some((line) => /^\s*(?:[-+*]|\d+[.)])\s+/u.test(line))) return "list";
  if (lines.some((line) => /^\s*>/u.test(line))) return "quote";
  if (lines.length > 1 && lines.some((line) => /\|/u.test(line)) && lines.some((line) => /^\s*\|?\s*:?-{3,}/u.test(line))) return "table";
  return "paragraph";
}

function mappedText(entries, value, sourceStart, sourceEnd, tone) {
  for (const item of graphemes(sanitizeTerminalText(value))) {
    if (item === "\n") entries.push({ newline: true, sourceStart, sourceEnd, tone });
    else entries.push({ text: item, sourceStart, sourceEnd, tone });
  }
}

function rawRange(entries, source, start, end, base, tone) {
  for (const entry of graphemeEntries(source.slice(start, end))) {
    const index = start + entry.index;
    const item = entry.segment;
    if (item === "\r\n") {
      entries.push({ newline: true, sourceStart: base + index, sourceEnd: base + index + item.length, tone });
      continue;
    }
    if (item === "\r" && source[index + 1] === "\n") continue;
    if (item === "\n") entries.push({ newline: true, sourceStart: base + index, sourceEnd: base + index + item.length, tone });
    else mappedText(entries, item === "\t" ? "\t" : item, base + index, base + index + item.length, tone);
  }
}

function unescapedIndex(source, value, from, end = source.length) {
  let index = source.indexOf(value, from);
  while (index >= 0 && index < end) {
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1;
    if (slashes % 2 === 0) return index;
    index = source.indexOf(value, index + value.length);
  }
  return -1;
}

function characterBefore(source, index) {
  if (index <= 0) return "";
  const last = source.charCodeAt(index - 1);
  const start = last >= 0xdc00 && last <= 0xdfff
    && index > 1
    && source.charCodeAt(index - 2) >= 0xd800
    && source.charCodeAt(index - 2) <= 0xdbff
    ? index - 2
    : index - 1;
  return source.slice(start, index);
}

function characterAfter(source, index) {
  if (index >= source.length) return "";
  return String.fromCodePoint(source.codePointAt(index));
}

function delimiterFlanking(source, index, length, underscore = false) {
  const previous = characterBefore(source, index);
  const next = characterAfter(source, index + length);
  const previousWhitespace = !previous || /\s/u.test(previous);
  const nextWhitespace = !next || /\s/u.test(next);
  const previousPunctuation = Boolean(previous && /[\p{Punctuation}\p{Symbol}]/u.test(previous));
  const nextPunctuation = Boolean(next && /[\p{Punctuation}\p{Symbol}]/u.test(next));
  const leftFlanking = !nextWhitespace && (!nextPunctuation || previousWhitespace || previousPunctuation);
  const rightFlanking = !previousWhitespace && (!previousPunctuation || nextWhitespace || nextPunctuation);
  return underscore
    ? {
        canOpen: leftFlanking && (!rightFlanking || previousPunctuation),
        canClose: rightFlanking && (!leftFlanking || nextPunctuation),
      }
    : { canOpen: leftFlanking, canClose: rightFlanking };
}

function closingDelimiter(source, delimiter, from, end) {
  let index = unescapedIndex(source, delimiter, from, end);
  while (index >= 0) {
    if (delimiterFlanking(source, index, delimiter.length, delimiter[0] === "_").canClose) return index;
    index = unescapedIndex(source, delimiter, index + delimiter.length, end);
  }
  return -1;
}

function closingParen(source, start, end) {
  let depth = 0;
  for (let index = start; index < end; index += 1) {
    if (source[index] === "\\") { index += 1; continue; }
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return -1;
}

function braceGroup(source, start, end) {
  if (source[start] !== "{") return null;
  let depth = 0;
  for (let index = start; index < end; index += 1) {
    if (source[index] === "{" && source[index - 1] !== "\\") depth += 1;
    else if (source[index] === "}" && source[index - 1] !== "\\") {
      depth -= 1;
      if (depth === 0) return { contentStart: start + 1, contentEnd: index, next: index + 1 };
    }
  }
  return null;
}

const mathSymbols = {
  to: "→", rightarrow: "→", Rightarrow: "⇒", longrightarrow: "⟶",
  leftarrow: "←", Leftarrow: "⇐", longleftarrow: "⟵", leftrightarrow: "↔", Leftrightarrow: "⇔", mapsto: "↦",
  le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈", equiv: "≡",
  times: "×", cdot: "·", pm: "±", mp: "∓", div: "÷", infty: "∞", partial: "∂", nabla: "∇",
  sum: "∑", prod: "∏", int: "∫", in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", supset: "⊃", supseteq: "⊇",
  land: "∧", lor: "∨", neg: "¬", forall: "∀", exists: "∃", emptyset: "∅", degree: "°",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ", eta: "η", theta: "θ",
  iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ",
  tau: "τ", upsilon: "υ", phi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω"
};

const superscript = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ" };
const subscript = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎", a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ" };
const literalMath = new Set(["text", "textrm", "texttt", "operatorname", "url"]);
const unwrapMath = new Set(["mathrm", "mathbf", "mathit", "mathsf", "mathtt"]);
const ignoredMath = new Set(["displaystyle", "textstyle", "scriptstyle", "scriptscriptstyle"]);

function mathRange(entries, source, start, end, base, tone = "math") {
  let index = start;
  let pendingSpace = false;
  const emitSpace = (sourceIndex) => {
    if (!entries.length || entries.at(-1).newline || entries.at(-1).text === " ") return;
    mappedText(entries, " ", base + sourceIndex, base + sourceIndex + 1, tone);
  };
  while (index < end) {
    const char = source[index];
    if (/\s/u.test(char)) { pendingSpace = true; index += 1; continue; }
    if (pendingSpace) { emitSpace(index - 1); pendingSpace = false; }
    if (char === "&") { index += 1; continue; }
    if (char === "~") { emitSpace(index); index += 1; continue; }
    if (char === "{" || char === "}") { index += 1; continue; }
    if (char === "^" || char === "_") {
      const table = char === "^" ? superscript : subscript;
      const group = braceGroup(source, index + 1, end);
      const valueStart = group ? group.contentStart : index + 1;
      const valueEnd = group ? group.contentEnd : Math.min(end, index + 2);
      const value = source.slice(valueStart, valueEnd);
      const converted = Array.from(value).map((item) => table[item]).join("");
      if (converted.length === Array.from(value).length) mappedText(entries, converted, base + index, base + (group?.next ?? valueEnd), tone);
      else {
        mappedText(entries, char, base + index, base + index + 1, tone);
        if (group) mathRange(entries, source, valueStart, valueEnd, base, tone);
        else rawRange(entries, source, valueStart, valueEnd, base, tone);
      }
      index = group?.next ?? valueEnd;
      continue;
    }
    if (char !== "\\") { rawRange(entries, source, index, index + 1, base, tone); index += 1; continue; }
    if (source[index + 1] === "\\") { entries.push({ newline: true, sourceStart: base + index, sourceEnd: base + index + 2, tone }); index += 2; continue; }
    const commandMatch = source.slice(index + 1, end).match(/^[A-Za-z]+/u);
    if (!commandMatch) {
      const escaped = source[index + 1];
      if (["{", "}", "$", "%", "_", "#", "&"].includes(escaped)) { mappedText(entries, escaped, base + index, base + index + 2, tone); index += 2; continue; }
      if ([",", ":", ";", "!", " "].includes(escaped)) { emitSpace(index); index += 2; continue; }
      rawRange(entries, source, index, Math.min(end, index + 2), base, tone); index += 2; continue;
    }
    const command = commandMatch[0];
    const commandEnd = index + 1 + command.length;
    if (["left", "right"].includes(command)) { index = commandEnd; continue; }
    if (ignoredMath.has(command)) { index = commandEnd; continue; }
    if (command === "quad" || command === "qquad") { mappedText(entries, command === "qquad" ? "  " : " ", base + index, base + commandEnd, tone); index = commandEnd; continue; }
    if (mathSymbols[command]) { mappedText(entries, mathSymbols[command], base + index, base + commandEnd, tone); index = commandEnd; continue; }
    const group = braceGroup(source, commandEnd, end);
    if (["begin", "end"].includes(command) && group) { index = group.next; continue; }
    if (literalMath.has(command) && group) {
      rawRange(entries, source, group.contentStart, group.contentEnd, base, command === "texttt" ? "inlineCode" : command === "url" ? "link" : tone);
      index = group.next; continue;
    }
    if (unwrapMath.has(command) && group) { mathRange(entries, source, group.contentStart, group.contentEnd, base, tone); index = group.next; continue; }
    if (command === "sqrt" && group) {
      mappedText(entries, "√", base + index, base + commandEnd, tone);
      mappedText(entries, "(", base + commandEnd, base + group.contentStart, tone);
      mathRange(entries, source, group.contentStart, group.contentEnd, base, tone);
      mappedText(entries, ")", base + group.contentEnd, base + group.next, tone);
      index = group.next; continue;
    }
    if (command === "frac" && group) {
      const denominator = braceGroup(source, group.next, end);
      if (denominator) {
        mappedText(entries, "(", base + index, base + group.contentStart, tone);
        mathRange(entries, source, group.contentStart, group.contentEnd, base, tone);
        mappedText(entries, ")/(", base + group.contentEnd, base + denominator.contentStart, tone);
        mathRange(entries, source, denominator.contentStart, denominator.contentEnd, base, tone);
        mappedText(entries, ")", base + denominator.contentEnd, base + denominator.next, tone);
        index = denominator.next; continue;
      }
    }
    rawRange(entries, source, index, commandEnd, base, tone);
    index = commandEnd;
  }
}

function inlineRange(entries, source, start, end, base, tone) {
  let index = start;
  while (index < end) {
    if (source.startsWith("<br>", index) || source.startsWith("<br/>", index) || source.startsWith("<br />", index)) {
      const length = source.startsWith("<br />", index) ? 6 : source.startsWith("<br/>", index) ? 5 : 4;
      entries.push({ newline: true, sourceStart: base + index, sourceEnd: base + index + length, tone }); index += length; continue;
    }
    if (source.startsWith("$$", index)) {
      const close = unescapedIndex(source, "$$", index + 2, end);
      if (close >= 0) {
        let contentStart = index + 2; let contentEnd = close;
        while (contentStart < contentEnd && /\s/u.test(source[contentStart])) contentStart += 1;
        while (contentEnd > contentStart && /\s/u.test(source[contentEnd - 1])) contentEnd -= 1;
        mathRange(entries, source, contentStart, contentEnd, base); index = close + 2; continue;
      }
    }
    if (source[index] === "$" && source[index + 1] !== "$" && !/[\s\d{]/u.test(source[index + 1] || "")) {
      const close = unescapedIndex(source, "$", index + 1, end);
      const content = close >= 0 ? source.slice(index + 1, close) : "";
      if (close > index + 1
        && !/\s/u.test(source[close - 1])
        && !/[A-Za-z0-9_{]/u.test(source[close + 1] || "")
        && !/[\r\n]/u.test(content)) {
        mathRange(entries, source, index + 1, close, base); index = close + 1; continue;
      }
    }
    if (source.startsWith("\\(", index)) {
      const close = unescapedIndex(source, "\\)", index + 2, end);
      if (close >= 0) { mathRange(entries, source, index + 2, close, base); index = close + 2; continue; }
    }
    if (source.startsWith("\\[", index)) {
      const close = unescapedIndex(source, "\\]", index + 2, end);
      if (close >= 0) { mathRange(entries, source, index + 2, close, base); index = close + 2; continue; }
    }
    if (source[index] === "\\" && index + 1 < end && /[\\`*{}\[\]()#+.!_$~|\-]/u.test(source[index + 1])) {
      mappedText(entries, source[index + 1], base + index, base + index + 2, tone); index += 2; continue;
    }
    const delimiter = source.startsWith("***", index) || source.startsWith("___", index) ? source.slice(index, index + 3)
      : source.startsWith("**", index) || source.startsWith("__", index) ? source.slice(index, index + 2)
        : source.startsWith("~~", index) ? "~~" : null;
    if (delimiter && delimiterFlanking(source, index, delimiter.length, delimiter[0] === "_").canOpen) {
      const close = closingDelimiter(source, delimiter, index + delimiter.length, end);
      if (close >= 0) {
        inlineRange(entries, source, index + delimiter.length, close, base, delimiter === "~~" ? "strike" : "strong");
        index = close + delimiter.length;
        continue;
      }
    }
    if (source[index] === "`") {
      let count = 1; while (source[index + count] === "`") count += 1;
      const ticks = "`".repeat(count);
      const close = unescapedIndex(source, ticks, index + count, end);
      if (close >= 0) { rawRange(entries, source, index + count, close, base, "inlineCode"); index = close + count; continue; }
    }
    if (source[index] === "[") {
      const labelEnd = unescapedIndex(source, "]", index + 1, end);
      if (labelEnd >= 0 && source[labelEnd + 1] === "(") {
        const urlEnd = closingParen(source, labelEnd + 2, end);
        if (urlEnd >= 0) {
          inlineRange(entries, source, index + 1, labelEnd, base, "link");
          const url = source.slice(labelEnd + 2, urlEnd).trim();
          if (url && url !== source.slice(index + 1, labelEnd)) {
            mappedText(entries, " <", base + labelEnd, base + labelEnd + 2, "link");
            rawRange(entries, source, labelEnd + 2, urlEnd, base, "link");
            mappedText(entries, ">", base + urlEnd, base + urlEnd + 1, "link");
          }
          index = urlEnd + 1; continue;
        }
      }
    }
    if (source[index] === "<") {
      const close = source.indexOf(">", index + 1);
      const value = close >= 0 ? source.slice(index + 1, close) : "";
      if (close < end && /^(?:https?:\/\/|mailto:)/iu.test(value)) { rawRange(entries, source, index + 1, close, base, "link"); index = close + 1; continue; }
    }
    if ((source[index] === "*" || source[index] === "_")
      && source[index - 1] !== source[index] && source[index + 1] !== source[index]
      && delimiterFlanking(source, index, 1, source[index] === "_").canOpen) {
      const close = closingDelimiter(source, source[index], index + 1, end);
      if (close > index + 1) {
        inlineRange(entries, source, index + 1, close, base, "emphasis"); index = close + 1; continue;
      }
    }
    rawRange(entries, source, index, index + 1, base, tone);
    index += 1;
  }
}

function tableCellRanges(value) {
  const separators = [];
  let codeTicks = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\") { index += 1; continue; }
    if (value[index] === "`") {
      let count = 1;
      while (value[index + count] === "`") count += 1;
      if (!codeTicks) codeTicks = count;
      else if (codeTicks === count) codeTicks = 0;
      index += count - 1;
      continue;
    }
    if (value[index] === "|" && !codeTicks) separators.push(index);
  }
  const boundaries = [-1, ...separators, value.length];
  const cells = boundaries.slice(0, -1).map((boundary, index) => ({
    start: boundary + 1,
    end: boundaries[index + 1],
  }));
  if (cells.length > 1 && !value.slice(cells[0].start, cells[0].end).trim()) cells.shift();
  if (cells.length > 1 && !value.slice(cells.at(-1).start, cells.at(-1).end).trim()) cells.pop();
  return cells;
}

function tableCellSpan(cell, line) {
  if (cell && cell.end > cell.start) return { start: cell.start, end: cell.end };
  return { start: 0, end: Math.max(1, line.value.length) };
}

function tableEntries(entries, source, base, tone) {
  let offset = 0;
  const lines = source.split(/(?<=\n)/u).map((raw) => {
    const newlineLength = raw.endsWith("\n") ? (raw.endsWith("\r\n") ? 2 : 1) : 0;
    const value = newlineLength ? raw.slice(0, -newlineLength) : raw;
    const cells = tableCellRanges(value);
    const separator = cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/u.test(value.slice(cell.start, cell.end)));
    const line = { raw, value, cells, separator, offset, newlineLength, rendered: [] };
    for (const cell of cells) {
      let start = cell.start; let end = cell.end;
      while (start < end && /\s/u.test(value[start])) start += 1;
      while (end > start && /\s/u.test(value[end - 1])) end -= 1;
      const rendered = [];
      if (!separator) inlineRange(rendered, value, start, end, base + offset, tone);
      line.rendered.push({ entries: rendered, width: rendered.reduce((sum, entry) => sum + (entry.newline ? 0 : displayWidth(entry.text)), 0) });
    }
    offset += raw.length;
    return line;
  });
  const columns = Math.max(0, ...lines.map((line) => line.cells.length));
  const widths = Array.from({ length: columns }, (_, column) => Math.max(3, ...lines
    .filter((line) => !line.separator)
    .map((line) => line.rendered[column]?.width ?? 0)));
  const separatorLine = lines.find((line) => line.separator);
  const alignments = Array.from({ length: columns }, (_, column) => {
    const cell = separatorLine?.cells[column];
    const value = cell ? separatorLine.value.slice(cell.start, cell.end).trim() : "";
    return value.startsWith(":") && value.endsWith(":") ? "center" : value.endsWith(":") ? "right" : "left";
  });

  for (const line of lines) {
    for (let column = 0; column < columns; column += 1) {
      const cell = line.cells[column];
      const span = tableCellSpan(cell, line);
      const sourceStart = base + line.offset + span.start;
      const sourceEnd = base + line.offset + Math.min(line.value.length, span.end);
      if (line.separator) {
        const extra = columns === 1 ? 0 : column === 0 || column === columns - 1 ? 1 : 2;
        mappedText(entries, "─".repeat(widths[column] + extra), sourceStart, Math.max(sourceStart + 1, sourceEnd), tone);
      } else {
        const rendered = line.rendered[column] ?? { entries: [], width: 0 };
        const padding = Math.max(0, widths[column] - rendered.width);
        const leading = alignments[column] === "right" ? padding : alignments[column] === "center" ? Math.floor(padding / 2) : 0;
        const trailing = padding - leading;
        if (leading) mappedText(entries, " ".repeat(leading), sourceStart, Math.max(sourceStart + 1, sourceEnd), tone);
        entries.push(...rendered.entries);
        if (trailing) mappedText(entries, " ".repeat(trailing), sourceStart, Math.max(sourceStart + 1, sourceEnd), tone);
      }
      if (column < columns - 1) {
        const divider = line.separator ? "┼" : " │ ";
        mappedText(entries, divider, sourceStart, Math.max(sourceStart + 1, sourceEnd), tone);
      }
    }
    if (line.newlineLength) entries.push({
      newline: true,
      sourceStart: base + line.offset + line.value.length,
      sourceEnd: base + line.offset + line.raw.length,
      tone,
    });
  }
}

function terminalMarkupEntries(text, sourceStart, type) {
  const source = String(text);
  const entries = [];
  if (type === "code") {
    const opening = source.match(/^\s*(`{3,}|~{3,})[^\n]*(?:\n|$)/u);
    let start = opening?.[0].length ?? 0;
    let end = source.length;
    const closing = source.slice(start).match(/(?:^|\n)\s*(`{3,}|~{3,})\s*$/u);
    if (opening && closing?.index !== undefined
      && closing[1][0] === opening[1][0]
      && closing[1].length >= opening[1].length) {
      end = start + closing.index + (closing[0].startsWith("\n") ? 1 : 0);
    }
    rawRange(entries, source, start, end, sourceStart, "code");
    return entries;
  }
  if (type === "math") {
    const trimmedStart = source.search(/\S/u);
    const first = Math.max(0, trimmedStart);
    const openLength = source.startsWith("$$", first) || source.startsWith("\\[", first) ? 2 : 0;
    const closeToken = source.startsWith("$$", first) ? "$$" : "\\]";
    const close = source.lastIndexOf(closeToken);
    let start = first + openLength; let end = close > start ? close : source.length;
    while (start < end && /\s/u.test(source[start])) start += 1;
    while (end > start && /\s/u.test(source[end - 1])) end -= 1;
    mathRange(entries, source, start, end, sourceStart);
    return entries;
  }
  if (type === "table") { tableEntries(entries, source, sourceStart, type); return entries; }
  let start = 0;
  if (type === "heading") {
    start = source.match(/^#{1,6}[ \t]+/u)?.[0].length ?? 0;
    const closing = source.slice(start).match(/[ \t]+#+[ \t]*$/u);
    const end = closing?.index === undefined ? source.length : start + closing.index;
    inlineRange(entries, source, start, end, sourceStart, type);
    return entries;
  }
  if (type === "quote") {
    let offset = 0;
    for (const line of source.split(/(?<=\n)/u)) {
      const marker = line.match(/^\s*>[ \t]?/u)?.[0].length ?? 0;
      inlineRange(entries, source, offset + marker, offset + line.length, sourceStart, type);
      offset += line.length;
    }
    return entries;
  }
  inlineRange(entries, source, start, source.length, sourceStart, type);
  return entries;
}

export function terminalMarkup(text, { sourceStart = 0, type = "paragraph" } = {}) {
  return terminalMarkupEntries(text, sourceStart, type).map((entry) => ({ ...entry }));
}

export function terminalPlainText(text, type = null) {
  const source = String(text);
  const resolvedType = type || contentBlocks(source)[0]?.type || "paragraph";
  return terminalMarkupEntries(source, 0, resolvedType).map((entry) => entry.newline ? "\n" : entry.text).join("");
}

export function terminalDocumentText(text) {
  const source = String(text);
  const blocks = contentBlocks(source);
  if (!blocks.length) return sanitizeTerminalText(source);
  return blocks.map((block) => terminalPlainText(block.text, block.type)).join("\n\n");
}

export function contentBlocks(text) {
  const blocks = [];
  const lines = text.split(/(?<=\n)/);
  let offset = 0;
  let start = 0;
  let buffer = "";
  let codeFence = null;
  let bufferCode = false;
  let mathFence = null;

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
    if (codeFence) {
      const closing = trimmed.match(/^(`{3,}|~{3,})[ \t]*(?:\r?\n)?$/u);
      buffer += line;
      offset += line.length;
      if (closing && closing[1][0] === codeFence.marker && closing[1].length >= codeFence.length) {
        codeFence = null;
        flush();
      }
      continue;
    }
    if (!codeFence && !mathFence && (trimmed.startsWith("$$") || trimmed.startsWith("\\["))) {
      if (buffer.trim()) flush();
      if (!buffer) start = offset;
      mathFence = trimmed.startsWith("$$") ? "$$" : "\\]";
      buffer += line;
      offset += line.length;
      const afterOpen = trimmed.slice(2);
      if ((mathFence === "$$" && afterOpen.includes("$$")) || (mathFence === "\\]" && afterOpen.includes("\\]"))) { mathFence = null; flush(); }
      continue;
    }
    if (mathFence) {
      buffer += line;
      offset += line.length;
      if (trimmed.includes(mathFence)) { mathFence = null; flush(); }
      continue;
    }
    const openingFence = !mathFence ? trimmed.match(/^(`{3,}|~{3,})[^\r\n]*(?:\r?\n)?$/u) : null;
    if (openingFence) {
      if (buffer.trim()) flush();
      if (!buffer) { start = offset; bufferCode = true; }
      codeFence = { marker: openingFence[1][0], length: openingFence[1].length };
      buffer += line;
      offset += line.length;
      continue;
    }
    if (!codeFence && line.trim() === "") {
      flush();
      offset += line.length;
      start = offset;
      continue;
    }
    const headingLine = /^#{1,6}(?:[ \t]|$)/u.test(trimmed);
    const quoteLine = /^>[ \t]?/u.test(trimmed);
    const bufferedQuote = /^\s*>[ \t]?/u.test(buffer);
    if (headingLine) {
      if (buffer.trim()) flush();
      start = offset;
      buffer = line;
      offset += line.length;
      flush();
      continue;
    }
    if (buffer && quoteLine !== bufferedQuote && (quoteLine || bufferedQuote)) {
      flush();
      start = offset;
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
    const source = ["code", "table", "heading", "math"].includes(block.type)
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

export function wrapAnnotatedText(text, width, { sourceStart = 0, ranges = [], type = "paragraph" } = {}) {
  const limit = Math.max(1, width);
  const entries = [];
  let column = 0;
  const toParts = (line) => {
    const parts = [];
    const append = (value, selectableIndex, tone) => {
      const last = parts.at(-1);
      if (last && last.selectableIndex === selectableIndex && last.tone === tone) last.text += value;
      else parts.push({ text: value, selectableIndex, tone });
    };
    for (const entry of line) append(entry.text, entry.selectableIndex, entry.tone);
    return { parts };
  };
  const append = (value, itemWidth, selectableIndex, tone) => {
    entries.push({ text: value, width: itemWidth, selectableIndex, tone });
  };

  for (const entry of terminalMarkupEntries(text, sourceStart, type)) {
    if (entry.newline) { entries.push({ newline: true }); column = 0; continue; }
    let visible = entry.text;
    let itemWidth = visible === "\t" ? tabAdvance(column) : displayWidth(visible);
    if (visible === "\t") visible = " ".repeat(itemWidth);
    const start = entry.sourceStart;
    const end = entry.sourceEnd;
    const range = ranges.find((candidate) => candidate.start < end && candidate.end > start);
    append(visible, itemWidth, range?.selectableIndex, entry.tone);
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
