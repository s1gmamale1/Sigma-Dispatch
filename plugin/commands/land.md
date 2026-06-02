---
description: Merge an APPROVED lane's worktree branch into the base branch, then clean up.
argument-hint: <lane-name>
allowed-tools: Bash, Read, Write
---

Land lane: **$ARGUMENTS**

Follow these steps exactly. Do NOT skip any gate.

## Step 1 — Read the lane status and check the verdict gate

Use the **Read tool** to read `.claude/lanes/$ARGUMENTS.json`.

If the file does not exist, report: "No status file found for lane `$ARGUMENTS`. Has it been dispatched and completed?" Then **STOP**.

Check the `verdict` field:
- If `verdict` is NOT `"approve"`, **REFUSE** and tell the user: "Lane `$ARGUMENTS` has not been approved (verdict: `<current verdict>`). Run `/verify $ARGUMENTS` first, then retry `/land $ARGUMENTS` only after the reviewer returns APPROVE." Then **STOP** — do not proceed.

## Step 2 — Determine the base branch

```bash
BASE=$(git rev-parse --verify main >/dev/null 2>&1 && echo main || echo master)
```

If neither `main` nor `master` exists as a branch, report: "Cannot determine base branch — neither `main` nor `master` found. Set the base branch manually and retry." Then **STOP**.

## Step 3 — Merge the worktree branch

Run:
```bash
git checkout "$BASE"
git merge --no-ff "worktree-$ARGUMENTS"
```

If the merge exits with a non-zero status (conflict), immediately run:
```bash
git merge --abort
```

Then report: "Merge conflict while landing lane `$ARGUMENTS`. The merge has been aborted — no changes were made. Resolve the conflict manually or re-dispatch the lane with adjusted instructions." Then **STOP** — never force-merge.

## Step 4 — Clean up the worktree and branch

Run:
```bash
git worktree remove ".claude/worktrees/$ARGUMENTS" --force
git branch -d "worktree-$ARGUMENTS"
```

If `git branch -d` fails (e.g. the branch was already merged or renamed), try `git branch -D "worktree-$ARGUMENTS"` as a fallback — but only after a successful merge in Step 3.

## Step 5 — Update the lane status file

Use the **Read tool** to read `.claude/lanes/$ARGUMENTS.json` again (it should still be present — the status file lives in the main checkout, not the worktree).

Use the **Write tool** to write `.claude/lanes/$ARGUMENTS.json` back with all existing fields preserved and `state` updated to `"landed"` and `updatedAt` updated to the current ISO-8601 timestamp. Do NOT use sed or shell substitution — always Read then Write the full JSON.

Example:
```json
{
  "id": "<existing>",
  "name": "$ARGUMENTS",
  "cli": "<existing>",
  "task": "<existing>",
  "state": "landed",
  "diffstat": "<existing>",
  "prUrl": "<existing or null>",
  "verdict": "approve",
  "error": "<existing or null>",
  "updatedAt": "<iso8601 timestamp of now>"
}
```

## Step 6 — Report

Tell the user:
- Lane `$ARGUMENTS` has been landed: branch `worktree-$ARGUMENTS` merged into `$BASE` with `--no-ff`.
- Worktree `.claude/worktrees/$ARGUMENTS` and branch `worktree-$ARGUMENTS` have been removed.
- Status file updated to `state: "landed"`.
- **Pushing is a separate explicit step** — run `git push` when you are ready to publish. This command does NOT push automatically.
