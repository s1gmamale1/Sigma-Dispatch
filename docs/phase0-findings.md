# Phase-0 Findings — CLI-Lanes Gate

**Date:** 2026-06-02 · **Claude Code:** v2.1.160 · **codex:** 0.135.0

## Confirmed (PASS)

- **`codex exec` reads the prompt from stdin** → `codex exec < taskfile` (or `cat taskfile | codex exec`). No untrusted text ever enters a shell string — the §7 injection risk is eliminated by design. Also available: `--json` (JSONL events), `--output-schema`, `--skip-git-repo-check`, sandbox modes (`read-only|workspace-write|danger-full-access`), skip-confirmations flag.
- **A session knows its own id** via env `CLAUDE_CODE_SESSION_ID` → status files key cleanly to `claude agents --json` `sessionId`.
- **`claude agents --json`** works for monitoring. Fields observed: `pid`, `cwd`, `kind`, `startedAt`, `sessionId`, optional `name`, optional `status` (`busy|idle|…`).
- **`claude` flags present:** `--agent`, `--model`, `--permission-mode`, `--worktree [name]`, `--tmux`, `--name`, `--session-id`, `-p/--print`, `--plugin-dir`, `--agents <json>`.

## BLOCKER (the core gate finding)

- **No `claude --bg` flag exists.** Full `claude --help` reviewed; the docs-guide's `claude --bg "<prompt>"` one-liner is not on this binary.
- **Agent View lanes are interactive `claude` sessions** (`"kind": "interactive"`), one per running terminal session/project. Live data included the user's own `finish-sigmavoice-v0.3` session (the screenshot one) and this session.
- **Agent-tool `run_in_background` subagents do NOT appear** in `claude agents --json` → the Agent View and the Agent-tool background subsystem are distinct (cc-guide was correct on this).
- ⟹ **No confirmed headless CLI dispatches an autonomous worker lane into Agent View.** The plan's primary dispatch wiring (`/codex` → `claude --bg`) is invalid.

## Decision: GO — Option C (headless worktree session) confirmed

Candidate mechanisms:

| # | Mechanism | Shows in Agent View switcher? | Headless / auto-dispatch from `/codex`? | Notes |
|---|---|---|---|---|
| A | Agent-tool `run_in_background` worker that runs `codex exec` in a worktree | ❌ No (separate subsystem) | ✅ Yes, fully programmatic | Robust, supervised, results return to main; lanes shown via our `/lanes` + statusline instead of the native switcher. Closest to today's `orchestrator` skill. |
| B | Interactive dispatch inside `claude agents` view | ✅ Yes (real lanes) | ❌ No (interactive TUI) | Matches the screenshot exactly, but a slash command can't silently spawn it. |
| C | Headless `claude -p --worktree <name> --name <name> "<wrapper prompt>"` background session | ❓ Unconfirmed (needs a spawn test) | ✅ Likely | Only candidate that is both programmatic AND potentially lands in the switcher. Needs an empirical spawn+observe test. |

**RESOLVED (2026-06-02, empirical probe):** Option **C** confirmed. A backgrounded headless session:

```bash
env -u CLAUDE_CODE_SESSION_ID claude -p \
  --session-id "$(uuidgen)" --name "$LANE" --worktree "$LANE" \
  --agent codex-worker --model haiku --permission-mode bypassPermissions \
  --plugin-dir "$PLUGIN_DIR" \
  "Run the Codex task in .claude/lanes/tasks/$LANE.md and report status." &
```

- registered in `claude agents --json` as a switchable lane (`kind: interactive`, `name`, `cwd: .claude/worktrees/<LANE>`),
- auto-created the worktree + branch `worktree-<LANE>`,
- ran the task autonomously and headlessly (exit 0, marker file written in the worktree).

Both auto-dispatchable from `/codex` and visible in the native Agent View switcher. Probe worktree cleaned up.
