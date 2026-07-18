# Threadline

Threadline is a small terminal UI for creating real deep-dive branches from individual passages in an LLM CLI answer. Its first provider is Codex, with full-screen and portable line modes.

## Requirements

- Node.js 18 or newer
- a working Codex login (`codex login`)
- a terminal; Windows Terminal is recommended on Windows

## Install

Install directly from GitHub. This also installs the compatible Codex CLI dependency:

```shell
npm install --global github:yinshanlake/threadline
codex login
threadline --probe
threadline --demo --new
threadline --new
```

To try it without a global install:

```shell
npx --yes github:yinshanlake/threadline --demo --new
```

To work from a clone:

```shell
git clone https://github.com/yinshanlake/threadline.git
cd threadline
npm install
npm test
npm link
threadline --demo --new
```

`--probe` verifies the Codex protocol without starting a conversation. `--demo` exercises selection, expansion, and collapse without using the model. Omit `--new` to resume the saved Threadline session for the current working directory.

## Keys

- Type and press `Enter` to send on the current scope.
- With an empty composer, `Up` or `Tab` enters Inspect mode at the latest answer.
- `Up`/`Down` chooses an answer passage, tool activity, or thread.
- Start typing on a selected passage (or press `Enter`) to ask a focused follow-up and create a real Codex fork.
- To keep one conversation navigable, Threadline allows up to 32 deep-dive threads, 4 nested levels, and 3 threads on the same excerpt. An identical follow-up reuses the existing idea instead of creating another provider fork.
- `Enter` on a tool activity expands the complete payload Threadline received from the CLI.
- `[` / `]` pages through very large expanded tool payloads; the session still keeps the complete received data.
- `Enter` on a thread opens its focused view; `B` returns to its parent.
- `Left`/`Right` collapses or expands a thread or tool activity; `Space` toggles it.
- `V` switches between passage and sentence precision while inspecting.
- `T` shows all deep-dive threads.
- `Ctrl+C` saves and exits. Command and file approvals require an explicit `y`; `n` or `Esc` declines.

## Portable mode

Threadline automatically uses line mode for `TERM=dumb` and non-TTY input/output. It can also be forced:

```powershell
.\threadline.cmd --line
```

Run `/help` for `/segments`, `/dive N question`, `/activities`, `/activity N`, `/threads`, `/open N`, `/back`, and `/quit`.

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

## Development

```powershell
npm install
npm test
npm run snapshot
npm run probe
```

See [SECURITY.md](SECURITY.md) before reporting a vulnerability or sharing diagnostics.
