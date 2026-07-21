import { EventEmitter } from "node:events";

let sequence = 1;

export class DemoProvider extends EventEmitter {
  constructor() {
    super();
    this.settings = {
      model: "demo-balanced",
      effort: "medium",
      personality: "pragmatic",
      permissions: ":workspace",
    };
  }

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

  async request(method) {
    if (method === "model/list") {
      return { data: [
        {
          id: "demo-fast", model: "demo-fast", displayName: "Demo Fast",
          description: "Quick interaction for the offline showcase", isDefault: false, defaultReasoningEffort: "low",
          supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fastest" }, { reasoningEffort: "medium", description: "More deliberate" }],
        },
        {
          id: "demo-balanced", model: "demo-balanced", displayName: "Demo Balanced",
          description: "Current showcase model", isDefault: true, defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Faster" }, { reasoningEffort: "medium", description: "Balanced" }, { reasoningEffort: "high", description: "Deeper" }],
        },
        {
          id: "demo-deep", model: "demo-deep", displayName: "Demo Deep",
          description: "Shows long model catalogs and effort selection", isDefault: false, defaultReasoningEffort: "high",
          supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Moderate" }, { reasoningEffort: "high", description: "Deepest" }],
        },
      ] };
    }
    if (method === "permissionProfile/list") return { data: [
      { id: ":read-only", allowed: true, description: "Inspect without writes" },
      { id: ":workspace", allowed: true, description: "Write within the workspace" },
      { id: ":danger-full-access", allowed: true, description: "Unrestricted demo profile" },
    ] };
    if (method === "collaborationMode/list") return { data: [
      { mode: "default", model: this.settings.model, reasoning_effort: this.settings.effort },
      { mode: "plan", model: this.settings.model, reasoning_effort: this.settings.effort },
    ] };
    if (method === "mcpServerStatus/list") return { data: [
      { name: "github", authStatus: "authenticated", tools: { search_code: {}, get_file: {} } },
      { name: "playwright", authStatus: "authenticated", tools: { browser_navigate: {}, browser_snapshot: {} } },
    ] };
    if (method === "skills/list") return { data: [{ skills: [
      { name: "feature-dev", description: "Guided feature development", enabled: true },
      { name: "frontend-design", description: "Production-grade frontend interfaces", enabled: true },
    ] }] };
    if (method === "account/rateLimits/read") return { rateLimits: { primary: "demo: unlimited" } };
    if (method === "account/usage/read") return { summary: { lifetimeTokens: 12480, peakDailyTokens: 2146, currentStreakDays: 1 } };
    return { data: [] };
  }

  async updateThreadSettings(_threadId, patch) {
    this.settings = { ...this.settings, ...patch };
  }

  async setThreadName() {}

  resolveServerRequest() {}
  resolveUserInput() {}
  rejectServerRequest() {}
  async interrupt() {}
  async close() {}
}
