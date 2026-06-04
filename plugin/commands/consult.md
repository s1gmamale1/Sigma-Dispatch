---
description: Consult an external CLI (codex/gemini/opencode/kimi) inline & synchronously for a quick review, research question, or quick fix. Runs in the current directory with NO worktree (works in non-git folders too). Read-only by default; add --write to allow edits.
argument-hint: <cli> [--write] <prompt>
allowed-tools: Bash, Write, Read
---

Consult request: **$ARGUMENTS**

This is a **consult** — a fast, inline, synchronous call to one external CLI in the *current directory*. There is no worktree, no lane, no `/verify`/`/land` gate. Use it for review, research, or a quick fix when you don't need an isolated lane.

Follow these steps exactly:

## Step 1 — Parse the arguments

From `$ARGUMENTS`:
1. The **first whitespace-delimited token** is the `<cli>`. It MUST be one of `codex`, `gemini`, `opencode`, `kimi`. If it is anything else (or missing), STOP and tell the user the usage: `/consult <codex|gemini|opencode|kimi> [--write] <prompt>` — do not guess a CLI.
2. If the token `--write` appears anywhere in the remaining arguments, the mode is **write** (`rw`); strip that token out. Otherwise the mode is **read-only** (`ro`).
3. Everything left after removing the cli token and any `--write` is the **prompt** (the task/question text). If the prompt is empty, STOP and ask for a prompt.

## Step 2 — Write the prompt to a temp file (injection-safe)

Get a temp path:

```bash
tf="$(mktemp "${TMPDIR:-/tmp}/sigma-consult.XXXXXX.md")"; echo "$tf"
```

Then use the **Write tool** to write the parsed prompt text to the printed `$tf`. Do NOT echo the prompt through the shell — the Write tool writes it safely as a file (avoids injection).

## Step 3 — Run the consult helper (synchronous — no `&`)

```bash
bash "$CLAUDE_PLUGIN_ROOT/lib/consult.sh" <cli> <ro|rw> "$tf"
```

Substitute `<cli>` and `<ro|rw>` from Step 1. Wait for it to finish and capture stdout + stderr. The helper handles per-CLI invocation, auth/model guards, and read-only enforcement.

Note: `$CLAUDE_PLUGIN_ROOT` must be set in your environment to the plugin directory. If unset, the helper path won't resolve.

## Step 4 — Clean up

```bash
rm -f "$tf"
```

## Step 5 — Report

Show the user:
- A header line: `consult: <cli> (<read-only|write>)`.
- The CLI's output (its review / research answer / what it did), preserving all substantive content.
- If a `consult-error:` line appeared, surface it clearly with the likely cause (missing CLI on PATH, missing `GEMINI_API_KEY`, unavailable opencode model, etc.) — do not silently retry.
- In **write** mode: if the current directory is a git repo, also run `git diff --stat` and show what changed. Nothing is committed — the user reviews and commits themselves.
- If a `consult-warning:` about a read-only run changing files appeared, surface it prominently.

## Notes

- Read-only is a **hard** guarantee for `codex` (sandboxed). For `gemini`/`opencode`/`kimi` it is **best-effort** (preamble + non-interactive flags + a post-run change check). Prefer `codex` when you need a guaranteed-safe review.
- This is synchronous: the result comes straight back into the conversation. For long-running parallel work, use `/codex` or `/fanout` lanes instead.
