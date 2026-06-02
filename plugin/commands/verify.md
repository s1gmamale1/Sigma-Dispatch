---
description: Run an Opus reviewer gate over a lane's diff before merge.
argument-hint: <lane-name | all>
allowed-tools: Bash, Read, Write, Agent
---

Run the Opus reviewer gate for lane(s): **$ARGUMENTS**

Follow these steps for each lane to verify (if `$ARGUMENTS` is `all`, process every lane with `state: "done"` and `verdict: "pending"`):

## Step 1 — Resolve which lanes to verify

If `$ARGUMENTS` is `all`:

```bash
node -e "
const L=require('$CLAUDE_PLUGIN_ROOT/lib/lanes.cjs');
const v=L.mergeLaneView(L.getAgentRows(),L.indexStatuses(L.readStatusFiles()));
const pending=v.filter(l=>l.state==='done'&&l.verdict==='pending').map(l=>l.name);
console.log(JSON.stringify(pending));
"
```

Use the printed list as the set of lane names to verify. If the list is empty, report "No done+pending lanes found" and stop.

Otherwise, verify the single lane named `$ARGUMENTS`.

## Step 2 — For each lane: capture the diff

Determine the base branch the worktree forked from. The worktree branch is `worktree-<lane-name>` by convention. Find the base (merge-base with main/master):

```bash
LANE="<lane-name>"
WORKTREE=".claude/worktrees/$LANE"
BASE=$(git -C "$WORKTREE" rev-parse --verify main >/dev/null 2>&1 && echo main || echo master)
DIFF=$(git -C "$WORKTREE" diff "$BASE"...HEAD 2>/dev/null)
```

If the worktree path does not exist, report: "Worktree `.claude/worktrees/<lane-name>` not found — lane may not have been dispatched yet or was already cleaned up." Skip this lane.

If the diff is empty, report: "Lane <lane-name> has no diff relative to $BASE — nothing to review." Skip this lane.

Also read the original task file:

Use the **Read tool** to read `.claude/lanes/tasks/<lane-name>.md` (if it exists) to pass to the reviewer as context. If absent, use the `task` field from the lane's status JSON.

## Step 3 — Dispatch the Opus reviewer

Use the **Agent tool** to dispatch an Opus reviewer. The agent should:
- Review the diff for correctness, security, and whether it satisfies the task description
- Return either `APPROVE` (the diff correctly and safely implements the task) or `REQUEST CHANGES` (with specific reasons)

Agent configuration:
- `subagent_type: reviewer`
- `model: opus` (alias — resolves to the latest available Opus)

Prompt to pass to the reviewer:
```
You are a code reviewer. Review the following diff and determine whether it correctly and safely implements the given task.

TASK:
<task text from .claude/lanes/tasks/<lane-name>.md>

DIFF:
<full output of git diff <base>...HEAD>

Return your verdict as one of:
- APPROVE — the diff is correct, safe, and satisfies the task
- REQUEST CHANGES — list specific issues that must be fixed before merging

Be concise. Lead with the verdict word on its own line.
```

## Step 4 — Record the verdict

Parse the reviewer's output: if it starts with `APPROVE`, verdict = `"approve"`; if it starts with `REQUEST CHANGES`, verdict = `"changes"`.

Use the **Read tool** to read `.claude/lanes/<lane-name>.json` in full.

Use the **Write tool** to write back `.claude/lanes/<lane-name>.json` with all existing fields preserved and `verdict` updated to `"approve"` or `"changes"`. Do NOT use sed or shell substitution — always Read then Write the full JSON object.

Example updated JSON shape:
```json
{
  "id": "<existing>",
  "name": "<lane-name>",
  "cli": "<existing>",
  "task": "<existing>",
  "state": "done",
  "diffstat": "<existing>",
  "prUrl": "<existing or null>",
  "verdict": "approve",
  "error": "<existing or null>",
  "updatedAt": "<iso8601 timestamp of now>"
}
```

## Step 5 — Report

For each verified lane, report:
- Lane name
- Verdict: **APPROVE** or **REQUEST CHANGES**
- If `REQUEST CHANGES`: summarize the reviewer's specific concerns so the user knows what to fix before re-dispatching.

If the verdict is `approve`, tell the user: "Lane <name> is approved — run `/land <name>` to merge."
