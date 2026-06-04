#!/usr/bin/env bash
# Sigma-Dispatch — consult helper.
#
# Runs an external CLI coding agent SYNCHRONOUSLY in the CURRENT directory for a
# quick review / research / quick-fix. Unlike a lane, there is NO git worktree
# and NO lane lifecycle — so this works in ANY folder, including non-git ones.
# This is the single source of truth for consult-mode CLI invocation; it is
# shared by the /consult command and the `consult` agent.
#
# Usage: consult.sh <cli> <mode> <taskfile>
#   <cli>      codex | gemini | opencode | kimi
#   <mode>     ro | rw   (ro = read-only [default], rw = allow writes to cwd)
#   <taskfile> absolute path to a file holding the prompt (written injection-safe
#              by the caller via the Write tool — never built from a shell string)
#
# Prints the CLI's stdout/stderr verbatim. Exit code: 0 = ok, 2 = guard failure,
# otherwise the CLI's own non-zero exit code.
#
# Read-only is a HARD guarantee only for codex (`-s read-only` sandbox). gemini,
# opencode, and kimi have no read-only sandbox, so ro is enforced softly: a
# read-only preamble is prepended to the prompt, no write-enabling flags are
# passed where avoidable, and any tree change is reported loudly afterward.
set -uo pipefail

CLI="${1:-}"
MODE="${2:-ro}"
TASKFILE="${3:-}"

die() { echo "consult-error: $*" >&2; exit 2; }

# --- Validate input at the boundary -----------------------------------------
[ -n "$CLI" ]      || die "no CLI specified (codex|gemini|opencode|kimi)"
[ -n "$TASKFILE" ] || die "no task file specified"
[ -f "$TASKFILE" ] || die "task file not found: $TASKFILE"
case "$MODE" in ro|rw) ;; *) die "mode must be 'ro' or 'rw', got '$MODE'" ;; esac
case "$CLI" in codex|gemini|opencode|kimi) ;; *) die "unknown CLI '$CLI' (expected codex|gemini|opencode|kimi)" ;; esac
command -v "$CLI" >/dev/null 2>&1 || die "$CLI CLI not found on PATH"

# --- Read-only preamble for soft CLIs ----------------------------------------
RO_PREAMBLE="IMPORTANT — READ-ONLY consultation. Do NOT create, modify, move, or delete any files. Only read and analyze the codebase, then respond with your findings as text."

EFFECTIVE="$TASKFILE"
cleanup() { [ "${EFFECTIVE:-}" != "$TASKFILE" ] && rm -f "$EFFECTIVE" 2>/dev/null || true; }
trap cleanup EXIT

if [ "$MODE" = ro ] && [ "$CLI" != codex ]; then
  EFFECTIVE="$(mktemp "${TMPDIR:-/tmp}/sigma-consult-eff.XXXXXX")" || die "mktemp failed"
  { printf '%s\n\n' "$RO_PREAMBLE"; cat "$TASKFILE"; } > "$EFFECTIVE"
fi

# --- Snapshot the tree (git only) so we can detect writes in ro mode ---------
IN_GIT=0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 && IN_GIT=1
snapshot() { [ "$IN_GIT" = 1 ] && git status --porcelain 2>/dev/null | sort || true; }
BEFORE="$(snapshot)"

# --- Dispatch ----------------------------------------------------------------
rc=0
case "$CLI" in
  codex)
    # codex has a TRUE read-only sandbox — a hard guarantee, no preamble needed.
    if [ "$MODE" = rw ]; then SANDBOX="workspace-write"; else SANDBOX="read-only"; fi
    codex exec --skip-git-repo-check -s "$SANDBOX" < "$EFFECTIVE" || rc=$?
    ;;
  gemini)
    [ -n "${GEMINI_API_KEY:-}" ] || die "GEMINI_API_KEY is not set (required for the Gemini CLI; see README)"
    if [ "$MODE" = rw ]; then
      gemini -p "$(cat "$EFFECTIVE")" --yolo || rc=$?
    else
      # No --yolo: in headless mode Gemini answers without auto-approving edits.
      gemini -p "$(cat "$EFFECTIVE")" || rc=$?
    fi
    ;;
  opencode)
    MODEL="opencode/deepseek-v4-flash-free"
    opencode models 2>&1 | grep -q "$MODEL" \
      || die "opencode model $MODEL not available — run 'opencode models' and update lib/consult.sh"
    # opencode has no read-only sandbox; ro is enforced via the prepended preamble.
    opencode run --dangerously-skip-permissions -m "$MODEL" --print-logs --log-level ERROR "$(cat "$EFFECTIVE")" || rc=$?
    ;;
  kimi)
    # kimi has no read-only sandbox; --afk keeps it non-interactive, ro enforced via preamble.
    kimi -w "$(pwd)" --afk -p "$(cat "$EFFECTIVE")" || rc=$?
    ;;
esac

# --- Honesty check: read-only must not have written anything -----------------
if [ "$MODE" = ro ] && [ "$IN_GIT" = 1 ]; then
  AFTER="$(snapshot)"
  if [ "$BEFORE" != "$AFTER" ]; then
    {
      echo ""
      echo "consult-warning: this was a READ-ONLY consult, but the working tree changed."
      echo "Review with 'git diff' and discard with 'git checkout -- .' if unintended."
    } >&2
  fi
fi

exit "$rc"
