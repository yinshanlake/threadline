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
  const sessionId = randomUUID();
  const root = {
    id: id("scope"),
    parentId: null,
    providerThreadId: null,
    providerState: {},
    tokenUsage: null,
    anchor: null,
    collapsed: false,
    turns: []
  };
  const now = new Date().toISOString();
  return {
    version: 2,
    id: `conversation_${sessionId}`,
    sessionId,
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
  const legacySessionId = String(value.id ?? "").replace(/^conversation_/u, "");
  value.sessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.sessionId)
    ? value.sessionId.toLowerCase()
    : /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(legacySessionId)
      ? legacySessionId.toLowerCase()
      : randomUUID();
  for (const scope of value.scopes) {
    scope.turns ??= [];
    scope.collapsed ??= false;
    scope.providerState ??= {};
    scope.tokenUsage ??= null;
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
    providerState: {},
    tokenUsage: null,
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
  const conversation = createConversation({ provider: "demo", title: "Threadline interactive showcase" });
  const root = rootScope(conversation);
  root.providerThreadId = "demo-root";
  root.providerState = {
    model: "demo-balanced",
    effort: "medium",
    collaborationMode: { mode: "default" },
    personality: "pragmatic",
    permissions: ":workspace",
    approvalPolicy: "on-request",
    cwd: conversation.cwd,
  };
  root.tokenUsage = {
    total: { totalTokens: 12_480 },
    last: { totalTokens: 2_146 },
    modelContextWindow: 200_000,
  };
  const first = addTurn(conversation, root.id, "为什么很多 LLM terminal 对话不方便深入追问？");
  first.providerTurnId = "demo-turn-1";
  upsertAssistantMessage(conversation, root.id, first.id, "demo-commentary", {
    text: "先沿着真实事件顺序检查 transcript、上下文和渲染边界。",
    phase: "commentary",
  });
  upsertAssistantMessage(conversation, root.id, first.id, "demo-answer", {
    phase: "final_answer",
    text: [
      "Threadline 把追问锚定到回答原文，而不是终端的行列坐标。窗口 resize 后可以重新排版，问题仍然指向同一段内容。",
      "",
      "每个 deep-dive thread 都是真实的 provider fork：它继承创建那一刻之前的上下文，之后与父对话独立发展。thread 还可以继续嵌套。",
      "",
      "工具调用按事件顺序保存。连续调用默认压成一条摘要，展开后仍能逐项查看完整 payload；很长的输出会分页，而不是从 session 中截断。",
    ].join("\n"),
  });
  first.assistant.status = "complete";

  const sourceSegment = segmentsForTurn(first).find((segment) => segment.text.includes("行列坐标"));
  const contextSegment = segmentsForTurn(first).find((segment) => segment.text.includes("provider fork"));
  if (!sourceSegment || !contextSegment) throw new Error("Demo anchors could not be built");

  const sourceThread = addBranch(conversation, root.id, makeAnchor(first, sourceSegment), "demo-source-thread");
  sourceThread.providerState = { ...root.providerState };
  const sourceFollowup = addTurn(conversation, sourceThread.id, "为什么不能保存 terminal 的行列坐标？");
  sourceFollowup.providerTurnId = "demo-turn-2";
  upsertAssistantMessage(conversation, sourceThread.id, sourceFollowup.id, "source-commentary", {
    text: "用两个窗口宽度复算同一段文本。", phase: "commentary",
  });
  upsertActivity(conversation, sourceThread.id, sourceFollowup.id, {
    id: "source-width-48", type: "commandExecution", command: "render --width 48", status: "completed", aggregatedOutput: "8 rows; source range 62..113",
  });
  upsertActivity(conversation, sourceThread.id, sourceFollowup.id, {
    id: "source-width-100", type: "commandExecution", command: "render --width 100", status: "completed", aggregatedOutput: "4 rows; source range 62..113",
  });
  upsertAssistantMessage(conversation, sourceThread.id, sourceFollowup.id, "source-answer", {
    text: "因为窗口宽度、CJK、emoji 和 Markdown 都会改变 cell 与换行。Threadline 保存消息 ID、源码区间和文本指纹；屏幕行只是当前渲染结果。",
    phase: "final_answer",
  });
  sourceFollowup.assistant.status = "complete";

  const contextThread = addBranch(conversation, root.id, makeAnchor(first, contextSegment), "demo-context-thread");
  contextThread.providerState = { ...root.providerState, effort: "high" };
  const contextFollowup = addTurn(conversation, contextThread.id, "父子 thread 的上下文究竟如何隔离？");
  contextFollowup.providerTurnId = "demo-turn-3";
  upsertAssistantMessage(conversation, contextThread.id, contextFollowup.id, "context-answer", {
    text: "子 thread 复制父 provider thread 到被选中回答所在的 turn，然后接收精确摘录和新问题。此后父子历史分开；父线的新消息不会悄悄进入已存在的子线。",
    phase: "final_answer",
  });
  contextFollowup.assistant.status = "complete";

  const nestedSegment = segmentsForTurn(contextFollowup).find((segment) => segment.text.includes("父子历史分开"));
  if (!nestedSegment) throw new Error("Nested demo anchor could not be built");
  const nestedThread = addBranch(conversation, contextThread.id, makeAnchor(contextFollowup, nestedSegment), "demo-nested-thread");
  nestedThread.providerState = { ...contextThread.providerState };
  const nestedFollowup = addTurn(conversation, nestedThread.id, "那嵌套 thread 从哪里 fork？");
  nestedFollowup.providerTurnId = "demo-turn-4";
  upsertAssistantMessage(conversation, nestedThread.id, nestedFollowup.id, "nested-answer", {
    text: "从直接父 thread 的选中 turn fork，不会绕回 root。面包屑、颜色和 provider ID 都保留这条父子关系。",
    phase: "final_answer",
  });
  nestedFollowup.assistant.status = "complete";

  const tools = addTurn(conversation, root.id, "连续几十条 tool calls 怎样保持可读，又不丢失细节？");
  tools.providerTurnId = "demo-turn-5";
  upsertAssistantMessage(conversation, root.id, tools.id, "tools-commentary", {
    text: "模拟一次搜索、MCP 调用、测试命令和文件修改。",
    phase: "commentary",
  });
  upsertActivity(conversation, root.id, tools.id, {
    id: "demo-search", type: "webSearch", query: "terminal conversation branching UX", status: "completed",
    result: { matches: 18, selected: 4 },
  });
  upsertActivity(conversation, root.id, tools.id, {
    id: "demo-mcp", type: "mcpToolCall", server: "github", tool: "search_code", status: "completed",
    arguments: { query: "thread/fork source offsets", repository: "threadline" },
    result: { files: ["src/model.mjs", "src/render.mjs", "src/tui.mjs"] },
  });
  upsertActivity(conversation, root.id, tools.id, {
    id: "demo-command", type: "commandExecution", command: "npm test -- --showcase", cwd: conversation.cwd, status: "completed", exitCode: 0, durationMs: 1_842,
    aggregatedOutput: Array.from({ length: 150 }, (_, index) => `${String(index + 1).padStart(3, "0")}  PASS  source anchor ${String(index + 1).padStart(3, "0")} remains stable after resize and redraw`).join("\n"),
  });
  upsertActivity(conversation, root.id, tools.id, {
    id: "demo-change", type: "fileChange", status: "completed",
    changes: [
      { type: "update", path: "src/render.mjs" },
      { type: "update", path: "src/tui.mjs" },
    ],
  });
  upsertAssistantMessage(conversation, root.id, tools.id, "tools-answer", {
    text: "这 4 条 activity 默认只占一行。现在按 Up 两次选中它，Enter 展开整组；再选中单条 activity 并按 Enter 查看 payload，长测试输出可用 [ 和 ] 翻页。按 T 查看彩色 thread 总览；回到输入框键入 /model 体验选择器。",
    phase: "final_answer",
  });
  tools.assistant.status = "complete";
  return conversation;
}
