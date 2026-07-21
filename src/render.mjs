import { assistantMessageParts, childScopes, findScope, scopeDepth, segmentsForTurn } from "./model.mjs";
import { contentBlocks, displayWidth, sanitizeTerminalText, terminalPlainText, truncate, wrapAnnotatedText, wrapDisplayText } from "./text.mjs";

export const ansi = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", italic: "\x1b[3m", underline: "\x1b[4m", strike: "\x1b[9m",
  cyan: "\x1b[36m", yellow: "\x1b[33m", red: "\x1b[31m", inverse: "\x1b[7m",
  threadColors: [81, 141, 114, 215, 212, 75, 44, 180].map((color) => `\x1b[38;5;${color}m`),
};

function makeLine(parts = [], options = {}) {
  const normalized = typeof parts === "string" ? [{ text: parts, tone: options.tone, accent: options.accent }] : parts;
  return { ...options, parts: normalized, text: normalized.map((part) => part.text).join("") };
}

function addLine(lines, parts = [], options = {}) { lines.push(makeLine(parts, options)); }
function turnCount(scopes) { return scopes.reduce((sum, scope) => sum + scope.turns.length, 0); }

const assistantRail = "  │ ";
const assistantRailBlank = "  │";

function addWrapped(lines, text, width, { prefix = "", continuation, prefixTone = "dim", prefixAccent = null, tone, accent = null, selectableIndex, singleLine = false } = {}) {
  const safe = sanitizeTerminalText(text);
  const rest = continuation ?? " ".repeat(displayWidth(prefix));
  const usable = Math.max(1, width - displayWidth(prefix));
  const values = singleLine ? [truncate(safe.replace(/[\t\r\n\u2028\u2029]+/gu, " "), usable)] : wrapDisplayText(safe, usable);
  values.forEach((value, index) => addLine(lines, [
    { text: index === 0 ? prefix : rest, tone: prefixTone, accent: prefixAccent },
    { text: value, tone, accent, selectableIndex },
  ], { selectableIndex }));
}

function hashScopeId(value) {
  let hash = 2166136261;
  for (const character of String(value ?? "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function threadColorIndex(conversation, scopeId) {
  const branches = conversation.scopes.filter((scope) => scope.parentId);
  const assigned = new Map();
  const used = new Set();
  for (const branch of branches) {
    const preferred = hashScopeId(branch.id) % ansi.threadColors.length;
    let color = preferred;
    if (assigned.size < ansi.threadColors.length) {
      while (used.has(color)) color = (color + 1) % ansi.threadColors.length;
      used.add(color);
    }
    assigned.set(branch.id, color);
  }
  return assigned.get(scopeId) ?? null;
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

function renderMessage(lines, selectables, conversation, scope, turn, message, width, { inlineIndent = null, granularity = "block", activityPages = null, activityGroups = null, accent = null } = {}) {
  const allSegments = segmentsForTurn(turn);
  const blocks = contentBlocks(message.text);
  const baseIndent = inlineIndent === null ? assistantRail : `${inlineIndent}  │ `;
  const codeIndent = inlineIndent === null ? "  │   " : `${inlineIndent}  │   `;

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
    const annotated = wrapAnnotatedText(block.text, usable, { sourceStart: globalStart, ranges, type: block.type });
    annotated.forEach((line) => {
      const parts = [{ text: prefix, tone: block.type === "code" ? "codeBorder" : "dim", accent }];
      const bodyTone = turn.assistant.status === "failed" ? "error" : message.phase === "commentary" ? "commentary" : block.type;
      for (const part of line.parts) parts.push({ text: part.text, tone: turn.assistant.status === "failed" ? "error" : part.tone || bodyTone, selectableIndex: part.selectableIndex });
      addLine(lines, parts, { selectableIndices: [...new Set(line.parts.map((part) => part.selectableIndex).filter((value) => value !== undefined))] });
    });

    for (const branches of anchoredGroups(conversation, scope.id, turn.assistant.id, globalStart, globalEnd)) {
      renderInlineBranches(lines, selectables, conversation, branches, width, baseIndent, granularity, activityPages, activityGroups);
    }
    if (blockPosition < blocks.length - 1) addLine(lines, inlineIndent === null ? assistantRailBlank : `${inlineIndent}  │`, { tone: "rail", accent });
  });
}

function branchSummary(branches) {
  const replies = turnCount(branches);
  return `${branches.length} ${branches.length === 1 ? "thread" : "threads"}  ${replies} ${replies === 1 ? "reply" : "replies"}`;
}

function renderInlineBranches(lines, selectables, conversation, branches, width, indent, granularity, activityPages, activityGroups) {
  const collapsed = branches.every((branch) => branch.collapsed);
  const groupIndex = selectables.length;
  selectables.push({ kind: "branch-group", scopeIds: branches.map((branch) => branch.id), parentScopeId: branches[0].parentId, anchor: branches[0].anchor });
  const groupAccent = branches.length === 1 ? threadColorIndex(conversation, branches[0].id) : null;
  addWrapped(lines, `${collapsed ? "▸" : "▾"} ${branchSummary(branches)}`, width, { prefix: indent, continuation: `${indent}  `, prefixAccent: groupAccent, tone: "thread", accent: groupAccent, selectableIndex: groupIndex });
  if (collapsed) return;

  branches.forEach((branch, branchPosition) => {
    const accent = threadColorIndex(conversation, branch.id);
    if (branchPosition > 0) addLine(lines, indent.trimEnd(), { tone: "rail", accent });
    const branchIndex = selectables.length;
    selectables.push({ kind: "branch", scopeId: branch.id });
    if (!branch.turns.length) {
      addWrapped(lines, "Open empty thread", width, { prefix: `${indent}  › `, continuation: `${indent}    `, prefixAccent: accent, tone: "user", accent, selectableIndex: branchIndex });
      return;
    }
    for (const turn of branch.turns) {
      addWrapped(lines, turn.user.text, width, { prefix: `${indent}  › `, continuation: `${indent}    `, prefixAccent: accent, tone: "user", accent, selectableIndex: branchIndex });
      const timeline = groupedTimeline(timelineFor(turn));
      if (turn.assistant.legacyTimeline) addLine(lines, [{ text: `${indent}  │ migrated session: original tool and message order was not recorded`, tone: "warning" }]);
      if (!timeline.length && turn.assistant.status === "streaming") {
        addLine(lines, [{ text: `${indent}  │ working...`, tone: "hint", accent }]);
      }
      for (const [entryIndex, entry] of timeline.entries()) {
        if (entry.kind === "message") {
          renderMessage(lines, selectables, conversation, branch, turn, entry.value, width, { inlineIndent: indent, granularity, activityPages, activityGroups, accent });
        } else if (entry.kind === "activity-run") {
          renderActivityGroup(lines, selectables, branch, turn, entry.entries, width, activityPages, activityGroups, accent, `${indent}  │ `);
        } else {
          renderActivity(lines, selectables, branch, turn, entry.value, width, activityPages, accent, `${indent}  │ `);
        }
        if (entryIndex < timeline.length - 1) addLine(lines, `${indent}  │`, { tone: "rail", accent });
      }
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

function activityGroupKey(scope, turn, entries) {
  return `${scope.id}:${turn.id}:${entries[0].id}`;
}

function groupedTimeline(entries) {
  const groups = [];
  for (const entry of entries) {
    if (entry.kind !== "activity") { groups.push(entry); continue; }
    const previous = groups.at(-1);
    if (previous?.kind === "activity-run") previous.entries.push(entry);
    else groups.push({ kind: "activity-run", entries: [entry] });
  }
  return groups.flatMap((entry) => entry.kind === "activity-run" && entry.entries.length === 1 ? entry.entries : [entry]);
}

function renderActivityGroup(lines, selectables, scope, turn, entries, width, activityPages, activityGroups, accent = null, rail = assistantRail) {
  const groupId = activityGroupKey(scope, turn, entries);
  const expanded = activityGroups?.get(groupId) === true;
  const states = entries.map((entry) => activityState(entry.value.status));
  const running = states.filter((state) => state === "running").length;
  const failed = states.filter((state) => state === "failed").length;
  const declined = states.filter((state) => state === "declined").length;
  const complete = entries.length - running - failed - declined;
  const status = [
    running ? `${running} running` : null,
    failed ? `${failed} failed` : null,
    declined ? `${declined} declined` : null,
    complete ? `${complete} complete` : null,
  ].filter(Boolean).join("  " );
  const selectableIndex = selectables.length;
  selectables.push({
    kind: "activity-group", scopeId: scope.id, turnId: turn.id, groupId,
    activityIds: entries.map((entry) => entry.value.id), expanded, running, failed,
  });
  addWrapped(lines, `${expanded ? "▾" : "▸"} ${entries.length} activities${status ? `  ${status}` : ""}`, width, {
    prefix: rail, continuation: rail, prefixAccent: accent, tone: failed ? "error" : "activity",
    accent: failed ? null : accent, selectableIndex, singleLine: true,
  });
  if (!expanded) return;
  for (const entry of entries) renderActivity(lines, selectables, scope, turn, entry.value, width, activityPages, accent, `${rail}  `);
}

function renderActivity(lines, selectables, scope, turn, activity, width, activityPages, accent = null, rail = assistantRail) {
  const selectableIndex = selectables.length;
  const state = activityState(activity.status);
  const fold = activity.expanded ? "▾" : "▸";
  addWrapped(lines, `${fold} ${activityTitle(activity)}${state ? `  ${state}` : ""}`, width, { prefix: rail, continuation: `${rail}  `, prefixAccent: accent, tone: state === "failed" ? "error" : "activity", accent: state === "failed" ? null : accent, selectableIndex, singleLine: true });
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
  if (pages > 1) addLine(lines, [{ text: `${rail}  page ${page + 1}/${pages}  chars ${start + 1}-${end} of ${details.length}`, tone: "hint", accent }]);
  addWrapped(lines, details.slice(start, end), width, { prefix: `${rail}  `, continuation: `${rail}  `, prefixAccent: accent, tone: "toolOutput" });
  addLine(lines, [{ text: `${rail}  ${activity.possiblyTruncated ? "upstream truncation marker detected" : "complete payload received from CLI"}`, tone: activity.possiblyTruncated ? "warning" : "hint", accent: activity.possiblyTruncated ? null : accent }]);
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

export function buildConversationView(conversation, { width = 80, scopeId = conversation.activeScopeId, granularity = "block", activityPages = null, activityGroups = null } = {}) {
  const lines = [];
  const selectables = [];
  const scope = findScope(conversation, scopeId);
  if (!scope) return { lines: [makeLine("Conversation scope not found", { tone: "error" })], selectables };
  const scopeAccent = scope.parentId ? threadColorIndex(conversation, scope.id) : null;
  if (!scope.turns.length) {
    addLine(lines, "");
    addLine(lines, [{ text: "  Ask a question. Press Up on a completed answer to explore it.", tone: "empty" }]);
  }

  for (const turn of scope.turns) {
    addWrapped(lines, turn.user.text, width, { prefix: "  › ", continuation: "    ", prefixAccent: scopeAccent, tone: "user", accent: scopeAccent });
    addLine(lines, "");

    const timeline = groupedTimeline(timelineFor(turn));
    if (turn.assistant.legacyTimeline) addLine(lines, [{ text: "  │ migrated session: original tool and message order was not recorded", tone: "warning" }]);
    if (!timeline.length && turn.assistant.status === "streaming") {
      addLine(lines, [{ text: "  │ working...", tone: "hint", accent: scopeAccent }]);
    }
    for (const [entryIndex, entry] of timeline.entries()) {
      if (entry.kind === "message") {
        const commentary = entry.value.phase === "commentary";
        renderMessage(lines, selectables, conversation, scope, turn, entry.value, width, { granularity, activityPages, activityGroups, accent: scopeAccent });
      } else if (entry.kind === "activity-run") {
        renderActivityGroup(lines, selectables, scope, turn, entry.entries, width, activityPages, activityGroups, scopeAccent);
      } else {
        renderActivity(lines, selectables, scope, turn, entry.value, width, activityPages, scopeAccent);
      }
      addLine(lines, entryIndex < timeline.length - 1 ? assistantRailBlank : "", { tone: "rail", accent: scopeAccent });
    }
  }
  return { lines, selectables };
}

export function breadcrumb(conversation, scopeId, width) {
  const parts = [];
  let scope = findScope(conversation, scopeId);
  while (scope) {
    parts.push(scope.parentId ? truncate(terminalPlainText(scope.anchor?.exactQuote || "thread").replace(/\s+/gu, " "), 22) : "main");
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
    const accent = threadColorIndex(conversation, scope.id);
    const selectableIndex = selectables.length;
    selectables.push({ kind: "branch", scopeId: scope.id });
    const depth = scopeDepth(conversation, scope.id);
    const label = terminalPlainText(scope.anchor?.exactQuote || "thread").replace(/\s+/gu, " " );
    addWrapped(lines, `${index + 1}  ${"  ".repeat(Math.max(0, depth - 1))}${label}`, width, { prefix: "    ", continuation: "       ", prefixAccent: accent, tone: "thread", accent, selectableIndex });
    addLine(lines, [{ text: `       ${scope.turns.length} turns`, tone: "hint", accent }]);
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

export function applyTone(text, tone, selected = false, colors = true, accent = null) {
  if (!colors && !selected) return text;
  let prefix = "";
  if (colors) {
    const accentColor = Number.isInteger(accent) ? ansi.threadColors[accent % ansi.threadColors.length] : "";
    if (accentColor) prefix += accentColor;
    if (tone === "user") prefix += ansi.bold;
    if (tone === "heading") prefix += ansi.bold;
    if (tone === "strong") prefix += ansi.bold;
    if (tone === "emphasis") prefix += ansi.italic;
    if (tone === "strike") prefix += ansi.strike + ansi.dim;
    if (tone === "quote") prefix += ansi.italic + ansi.dim;
    if (!accentColor && ["thread", "activity", "section"].includes(tone)) prefix += ansi.cyan;
    if (["dim", "hint", "empty", "commentary", "rail"].includes(tone)) prefix += ansi.dim;
    if (["code", "inlineCode", "toolOutput"].includes(tone)) prefix += ansi.dim;
    if (tone === "link") prefix += ansi.underline;
    if (tone === "math") prefix += ansi.cyan;
    if (tone === "codeBorder") prefix += (accentColor ? "" : ansi.cyan) + ansi.dim;
    if (tone === "error") prefix += ansi.red;
    if (tone === "warning") prefix += ansi.yellow;
  }
  if (selected) prefix += colors ? (Number.isInteger(accent) ? ansi.threadColors[accent % ansi.threadColors.length] : ansi.cyan) + ansi.bold + ansi.underline : ansi.inverse;
  return prefix ? prefix + text + ansi.reset : text;
}

export function renderLine(line, selectedIndex, { colors = true, inspect = false } = {}) {
  return (line.parts ?? [{ text: line.text, tone: line.tone }]).map((part) => {
    const selected = inspect && part.selectableIndex !== undefined && part.selectableIndex === selectedIndex;
    return applyTone(part.text, part.tone ?? line.tone, selected, colors, part.accent ?? line.accent ?? null);
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
