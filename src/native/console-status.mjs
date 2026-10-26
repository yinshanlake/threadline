const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u;
const BLOCKED = /allow command\?|approval required|press enter to confirm|Trust this folder\?|Do you want to proceed|Do you trust the contents|enter to submit (?:answer|all)/iu;
const RUN_STATE = /(?:^|[·│])\s*(Ready|Working|Starting|Thinking|Running|Waiting|Blocked|Action Required|Idle)\s*(?:[·│]|$)/iu;

function nativeElapsed(line) {
  const match = line.match(/\(((?:\d+h\s*)?(?:\d+m\s*)?\d+s)(?:[\s•·]|\))/u);
  if (!match) return null;
  let seconds = 0;
  for (const unit of match[1].matchAll(/(\d+)([hms])/gu)) seconds += Number(unit[1]) * ({ h: 3600, m: 60, s: 1 }[unit[2]]);
  return seconds;
}

function activityText(line) {
  return line.trim().replace(/^[•◦*⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*/u, "")
    .replace(/\s*\((?:\d+h\s*)?(?:\d+m\s*)?\d+s(?:[^)]*)\).*$/u, "").trim();
}

// Inspect the native live viewport, never the user's scrolled transcript.
// Footer/OSC state wins over old progress text; quoted or completed output is
// not treated as proof that an agent is running.
export function inspectNativeStatus(lines, title = "") {
  const visible = lines.map((line) => line.replace(/\x1b\[[\d;:]*m/gu, "").trimEnd());
  const prompt = visible.findLastIndex((line) => /^\s*[›❯]/u.test(line));
  const live = prompt >= 0 ? visible.slice(prompt) : visible.slice(-20);
  if (/Action Required/iu.test(title) || BLOCKED.test(live.join(" "))) {
    return { kind: "blocked", activity: live.find((line) => BLOCKED.test(line))?.trim() || "等待确认或回答", row: null };
  }
  const footer = visible.findLastIndex((line, row) => (prompt < 0 ? row >= visible.length - 4 : row > prompt) &&
    /(?:[·│].*(?:Context|Fast|Workspace|used)|(?:GPT-|gpt-|Codex))/iu.test(line) && RUN_STATE.test(line));
  const footerState = footer >= 0 ? visible[footer].match(RUN_STATE)[1].toLowerCase() : null;
  if (["blocked", "action required"].includes(footerState)) return { kind: "blocked", activity: "等待人工输入", row: footer };
  if (footerState === "waiting") return { kind: "waiting", activity: "Codex 正在等待", row: footer };
  const row = visible.findLastIndex((line) =>
    !/^\s*(?:›|❯|Worked for|[•◦]\s*Worked for)/iu.test(line) &&
    (/\((?:\d+h\s*)?(?:\d+m\s*)?\d+s[^)]*to interrupt\)/iu.test(line) ||
      /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏].*\(\d+[hms]/u.test(line)));
  const laterCompletion = row >= 0 && visible.slice(row + 1).some((line) =>
    /^\s*(?:[•◦]\s*)?Worked for\b/iu.test(line) || /^\s*[•■✓✗]\s+/u.test(line) && !/to interrupt/iu.test(line));
  if (["ready", "idle"].includes(footerState)) return { kind: "idle", activity: "可继续输入", row: footer };
  if (footerState === "starting") return { kind: "starting", activity: "正在启动 Codex", row: footer };
  if (["working", "thinking", "running"].includes(footerState) || SPINNER.test(title) || row >= 0 && !laterCompletion) {
    const activity = row >= 0 && !laterCompletion ? activityText(visible[row]) : "Codex 正在处理";
    return { kind: "working", activity: activity || "Codex 正在处理", row: row >= 0 && !laterCompletion ? row : null,
      elapsedSeconds: row >= 0 && !laterCompletion ? nativeElapsed(visible[row]) : null };
  }
  if (/Reconnect failed/iu.test(live.join(" "))) return { kind: "failed", activity: "连接失败，请查看原生详情", row: null };
  return { kind: "unknown", activity: "尚未识别运行状态", row: null };
}

export class NativeStatus {
  constructor(now = Date.now()) { this.state = { kind: "starting", activity: "正在启动终端", row: null }; this.startedAt = now; this.lastDuration = null; }

  observe(evidence, now = Date.now()) {
    const running = ["working", "starting"].includes(evidence.kind);
    const previousRunning = ["working", "starting"].includes(this.state.kind);
    if (running && (!previousRunning || evidence.kind === "working" && this.state.kind === "starting")) {
      this.startedAt = now - (evidence.elapsedSeconds || 0) * 1000;
    }
    if (!running && previousRunning && this.state.kind === "working") this.lastDuration = Math.max(0, Math.floor((now - this.startedAt) / 1000));
    if (evidence.kind === "working" && Number.isFinite(evidence.elapsedSeconds)) {
      this.startedAt = Math.min(this.startedAt, now - evidence.elapsedSeconds * 1000);
    }
    this.state = evidence;
    return this.current(now);
  }

  current(now = Date.now()) {
    return { ...this.state, elapsedSeconds: ["working", "starting"].includes(this.state.kind)
      ? Math.max(0, Math.floor((now - this.startedAt) / 1000)) : null, lastDuration: this.lastDuration };
  }
}

export function formatNativeStatus(status, now = Date.now()) {
  const labels = { starting: "启动中", working: "工作中", waiting: "等待中", blocked: "等待确认", idle: "就绪", failed: "失败", exited: "已退出", unknown: "状态未识别" };
  const label = labels[status.kind] || labels.unknown;
  const animation = status.kind === "working" || status.kind === "starting" ? Array.from("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏")[Math.floor(now / 200) % 10] + " " : "";
  const elapsed = Number.isFinite(status.elapsedSeconds) ? " " + status.elapsedSeconds + "s" : "";
  const activity = status.activity && status.kind !== "idle" ? " · " + status.activity : "";
  return animation + label + elapsed + activity;
}
