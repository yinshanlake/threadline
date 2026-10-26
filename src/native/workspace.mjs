import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  addBranch, branchCapacity, createConversation, findScope, makeAnchor,
  normalizeThreadLimits, rootScope, touch,
} from "../model.mjs";
import { nativeArgs, NativeTerminal } from "./terminal.mjs";
import { nativeEnvironment } from "./codex.mjs";

function userText(items) {
  return items.filter((item) => item.type === "userMessage").flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

export function importNativeThread(scope, thread) {
  const previous = new Map(scope.turns.map((turn) => [turn.providerTurnId, turn]));
  // Forked histories contain the parent's turns. Keep those in the parent
  // pane instead of repeating them as the child's own conversation.
  const inherited = new Set(scope.native?.inheritedTurnIds ?? []);
  scope.turns = (thread.turns ?? []).filter((turn) => !inherited.has(turn.id)).map((turn) => {
    const items = turn.items ?? [];
    const existing = previous.get(turn.id);
    const input = userText(items);
    const focused = scope.anchor && scope.native?.question && input.trim() === focusedPrompt(scope.anchor.exactQuote, scope.native.question).trim();
    if (scope.native?.pendingPrompt && input.trim() === scope.native.pendingPrompt.trim()) delete scope.native.pendingPrompt;
    const submitted = scope.native?.submission;
    if (submitted && input.trim() === submitted.text.trim() && turn.id !== submitted.afterTurnId && turn.status !== "inProgress") {
      delete scope.native.submission;
    }
    const messages = items.filter((item) => item.type === "agentMessage").map((item, index) => ({
      id: item.id || `${turn.id}-message-${index}`, text: item.text ?? "", phase: item.phase ?? null,
    }));
    return {
      id: existing?.id ?? `native-turn-${turn.id}`, providerTurnId: turn.id,
      collapsed: Boolean(existing?.collapsed),
      user: { id: existing?.user?.id ?? `native-user-${turn.id}`, text: focused ? scope.native.question : input },
      assistant: {
        id: existing?.assistant?.id ?? `native-answer-${turn.id}`,
        text: messages.map((message) => message.text).join("\n\n"),
        status: ({ completed: "complete", interrupted: "interrupted", failed: "failed", inProgress: "streaming" })[turn.status] ?? "complete",
        messages, itemIds: messages.map((message) => message.id), activities: [],
        timeline: messages.map((message) => ({ kind: "message", id: message.id })),
      },
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
  });
  scope.native ??= {};
  const firstQuestion = scope.turns[0]?.user.text?.split("\n")[0].trim().slice(0, 80);
  const title = scope.native.title;
  const generatedTitle = !scope.parentId && [undefined, "Main conversation", "New conversation", "Native conversation"].includes(title) ? firstQuestion : title;
  scope.native.title = thread.name || generatedTitle || (scope.parentId ? "Follow-up" : "Main conversation");
}

export function focusedPrompt(quote, question) {
  return [
    "This is a separate follow-up about a passage in the conversation you inherited.",
    "Focus on the selected excerpt and the question below.",
    "", "<selected_excerpt>", quote, "</selected_excerpt>", "", question,
  ].join("\n");
}

export class NativeWorkspace extends EventEmitter {
  constructor({ conversation = createConversation(), sessions, command, writer = null, terminalFactory = (options) => new NativeTerminal(options), yolo = false, threadLimits = {}, demo = false }) {
    super();
    if (conversation.provider !== "codex" && !demo) throw new Error("Native sidebar currently supports Codex only.");
    Object.assign(this, { conversation, sessions, command, writer, terminalFactory, yolo, demo });
    this.limits = normalizeThreadLimits(threadLimits);
    this.terminals = new Map();
    this.pending = Promise.resolve();
    this.notify = {};
    this.previousNotify = [];
    this.notice = null;
    this.closed = false;
    conversation.native ??= { version: 1 };
  }

  changed() { touch(this.conversation); this.writer?.schedule(); this.emit("change"); }

  transaction(operation) {
    const result = this.pending.catch(() => {}).then(() => {
      if (this.closed) throw new Error("Workspace is closed.");
      return operation();
    });
    this.pending = result;
    return result;
  }

  scope(id = this.conversation.activeScopeId) {
    const scope = findScope(this.conversation, id);
    if (!scope) throw new Error("Conversation no longer exists.");
    return scope;
  }

  terminalFor(id) { return [...this.terminals.values()].find((entry) => entry.scopeId === id && !entry.terminal.exited); }

  state() {
    return {
      sessionId: this.conversation.sessionId, cwd: this.conversation.cwd,
      activeScopeId: this.conversation.activeScopeId, rootScopeId: this.conversation.rootScopeId,
      notice: this.notice, demo: this.demo,
      scopes: this.conversation.scopes.map((scope) => {
        const entry = this.terminalFor(scope.id);
        return {
          id: scope.id, parentId: scope.parentId, threadId: scope.providerThreadId, anchor: scope.anchor,
          title: scope.native?.question || scope.native?.title || (scope.parentId ? "Follow-up" : "Main conversation"),
          turns: scope.turns, terminalId: entry?.id ?? null, pendingPrompt: Boolean(scope.native?.pendingPrompt),
          collapsed: Boolean(scope.collapsed),
          pendingSubmission: Boolean(scope.native?.submission), pendingText: scope.native?.submission?.text || null,
        };
      }),
    };
  }

  async initialize({ cols, rows } = {}) {
    if (!this.demo) this.previousNotify = await this.sessions.notifyCommand();
    const scope = this.scope();
    if (scope.providerThreadId) await this.sync(scope.id);
    this.openTerminal(scope.id, { cols, rows });
    await this.writer?.flush();
  }

  openTerminal(scopeId, { cols = 100, rows = 30 } = {}) {
    const scope = this.scope(scopeId);
    const existing = this.terminalFor(scopeId);
    if (existing) return existing;
    for (const entry of this.terminals.values()) {
      if (entry.scopeId === scopeId && entry.terminal.exited) { entry.terminal.close(); this.terminals.delete(entry.id); }
    }
    const id = randomUUID();
    const prompt = scope.native?.pendingPrompt;
    const terminal = this.terminalFactory({
      command: this.command,
      args: nativeArgs({ command: this.command, threadId: scope.providerThreadId, prompt, cwd: this.conversation.cwd, yolo: this.yolo, notify: !this.demo }),
      cwd: this.conversation.cwd, cols, rows,
      env: {
        ...nativeEnvironment(), THREADLINE_NOTIFY_URL: this.notify.url, THREADLINE_NOTIFY_TOKEN: this.notify.token,
        THREADLINE_TERMINAL_ID: id, THREADLINE_PREVIOUS_NOTIFY: JSON.stringify(this.previousNotify),
      },
    });
    const entry = { id, scopeId, terminal };
    this.terminals.set(id, entry);
    terminal.on("exit", ({ exitCode, error }) => {
      if (scope.native?.submission?.terminalId === id) {
        delete scope.native.submission;
        delete scope.native.pendingPrompt;
      }
      this.notice = error || (exitCode ? `Codex exited with code ${exitCode}. Reopen this conversation to continue.` : null);
      this.changed();
    });
    if (prompt) terminal.on("data", () => {
      if (!scope.native?.pendingPrompt || entry.checkingPrompt) return;
      entry.checkingPrompt = true;
      // A pending prompt survives a failed spawn, but must not survive a
      // successful native turn just because a completion hook was interrupted.
      const timer = setTimeout(() => {
        void this.transaction(() => this.sync(scope.id)).catch((error) => {
          if (!this.closed) { this.notice = error.message; this.emit("change"); }
        }).finally(() => { entry.checkingPrompt = false; });
      }, 1000);
      timer.unref?.();
    });
    this.changed();
    return entry;
  }

  async sync(scopeId = this.conversation.activeScopeId) {
    const scope = this.scope(scopeId);
    if (!scope.providerThreadId) return;
    const threadId = scope.providerThreadId;
    const thread = await this.sessions.read(threadId);
    if (scope.providerThreadId !== threadId) return;
    importNativeThread(scope, thread);
    this.changed();
  }

  notification({ terminalId, threadId, question, answer }) {
    return this.transaction(async () => {
      if (typeof threadId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(threadId)) throw new Error("Invalid Codex session identifier.");
      const entry = this.terminals.get(terminalId);
      if (!entry) throw new Error("Unknown native terminal.");
      let scope = this.scope(entry.scopeId);
      // Resolve history before changing the scope binding. Some CLI versions
      // emit notifications for transient runtime threads that have no stored
      // transcript; those must not replace the persisted conversation.
      let thread;
      if (this.demo && typeof answer === "string") this.sessions.record(threadId, { question, answer });
      try { thread = await this.sessions.read(threadId); }
      catch (error) {
        if (/thread not loaded|not found|no rollout|no conversation/iu.test(error.message)) return;
        throw error;
      }
      if (thread.id !== threadId) throw new Error("Codex returned a different session than the notification.");
      if (scope.providerThreadId && scope.providerThreadId !== threadId) {
        // /new, /resume and /fork remain native commands. Track the resulting
        // session without overwriting the original conversation's anchors.
        const known = this.conversation.scopes.find((candidate) => candidate.providerThreadId === threadId);
        if (known) scope = known;
        else {
          const fresh = rootScope(createConversation());
          fresh.providerThreadId = threadId;
          fresh.native = { title: "Native conversation" };
          this.conversation.scopes.push(fresh);
          scope = fresh;
        }
        const duplicate = this.terminalFor(scope.id);
        if (duplicate && duplicate !== entry) throw new Error("This session is already open in another terminal. Close that terminal before resuming it here.");
        const wasActive = this.conversation.activeScopeId === entry.scopeId;
        entry.scopeId = scope.id;
        if (wasActive) this.conversation.activeScopeId = scope.id;
      }
      scope.providerThreadId = threadId;
      importNativeThread(scope, thread);
      delete scope.native?.pendingPrompt;
      this.changed();
    });
  }

  branch({ scopeId, turnId, start, end, quote, question }) {
    return this.transaction(async () => {
      const parent = this.scope(scopeId);
      await this.sync(parent.id);
      const turn = parent.turns.find((candidate) => candidate.id === turnId);
      if (!turn || turn.assistant.status !== "complete" || !turn.providerTurnId || !parent.providerThreadId) {
        throw new Error("Select a passage from a completed answer.");
      }
      const text = turn.assistant.text;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length || text.slice(start, end) !== quote) {
        throw new Error("The selected passage changed. Select it again before asking.");
      }
      const value = String(question ?? "").trim();
      if (!value || value.length > 16000) throw new Error("Enter a follow-up of at most 16,000 characters.");
      const anchor = makeAnchor(turn, { start, end, text: quote });
      const duplicate = this.conversation.scopes.find((scope) => scope.parentId === parent.id &&
        scope.anchor?.messageId === anchor.messageId && scope.anchor.sourceStart === start && scope.anchor.sourceEnd === end &&
        String(scope.native?.question ?? scope.turns[0]?.user?.text ?? "").trim().replace(/\s+/gu, " " ).toLowerCase() === value.replace(/\s+/gu, " " ).toLowerCase());
      if (duplicate) return this.activate(duplicate.id);
      const capacity = branchCapacity(this.conversation, parent.id, anchor, this.limits);
      if (!capacity.allowed) throw new Error(capacity.message);
      const fork = await this.sessions.fork(parent.providerThreadId, turn.providerTurnId);
      const child = addBranch(this.conversation, parent.id, anchor, fork.threadId);
      child.providerState = fork.state ?? {};
      child.native = {
        question: value, pendingPrompt: focusedPrompt(quote, value),
        inheritedTurnIds: fork.raw?.thread?.turns?.map((item) => item.id) ??
          [...(parent.native?.inheritedTurnIds ?? []), ...parent.turns.slice(0, parent.turns.indexOf(turn) + 1).map((item) => item.providerTurnId)],
      };
      // Persist the fork and its first prompt before launching the CLI. A
      // failed launch can be reopened without creating another provider fork.
      this.conversation.activeScopeId = child.id;
      this.expandPath(child);
      this.changed();
      await this.writer?.flush();
      this.openTerminal(child.id);
      return child;
    });
  }

  async activate(scopeId) {
    const scope = this.scope(scopeId);
    if (!this.terminalFor(scope.id)) await this.sync(scope.id);
    this.openTerminal(scope.id);
    this.conversation.activeScopeId = scope.id;
    this.expandPath(scope);
    this.notice = null;
    this.changed();
    return scope;
  }

  back() {
    const scope = this.scope();
    if (!scope.parentId) throw new Error("This conversation has no parent.");
    scope.collapsed = true;
    return this.activate(scope.parentId);
  }

  expandPath(scope) {
    const visited = new Set();
    while (scope && !visited.has(scope.id)) {
      visited.add(scope.id);
      scope.collapsed = false;
      scope = scope.parentId ? this.scope(scope.parentId) : null;
    }
  }

  collapse({ scopeId, collapsed }) {
    return this.transaction(() => {
      if (typeof scopeId !== "string" || typeof collapsed !== "boolean") {
        throw new Error("Choose a conversation and an explicit collapse state.");
      }
      const scope = this.scope(scopeId);
      scope.collapsed = collapsed;
      this.changed();
      return scope;
    });
  }

  newConversation() {
    return this.transaction(async () => {
      const scope = rootScope(createConversation({ cwd: this.conversation.cwd }));
      scope.native = { title: "New conversation" };
      if (this.demo) scope.providerThreadId = (await this.sessions.create()).id;
      this.conversation.scopes.push(scope);
      this.conversation.activeScopeId = scope.id;
      this.notice = null;
      this.changed();
      await this.writer?.flush();
      this.openTerminal(scope.id);
      return scope;
    });
  }

  sendMessage({ scopeId, text }) {
    return this.transaction(async () => {
      if (typeof scopeId !== "string" || typeof text !== "string" || !text.trim() || text.length > 16000) {
        throw new Error("Enter a message of at most 16,000 characters.");
      }
      const value = text.trim().replace(/\r\n?/gu, "\n");
      if (/[\x00-\x08\x0b-\x1f\x7f]/u.test(value)) throw new Error("The message contains unsupported control characters.");
      if (value.startsWith("/")) throw new Error("Use the native terminal for slash commands.");
      const scope = this.scope(scopeId);
      if (scope.native?.submission || scope.native?.pendingPrompt || scope.turns.at(-1)?.assistant.status === "streaming") {
        throw new Error("This conversation is still running. Open Terminal for progress or approvals.");
      }
      scope.native ??= {};
      const submission = { text: value, afterTurnId: scope.turns.at(-1)?.providerTurnId || null, at: new Date().toISOString() };
      if (!scope.turns.length && !scope.parentId) scope.native.title = value.split("\n")[0].slice(0, 80);
      scope.native.submission = submission;
      this.conversation.activeScopeId = scope.id;
      this.expandPath(scope);
      this.notice = null;
      let launched = false;
      try {
        if (!scope.providerThreadId) {
          const existing = this.terminalFor(scope.id);
          if (existing) { await existing.terminal.stop?.(); existing.terminal.close(); this.terminals.delete(existing.id); }
          scope.native.submission = submission;
          scope.native.pendingPrompt = value;
          this.changed();
          await this.writer?.flush();
          submission.terminalId = this.openTerminal(scope.id).id;
          launched = true;
        } else {
          const entry = this.openTerminal(scope.id);
          submission.terminalId = entry.id;
          await entry.terminal.submit(value, { demo: this.demo });
          launched = true;
          this.changed();
        }
        await this.writer?.flush();
      } catch (error) {
        if (!launched && !scope.providerThreadId) {
          delete scope.native.submission;
          delete scope.native.pendingPrompt;
        } else if (!launched) delete scope.native.submission;
        this.changed();
        throw error;
      }
      return scope;
    });
  }

  async close() {
    this.closed = true;
    await this.pending.catch(() => {});
    await Promise.all([...this.terminals.values()].map((entry) =>
      entry.terminal.stop?.(this.demo ? { input: "/quit\r" } : {}) ?? entry.terminal.close()));
    this.terminals.clear();
    await this.writer?.flush();
  }
}
