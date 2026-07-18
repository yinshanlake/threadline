import { EventEmitter } from "node:events";

let sequence = 1;

export class DemoProvider extends EventEmitter {
  async connect() {
    return { platformFamily: process.platform, userAgent: "threadline-demo" };
  }

  async startThread() {
    return { threadId: `demo-thread-${sequence++}` };
  }

  async resumeThread(threadId) {
    return { threadId };
  }

  async forkThread() {
    return { threadId: `demo-thread-${sequence++}` };
  }

  async send(threadId, text) {
    const turnId = `demo-turn-${sequence++}`;
    const answer = `这是 demo provider 对“${text}”的回答。真实模式会由 Codex app-server 流式生成，并将这个局部问答保存在对应锚点下。`;
    queueMicrotask(async () => {
      for (const token of answer.match(/.{1,8}/gu) ?? []) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        this.emit("delta", { threadId, turnId, itemId: `${turnId}-message`, text: token });
      }
      this.emit("turn-complete", { threadId, turnId, status: "completed", error: null });
    });
    return { turnId };
  }

  resolveServerRequest() {}
  resolveUserInput() {}
  rejectServerRequest() {}
  async interrupt() {}
  async close() {}
}
