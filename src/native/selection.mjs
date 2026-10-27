import { contentBlocks, graphemeEntries, terminalMarkup } from "../text.mjs";

export function nativeSelectionSources(scopes, scopeId) {
  const source = scopes.find((scope) => scope.id === scopeId);
  if (!source) throw new Error("The native source conversation is no longer available.");
  const inherited = new Set(source.inheritedTurnIds || []);
  const path = [];
  let scope = source;
  while (scope && !path.includes(scope)) {
    path.unshift(scope);
    scope = scopes.find((item) => item.id === scope.parentId);
  }
  return path.flatMap((owner) => owner.turns
    .filter((turn) => owner === source || inherited.has(turn.providerTurnId))
    .map((turn) => ({ scope: owner, turn })));
}

function projection(entries) {
  let text = "";
  const offsets = [];
  for (const entry of entries) {
    const visible = (entry.newline ? "\n" : entry.text).replace(/\s/gu, "");
    for (let index = 0; index < visible.length; index += 1) {
      offsets.push({ start: entry.sourceStart, end: entry.sourceEnd });
    }
    text += visible;
  }
  return { text, offsets };
}

export function resolveNativeSelection(scopes, scopeId, selectedText, { context } = {}) {
  if (typeof selectedText !== "string" || !selectedText.trim() || selectedText.length > 16000) {
    throw new Error("Select a passage of at most 16,000 characters in a completed native answer.");
  }
  // Only layout whitespace is ignored. Every visible glyph must map back to
  // canonical text; no terminal row is ever imported as conversation history.
  const needle = selectedText.replace(/\s/gu, "");
  if (context !== undefined && (typeof context !== "string" || context.length > 20000)) {
    throw new Error("Select a shorter passage so its native source lines can be checked.");
  }
  // Codex marks an assistant's first line with a bullet. Keep input prompts,
  // tool borders and other chrome intact so an echoed quote is not an answer.
  const surrounding = context?.split(/\r?\n/u).map((line) => line.replace(/^\s*\u2022\s?/u, "")).join("").replace(/\s/gu, "");
  const matches = new Map();
  for (const { scope, turn } of nativeSelectionSources(scopes, scopeId)) {
    const source = turn.assistant.text;
    const rendered = contentBlocks(source).flatMap((block) =>
      terminalMarkup(block.text, { sourceStart: block.start, type: block.type }));
    const literal = graphemeEntries(source).map(({ segment, index }) => ({
      text: segment, sourceStart: index, sourceEnd: index + segment.length,
    }));
    for (const entries of [rendered, literal]) {
      const { text, offsets } = projection(entries);
      let index = text.indexOf(needle);
      while (index >= 0) {
        const last = index + needle.length - 1;
        const start = offsets[index].start;
        const end = offsets[last].end;
        // Never anchor half of a grapheme or of a rendered math replacement.
        if (offsets[index - 1]?.start !== start && offsets[last + 1]?.end !== end) {
          const key = `${scope.id}:${turn.id}:${start}:${end}`;
          let contextIndex = surrounding ? text.indexOf(surrounding) : -1;
          let contextMatched = context === undefined;
          while (contextIndex >= 0) {
            if (contextIndex <= index && contextIndex + surrounding.length >= index + needle.length) { contextMatched = true; break; }
            contextIndex = text.indexOf(surrounding, contextIndex + 1);
          }
          matches.set(key, {
            scopeId: scope.id, sourceThreadId: scope.threadId, turnId: turn.id,
            providerTurnId: turn.providerTurnId, start, end, quote: source.slice(start, end),
            complete: turn.assistant.status === "complete",
            contextMatched: contextMatched || Boolean(matches.get(key)?.contextMatched),
          });
          if (matches.size > 1) {
            throw new Error("This selection matches more than one answer or passage. Select a longer, unique excerpt; no branch was created.");
          }
        }
        index = text.indexOf(needle, index + 1);
      }
    }
  }
  const match = [...matches.values()][0];
  if (!match || !match.complete || !match.sourceThreadId || !match.providerTurnId || !match.contextMatched) {
    throw new Error("This text could not be mapped to a completed answer in this native session. Wait for completion or select a longer passage without terminal controls.");
  }
  const { complete, contextMatched, ...selection } = match;
  return selection;
}
