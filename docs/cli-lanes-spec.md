# Sigma-Dispatch — Design Spec

**Repo:** https://github.com/s1gmamale1/Sigma-Dispatch
**Status:** Approved design / Phase 0 PASSED (GO — see `docs/phase0-findings.md`)
**Owner:** SIGMA / OpenClaw
**Date:** 2026-06-02
**Supersedes:** the premises of `docs/external-agent-workers-design.md` (corrected by research — see §2)
**Target:** Claude Code v2.1.160+, macOS (Apple Silicon), git repos

---

## 1. Goal

Let Claude Code act as an **orchestrator** that dispatches external CLI coding agents — **Codex first**, then Gemini / OpenCode / Kimi — as **switchable, worktree-isolated lanes**. The main session keeps full control (dispatch → monitor → verify → merge) and **nothing merges unverified**. The agents feel like natural subagent-level tools (slash commands + a worker agent type) and appear in the lane view you already see, under the RuFlo statusbar.

This is the inversion of "babysit each agent": Claude fans out, supervises, and gates; the human trusts-and-verifies at the end.

---

## 2. What the research changed (read this first)

The original design assumed we would build on **RuFlo's lane TUI** and that **Codex was a first-class RuFlo worker**. Empirical investigation of the installed packages and of Claude Code falsified the load-bearing premises:

| Original premise | Reality (verified on this machine) |
|---|---|
| RuFlo provides a switchable lane TUI to surface workers into | ❌ No lane TUI in any installed package (`@claude-flow/cli` 3.6.30, `ruflo` / `agentic-flow` 3.7.0-alpha.18 / 2.0.13). No TUI deps, no lane-render code, none of the on-screen strings. |
| Codex is already a first-class RuFlo worker | ❌ `@claude-flow/codex` is project-setup tooling, not a spawnable worker. Worker types are a hardcoded enum; not plugin-extensible. |
| The RuFlo plugin SDK lets you create workers | ❌ The SDK is generic lifecycle hooks only (no `WorkerFactory`/`WorkerPool`). |
| `agent_spawn` spawns worktree workers | ❌ It writes coordination metadata only; RuFlo has no git-worktree manager. |
| The lane view in the "v3.6 screenshots" is RuFlo's | ✅ It is **Claude Code's native "Agent View"** (`claude agents`, a research preview ≥ v2.1.139) **+** a RuFlo-branded **statusLine script** (`.claude/helpers/statusline.cjs`). |

**Consequence:** the integration surface is **Claude Code**, not RuFlo. We build a **standalone Claude Code plugin** plus a **lane-aware statusline**. RuFlo keeps exactly two jobs: the base statusbar and optional memory/coordination. **We do not fork RuFlo and we do not build a TUI.**

---

## 3. Architecture

```
main Claude (orchestrator)
   │  /codex <task>   ·   /fanout <plan>           (slash commands)
   ▼  writes task file, then (backgrounded) `claude -p --worktree <id> --name <id> --agent codex-worker …`
codex-worker LANE  ── Haiku Claude session, auto-worktree (.claude/worktrees/<name>)
   │  reads task file → runs `codex exec` (safe input) → verifies git diff
   │  → commits / opens PR → writes .claude/lanes/<name>.json
   ▼
Claude Code Agent View   (↑/↓ select · Enter view · Space peek · Ctrl+X stop)
RuFlo statusbar  ← composer reads `claude agents --json` + lane files → "🛠 codex●run ✓2"
   │
main Claude:  /lanes (status) → /verify (Opus reviewer gate) → /land (merge + clean)
```

A **lane** is a Haiku Claude Code background session whose only job is to drive one external CLI inside its own git worktree, verify the result, and report. Claude Code renders lanes; we never render them ourselves. The CLI does the real coding work; the Haiku wrapper is cheap supervision glue that also gives us liveness (a hung `codex` is noticed by its wrapper, not lost in a raw shell).

---

## 4. Runtime model — lifecycle of a lane

1. **Dispatch** — `/codex <task>` writes the task to `.claude/lanes/tasks/<id>.md` (untrusted text never enters a shell string), then dispatches (Phase-0-confirmed mechanism): `env -u CLAUDE_CODE_SESSION_ID claude -p --session-id "$(uuidgen)" --worktree <id> --name <id> --agent codex-worker --model haiku --permission-mode bypassPermissions --plugin-dir <plugin> "Run the Codex task in .claude/lanes/tasks/<id>.md" &`.
2. **Isolate** — the background session auto-creates its worktree `.claude/worktrees/<name>` on branch `worktree-<name>`.
3. **Execute** — the `codex-worker` (Haiku) reads the task file and runs `codex exec` with the prompt passed safely (§7), under a per-worktree `CODEX_HOME`.
4. **Verify-self** — confirms `git diff` is non-empty (guards the known opencode/codex silent-fail), commits, optionally opens a PR.
5. **Report** — writes `.claude/lanes/<name>.json` (status contract, §6) and stops.
6. **Review** — `/verify` dispatches an **Opus reviewer** (Agent tool) over the lane's diff/PR; the verdict is recorded in the status file.
7. **Land** — `/land` merges `worktree-<name>` into the base branch **only if APPROVED**, then removes the worktree + branch.
8. **Observe** — throughout, the lane is visible in Agent View and summarized in the statusbar.

---

## 5. Components (the standalone plugin)

| Path | Responsibility |
|---|---|
| `plugin/.claude-plugin/plugin.json` | Plugin manifest |
| `plugin/agents/codex-worker.md` | Haiku thin-dispatcher subagent (then `gemini`/`opencode`/`kimi`) |
| `plugin/commands/codex.md` | `/codex <task>` — dispatch one lane |
| `plugin/commands/lanes.md` | `/lanes` — readable status of all lanes |
| `plugin/commands/verify.md` | `/verify <id\|all>` — Opus reviewer gate |
| `plugin/commands/land.md` | `/land <id>` — merge approved lane + cleanup |
| `plugin/commands/fanout.md` | `/fanout <plan>` — N lanes (phase 5) |
| `plugin/lib/lanes.cjs` | Pure helpers + IO for lane status (single source of truth) |
| `plugin/lib/statusline-cli-lanes.cjs` | Composes RuFlo's statusline + appends lane summary |
| `plugin/README.md` | Usage |

---

## 6. Contracts

### 6.1 Lane status file — `.claude/lanes/<name>.json`
```json
{
  "id": "<claude session id, if known>",
  "name": "<worktree name>",
  "cli": "codex",
  "task": "<short task summary>",
  "state": "running | done | error",
  "diffstat": "3 files changed, +120 -4",
  "prUrl": "https://github.com/…/pull/123",
  "verdict": "pending | approve | changes",
  "error": null,
  "updatedAt": "2026-06-02T20:55:00Z"
}
```

### 6.2 `claude agents --json` fields relied upon
`sessionId`, `name`, `status` (`working|completed|error|…`), `cwd`, `startedAt`. Extra fields are treated as optional. (Pinned in Phase 0.)

### 6.3 statusLine stdin (Claude Code → script)
JSON with `model`, `cwd`, `workspace`, `session_id`, `cost`, `context_window`, `version`. The composer passes this through to RuFlo's statusline unchanged; lane data is sourced separately from `claude agents --json`.

---

## 7. Security model

We spawn autonomous bypass-permission agents that write code and run git. Controls:

- **No untrusted text in shell strings.** Task text is written to a file with the Write tool and referenced by path; the worker passes the prompt to `codex exec` via stdin / heredoc / a file flag (safe form pinned in Phase 0), never `codex exec "$(cat …)"`.
- **Isolation = blast-radius control.** All edits happen in a per-lane git worktree; the main branch is never the working dir. `bypassPermissions` / `--yolo` are scoped to lanes only, never the main session.
- **Per-worktree `CODEX_HOME`** to avoid the Codex auth mode-switch bug (false "usage limit reached" when subscription + API-key auth coexist).
- **Verify-before-merge gate.** `/land` refuses any lane whose `verdict` is not `approve`.
- **Resource cap.** `/codex` and `/fanout` refuse to exceed `maxConcurrentLanes` (default 4) to avoid thrash.

---

## 8. Cost / auth model

- Each CLI uses its own auth/quota (Codex → OpenAI; Gemini → Google; etc.). Lane overhead is a cheap Haiku wrapper; the real cost is the CLI's own quota.
- **Gemini hard risk:** subscription tiers stop serving **2026-06-18**. The `gemini-worker` (phase 5) must use API-key + Flash, or defer to Antigravity CLI. The Codex-first v1 sidesteps this.

---

## 9. Scope & non-goals

**v1 (this spec):** Codex only, end-to-end — `/codex` → lane → worktree → `codex exec` → verify → `/land`; `/lanes` status; lane-aware statusline.

**Breadth (later):** `gemini` / `opencode` / `kimi` workers + `/fanout`, reusing the status contract and the delegation matrix from the existing `orchestrator` skill.

**Non-goals:** local Qwen (Qwen3-30B infeasible on 16 GB — ~2–3 tok/s with swap thrash); SendMessage live coordination (Agent Teams = experimental, churn-prone); building or forking any TUI; forking RuFlo or editing its package.

---

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Agent View is a **research preview** — `claude --bg` / `agents --json` may change | Rely only on documented flags; degrade to a Bash-dispatch fallback (the lean path) if they shift. Pinned in Phase 0. |
| Codex CLI flag drift (prompt input, exec flags) | Phase 0 pins the safe forms; the worker reads them from one place. |
| Worktree sprawl | `/land` always cleans; `/lanes` surfaces orphans for pruning. |
| Lane = Claude-wrapping-Codex (token overhead) | Wrapper is Haiku; minimal. Accept as inherent (no supported "lane runs a raw CLI"). |

---

## 11. Phase-0 gate (must pass before building)

Confirms, empirically: the exact `claude --bg` flags (`--agent`, `--model`, `--permission-mode`); that a dispatched session appears in `claude agents --json`; the auto-worktree behavior + path; that dispatch from inside a slash command registers in the same Agent View; the safe `codex exec` prompt-input form; and `claude stop` / `claude logs`. Output: a short findings note and a GO/NO-GO. (Details in the implementation plan, Phase 0.)

---

## 12. References (verified)

- Claude Code Agent View / background agents / worktrees / statusline / sub-agents — official docs (`code.claude.com/docs`).
- Agent Client Protocol (ACP) — `agentclientprotocol.com` (used by Gemini/OpenCode/Qwen/Kimi; not needed for v1 since we wrap CLIs).
- Codex App Server / `codex exec --json` — `developers.openai.com/codex` (stdio JSON-RPC, **not** HTTP+SSE).
- `codex-plugin-cc` / `gemini-plugin-cc` — the broker + slash-command + subagent pattern this plugin mirrors.
- Claude Squad — tmux+worktree+`Instance` prior art (fallback patterns).
- Local `orchestrator` skill — proven non-interactive invocation + worktree hygiene + cleanup loop for these exact CLIs.
- `docs/external-agent-workers-design.md` — the original seed design (premises corrected here).
