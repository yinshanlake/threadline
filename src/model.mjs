import { randomUUID } from "node:crypto";
import { textSegments } from "./text.mjs";

function id(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export const DEFAULT_THREAD_LIMITS = Object.freeze({
  maxTotal: 32,
  maxDepth: 4,
  maxPerAnchor: 3,
  warningAt: 24,
});

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

export function normalizeThreadLimits(value = {}) {
  const maxTotal = positiveInteger(value.maxTotal, DEFAULT_THREAD_LIMITS.maxTotal);
  const maxDepth = positiveInteger(value.maxDepth, DEFAULT_THREAD_LIMITS.maxDepth);
  const maxPerAnchor = positiveInteger(value.maxPerAnchor, DEFAULT_THREAD_LIMITS.maxPerAnchor);
  const defaultWarning = Math.max(1, Math.floor(maxTotal * 0.75));
  const warningAt = Math.min(maxTotal, positiveInteger(value.warningAt, defaultWarning));
  return { maxTotal, maxDepth, maxPerAnchor, warningAt };
}

export function createConversation({ provider = "codex", cwd = process.cwd(), title = "Threadline" } = {}) {
  const root = {
    id: id("scope"),
    parentId: null,
    providerThreadId: null,
    anchor: null,
    collapsed: false,
    turns: []
  };
  const now = new Date().toISOString();
  return {
    version: 2,
    id: id("conversation"),
    provider,
    cwd,
    title,
    rootScopeId: root.id,
    activeScopeId: root.id,
    scopes: [root],
    createdAt: now,
    updatedAt: now
  };
}

export function normalizeConversation(value) {
  if (!value || ![1, 2].includes(value.version) || !Array.isArray(value.scopes)) {
    throw new Error("Unsupported or corrupt Threadline session");
  }
  for (const scope of value.scopes) {
    scope.turns ??= [];
    scope.collapsed ??= false;
    for (const turn of scope.turns) {
      turn.assistant ??= { id: id("message"), text: "", status: "complete" };
      turn.assistant.itemIds ??= [];
      turn.assistant.activities ??= [];
      turn.assistant.messages ??= turn.assistant.text ? [{ id: turn.assistant.itemIds[0] || turn.assistant.id, text: turn.assistant.text, phase: "final_answer" }] : [];
      if (!turn.assistant.timeline) {
        turn.assistant.timeline = [
          ...turn.assistant.messages.map((message) => ({ kind: "message", id: message.id })),
          ...turn.assistant.activities.map((activity) => ({ kind: "activity", id: activity.id })),
        ];
        if (turn.assistant.activities.length) turn.assistant.legacyTimeline = true;
      }
      for (const activity of turn.assistant.activities) activity.expanded ??= false;
      if (turn.assistant.status === "streaming") turn.assistant.status = "interrupted";
    }
  }
  value.activeScopeId = findScope(value, value.activeScopeId)?.id ?? value.rootScopeId;
  value.version = 2;
  return value;
}

export function touch(conversation) {
  conversation.updatedAt = new Date().toISOString();
}

export function findScope(conversation, scopeId) {
  return conversation.scopes.find((scope) => scope.id === scopeId);
}

export function rootScope(conversation) {
  return findScope(conversation, conversation.rootScopeId);
}

export function childScopes(conversation, scopeId) {
  return conversation.scopes.filter((scope) => scope.parentId === scopeId);
}

export function addTurn(conversation, scopeId, userText) {
  const scope = findScope(conversation, scopeId);
  if (!scope) throw new Error(`Unknown scope: ${scopeId}`);
  const turn = {
    id: id("turn"),
    providerTurnId: null,
    user: { id: id("message"), text: userText },
    assistant: { id: id("message"), text: "", status: "streaming", itemIds: [], messages: [], activities: [], timeline: [] },
    createdAt: new Date().toISOString()
  };
  scope.turns.push(turn);
  touch(conversation);
  return turn;
}

export function appendAssistant(conversation, scopeId, turnId, delta) {
  const turn = findTurn(conversation, scopeId, turnId);
  if (!turn) return null;
  turn.assistant.text += delta;
  touch(conversation);
  return turn;
}

function rebuildAssistantText(assistant) {
  assistant.text = assistant.messages.map((message) => message.text).filter(Boolean).join("\n\n");
}

export function upsertAssistantMessage(conversation, scopeId, turnId, itemId, { delta = "", text, phase } = {}) {
  const turn = findTurn(conversation, scopeId, turnId);
  if (!turn || !itemId) return null;
  turn.assistant.messages ??= [];
  turn.assistant.timeline ??= [];
  turn.assistant.itemIds ??= [];
  let message = turn.assistant.messages.find((candidate) => candidate.id === itemId);
  if (!message) {
    message = { id: itemId, text: "", phase: phase ?? null };
    turn.assistant.messages.push(message);
    turn.assistant.timeline.push({ kind: "message", id: itemId });
    turn.assistant.itemIds.push(itemId);
  }
  if (delta) message.text += delta;
  if (typeof text === "string") message.text = text;
  if (phase !== undefined) message.phase = phase;
  rebuildAssistantText(turn.assistant);
  touch(conversation);
  return message;
}

export function assistantMessageParts(turn) {
  const messages = turn.assistant.messages?.length ? turn.assistant.messages : [{ id: turn.assistant.id, text: turn.assistant.text, phase: "final_answer" }];
  let offset = 0;
  return messages.map((message, index) => {
    const part = { ...message, sourceStart: offset, sourceEnd: offset + message.text.length };
    offset = part.sourceEnd + (index < messages.length - 1 ? 2 : 0);
    return part;
  });
}

export function setAssistant(conversation, scopeId, turnId, text) {
  const turn = findTurn(conversation, scopeId, turnId);
  if (!turn) return null;
  turn.assistant.text = text;
  touch(conversation);
  return turn;
}

export function completeTurn(conversation, scopeId, turnId, status = "complete") {
  const turn = findTurn(conversation, scopeId, turnId);
  if (!turn) return null;
  turn.assistant.status = status;
  touch(conversation);
  return turn;
}

export function upsertActivity(conversation, scopeId, turnId, item, { appendOutput = "" } = {}) {
  const turn = findTurn(conversation, scopeId, turnId);
  if (!turn || !item?.id) return null;
  turn.assistant.activities ??= [];
  let activity = turn.assistant.activities.find((candidate) => candidate.id === item.id);
  if (!activity) {
    activity = { id: item.id, type: item.type || "activity", status: item.status || "inProgress", output: "", expanded: false, item: {} };
    turn.assistant.activities.push(activity);
    turn.assistant.timeline ??= [];
    turn.assistant.timeline.push({ kind: "activity", id: item.id });
  }
  activity.type = item.type || activity.type;
  activity.status = item.status || activity.status;
  const { aggregatedOutput, ...metadata } = item;
  activity.item = { ...activity.item, ...metadata };
  if (appendOutput) { activity.output += appendOutput; activity.outputSource = "stream"; }
  if (typeof aggregatedOutput === "string" && !activity.output) { activity.output = aggregatedOutput; activity.outputSource = "aggregate"; }
  activity.receivedChars = activity.output.length;
  activity.possiblyTruncated = /(?:…|\.\.\.)?\s*(?:truncated|output limit|bytes cap|chars truncated)/iu.test(activity.output);
  touch(conversation);
  return activity;
}

export function findActivity(conversation, scopeId, turnId, activityId) {
  return findTurn(conversation, scopeId, turnId)?.assistant.activities?.find((activity) => activity.id === activityId);
}

export function findTurn(conversation, scopeId, turnId) {
  return findScope(conversation, scopeId)?.turns.find((turn) => turn.id === turnId);
}

export function findStreamingTurn(conversation, scopeId) {
  const turns = findScope(conversation, scopeId)?.turns ?? [];
  return [...turns].reverse().find((turn) => turn.assistant.status === "streaming");
}

export function segmentsForTurn(turn) {
  return textSegments(turn.assistant.text).map((segment) => ({
    ...segment,
    key: `${turn.assistant.id}:${segment.start}:${segment.end}`,
    messageId: turn.assistant.id,
    turnId: turn.id,
    providerTurnId: turn.providerTurnId
  }));
}

export function makeAnchor(turn, segment) {
  const text = turn.assistant.text;
  return {
    messageId: turn.assistant.id,
    turnId: turn.id,
    providerTurnId: turn.providerTurnId,
    sourceStart: segment.start,
    sourceEnd: segment.end,
    exactQuote: segment.text,
    prefix: text.slice(Math.max(0, segment.start - 32), segment.start),
    suffix: text.slice(segment.end, segment.end + 32),
    blockIndex: segment.blockIndex,
    segmentIndex: segment.segmentIndex
  };
}

export function addBranch(conversation, parentScopeId, anchor, providerThreadId = null) {
  if (!findScope(conversation, parentScopeId)) throw new Error(`Unknown parent scope: ${parentScopeId}`);
  const scope = {
    id: id("scope"),
    parentId: parentScopeId,
    providerThreadId,
    anchor,
    collapsed: false,
    turns: []
  };
  conversation.scopes.push(scope);
  touch(conversation);
  return scope;
}

export function branchesAt(conversation, parentScopeId, messageId, start, end) {
  return conversation.scopes.filter((scope) =>
    scope.parentId === parentScopeId &&
    scope.anchor?.messageId === messageId &&
    scope.anchor?.sourceStart === start &&
    scope.anchor?.sourceEnd === end
  );
}

function normalizedQuestion(value) {
  const text = String(value ?? "").trim().replace(/\s+/gu, " " );
  return text.toLocaleLowerCase();
}

export function duplicateBranchAt(conversation, parentScopeId, anchor, question) {
  const normalized = normalizedQuestion(question);
  if (!normalized) return null;
  return branchesAt(
    conversation,
    parentScopeId,
    anchor.messageId,
    anchor.sourceStart,
    anchor.sourceEnd,
  ).find((scope) => normalizedQuestion(scope.turns[0]?.user?.text) === normalized) ?? null;
}

export function branchCapacity(conversation, parentScopeId, anchor, configuredLimits = DEFAULT_THREAD_LIMITS) {
  if (!findScope(conversation, parentScopeId)) throw new Error(`Unknown parent scope: ${parentScopeId}`);
  const limits = normalizeThreadLimits(configuredLimits);
  const total = conversation.scopes.filter((scope) => scope.parentId).length;
  const depth = scopeDepth(conversation, parentScopeId) + 1;
  const atAnchor = branchesAt(
    conversation,
    parentScopeId,
    anchor.messageId,
    anchor.sourceStart,
    anchor.sourceEnd,
  ).length;

  let code = null;
  let message = null;
  if (total >= limits.maxTotal) {
    code = "thread-total-limit";
    message = `This conversation has reached its ${limits.maxTotal}-thread limit. Continue in an existing thread.`;
  } else if (depth > limits.maxDepth) {
    code = "thread-depth-limit";
    message = `Threads can be nested up to ${limits.maxDepth} levels. Continue in this thread or return to a parent.`;
  } else if (atAnchor >= limits.maxPerAnchor) {
    code = "thread-anchor-limit";
    message = `This excerpt already has ${limits.maxPerAnchor} threads. Open one of them and continue there.`;
  }

  return {
    allowed: !code,
    code,
    message,
    total,
    atAnchor,
    depth,
    remainingTotal: Math.max(0, limits.maxTotal - total),
    nearTotalLimit: total >= limits.warningAt,
    limits,
  };
}

export function scopeDepth(conversation, scopeId) {
  let depth = 0;
  let scope = findScope(conversation, scopeId);
  while (scope?.parentId) {
    depth += 1;
    scope = findScope(conversation, scope.parentId);
  }
  return depth;
}

export function createDemoConversation() {
  const conversation = createConversation({ provider: "demo", title: "Threadline demo" });
  const root = rootScope(conversation);
  root.providerThreadId = "demo-root";
  const first = addTurn(conversation, root.id, "为什么很多 LLM terminal 对话不方便深入追问？");
  first.providerTurnId = "demo-turn-1";
  first.assistant.text = [
    "线性 transcript 很适合连续输入，却不适合局部探索。看到某个结论时，用户往往已经产生新的问题。",
    "",
    "更自然的模型是把追问锚定到原回答中的一句话，并让它形成一个可以折叠的局部 thread。主对话继续保持线性，deep dive 默认不污染主线。",
    "",
    "终端 resize 时，锚点必须跟随原文而不是屏幕坐标。"
  ].join("\n");
  const demoAnswer = first.assistant.text;
  first.assistant.status = "complete";
  upsertAssistantMessage(conversation, root.id, first.id, "demo-commentary", { text: "先检查现有 terminal transcript 的限制。", phase: "commentary" });
  const demoTool = upsertActivity(conversation, root.id, first.id, {
    id: "demo-tool", type: "commandExecution", command: "inspect transcript layout", status: "completed", exitCode: 0, durationMs: 84, aggregatedOutput: "5 answer segments\n1 anchored thread\n0 screen-coordinate anchors"
  });
  demoTool.expanded = false;
  upsertAssistantMessage(conversation, root.id, first.id, "demo-answer", { text: demoAnswer, phase: "final_answer" });
  first.assistant.timeline = [
    { kind: "message", id: "demo-commentary" },
    { kind: "activity", id: "demo-tool" },
    { kind: "message", id: "demo-answer" },
  ];

  const segment = segmentsForTurn(first)[2];
  const child = addBranch(conversation, root.id, makeAnchor(first, segment), "demo-child");
  const followup = addTurn(conversation, child.id, "为什么不能保存 terminal 的行列坐标？");
  followup.providerTurnId = "demo-turn-2";
  followup.assistant.text = "因为窗口宽度改变后会重新换行；CJK、emoji 和 Markdown 渲染也会改变 cell 数。锚点应保存消息 ID、源码区间和文本指纹。";
  followup.assistant.status = "complete";
  return conversation;
}
