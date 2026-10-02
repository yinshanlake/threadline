import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const require = createRequire(import.meta.url);
const directory = path.dirname(fileURLToPath(import.meta.url));
const vendor = (name, file) => path.join(path.dirname(require.resolve(`${name}/package.json`)), file);
const assets = new Map([
  ["/", [path.join(directory, "web", "index.html"), "text/html"]],
  ["/app.js", [path.join(directory, "web", "app.js"), "text/javascript"]],
  ["/style.css", [path.join(directory, "web", "style.css"), "text/css"]],
  ["/vendor/xterm.mjs", [vendor("@xterm/xterm", "lib/xterm.mjs"), "text/javascript"]],
  ["/vendor/fit.mjs", [vendor("@xterm/addon-fit", "lib/addon-fit.mjs"), "text/javascript"]],
  ["/vendor/xterm.css", [vendor("@xterm/xterm", "css/xterm.css"), "text/css"]],
]);

function matches(actual, expected) {
  if (typeof actual !== "string") return false;
  const value = Buffer.from(actual);
  const target = Buffer.from(expected);
  return value.length === target.length && timingSafeEqual(value, target);
}

async function jsonBody(request) {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new Error("Expected JSON input.");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 128 * 1024) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startNativeServer({ workspace, port = 0 }) {
  const token = randomBytes(32).toString("hex");
  const notifyToken = randomBytes(32).toString("hex");
  const cookieName = "threadline_" + randomBytes(8).toString("hex");
  let origin;
  const authorized = (request) => matches(request.headers.cookie?.split(";").map((value) => value.trim())
    .find((value) => value.startsWith(cookieName + "="))?.slice(cookieName.length + 1), token);
  const send = (response, status, value) => {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(value));
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) {
      send(response, 403, { error: "Invalid origin." }); return;
    }
    try {
      const pathname = new URL(request.url, origin).pathname;
      if (pathname === "/readyz" && request.method === "GET") { send(response, 200, { ready: true }); return; }
      if (pathname === "/api/bootstrap" && request.method === "POST") {
        if (!matches(request.headers["x-threadline-token"], token)) { send(response, 401, { error: "Open the link printed by Threadline to connect." }); return; }
        response.setHeader("Set-Cookie", `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`);
        send(response, 200, { connected: true }); return;
      }
      if (pathname === "/api/notify" && request.method === "POST") {
        if (!matches(request.headers["x-threadline-notify"], notifyToken)) { send(response, 401, { error: "Unauthorized notification." }); return; }
        try { await workspace.notification(await jsonBody(request)); }
        catch (error) { workspace.notice = "Could not update the answer panel: " + error.message; workspace.emit("change"); throw error; }
        send(response, 200, { ok: true }); return;
      }
      if (pathname.startsWith("/api/")) {
        if (!authorized(request)) { send(response, 401, { error: "Open the link printed by Threadline to connect." }); return; }
        if (request.method === "GET" && pathname === "/api/state") { send(response, 200, workspace.state()); return; }
        if (request.method !== "POST") { send(response, 404, { error: "Unknown action." }); return; }
        const input = await jsonBody(request);
        if (pathname === "/api/branch") await workspace.branch(input);
        else if (pathname === "/api/activate") await workspace.transaction(() => workspace.activate(input.scopeId));
        else if (pathname === "/api/back") await workspace.transaction(() => workspace.back());
        else if (pathname === "/api/refresh") await workspace.transaction(() => workspace.sync());
        else { send(response, 404, { error: "Unknown action." }); return; }
        send(response, 200, workspace.state()); return;
      }
      if (request.method === "GET" && assets.has(pathname)) {
        const [file, mime] = assets.get(pathname);
        response.writeHead(200, { "Content-Type": `${mime}; charset=utf-8` });
        response.end(await readFile(file)); return;
      }
      send(response, 404, { error: "Not found." });
    } catch (error) {
      if (!response.headersSent) send(response, 400, { error: error.message });
      else response.end();
    }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => {});
    const pathname = new URL(request.url, origin).pathname;
    const id = pathname.startsWith("/terminal/") ? pathname.slice(10) : null;
    const entry = workspace.terminals.get(id);
    if (request.headers.host !== new URL(origin).host || request.headers.origin !== origin || !authorized(request) || !entry) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client, entry));
  });
  sockets.on("connection", async (client, entry) => {
    const terminal = entry.terminal;
    terminal.viewers += 1;
    let ready = false;
    const queued = [];
    const transmit = (value) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (client.bufferedAmount > 4 * 1024 * 1024) { client.close(1013, "Terminal output is waiting. Reconnect to restore the screen."); return; }
      client.send(JSON.stringify(value));
    };
    const onData = (event) => { if (ready) transmit({ type: "output", data: event.data }); else queued.push(event); };
    const onExit = (event) => transmit({ type: "exit", ...event });
    terminal.on("data", onData);
    terminal.on("exit", onExit);
    client.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === "input") terminal.write(message.data);
        else if (message.type === "resize") terminal.resize(message.cols, message.rows);
        else throw new Error("Unknown terminal action.");
      } catch (error) { transmit({ type: "error", message: error.message }); }
    });
    client.on("error", () => {});
    client.on("close", () => {
      terminal.viewers = Math.max(0, terminal.viewers - 1);
      terminal.off("data", onData); terminal.off("exit", onExit);
    });
    try {
      const snapshot = await terminal.snapshot();
      transmit({ type: "snapshot", ...snapshot });
      for (const event of queued) if (event.sequence > snapshot.sequence) transmit({ type: "output", data: event.data });
      ready = true;
      if (terminal.exited) transmit({ type: "exit", exitCode: 0 });
    } catch (error) { transmit({ type: "error", message: error.message }); }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  workspace.notify = { url: `${origin}/api/notify`, token: notifyToken };
  return {
    origin, url: `${origin}/#${token}`, server,
    async close() {
      for (const client of sockets.clients) client.terminate();
      await new Promise((resolve) => sockets.close(resolve));
      await new Promise((resolve) => { server.close(resolve); server.closeIdleConnections?.(); });
    },
  };
}
