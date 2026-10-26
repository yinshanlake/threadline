import pty from "node-pty";

let terminal;
let finished = false;
let closing = false;
let shutdownTimer;

function transmit(message, callback) {
  if (process.connected) process.send(message, callback || (() => {}));
  else callback?.();
}

function finish(event) {
  if (finished) return;
  finished = true;
  clearTimeout(shutdownTimer);
  // Exit the isolated host only after its final event reaches the parent.
  transmit({ type: "exit", event }, () => process.exit(0));
}

function terminateOwnProcess() {
  if (finished || !terminal) return;
  try { process.kill(terminal.pid); }
  catch (error) { if (error.code !== "ESRCH") transmit({ type: "error", error: error.message }); }
  shutdownTimer = setTimeout(() => process.exit(1), 4000);
}

function close() {
  if (closing || finished) return;
  closing = true;
  if (!terminal) { process.exit(0); return; }
  // Graceful Ctrl+C is attempted before this fallback. Do not enumerate or
  // kill other consoles through node-pty after a native exit.
  terminateOwnProcess();
}

process.on("message", (message) => {
  try {
    if (message.type === "start") {
      if (terminal) throw new Error("A PTY host may start only one terminal.");
      terminal = pty.spawn(message.file, message.args, message.options);
      terminal.onData((data) => transmit({ type: "data", data }));
      terminal.onExit((event) => finish(event));
      transmit({ type: "ready", pid: terminal.pid });
    } else if (message.type === "input") {
      if (terminal && !finished && !closing) terminal.write(message.data);
    } else if (message.type === "resize") {
      if (terminal && !finished && !closing) terminal.resize(message.cols, message.rows);
    } else if (message.type === "close") close();
  } catch (error) {
    transmit({ type: "error", error: error.message });
    if (!terminal) finish({ exitCode: 1, error: error.message });
  }
});

process.on("disconnect", () => close());
