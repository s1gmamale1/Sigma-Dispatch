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

- A git repository with a `main` or `master` branch.
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

**Statusline wiring**

Add to `.claude/settings.json` in your project:

```json
{
  "statusLine": {
    "command": "sh -c 'exec node \"$CLAUDE_PROJECT_DIR/plugin/lib/statusline-cli-lanes.cjs\"'"
  }
}
```

The statusline script reads the live agent list and lane status files and renders a compact summary (e.g. `codex● · gemini✓2`). If a RuFlo statusline helper is present at `.claude/helpers/statusline.cjs`, the lane summary is composed onto the end of the existing bar — nothing is overwritten.

---

## Commands

| Command | Description |
|---------|-------------|
| `/codex <task>` | Dispatch a single Codex lane for the given task. |
| `/fanout <tasks>` | Dispatch multiple lanes. Each line may be prefixed with `codex:` / `gemini:` / `opencode:` / `kimi:` (default `codex`). Enforces the 4-lane running cap. |
| `/lanes` | Show the status of all lanes (name, cli, state, diffstat, verdict). |
| `/verify <lane>` | Run an Opus reviewer gate over the lane's diff. Updates the lane verdict to `approve` or `changes`. |
| `/land <lane>` | Merge an approved lane into the base branch with `--no-ff` and clean up the worktree. |

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
