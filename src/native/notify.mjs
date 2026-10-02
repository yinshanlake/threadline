import http from "node:http";
import { spawn } from "node:child_process";

// Called by the native CLI's documented notify hook, never from terminal text.
// No credentials, transcript, or notification payload is written to stdout.
const raw = process.argv.at(-1);
try {
  const event = JSON.parse(raw);
  const endpoint = new URL(process.env.THREADLINE_NOTIFY_URL);
  if (event.type === "agent-turn-complete" && endpoint.hostname === "127.0.0.1") {
    const body = JSON.stringify({
      terminalId: process.env.THREADLINE_TERMINAL_ID,
      threadId: event["thread-id"],
      turnId: event["turn-id"],
    });
    await new Promise((resolve) => {
      const request = http.request(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "X-Threadline-Notify": process.env.THREADLINE_NOTIFY_TOKEN },
        timeout: 3000,
      }, (response) => { response.resume(); response.on("end", resolve); });
      request.on("error", resolve);
      request.on("timeout", () => { request.destroy(); resolve(); });
      request.end(body);
    });
  }
} catch {}

// Preserve the user's existing notification program for this invocation.
try {
  const previous = JSON.parse(process.env.THREADLINE_PREVIOUS_NOTIFY || "[]");
  if (previous.length && previous.every((part) => typeof part === "string")) {
    const child = spawn(previous[0], [...previous.slice(1), raw], { stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
  }
} catch {}
