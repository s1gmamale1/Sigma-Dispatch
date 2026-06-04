---
description: Dispatch multiple CLI tasks as parallel lanes. Each line in $ARGUMENTS may be prefixed with a CLI (codex:/gemini:/opencode:/kimi:) — defaults to codex. Respects the 4-lane running cap.
argument-hint: <cli:task description, one per line>
allowed-tools: Bash, Write, Read
---

Fan-out dispatch for these tasks:

```
$ARGUMENTS
```

Follow these steps exactly:

## Step 0 — Require a git repository

Lanes run in git worktrees, so this command only works inside a git repo. Check first:

```bash
git rev-parse --is-inside-work-tree >/dev/null 2>&1 && echo GIT_OK || echo NO_GIT
```

If the output is `NO_GIT`, STOP and tell the user: "Lane dispatch needs a git repository (worktrees require git). Run `git init` here first, or use `/consult <cli> <task>` for a quick, non-isolated run in this directory." Do not proceed.

## Step 1 — Check the resource cap before dispatching

Run this exact command to count how many lanes are currently running:

```bash
node -e "
const L=require('$CLAUDE_PLUGIN_ROOT/lib/lanes.cjs');
const running=L.countByState(L.mergeLaneView(L.getAgentRows(),L.indexStatuses(L.readStatusFiles())),'running');
console.log(running);
"
```

Capture the printed number as `CURRENT_RUNNING`. The maximum allowed total running lanes is **4**. The number of new tasks to dispatch is the number of non-empty lines in `$ARGUMENTS`.

If `CURRENT_RUNNING + (number of tasks)` would exceed 4:
- Dispatch only as many tasks as fit under the cap (i.e. `4 - CURRENT_RUNNING` tasks).
- Report clearly which tasks were dispatched and which were skipped due to the cap.
- Tell the user to run `/lanes` to monitor progress and retry the skipped tasks when a lane frees up.

If `CURRENT_RUNNING` is already 4 or greater, dispatch NO tasks and tell the user: "Resource cap reached: 4 lanes are already running. Wait for a lane to finish (check with `/lanes`) before dispatching more." Then **STOP**.

## Step 2 — Parse the task list

Parse `$ARGUMENTS` line by line. For each non-empty line:
1. Strip leading/trailing whitespace.
2. If the line starts with `codex:`, `gemini:`, `opencode:`, or `kimi:`, extract that prefix as the CLI name and the remainder as the task text.
3. Otherwise default the CLI to `codex` and treat the whole line as the task text.

Build an ordered list of `(cli, task_text)` pairs up to the cap computed in Step 1.

## Step 3 — Ensure the tasks directory exists

```bash
mkdir -p .claude/lanes/tasks
```

## Step 4 — For each task: generate an id, write the task file, and dispatch

For each `(cli, task_text)` pair (in order, up to the cap):

### 4a — Generate a lane id

```bash
id="<cli>-$(date +%s)-<n>"
```

Where `<n>` is the 0-based index of this task (0, 1, 2, …) to ensure uniqueness when multiple tasks are dispatched in the same second.

### 4b — Write the task file (injection-safe)

Use the **Write tool** to write the task text to `.claude/lanes/tasks/$id.md`. The content is the task text for this lane only.

Do NOT echo or pass the task text through the shell — this avoids injection. The Write tool writes it safely as a file.

### 4c — Write the initial RUNNING status

Use the **Write tool** to write `.claude/lanes/$id.json` now — before dispatching — so the lane shows live in the statusline immediately (the worker overwrites it with `done`/`error` at the end):

```json
{ "id": null, "name": "$id", "cli": "<cli>", "task": "<short summary of this task>", "state": "running", "diffstat": null, "prUrl": null, "verdict": "pending", "error": null, "updatedAt": "<ISO-8601 now>" }
```

### 4d — Dispatch the lane

```bash
task="$(pwd)/.claude/lanes/tasks/$id.md"   # absolute: the lane runs in a worktree, a relative path won't resolve there
env -u CLAUDE_CODE_SESSION_ID claude -p \
  --session-id "$(uuidgen)" \
  --worktree "$id" \
  --name "$id" \
  --agent <cli>-worker \
  --model haiku \
  --permission-mode bypassPermissions \
  --plugin-dir "$CLAUDE_PLUGIN_ROOT" \
  "Run the <CLI> task in $task and report status." &
```

Replace `<cli>-worker` with the appropriate worker name: `codex-worker`, `gemini-worker`, `opencode-worker`, or `kimi-worker`.
Replace `<CLI>` in the prompt string with the uppercase CLI name (e.g. `Codex`, `Gemini`, `OpenCode`, `Kimi`) for clarity.

Note: `$CLAUDE_PLUGIN_ROOT` must be set in your environment to the plugin directory path. If unset, the worker will not load the agent definition.

## Step 5 — Report

Tell the user:
- A table of all dispatched lanes: lane id · cli · task summary
- How many lanes were dispatched vs skipped (if cap was hit)
- That results will appear in `.claude/lanes/<id>.json` when each worker completes
- Reminder: run `/lanes` to watch status across all active lanes
