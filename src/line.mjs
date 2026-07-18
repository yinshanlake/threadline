import { createInterface } from "node:readline/promises";
import { findScope, segmentsForTurn } from "./model.mjs";
import { overviewView, renderSnapshot } from "./render.mjs";
import { sanitizeTerminalText } from "./text.mjs";

function selectableSegments(conversation, scopeId) {
  const scope = findScope(conversation, scopeId);
  const items = [];
  for (const turn of scope?.turns ?? []) {
    if (turn.assistant.status !== "complete") continue;
    for (const segment of segmentsForTurn(turn)) items.push({ scopeId, turnId: turn.id, segment });
  }
  return items;
}

function selectableActivities(conversation, scopeId) {
  const scope = findScope(conversation, scopeId);
  const items = [];
  for (const turn of scope?.turns ?? []) {
    for (const activity of turn.assistant.activities ?? []) items.push({ scope, turn, activity });
  }
  return items;
}

export class LineApp {
  constructor({ controller, input = process.stdin, output = process.stdout }) {
    this.controller = controller; this.input = input; this.output = output; this.rl = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  }

  print(text = "") { this.output.write(sanitizeTerminalText(text) + "\n"); }

  async waitForTurn(turn) {
    while (turn.assistant.status === "streaming") {
      if (this.controller.pendingUserInput) {
        if (!this.input.isTTY) { this.controller.answerUserInput(""); continue; }
        const question = this.controller.currentUserQuestion();
        const answer = await this.rl.question(`${sanitizeTerminalText(question?.question || "Input requested")} > `);
        this.controller.answerUserInput(answer);
        continue;
      }
      if (this.controller.pendingApproval) {
        if (!this.input.isTTY) { this.controller.answerApproval(false); continue; }
        const answer = await this.rl.question("Codex requests approval [y/N] > ");
        this.controller.answerApproval(/^y(es)?$/i.test(answer.trim()));
        continue;
      }
      await new Promise((resolve) => {
        const changed = () => { this.controller.off("change", changed); resolve(); };
        this.controller.once("change", changed);
      });
    }
  }

  async run() {
    try {
      await this.controller.start();
      this.print("Threadline line mode. /help lists commands.");
      this.print(renderSnapshot(this.controller.conversation));
      if (!this.input.isTTY) {
        for await (const value of this.rl) { if (!(await this.execute(value))) break; }
        return;
      }
      while (true) {
        if (this.controller.pendingUserInput) {
          const question = this.controller.currentUserQuestion();
          const answer = await this.rl.question(`${sanitizeTerminalText(question?.question || "Input requested")} > `);
          this.controller.answerUserInput(answer);
          continue;
        }
        if (this.controller.pendingApproval) {
          const answer = await this.rl.question("Codex requests approval [y/N] > ");
          this.controller.answerApproval(/^y(es)?$/i.test(answer.trim()));
          continue;
        }
        const value = await this.rl.question("threadline> ");
        const shouldContinue = await this.execute(value);
        if (!shouldContinue) break;
      }
    } finally {
      this.rl.close();
      await this.controller.close();
    }
  }

  async execute(raw) {
    const input = raw.trim();
    if (!input) return true;
    if (["/quit", "/exit"].includes(input)) return false;
    if (input === "/help") {
      this.print("/show  /segments  /dive N question  /activities  /activity N  /threads  /open N  /back  /quit"); return true;
    }
    if (input === "/show") { this.print(renderSnapshot(this.controller.conversation)); return true; }
    if (input === "/segments") {
      const items = selectableSegments(this.controller.conversation, this.controller.conversation.activeScopeId);
      items.forEach((item, index) => this.print(`${index + 1}. ${item.segment.text}`));
      if (!items.length) this.print("No completed answer segments.");
      return true;
    }
    if (input === "/threads") {
      const count = this.controller.conversation.scopes.filter((scope) => scope.parentId).length;
      const limit = this.controller.threadLimits?.maxTotal;
      if (limit) this.print(`Threads: ${count}/${limit}`);
      const view = overviewView(this.controller.conversation, 88); view.lines.forEach((line) => this.print(line.text)); return true;
    }
    if (input === "/activities") {
      const items = selectableActivities(this.controller.conversation, this.controller.conversation.activeScopeId);
      items.forEach((entry, index) => this.print(`${index + 1}. ${entry.activity.type}  ${entry.activity.status}  ${entry.activity.item?.command || entry.activity.item?.tool || entry.activity.item?.query || entry.activity.id}`));
      if (!items.length) this.print("No tool activities in this scope.");
      return true;
    }
    const activity = input.match(/^\/activity\s+(\d+)$/i);
    if (activity) {
      const items = selectableActivities(this.controller.conversation, this.controller.conversation.activeScopeId);
      const target = items[Number(activity[1]) - 1];
      if (!target) { this.print("Unknown activity number. Run /activities first."); return true; }
      target.activity.expanded = true;
      this.print(renderSnapshot(this.controller.conversation));
      target.activity.expanded = false;
      return true;
    }
    if (input === "/back") { this.controller.goToParent(); this.print(renderSnapshot(this.controller.conversation)); return true; }
    const open = input.match(/^\/open\s+(\d+)$/i);
    if (open) {
      const scopes = this.controller.conversation.scopes.filter((scope) => scope.parentId);
      const scope = scopes[Number(open[1]) - 1];
      if (!scope) this.print("Unknown thread number."); else { this.controller.setActiveScope(scope.id); this.print(renderSnapshot(this.controller.conversation)); }
      return true;
    }
    const dive = input.match(/^\/dive\s+(\d+)\s+(.+)$/is);
    if (dive) {
      const items = selectableSegments(this.controller.conversation, this.controller.conversation.activeScopeId);
      const target = items[Number(dive[1]) - 1];
      if (!target) { this.print("Unknown segment number. Run /segments first."); return true; }
      const scopeCount = this.controller.conversation.scopes.length;
      try {
        await this.controller.dive(target.scopeId, target.turnId, target.segment, dive[2]);
      } catch (error) {
        if (error.code === "duplicate-thread" && error.scopeId) {
          this.controller.setActiveScope(error.scopeId);
          this.print("Opened the existing matching thread.");
          this.print(renderSnapshot(this.controller.conversation));
        } else {
          this.print(`Thread not created: ${error.message}`);
        }
        return true;
      }
      const child = this.controller.conversation.scopes[scopeCount];
      const turn = child?.turns.at(-1); if (turn) await this.waitForTurn(turn);
      this.print(renderSnapshot(this.controller.conversation)); return true;
    }
    if (input.startsWith("/")) { this.print("Unknown command. Run /help."); return true; }
    const turn = await this.controller.send(this.controller.conversation.activeScopeId, input);
    if (turn) await this.waitForTurn(turn);
    const scope = findScope(this.controller.conversation, this.controller.conversation.activeScopeId);
    this.print(scope?.turns.at(-1)?.assistant.text ?? "");
    return true;
  }
}
