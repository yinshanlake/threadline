import readline from "node:readline";
import http from "node:http";

const args = process.argv.slice(2);
const threadId = args.includes("resume") ? args[args.indexOf("--cd") + 2] : null;
const firstPrompt = threadId ? args[args.indexOf("--cd") + 3] : null;
process.stdout.write("\x1b[?1049h\x1b[2J\x1b[HThreadline native sidebar demo\r\n\r\nThis is an offline terminal fixture. No model connection is made.\r\nSelect a passage in the panel to explore it.\r\n\r\n");

async function reply(question) {
  const visible = question.includes("</selected_excerpt>") ? question.split("</selected_excerpt>").at(-1).trim() : question;
  const answer = `This answer belongs to a separate conversation.\n\nYour follow-up was: ${visible}\n\nThe original conversation stays visible above. Select a passage here to create a nested branch, or use Return to parent to resume reading at the source.`;
  process.stdout.write(`\r\n${answer.replace(/\n/g, "\r\n")}\r\n\r\n› `);
  if (!threadId || !process.env.THREADLINE_NOTIFY_URL) return;
  const body = JSON.stringify({ terminalId: process.env.THREADLINE_TERMINAL_ID, threadId, question: visible, answer });
  await new Promise((resolve) => {
    const request = http.request(process.env.THREADLINE_NOTIFY_URL, { method: "POST", headers: {
      "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "X-Threadline-Notify": process.env.THREADLINE_NOTIFY_TOKEN,
    } }, (response) => { response.resume(); response.on("end", resolve); });
    request.on("error", resolve); request.end(body);
  });
}

const input = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let pending = Promise.resolve();
input.on("line", (line) => {
  if (line === "/quit" || line === "/exit") { input.close(); return; }
  process.stdout.write(`\r\nReceived literally: ${line}\r\n`);
  if (line.startsWith("/")) { process.stdout.write("› " ); return; }
  pending = pending.then(() => reply(line));
});
input.on("close", () => { process.stdout.write("\x1b[?1049l"); process.exit(0); });
input.on("SIGINT", () => input.close());
if (firstPrompt) await reply(firstPrompt);
else process.stdout.write("› " );
