import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

// The terminal UI needs the native completion callback, not a browser server.
export async function startNotificationServer(workspace) {
  const token = randomBytes(32).toString("hex");
  const server = http.createServer(async (request, response) => {
    try {
      const actual = Buffer.from(String(request.headers["x-threadline-notify"] || ""));
      const expected = Buffer.from(token);
      if (request.method !== "POST" || request.url !== "/notify" || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        response.writeHead(401); response.end(); return;
      }
      if (!request.headers["content-type"]?.startsWith("application/json")) throw new Error("Expected JSON notification.");
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 128 * 1024) throw new Error("Notification is too large."); chunks.push(chunk); }
      await workspace.notification(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200); response.end();
    } catch (error) {
      workspace.notice = "Could not update conversation history: " + error.message;
      workspace.emit("change"); response.writeHead(400); response.end();
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  workspace.notify = { url: "http://127.0.0.1:" + server.address().port + "/notify", token };
  return { async close() { await new Promise((resolve) => { server.close(resolve); server.closeIdleConnections?.(); }); } };
}
