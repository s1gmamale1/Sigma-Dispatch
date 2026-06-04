# Sigma-Dispatch

Sigma-Dispatch is a Claude Code plugin that lets you offload coding tasks to multiple AI CLI tools — Codex, Gemini, OpenCode, and Kimi — as isolated, parallel **lanes**. Each lane runs in its own git worktree so work is sandboxed from your main branch. When a lane finishes you review the diff with an Opus gate, then land it with a single command.

**What it solves:** running several AI coding agents in parallel without them clobbering each other, without leaving unreviewed code on your main branch, and without manual worktree plumbing.

---

## Lifecycle

```
/codex <task>  or  /fanout codex:task1\ngemini:task2
       │
       ▼
  Write task to .claude/lanes/tasks/<id>.md   (injection-safe, no shell interp)
       │
       ▼
  env -u CLAUDE_CODE_SESSION_ID claude -p --worktree <id> --agent <cli>-worker ...
       │
       ▼
  [Worktree Lane]  isolation check → CLI runs → git diff non-empty guard → local commit
       │
       ▼
  .claude/lanes/<id>.json written  (state: done | error, verdict: pending)
       │
       ▼
  /verify <id>   — Opus reviewer gate  →  verdict: approve | changes
       │
       ▼
  /land <id>     — no-ff merge into base branch, worktree cleaned up
       │
       ▼
  git push       — explicit, manual step (never automatic)
```

---

## Setup

**Prerequisites**

- A git repository with a `main` or `master` branch — **required for lanes** (`/codex`, `/fanout`), since they use worktrees. `/consult` does not need a git repo. If you run a lane command outside a git repo it stops with a clear message pointing you at `git init` or `/consult`.
- The AI CLIs you want to use installed and authenticated:
  - **codex** — credentials in `~/.codex/auth.json`
  - **gemini** — `GEMINI_API_KEY` env var set to a valid API key with Flash model access
  - **opencode** — free-tier account; verify active model via `opencode models`
  - **kimi** — authenticated via `kimi login`
- Node.js 18+ (for `lanes.cjs` and the statusline helper).

**Install the plugin**

```bash
export CLAUDE_PLUGIN_ROOT=/absolute/path/to/plugin   # e.g. $(pwd)/plugin
claude --plugin-dir "$CLAUDE_PLUGIN_ROOT"
```

Add the export to your shell profile so it persists across sessions.

**Or install it persistently (recommended)** via the bundled marketplace manifest:

```bash
claude plugin marketplace add s1gmamale1/Sigma-Dispatch
claude plugin install sigma-dispatch@sigma-dispatch
```

**Statusline wiring**

Add to `.claude/settings.json` in your project, using the **absolute path** to the plugin's statusline script (the statusline command does not reliably inherit `$CLAUDE_PLUGIN_ROOT`):

```json
{
  "statusLine": {
    "command": "sh -c 'exec node \"/absolute/path/to/sigma-dispatch/plugin/lib/statusline-cli-lanes.cjs\"'"
  }
}
```

The statusline script reads the live agent list and lane status files and renders a compact summary (e.g. `codex● · gemini✓2`). If a RuFlo statusline helper is present at `.claude/helpers/statusline.cjs`, the lane summary is composed onto the end of the existing bar — nothing is overwritten.

The `🛠` segment appears **only while you have active dispatch lanes**: `/codex` and `/fanout` write a `running` status the moment they dispatch, the worker flips it to `✓`/`✗` on completion, and it clears once the lane's session exits. Unrelated Claude sessions are filtered out, so an idle bar stays clean.

---

## Commands

| Command | Description |
|---------|-------------|
| `/consult <cli> [--write] <prompt>` | **Inline, synchronous** call to one CLI in the *current directory* — no worktree, no lane. Read-only by default; `--write` allows edits. For quick review / research / fixes. Works in non-git folders too. |
| `/codex <task>` | Dispatch a single Codex lane for the given task. |
| `/fanout <tasks>` | Dispatch multiple lanes. Each line may be prefixed with `codex:` / `gemini:` / `opencode:` / `kimi:` (default `codex`). Enforces the 4-lane running cap. |
| `/lanes` | Show the status of all lanes (name, cli, state, diffstat, verdict). |
| `/verify <lane>` | Run an Opus reviewer gate over the lane's diff. Updates the lane verdict to `approve` or `changes`. |
| `/land <lane>` | Merge an approved lane into the base branch with `--no-ff` and clean up the worktree. |

### Lanes vs. consult — which to use

- **Lane** (`/codex`, `/fanout`) — for *implementation* work you want isolated and reviewed: runs in a git worktree, commits locally, goes through `/verify` → `/land`. Requires a git repo. Asynchronous; shows in the Agent View and statusline.
- **Consult** (`/consult`) — for a *quick second opinion or fix*: runs the CLI synchronously in the current directory and returns its output straight into the conversation. No worktree, no lifecycle, no git requirement. Read-only by default.

### Consult mode

```bash
/consult codex    review plugin/lib/lanes.cjs for edge cases     # read-only (default)
/consult gemini   research how sessions are cached in this repo  # read-only
/consult opencode --write fix the typo in README.md              # writes to the current dir
```

Read-only is a **hard guarantee for `codex`** (it runs under codex's `-s read-only` sandbox and genuinely cannot write). For `gemini` / `opencode` / `kimi` there is no read-only sandbox, so read-only is **best-effort**: a strict read-only preamble is prepended, write-enabling flags are withheld where possible, and if the working tree changes during a read-only consult the helper prints a `consult-warning`. Prefer `codex` when you need a guaranteed-safe review.

In `--write` mode nothing is committed — changes are left in the working tree for you to review (`git diff`) and commit yourself. There is no `/verify` gate on consult writes, so use it for small, obvious fixes; reach for a lane when you want the review gate.

Main Claude can also delegate to the bundled `consult` agent directly (e.g. "have codex review this") — it's the same path, run as a synchronous sub-agent so the CLI's verbose output stays out of the main context.

---

## Security model

**Worktree isolation.** Every lane runs in a dedicated git worktree under `.claude/worktrees/<id>/`. Workers check at startup that they are inside a `.claude/worktrees/` path and refuse to run otherwise. This limits the blast radius of any single lane to its own branch.

**No untrusted text in the shell.** Task text is written to `.claude/lanes/tasks/<id>.md` via the Write tool (bypassing the shell entirely) and passed to CLIs via stdin or a quoted `"$(cat "$TASKFILE")"` expansion — never via unquoted interpolation into a shell command string.

**Verify-before-land gate.** `/land` checks the `verdict` field in the lane's status JSON before merging. If the verdict is not `approve`, it refuses. You must run `/verify` first and have it return `APPROVE`.

**Per-worktree seeded CODEX_HOME.** The Codex worker seeds its own `CODEX_HOME` inside the worktree (`.codex-home/`) from your real `~/.codex` credentials to work around a known auth mode-switch bug in parallel lanes. The `.codex-home/` directory is gitignored so seeded credentials are never committed.

**Resource cap.** The `/codex` and `/fanout` commands enforce a maximum of 4 concurrently running lanes. Dispatch requests that would exceed the cap are rejected with a clear error message.

---

## Per-CLI auth notes

**codex** — Credentials are read from `~/.codex/auth.json`. Each lane gets an isolated but seeded `CODEX_HOME` to prevent the auth mode-switch bug across parallel lanes.

**gemini** — Requires `GEMINI_API_KEY` set in the environment. Use a Flash model (e.g. `gemini-2.5-flash-preview-05-20`).
> **Deprecation 2026-06-18:** Gemini CLI subscription tiers stop serving on this date. After that date, the `gemini-worker` will fail if `GEMINI_API_KEY` is not set to a valid API key. The worker checks for this at startup and writes an error status if the key is absent. Migrate to the Antigravity CLI or another Gemini-API-backed tool before this date.

**opencode** — Uses the free-tier provider. Run `opencode models` to list available free models. The worker defaults to `opencode/deepseek-v4-flash-free` (verified 2026-06-03). If this model is no longer listed, the worker aborts with an error and logs the check — update the `-m` flag to a valid current free model.

**kimi** — Authenticate via `kimi login`. The worker passes `-w` (working directory), `--yolo`, and `--afk` for fully non-interactive background execution.

---

## Agent View — research preview

The Claude Code Agent View (the panel that shows running lanes and lets you switch between them) is a **research preview** feature. Its availability and behaviour may change between Claude Code versions. The `/lanes` command and the statusline remain functional regardless of whether the Agent View panel is present.

---

## Further reading

- [`docs/cli-lanes-spec.md`](docs/cli-lanes-spec.md) — full technical specification for the CLI-Lanes protocol
- [`docs/cli-lanes-plan.md`](docs/cli-lanes-plan.md) — phased implementation plan and design decisions
