---
description: Dispatch a Codex CLI task as an isolated, switchable lane.
argument-hint: <task description>
allowed-tools: Bash, Write, Read
---

Dispatch a Codex lane for this task: **$ARGUMENTS**

Follow these steps exactly:

## Step 0 — Require a git repository

A lane runs in a git worktree, so this command only works inside a git repo. Check first:

```bash
git rev-parse --is-inside-work-tree >/dev/null 2>&1 && echo GIT_OK || echo NO_GIT
```

If the output is `NO_GIT`, STOP and tell the user: "Lane dispatch needs a git repository (worktrees require git). Run `git init` here first, or use `/consult codex <task>` for a quick, non-isolated run in this directory." Do not proceed.

## Step 1 — Enforce the resource cap

Run this exact command to count how many lanes are currently running:

```bash
node -e "
const L=require('$CLAUDE_PLUGIN_ROOT/lib/lanes.cjs');
const running=L.countByState(L.mergeLaneView(L.getAgentRows(),L.indexStatuses(L.readStatusFiles())),'running');
console.log(running);
"
```

If the printed number is **4 or greater**, tell the user: "Resource cap reached: 4 lanes are already running. Wait for a lane to finish (check with `/lanes`) before dispatching another." Then **STOP** — do not proceed.

## Step 2 — Generate a lane id

```bash
id="codex-$(date +%s)"
```

## Step 3 — Write the task file (injection-safe)

Use the **Write tool** to write the task text to `.claude/lanes/tasks/$id.md`. The content to write is exactly: `$ARGUMENTS`

Do NOT echo or pass the task text through the shell — this avoids injection. The Write tool writes it safely as a file.

Ensure the directory exists first:
```bash
mkdir -p .claude/lanes/tasks
```

Then use the Write tool: write `$ARGUMENTS` to `.claude/lanes/tasks/$id.md`.

## Step 4 — Write the initial RUNNING status (so the lane shows live immediately)

Use the **Write tool** to write `.claude/lanes/$id.json` now — before dispatching — so the lane appears in the statusline the instant it launches (no startup dark window). The worker overwrites this with `done`/`error` when it finishes:

```json
{ "id": null, "name": "$id", "cli": "codex", "task": "<short one-line summary of $ARGUMENTS>", "state": "running", "diffstat": null, "prUrl": null, "verdict": "pending", "error": null, "updatedAt": "<ISO-8601 now>" }
```

## Step 5 — Dispatch the lane

Run the following command (backgrounded headless worktree session, Phase-0-confirmed mechanism):

```bash
task="$(pwd)/.claude/lanes/tasks/$id.md"   # absolute: the lane runs in a worktree, a relative path won't resolve there
env -u CLAUDE_CODE_SESSION_ID claude -p \
  --session-id "$(uuidgen)" \
  --worktree "$id" \
  --name "$id" \
  --agent codex-worker \
  --model haiku \
  --permission-mode bypassPermissions \
  --plugin-dir "$CLAUDE_PLUGIN_ROOT" \
  "Run the Codex task in $task and report status." &
```

Note: `$CLAUDE_PLUGIN_ROOT` must be set in your environment to the plugin directory path (e.g. `./plugin` or the absolute path). If unset, the worker will not load the codex-worker agent definition.

## Step 6 — Report

Tell me:
- The dispatched lane id: `$id`
- That the lane is now running and visible in the native Agent View switcher (use `/lanes` to check status, or open the Agent View panel)
- That results will appear in `.claude/lanes/$id.json` when the worker completes
