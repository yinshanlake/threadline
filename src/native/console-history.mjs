import { findScope } from "../model.mjs";
import { buildConversationView, applyTone } from "../render.mjs";
import { displayWidth, sanitizeTerminalText, terminalPlainText, truncate } from "../text.mjs";

export function historyRoot(conversation, scopeId) {
  let scope = findScope(conversation, scopeId); const visited = new Set();
  while (scope?.parentId && !visited.has(scope.id)) { visited.add(scope.id); scope = findScope(conversation, scope.parentId); }
  return scope?.id || conversation.rootScopeId;
}

export function selectionKey(item) {
  if (!item) return null;
  if (item.kind === "segment") return [item.kind, item.scopeId, item.turnId, item.segment.start, item.segment.end].join(":");
  if (item.kind === "turn") return [item.kind, item.scopeId, item.turnId].join(":");
  if (item.kind === "branch-group") return [item.kind, item.parentScopeId, item.anchor.messageId, item.anchor.sourceStart, item.anchor.sourceEnd].join(":");
  return [item.kind, item.scopeId, item.groupId || item.activityId || ""].join(":");
}

export function historyView(conversation, { width, scopeId, tree = false, granularity = "block", activityGroups = new Map(), newTurns = null }) {
  if (tree) {
    const lines = []; const selectables = []; const visited = new Set();
    const visit = (scope, depth) => {
      if (visited.has(scope.id)) return; visited.add(scope.id);
      const selectableIndex = selectables.length;
      selectables.push({ kind: "scope", scopeId: scope.id });
      const title = scope.native?.question || scope.native?.title || scope.turns[0]?.user.text || "Main conversation";
      const label = (scope.id === conversation.activeScopeId ? "● " : "  ") + "  ".repeat(depth) + terminalPlainText(title).replace(/\s+/gu, " ");
      lines.push({ text: truncate(label, width), parts: [{ text: truncate(label, width), tone: scope.parentId ? "thread" : "user", selectableIndex }], selectableIndex });
      for (const child of conversation.scopes.filter((item) => item.parentId === scope.id)) visit(child, depth + 1);
    };
    for (const scope of conversation.scopes.filter((item) => !item.parentId)) visit(scope, 0);
    return { lines, selectables };
  }
  return buildConversationView(conversation, { width, scopeId, granularity, sourceMap: true, activityGroups, hierarchy: true, newTurns });
}

export function sourceAt(view, lineIndex, column) {
  const line = view.lines[lineIndex];
  if (!line?.scopeId || !line.turnId) return null;
  let x = 0;
  for (const part of line.parts || []) {
    const width = displayWidth(part.text);
    if (column >= x && column < x + width && Number.isInteger(part.sourceStart)) {
      return { scopeId: line.scopeId, turnId: line.turnId, start: part.sourceStart, end: part.sourceEnd };
    }
    x += width;
  }
  return null;
}

export function selectedSource(conversation, start, end) {
  if (!start || !end || start.scopeId !== end.scopeId || start.turnId !== end.turnId) return null;
  const turn = findScope(conversation, start.scopeId)?.turns.find((item) => item.id === start.turnId);
  if (turn?.assistant.status !== "complete") return null;
  const low = Math.min(start.start, end.start); const high = Math.max(start.end, end.end);
  const quote = turn.assistant.text.slice(low, high);
  if (!quote.trim()) return null;
  return { scopeId: start.scopeId, turnId: start.turnId, start: low, end: high, quote };
}

export function paintHistoryLine(line, selection, { colors, focused, range }) {
  return (line.parts || [{ text: line.text }]).map((part) => {
    const selected = focused && (range ? line.scopeId === range.scopeId && line.turnId === range.turnId &&
      part.sourceStart < range.end && part.sourceEnd > range.start : part.selectableIndex === selection);
    return applyTone(part.text, part.tone || line.tone, selected, colors, part.accent ?? line.accent ?? null);
  }).join("");
}

export function oneLine(value) { return sanitizeTerminalText(value).replace(/\s+/gu, " "); }
