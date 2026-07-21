import { EventEmitter } from "node:events";
import { executeSlashCommand, SLASH_COMMANDS } from "./commands.mjs";
import {
  addBranch,
  addTurn,
  branchCapacity,
  completeTurn,
  duplicateBranchAt,
  findScope,
  findStreamingTurn,
  findTurn,
  makeAnchor,
  normalizeThreadLimits,
  findActivity,
  upsertActivity,
  upsertAssistantMessage,
  touch
} from "./model.mjs";

const ACTIVITY_TYPES = new Set([
  "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch",
  "plan", "reasoning", "collabAgentToolCall", "subAgentActivity", "imageGeneration",
  "contextCompaction", "enteredReviewMode", "exitedReviewMode", "sleep"
]);

export class Controller extends EventEmitter {
  constructor({ conversation, provider, writer = null, threadLimits = {} }) {
    super();
    this.conversation = conversation;
    this.provider = provider;
    this.writer = writer;
    this.threadLimits = normalizeThreadLimits(threadLimits);
    this.loadedThreads = new Set();
    this.scopeLoads = new Map();
    this.busyScopes = new Set();
    this.pendingApproval = null;
    this.pendingUserInput = null;
    this.approvalQueue = [];
    this.status = "Starting provider…";
    this.busy = false;
    this.#wireProvider();
  }

  async start() {
    const info = await this.provider.connect();
    this.status = this.conversation.provider === "demo" ? "Demo mode" : `Codex connected  ${info.platformFamily ?? "unknown platform"}`;
    this.changed();
    return info;
  }

  slashCommands() { return SLASH_COMMANDS; }

  async executeSlashCommand(input) {
    const result = await executeSlashCommand(this, input);
    if (result?.message) this.status = result.message;
    this.changed();
    return result;
  }

  addCommandTurn(scopeId, text) {
    const turn = addTurn(this.conversation, scopeId, text);
    this.status = "Codex is working…";
    this.changed();
    return turn;
  }

  async ensureScope(scopeId) {
    const scope = findScope(this.conversation, scopeId);
    if (!scope) throw new Error(`Unknown scope: ${scopeId}`);
    if (scope.providerThreadId && this.loadedThreads.has(scope.providerThreadId)) return scope;
    if (this.scopeLoads.has(scopeId)) return this.scopeLoads.get(scopeId);
    const loading = (async () => {
      if (scope.providerThreadId) {
        const resumed = await this.provider.resumeThread(scope.providerThreadId, { cwd: this.conversation.cwd });
        scope.providerThreadId = resumed.threadId;
        scope.providerState = { ...scope.providerState, ...(resumed.state ?? {}) };
      } else {
        const started = await this.provider.startThread({ cwd: this.conversation.cwd });
        scope.providerThreadId = started.threadId;
        scope.providerState = { ...scope.providerState, ...(started.state ?? {}) };
      }
      this.loadedThreads.add(scope.providerThreadId);
      this.persist();
      return scope;
    })();
    this.scopeLoads.set(scopeId, loading);
    try { return await loading; } finally { this.scopeLoads.delete(scopeId); }
  }

  async send(scopeId, text, { providerText = text, internal = false } = {}) {
    const value = text.trim();
    if (!value) return null;
    if ((this.busy && !internal) || this.busyScopes.has(scopeId)) throw new Error("Wait for the current operation to finish");
    this.busyScopes.add(scopeId);
    let turn = null;
    let scope;
    try {
      scope = await this.ensureScope(scopeId);
      turn = addTurn(this.conversation, scope.id, value);
    } catch (error) {
      this.busyScopes.delete(scopeId);
      throw error;
    }
    this.status = "Codex is working…";
    this.changed();
    try {
      const result = await this.provider.send(scope.providerThreadId, providerText);
      turn.providerTurnId = result.turnId;
      this.persist();
      this.changed();
      return turn;
    } catch (error) {
      turn.assistant.text = `Provider error: ${error.message}`;
      turn.assistant.status = "failed";
      this.busyScopes.delete(scopeId);
      this.status = error.message;
      this.persist();
      this.changed();
      throw error;
    }
  }

  async dive(parentScopeId, turnId, segment, question) {
    if (this.busy) throw new Error("Another branch is already being created");
    this.busy = true;
    try {
      const value = question.trim();
      if (!value) throw new Error("Enter a question before creating a thread");
      const sourceTurn = findTurn(this.conversation, parentScopeId, turnId);
      if (!sourceTurn) throw new Error("The selected source turn no longer exists");
      if (sourceTurn.assistant.status !== "complete") throw new Error("Wait for the selected answer to finish before branching");
      if (!sourceTurn.providerTurnId && this.conversation.provider !== "demo") {
        throw new Error("This answer predates provider turn metadata and cannot be forked safely");
      }
      const anchor = makeAnchor(sourceTurn, segment);
      const duplicate = duplicateBranchAt(this.conversation, parentScopeId, anchor, value);
      if (duplicate) {
        const error = new Error("This exact follow-up already exists at this excerpt. Open the existing thread instead.");
        error.code = "duplicate-thread";
        error.scopeId = duplicate.id;
        throw error;
      }
      const capacity = branchCapacity(this.conversation, parentScopeId, anchor, this.threadLimits);
      if (!capacity.allowed) {
        const error = new Error(capacity.message);
        error.code = capacity.code;
        error.capacity = capacity;
        throw error;
      }

      this.status = "Forking at selected answer…";
      this.changed();
      const parent = await this.ensureScope(parentScopeId);
      const fork = await this.provider.forkThread(parent.providerThreadId, sourceTurn.providerTurnId, { cwd: this.conversation.cwd });
      const child = addBranch(this.conversation, parentScopeId, anchor, fork.threadId);
      child.providerState = { ...child.providerState, ...(fork.state ?? {}) };
      this.loadedThreads.add(fork.threadId);
      this.persist();
      const focusedPrompt = [
        "Focused follow-up on this exact excerpt from your previous answer:",
        "",
        "<selected_excerpt>",
        segment.text,
        "</selected_excerpt>",
        "",
        "Question:",
        value
      ].join("\n");
      await this.send(child.id, value, { providerText: focusedPrompt, internal: true });
      return child;
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  threadCapacity(parentScopeId, turnId, segment) {
    const sourceTurn = findTurn(this.conversation, parentScopeId, turnId);
    if (!sourceTurn) {
      return { allowed: false, code: "missing-source-turn", message: "The selected source turn no longer exists" };
    }
    return branchCapacity(this.conversation, parentScopeId, makeAnchor(sourceTurn, segment), this.threadLimits);
  }

  setActiveScope(scopeId) {
    if (!findScope(this.conversation, scopeId)) return;
    this.conversation.activeScopeId = scopeId;
    touch(this.conversation);
    this.persist();
    this.changed();
  }

  goToParent() {
    const scope = findScope(this.conversation, this.conversation.activeScopeId);
    if (scope?.parentId) this.setActiveScope(scope.parentId);
  }

  toggleBranches(parentScopeId, anchor) {
    const matches = this.conversation.scopes.filter((scope) =>
      scope.parentId === parentScopeId &&
      scope.anchor?.messageId === anchor.messageId &&
      scope.anchor?.sourceStart === anchor.sourceStart &&
      scope.anchor?.sourceEnd === anchor.sourceEnd
    );
    const collapse = matches.some((scope) => !scope.collapsed);
    for (const scope of matches) scope.collapsed = collapse;
    this.persist();
    this.changed();
  }

  toggleActivity(scopeId, turnId, activityId) {
    const activity = findActivity(this.conversation, scopeId, turnId, activityId);
    if (!activity) return;
    activity.expanded = !activity.expanded;
    this.persist();
    this.changed();
  }

  answerApproval(accepted) {
    if (!this.pendingApproval) return;
    this.provider.resolveServerRequest(this.pendingApproval, accepted);
    this.pendingApproval = null;
    this.status = accepted ? "Approved" : "Declined";
    this.#activateNextRequest();
    this.changed();
  }

  currentUserQuestion() {
    if (!this.pendingUserInput) return null;
    return this.pendingUserInput.questions[this.pendingUserInput.index] ?? null;
  }

  answerUserInput(value) {
    const pending = this.pendingUserInput;
    const question = this.currentUserQuestion();
    if (!pending || !question) return;
    pending.answers[question.id] = { answers: value ? [value] : [] };
    pending.index += 1;
    if (pending.index < pending.questions.length) {
      this.status = "Codex needs more input";
      this.changed();
      return;
    }
    this.provider.resolveUserInput(pending.request, pending.answers);
    this.pendingUserInput = null;
    this.status = "Input sent";
    this.#activateNextRequest();
    this.changed();
  }

  async interrupt() {
    const scope = findScope(this.conversation, this.conversation.activeScopeId);
    const turn = scope ? findStreamingTurn(this.conversation, scope.id) : null;
    if (!scope?.providerThreadId || !turn?.providerTurnId) return false;
    this.status = "Interrupting Codex…";
    this.changed();
    try {
      await this.provider.interrupt(scope.providerThreadId, turn.providerTurnId);
      if (turn.assistant.status === "streaming") {
        completeTurn(this.conversation, scope.id, turn.id, "interrupted");
        this.busyScopes.delete(scope.id);
        this.status = "Turn interrupted";
        this.persist();
        this.changed();
      }
      return true;
    } catch (error) {
      this.status = `Could not interrupt: ${error.message}`;
      this.changed();
      throw error;
    }
  }

  persist() {
    touch(this.conversation);
    this.writer?.schedule();
  }

  changed() {
    this.emit("change");
  }

  async close() {
    if (this.pendingApproval) { try { this.provider.rejectServerRequest(this.pendingApproval); } catch {} }
    if (this.pendingUserInput) { try { this.provider.rejectServerRequest(this.pendingUserInput.request); } catch {} }
    for (const request of this.approvalQueue) { try { this.provider.rejectServerRequest(request); } catch {} }
    this.pendingApproval = null; this.pendingUserInput = null; this.approvalQueue = [];
    for (const scope of this.conversation.scopes) {
      for (const turn of scope.turns.filter((candidate) => candidate.assistant.status === "streaming")) {
        if (scope.providerThreadId && turn.providerTurnId) { try { await this.provider.interrupt(scope.providerThreadId, turn.providerTurnId); } catch {} }
        turn.assistant.status = "interrupted";
      }
    }
    let closeError = null;
    try { await this.writer?.flush(); } catch (error) { closeError = error; }
    try { await this.provider.close(); } catch (error) { closeError ??= error; }
    if (closeError) throw closeError;
  }

  #scopeAndTurn(providerThreadId, providerTurnId) {
    const scope = this.conversation.scopes.find((candidate) => candidate.providerThreadId === providerThreadId);
    if (!scope) return {};
    const turn = scope.turns.find((candidate) => candidate.providerTurnId === providerTurnId) ?? findStreamingTurn(this.conversation, scope.id);
    return { scope, turn };
  }

  #wireProvider() {
    this.provider.on("turn-start", (event) => {
      const scope = this.conversation.scopes.find((candidate) => candidate.providerThreadId === event.threadId);
      if (!scope || !event.turnId) return;
      const pending = findStreamingTurn(this.conversation, scope.id);
      if (pending && !pending.providerTurnId) {
        pending.providerTurnId = event.turnId;
        this.persist(); this.changed();
      }
    });

    this.provider.on("delta", (event) => {
      const { scope, turn } = this.#scopeAndTurn(event.threadId, event.turnId);
      if (!scope || !turn) return;
      if (!turn.providerTurnId) turn.providerTurnId = event.turnId;
      upsertAssistantMessage(this.conversation, scope.id, turn.id, event.itemId, { delta: event.text });
      this.persist();
      this.changed();
    });

    this.provider.on("item-complete", (event) => {
      const located = this.#scopeAndTurn(event.threadId, event.turnId);
      if (located.scope && located.turn && ACTIVITY_TYPES.has(event.item?.type)) {
        upsertActivity(this.conversation, located.scope.id, located.turn.id, event.item);
        this.persist();
        this.changed();
      }
      if (["commandExecution", "fileChange", "mcpToolCall"].includes(event.item?.type)) {
        this.status = "Codex is working…";
      }
      if (event.item?.type !== "agentMessage") return;
      const { scope, turn } = this.#scopeAndTurn(event.threadId, event.turnId);
      if (!scope || !turn || typeof event.item.text !== "string") return;
      upsertAssistantMessage(this.conversation, scope.id, turn.id, event.item.id, { text: event.item.text, phase: event.item.phase });
      this.persist();
      this.changed();
    });

    this.provider.on("item-start", (event) => {
      const item = event.item ?? {};
      const { scope, turn } = this.#scopeAndTurn(event.threadId, event.turnId);
      if (scope && turn && item.type === "agentMessage") {
        upsertAssistantMessage(this.conversation, scope.id, turn.id, item.id, { text: item.text || "", phase: item.phase });
        this.persist(); this.changed();
        return;
      }
      const visibleActivity = scope && turn && ACTIVITY_TYPES.has(item.type);
      if (visibleActivity) { upsertActivity(this.conversation, scope.id, turn.id, item); this.persist(); }
      if (item.type === "commandExecution") this.status = `Running: ${item.command || "command"}`;
      else if (item.type === "fileChange") this.status = "Preparing file changes…";
      else if (item.type === "mcpToolCall") this.status = `Calling ${item.server || "MCP"}/${item.tool || "tool"}`;
      else if (!visibleActivity) return;
      this.changed();
    });

    this.provider.on("item-output", (event) => {
      const { scope, turn } = this.#scopeAndTurn(event.threadId, event.turnId);
      if (!scope || !turn) return;
      upsertActivity(this.conversation, scope.id, turn.id, { id: event.itemId }, { appendOutput: event.text });
      this.persist(); this.changed();
    });

    this.provider.on("item-progress", (event) => {
      const { scope, turn } = this.#scopeAndTurn(event.threadId, event.turnId);
      if (!scope || !turn) return;
      const activity = upsertActivity(this.conversation, scope.id, turn.id, { id: event.itemId });
      if (activity) activity.progress = event.text;
      this.persist(); this.changed();
    });

    this.provider.on("item-interaction", (event) => {
      const { scope, turn } = this.#scopeAndTurn(event.threadId, event.turnId);
      if (!scope || !turn) return;
      const activity = upsertActivity(this.conversation, scope.id, turn.id, { id: event.itemId });
      if (activity) { activity.interactions ??= []; activity.interactions.push(event.text); }
      this.persist(); this.changed();
    });

    this.provider.on("item-update", (event) => {
      const { scope, turn } = this.#scopeAndTurn(event.threadId, event.turnId);
      if (!scope || !turn) return;
      upsertActivity(this.conversation, scope.id, turn.id, { id: event.itemId, ...event.patch });
      this.persist(); this.changed();
    });

    this.provider.on("turn-complete", (event) => {
      const { scope, turn } = this.#scopeAndTurn(event.threadId, event.turnId);
      if (!scope || !turn) return;
      const status = event.status === "completed" ? "complete" : (event.status || "failed");
      completeTurn(this.conversation, scope.id, turn.id, status);
      for (const activity of turn.assistant.activities ?? []) {
        if (["inProgress", "running"].includes(activity.status)) activity.status = status === "complete" ? "completed" : status;
      }
      this.busyScopes.delete(scope.id);
      if (event.error?.message) {
        upsertAssistantMessage(this.conversation, scope.id, turn.id, `error-${event.turnId}`, { text: `[${event.error.message}]`, phase: "commentary" });
      }
      this.status = status === "complete" ? "Ready" : `Turn ${status}`;
      this.persist();
      this.changed();
    });

    this.provider.on("thread-settings", (event) => {
      const scope = this.conversation.scopes.find((candidate) => candidate.providerThreadId === event.threadId);
      if (!scope) return;
      const settings = event.settings ?? {};
      const profile = settings.activePermissionProfile ?? scope.providerState?.activePermissionProfile ?? null;
      scope.providerState = {
        ...scope.providerState,
        model: settings.model ?? scope.providerState?.model ?? null,
        modelProvider: settings.modelProvider ?? scope.providerState?.modelProvider ?? null,
        serviceTier: settings.serviceTier ?? scope.providerState?.serviceTier ?? null,
        cwd: settings.cwd ?? scope.providerState?.cwd ?? null,
        approvalPolicy: settings.approvalPolicy ?? scope.providerState?.approvalPolicy ?? null,
        approvalsReviewer: settings.approvalsReviewer ?? scope.providerState?.approvalsReviewer ?? null,
        sandbox: settings.sandboxPolicy ?? scope.providerState?.sandbox ?? null,
        activePermissionProfile: profile,
        permissions: profile?.id ?? scope.providerState?.permissions ?? null,
        effort: settings.effort ?? settings.reasoningEffort ?? scope.providerState?.effort ?? null,
        personality: settings.personality ?? scope.providerState?.personality ?? null,
        collaborationMode: settings.collaborationMode ?? scope.providerState?.collaborationMode ?? null,
      };
      this.persist(); this.changed();
    });

    this.provider.on("token-usage", (event) => {
      const scope = this.conversation.scopes.find((candidate) => candidate.providerThreadId === event.threadId);
      if (!scope) return;
      scope.tokenUsage = event.tokenUsage;
      this.persist(); this.changed();
    });

    this.provider.on("server-request", (request) => {
      const supported = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput"]);
      if (!supported.has(request.method)) {
        this.provider.rejectServerRequest(request);
        this.status = `Unsupported Codex request: ${request.method}`;
        this.changed();
        return;
      }
      if (this.pendingApproval || this.pendingUserInput) {
        this.approvalQueue.push(request);
        return;
      }
      this.#activateRequest(request);
      this.changed();
    });

    this.provider.on("provider-error", (event) => {
      this.status = event.message || "Provider error";
      if (event.threadId && event.turnId && !event.willRetry) {
        const { scope, turn } = this.#scopeAndTurn(event.threadId, event.turnId);
        if (scope && turn) {
          if (!turn.assistant.text) turn.assistant.text = `Provider error: ${event.message || "unknown error"}`;
          turn.assistant.status = "failed";
          this.busyScopes.delete(scope.id);
          this.persist();
        }
      }
      this.changed();
    });
    this.provider.on("protocol-error", (event) => {
      this.status = event.message || "Provider protocol error";
      this.changed();
    });
  }

  #activateNextRequest() {
    if (this.pendingApproval || this.pendingUserInput || !this.approvalQueue.length) return;
    this.#activateRequest(this.approvalQueue.shift());
  }

  #activateRequest(request) {
    if (request.method === "item/tool/requestUserInput") {
      const questions = request.params?.questions ?? [];
      if (!questions.length) { this.provider.resolveUserInput(request, {}); return; }
      this.pendingUserInput = { request, questions, index: 0, answers: {} };
      this.status = "Codex needs input";
      return;
    }
    this.pendingApproval = request;
    this.status = "Codex needs a decision";
  }
}
