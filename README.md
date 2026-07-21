# Threadline

Threadline is a small terminal UI for creating real deep-dive branches from individual passages in an LLM CLI answer. Its first provider is Codex, with full-screen and portable line modes.

## Requirements

- Node.js 18 or newer
- a working Codex login (`codex login`)
- a terminal; Windows Terminal is recommended on Windows

## Install

Install the current `main` branch from GitHub's source archive. This also installs the compatible Codex CLI dependency:

```shell
npm install --global https://github.com/yinshanlake/threadline/archive/refs/heads/main.tar.gz
codex login
threadline --probe
threadline demo
threadline --new
```

To try it without a global install:

```shell
npx --yes --package=https://github.com/yinshanlake/threadline/archive/refs/heads/main.tar.gz threadline demo
```

To work from a clone:

```shell
git clone https://github.com/yinshanlake/threadline.git
cd threadline
npm install
npm test
npm link
threadline demo
```

`--probe` verifies the Codex protocol without starting a conversation. `threadline demo` always opens a fresh offline feature showcase; `--demo` keeps the resumable demo-session behavior. Neither connects to Codex.
Use `--yolo` for the same full-access/no-approval posture as Codex (`danger-full-access` plus `approval_policy=never`). This is intentionally opt-in.

## Interactive demo

Run `threadline demo` in Windows Terminal or another full-screen terminal. The showcase includes two root threads, one nested thread, stable thread colors, a collapsed tool-call group, a paged command payload, the slash-command menu, and the model/reasoning picker.
Use `threadline demo --no-alt-screen` if the walkthrough should remain in terminal scrollback, or `threadline demo --snapshot` for a non-interactive text preview.

A quick walkthrough:

1. Press `Up` twice. The `4 activities` summary is selected.
2. Press `Enter` to expand the group, then move to `npm test -- --showcase` and press `Enter` again. Use `[` and `]` to page through its output.
3. Press `T` to see the colored thread tree. `Enter` opens a focused thread; `B` returns to its parent.
4. Press `Esc`, type `/model`, and press `Enter`. Choose a model and reasoning effort with the arrow keys and `Enter`.
5. Type `/status`, `/mcp`, or `/skills` to see offline command panels.
6. Select any completed answer passage and start typing to create another simulated deep-dive fork.
7. Press `Ctrl+C` to save and print a GUID-based resume command.

Every session is also archived under a GUID. On exit Threadline prints a command such as:

```shell
Session saved: 91e041bc-6238-47cd-9f37-4146e4432dc2
To continue, run: threadline resume 91e041bc-6238-47cd-9f37-4146e4432dc2
```

The existing per-directory automatic resume remains available. `threadline resume GUID` (or `--resume GUID`) restores a specific archived session from any directory.

## Keys

- Type and press `Enter` to send on the current scope.
- While Codex is working, the footer shows elapsed time; press `Esc` to stop a stalled or unwanted answer without leaving Threadline.
- With an empty composer and completed content available, `Up` or `Tab` enters Inspect mode at the latest answer.
- `Up`/`Down` chooses an answer passage, tool activity, or thread.
- Start typing on a selected passage (or press `Enter`) to ask a focused follow-up and create a real Codex fork.
- To keep one conversation navigable, Threadline allows up to 32 deep-dive threads, 4 nested levels, and 3 threads on the same excerpt. An identical follow-up reuses the existing idea instead of creating another provider fork.
- Consecutive tool activities are collapsed into one status summary by default. `Enter`, `Space`, or `Right` expands the group so each activity can be inspected; `Left` collapses it again.
- `Enter` on an individual tool activity expands the complete payload Threadline received from the CLI.
- `[` / `]` pages through very large expanded tool payloads; the session still keeps the complete received data.
- `Enter` on a thread opens its focused view; `B` returns to its parent.
- `Left`/`Right` collapses or expands a thread, tool group, or individual tool activity; `Space` toggles it.
- `V` switches between passage and sentence precision while inspecting.
- `T` shows all deep-dive threads.
- `Ctrl+C` saves and exits. Command and file approvals require an explicit `y`; `n` or `Esc` declines.

Each deep-dive thread has a stable accent color derived from its Threadline scope ID. The accent follows that thread through inline, focused, overview, resize, and resumed views; `--no-color` remains plain text. Completed answer blocks inside an inline thread are selectable too, so a thread can branch again from its own answer.

## Thread context

Threadline deep dives are real Codex forks, not prompts reconstructed from the visible terminal. When a passage is selected, Threadline calls `thread/fork` with the parent Codex thread ID and the provider turn ID that produced that answer. Codex therefore copies the complete provider context up to that turn. Threadline then sends a focused prompt containing the exact selected excerpt and the follow-up question.

After the fork, contexts are isolated: later main-thread messages do not enter an existing child, and child answers do not alter the parent. A nested deep dive forks from its immediate child thread and selected child turn. Threadline stores the tree, anchors, provider thread/turn IDs, transcript, and UI state; Codex owns the actual model-context history and compaction for each provider thread.

## Portable mode

Threadline automatically uses line mode for `TERM=dumb` and non-TTY input/output. It can also be forced:

```powershell
.\threadline.cmd --line
```

Run `/help` for `/segments`, `/dive N question`, `/activities`, `/activity N`, `/threads`, `/open N`, `/back`, and `/quit`.

## Codex slash commands

Threadline handles compatible Codex commands locally instead of sending slash text to the model.
Type `/` in the full-screen composer to open the command menu; use Up/Down, Tab, and Enter to
select a command. Core commands include `/status`, `/model [MODEL [EFFORT]]`,
`/permissions [PROFILE]`, `/personality`, `/plan [PROMPT]`, `/default [PROMPT]`, `/compact`,
`/review [INSTRUCTIONS]`, `/rename NAME`, `/mcp [verbose]`, `/skills [FILTER]`, `/usage`,
`/init`, `/diff`, `/new`, and `/copy`.

Some commands such as `/theme`, `/keymap`, `/vim`, and `/app` only control the original Codex
TUI and have no portable app-server equivalent. Threadline reports these explicitly and never
silently turns them into model prompts. Run `/help` for the current Threadline command list.

## Storage and boundaries

Threadline stores its own anchors and branch layout under `%LOCALAPPDATA%\threadline\sessions` on Windows or the platform state directory on macOS/Linux. Codex stores provider sessions normally. Anchors use source-text offsets and quote context, never terminal row/column coordinates. Model text is sanitized before terminal rendering so it cannot emit terminal control sequences. Local sessions and transcripts are not part of this repository.

Assistant messages and tool activities are persisted in app-server event order. Command and file output deltas are stored in full as received and are not shortened by the UI. If Codex or a tool truncates output before sending it, Threadline cannot recover the missing bytes; it preserves visible truncation markers and reports the received character count in activity details.
Inspect highlights are local source-range metadata and never become line-by-line model input. Long streams are coalesced for repaint only; persisted events are not coalesced or discarded. A malformed app-server JSON line is surfaced as a protocol error rather than silently treated as transcript data.
Sessions created by the earlier `0.1` prototype remain readable, but their original interleaving of tools and assistant notes was never recorded; migrated turns are labeled instead of presenting a guessed order as exact.

Thread limits are enforced before `thread/fork`, so a rejected deep dive does not leave an orphan Codex session. Existing threads remain readable if an older saved conversation already exceeds a current limit; only additional forks are blocked.

By default, one session allows up to **32 deep-dive threads**, **4 nesting levels**, and **3 threads on the same excerpt**. An identical follow-up on the same excerpt reopens the existing thread instead of forking again. The TUI header shows `current/max` and adds `!` after 75% capacity. Limits can be tightened for a run:

```powershell
.\threadline.cmd --max-threads 16 --max-depth 3 --max-per-anchor 2
```

The Codex app-server protocol is currently experimental. Its JSON-RPC details are isolated in `src/providers/codex.mjs`, and `--probe` provides a quick compatibility check after Codex upgrades.
Threadline uses its installed `@openai/codex` dependency. Nonstandard installations can set `THREADLINE_CODEX_PATH` to an absolute `codex` executable or `codex.js` path.
The legacy `ado` MCP entry is disabled only inside Threadline's Codex process because it duplicates the newer `azure-devops` entry and can block the first answer for more than a minute. This does not edit the user's global Codex configuration; `azure-devops`, Bluebird, WorkIQ, Playwright, and Substrate MCP servers remain available.

## Development

```powershell
npm install
npm test
npm run snapshot
npm run probe
```

See [SECURITY.md](SECURITY.md) before reporting a vulnerability or sharing diagnostics.
