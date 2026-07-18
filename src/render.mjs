import { assistantMessageParts, childScopes, findScope, scopeDepth, segmentsForTurn } from "./model.mjs";
import { contentBlocks, displayWidth, sanitizeTerminalText, truncate, wrapAnnotatedText, wrapDisplayText } from "./text.mjs";

export const ansi = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", italic: "\x1b[3m", underline: "\x1b[4m",
  cyan: "\x1b[36m", yellow: "\x1b[33m", red: "\x1b[31m", inverse: "\x1b[7m"
};

function makeLine(parts = [], options = {}) {
  const normalized = typeof parts === "string" ? [{ text: parts, tone: options.tone }] : parts;
  return { ...options, parts: normalized, text: normalized.map((part) => part.text).join("") };
}

function addLine(lines, parts = [], options = {}) { lines.push(makeLine(parts, options)); }
function turnCount(scopes) { return scopes.reduce((sum, scope) => sum + scope.turns.length, 0); }

const assistantRail = "  │ ";
const assistantRailBlank = "  │";

function addWrapped(lines, text, width, { prefix = "", continuation, tone, selectableIndex } = {}) {
  const safe = sanitizeTerminalText(text);
  const rest = continuation ?? " ".repeat(displayWidth(prefix));
  const usable = Math.max(1, width - displayWidth(prefix));
  wrapDisplayText(safe, usable).forEach((value, index) => addLine(lines, [
    { text: index === 0 ? prefix : rest, tone: "dim" },
    { text: value, tone, selectableIndex },
  ], { selectableIndex }));
}

function blockSelection(turn, message, block, blockPosition) {
  const start = message.sourceStart + block.start;
  const end = message.sourceStart + block.end;
  return {
    text: block.text, start, end, blockIndex: blockPosition, segmentIndex: 0, blockType: block.type,
    key: `${turn.assistant.id}:${start}:${end}`, messageId: turn.assistant.id, turnId: turn.id, providerTurnId: turn.providerTurnId,
  };
}

function anchoredGroups(conversation, scopeId, messageId, start, end) {
  const groups = new Map();
  for (const branch of childScopes(conversation, scopeId)) {
    const anchor = branch.anchor;
    if (anchor?.messageId !== messageId || anchor.sourceStart < start || anchor.sourceStart >= end) continue;
    const key = `${anchor.messageId}:${anchor.sourceStart}:${anchor.sourceEnd}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(branch);
  }
  return [...groups.values()];
}

function renderMessage(lines, selectables, conversation, scope, turn, message, width, { inline = false, granularity = "block" } = {}) {
  const allSegments = segmentsForTurn(turn);
  const blocks = contentBlocks(message.text);
  const baseIndent = inline ? "  │   │ " : assistantRail;
  const codeIndent = inline ? "  │   │   " : "  │   ";

  blocks.forEach((block, blockPosition) => {
    const globalStart = message.sourceStart + block.start;
    const globalEnd = message.sourceStart + block.end;
    const blockSegments = granularity === "sentence"
      ? allSegments.filter((segment) => segment.start >= globalStart && segment.end <= globalEnd)
      : [blockSelection(turn, message, block, blockPosition)];
    const ranges = [];
    for (const segment of blockSegments) {
      if (turn.assistant.status !== "complete") continue;
      const selectableIndex = selectables.length;
      selectables.push({ kind: "segment", scopeId: scope.id, turnId: turn.id, segment });
      ranges.push({ start: segment.start, end: segment.end, selectableIndex });
    }
    const prefix = block.type === "code" ? codeIndent : baseIndent;
    const usable = Math.max(1, width - displayWidth(prefix));
    const annotated = wrapAnnotatedText(block.text, usable, { sourceStart: globalStart, ranges });
    annotated.forEach((line) => {
      const parts = [{ text: prefix, tone: block.type === "code" ? "codeBorder" : "dim" }];
      const bodyTone = turn.assistant.status === "failed" ? "error" : message.phase === "commentary" ? "commentary" : block.type;
      for (const part of line.parts) parts.push({ text: part.text, tone: bodyTone, selectableIndex: part.selectableIndex });
      addLine(lines, parts, { selectableIndices: [...new Set(line.parts.map((part) => part.selectableIndex).filter((value) => value !== undefined))] });
    });

    for (const branches of anchoredGroups(conversation, scope.id, turn.assistant.id, globalStart, globalEnd)) {
      renderInlineBranches(lines, selectables, conversation, branches, width, baseIndent);
    }
    if (blockPosition < blocks.length - 1) addLine(lines, inline ? "  │   │" : assistantRailBlank, { tone: "rail" });
  });
}

function branchSummary(branches) {
  const replies = turnCount(branches);
  return `${branches.length} ${branches.length === 1 ? "thread" : "threads"}  ${replies} ${replies === 1 ? "reply" : "replies"}`;
}

function renderInlineBranches(lines, selectables, conversation, branches, width, indent) {
  const collapsed = branches.every((branch) => branch.collapsed);
  const groupIndex = selectables.length;
  selectables.push({ kind: "branch-group", scopeIds: branches.map((branch) => branch.id), parentScopeId: branches[0].parentId, anchor: branches[0].anchor });
  addWrapped(lines, `${collapsed ? "▸" : "▾"} ${branchSummary(branches)}`, width, { prefix: indent, continuation: `${indent}  `, tone: "thread", selectableIndex: groupIndex });
  if (collapsed) return;

  branches.forEach((branch, branchPosition) => {
    if (branchPosition > 0) addLine(lines, indent.trimEnd(), { tone: "rail" });
    const branchIndex = selectables.length;
    selectables.push({ kind: "branch", scopeId: branch.id });
    if (!branch.turns.length) {
      addWrapped(lines, "Open empty thread", width, { prefix: `${indent}  › `, continuation: `${indent}    `, tone: "user", selectableIndex: branchIndex });
      return;
    }
    for (const turn of branch.turns) {
      addWrapped(lines, turn.user.text, width, { prefix: `${indent}  › `, continuation: `${indent}    `, tone: "user", selectableIndex: branchIndex });
      const answer = turn.assistant.text || (turn.assistant.status === "streaming" ? "working..." : "");
      if (answer) addWrapped(lines, answer, width, { prefix: `${indent}  │ `, continuation: `${indent}  │ `, tone: turn.assistant.status === "failed" ? "error" : "paragraph" });
    }
  });
}

function activityState(status) {
  if (["completed", "complete"].includes(status)) return "";
  if (["failed", "errored"].includes(status)) return "failed";
  if (["declined", "cancelled", "canceled"].includes(status)) return "declined";
  return "running";
}

function activityTitle(activity) {
  const item = activity.item ?? {};
  switch (activity.type) {
    case "commandExecution": return item.command || "shell command";
    case "fileChange": return `${item.changes?.length ?? 0} file change${item.changes?.length === 1 ? "" : "s"}`;
    case "mcpToolCall": return `${item.server || "mcp"} / ${item.tool || "tool"}`;
    case "dynamicToolCall": return `${item.namespace ? item.namespace + " / " : ""}${item.tool || "tool"}`;
    case "webSearch": return item.query ? `search  ${item.query}` : "web search";
    case "plan": return "plan updated";
    case "reasoning": return "reasoning summary";
    case "collabAgentToolCall": return item.tool ? `agent  ${item.tool}` : "agent activity";
    default: return activity.type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  }
}

function jsonText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function activityDetails(activity) {
  const item = activity.item ?? {};
  const details = [];
  if (item.cwd) details.push(`cwd  ${item.cwd}`);
  if (item.arguments !== undefined) details.push(`arguments\n${jsonText(item.arguments)}`);
  if (item.changes?.length) details.push(item.changes.map((change) => `${change.kind?.type || change.type || "change"}  ${change.path || ""}`).join("\n"));
  if (activity.progress) details.push(activity.progress);
  if (activity.interactions?.length) details.push(`stdin\n${activity.interactions.join("\n")}`);
  if (activity.output) details.push(activity.output);
  if (item.result !== undefined && item.result !== null) details.push(`result\n${jsonText(item.result)}`);
  if (item.contentItems?.length) details.push(`content\n${jsonText(item.contentItems)}`);
  if (item.action) details.push(`action\n${jsonText(item.action)}`);
  if (item.agentsStates) details.push(`agents\n${jsonText(item.agentsStates)}`);
  if (item.receiverThreadIds?.length) details.push(`threads\n${item.receiverThreadIds.join("\n")}`);
  if (item.prompt) details.push(`prompt\n${item.prompt}`);
  if (item.path) details.push(`path  ${item.path}`);
  if (item.savedPath) details.push(`saved  ${item.savedPath}`);
  if (item.error) details.push(`error\n${jsonText(item.error)}`);
  if (item.text && !activity.output) details.push(item.text);
  if (item.summary?.length && !activity.output) details.push(item.summary.join("\n"));
  const metadata = [];
  if (item.exitCode !== undefined && item.exitCode !== null) metadata.push(`exit ${item.exitCode}`);
  if (item.durationMs !== undefined && item.durationMs !== null) metadata.push(`${item.durationMs} ms`);
  if (activity.receivedChars) metadata.push(`${activity.receivedChars} chars received`);
  if (activity.possiblyTruncated) metadata.push("provider marked output as truncated");
  if (metadata.length) details.push(metadata.join("  "));
  return details.join("\n\n");
}

const activityPageChars = 8_192;

function safePageBoundary(text, index) {
  if (index <= 0 || index >= text.length) return Math.min(Math.max(0, index), text.length);
  const code = text.charCodeAt(index);
  const previous = text.charCodeAt(index - 1);
  if (code >= 0xdc00 && code <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) return index + 1;
  if (text[index] === "\n" && text[index - 1] === "\r") return index + 1;
  return index;
}

function activityPageKey(scope, turn, activity) {
  return `${scope.id}:${turn.id}:${activity.id}`;
}

function renderActivity(lines, selectables, scope, turn, activity, width, activityPages) {
  const selectableIndex = selectables.length;
  const state = activityState(activity.status);
  const fold = activity.expanded ? "▾" : "▸";
  addWrapped(lines, `${fold} ${activityTitle(activity)}${state ? `  ${state}` : ""}`, width, { prefix: assistantRail, continuation: `${assistantRail}  `, tone: state === "failed" ? "error" : "activity", selectableIndex });
  if (!activity.expanded) {
    selectables.push({ kind: "activity", scopeId: scope.id, turnId: turn.id, activityId: activity.id, page: 0, pages: 1 });
    return;
  }
  const details = activityDetails(activity) || "No additional payload was provided by the CLI.";
  const pages = Math.max(1, Math.ceil(details.length / activityPageChars));
  const requestedPage = activityPages?.get(activityPageKey(scope, turn, activity)) ?? 0;
  const page = Math.min(Math.max(0, requestedPage), pages - 1);
  const start = safePageBoundary(details, page * activityPageChars);
  const end = safePageBoundary(details, Math.min(details.length, (page + 1) * activityPageChars));
  selectables.push({ kind: "activity", scopeId: scope.id, turnId: turn.id, activityId: activity.id, page, pages });
  if (pages > 1) addLine(lines, [{ text: `  │   page ${page + 1}/${pages}  chars ${start + 1}-${end} of ${details.length}`, tone: "hint" }]);
  addWrapped(lines, details.slice(start, end), width, { prefix: "  │   " , continuation: "  │   ", tone: "toolOutput" });
  addLine(lines, [{ text: `  │   ${activity.possiblyTruncated ? "upstream truncation marker detected" : "complete payload received from CLI"}`, tone: activity.possiblyTruncated ? "warning" : "hint" }]);
}

function timelineFor(turn) {
  const messages = assistantMessageParts(turn);
  const activities = turn.assistant.activities ?? [];
  if (turn.assistant.timeline?.length) return turn.assistant.timeline.map((entry) => ({
    ...entry, value: entry.kind === "message" ? messages.find((message) => message.id === entry.id) : activities.find((activity) => activity.id === entry.id),
  })).filter((entry) => entry.value);
  return [
    ...messages.filter((message) => message.text).map((value) => ({ kind: "message", id: value.id, value })),
    ...activities.map((value) => ({ kind: "activity", id: value.id, value })),
  ];
}

export function buildConversationView(conversation, { width = 80, scopeId = conversation.activeScopeId, granularity = "block", activityPages = null } = {}) {
  const lines = [];
  const selectables = [];
  const scope = findScope(conversation, scopeId);
  if (!scope) return { lines: [makeLine("Conversation scope not found", { tone: "error" })], selectables };
  if (!scope.turns.length) {
    addLine(lines, "");
    addLine(lines, [{ text: "  Ask a question. Press Up on a completed answer to explore it.", tone: "empty" }]);
  }

  for (const turn of scope.turns) {
    addWrapped(lines, turn.user.text, width, { prefix: "  › ", continuation: "    ", tone: "user" });
    addLine(lines, "");

    const timeline = timelineFor(turn);
    if (turn.assistant.legacyTimeline) addLine(lines, [{ text: "  │ migrated session: original tool and message order was not recorded", tone: "warning" }]);
    if (!timeline.length && turn.assistant.status === "streaming") {
      addLine(lines, [{ text: "  │ working...", tone: "hint" }]);
    }
    for (const [entryIndex, entry] of timeline.entries()) {
      if (entry.kind === "message") {
        const commentary = entry.value.phase === "commentary";
        renderMessage(lines, selectables, conversation, scope, turn, entry.value, width, { granularity });
      } else {
        renderActivity(lines, selectables, scope, turn, entry.value, width, activityPages);
      }
      addLine(lines, entryIndex < timeline.length - 1 ? assistantRailBlank : "", { tone: "rail" });
    }
  }
  return { lines, selectables };
}

export function breadcrumb(conversation, scopeId, width) {
  const parts = [];
  let scope = findScope(conversation, scopeId);
  while (scope) {
    parts.push(scope.parentId ? truncate(sanitizeTerminalText(scope.anchor?.exactQuote || "thread"), 22) : "main");
    scope = scope.parentId ? findScope(conversation, scope.parentId) : null;
  }
  return truncate(parts.reverse().join("  /  "), width);
}

export function overviewView(conversation, width) {
  const lines = [];
  const selectables = [];
  const branches = conversation.scopes.filter((scope) => scope.parentId);
  addLine(lines, [{ text: "  Threads", tone: "section" }]);
  addLine(lines, "");
  if (!branches.length) addLine(lines, [{ text: "    No threads yet. Inspect a completed answer to create one.", tone: "empty" }]);
  branches.forEach((scope, index) => {
    const selectableIndex = selectables.length;
    selectables.push({ kind: "branch", scopeId: scope.id });
    const depth = scopeDepth(conversation, scope.id);
    addWrapped(lines, `${index + 1}  ${"  ".repeat(Math.max(0, depth - 1))}${scope.anchor?.exactQuote || "thread"}`, width, { prefix: "    ", continuation: "       ", tone: "thread", selectableIndex });
    addLine(lines, [{ text: `       ${scope.turns.length} turns`, tone: "hint" }]);
  });
  return { lines, selectables };
}

export function conversationStats(conversation) {
  const branches = conversation.scopes.filter((scope) => scope.parentId);
  return { threads: branches.length, open: branches.filter((scope) => !scope.collapsed).length, turns: turnCount(conversation.scopes), directChildren: childScopes(conversation, conversation.activeScopeId).length };
}

export function approvalText(request, width) {
  const params = request?.params ?? {};
  return truncate(sanitizeTerminalText(params.command || params.reason || params.itemId || request?.method || "request"), Math.max(1, width));
}

export function applyTone(text, tone, selected = false, colors = true) {
  if (!colors && !selected) return text;
  let prefix = "";
  if (colors) {
    if (tone === "user") prefix += ansi.bold;
    if (tone === "heading") prefix += ansi.bold;
    if (tone === "quote") prefix += ansi.italic + ansi.dim;
    if (["thread", "activity", "section"].includes(tone)) prefix += ansi.cyan;
    if (["dim", "hint", "empty", "commentary", "rail"].includes(tone)) prefix += ansi.dim;
    if (["code", "toolOutput"].includes(tone)) prefix += ansi.dim;
    if (tone === "codeBorder") prefix += ansi.cyan + ansi.dim;
    if (tone === "error") prefix += ansi.red;
    if (tone === "warning") prefix += ansi.yellow;
  }
  if (selected) prefix += colors ? ansi.cyan + ansi.bold + ansi.underline : ansi.inverse;
  return prefix ? prefix + text + ansi.reset : text;
}

export function renderLine(line, selectedIndex, { colors = true, inspect = false } = {}) {
  return (line.parts ?? [{ text: line.text, tone: line.tone }]).map((part) => {
    const selected = inspect && part.selectableIndex !== undefined && part.selectableIndex === selectedIndex;
    return applyTone(part.text, part.tone ?? line.tone, selected, colors);
  }).join("");
}

export function lineContainsSelection(line, selectedIndex) {
  return line.selectableIndex === selectedIndex || line.selectableIndices?.includes(selectedIndex) || line.parts?.some((part) => part.selectableIndex === selectedIndex);
}

export function renderSnapshot(conversation, width = 88) {
  const stats = conversationStats(conversation);
  const scope = findScope(conversation, conversation.activeScopeId);
  const view = buildConversationView(conversation, { width, scopeId: scope?.id });
  const threadLabel = `${stats.threads} ${stats.threads === 1 ? "thread" : "threads"}`;
  return [`threadline  ${conversation.provider}  ${breadcrumb(conversation, scope?.id, width - 34)}  ${threadLabel}`, "", ...view.lines.map((line) => line.text)].join("\n").trimEnd() + "\n";
}
