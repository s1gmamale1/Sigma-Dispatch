# Heterogeneous Agent Workers for Claude Code (via RuFlo)

**Status:** Design / pre-development
**Owner:** SIGMA / OpenClaw
**Target dev environment:** Claude Code
**Last updated:** 2026-06-02

---

## 1. Goal

Let **Claude Code act as the orchestrator** that autonomously dispatches and controls **external and local CLI coding agents** — Codex CLI, Gemini CLI, OpenCode, and a local model (Qwen3-30B) — as if they were subagents, then verifies their work at the end.

Concretely:

1. **Claude controls, not the human.** Claude decides what to fan out, dispatches the workers, collects results, and runs a verification pass before anything merges. The human trusts-and-verifies at the end rather than babysitting each agent.
2. **Each external agent runs as a worktree-isolated worker** (own git worktree, own branch, zero cross-contamination).
3. **All workers surface in RuFlo's existing lane TUI** for observability — per-lane status, token usage, and live trajectory — so any lane can be inspected on demand without killing the main session.
4. **Supervised sessions, not blind shells.** The orchestrator always knows a worker's true state (running / done / died), eliminating the "agent silently tailed out and nobody noticed" failure mode.
5. **Cost-aware routing** consistent with a local-first philosophy: cheap/local work to Qwen or OpenCode, escalate to paid APIs (Codex, Gemini) only when the task warrants it.

### Non-goals

- Building a new TUI from scratch (RuFlo already provides one).
- Turning external CLIs into *literal* Claude Code native subagents (not possible — see Problem 3).
- Replacing RuFlo's swarm/memory/federation stack.

---

## 2. Context & Architecture Decision

There are two viable architectures for "Claude calls other agents":

| Approach | What it gives | Why it's not the pick |
|---|---|---|
| **In-session dispatch** (ACP / App Server Protocol broker, e.g. `codex-plugin-cc`, `gemini-plugin-cc`) | Claude calls an external agent as a tool/subagent mid-reasoning and gets a result back. Supervised session. | No live, switchable, parallel **lane visualization**. Single-session, request/response shape. |
| **Worktree supervisor** (RuFlo / Claude Squad / parallel-code) | Parallel peer agents, each isolated in a worktree, rendered as switchable lanes; orchestrator-driven dispatch. | — (this is the pick) |

**Decision: build on RuFlo.** Its architecture is already the exact shape we want:

```
User → RuFlo (CLI / MCP) → Router → Swarm → Agents → Memory → LLM Providers
                                                   ↑                 |
                                                   +-- Learning loop -+
```

- Claude is the controller at the top, dispatching via RuFlo's MCP tools (`swarm_init`, `agent_spawn`).
- RuFlo's harness handles spawning, worktree isolation, telemetry, and the lane TUI.
- **Codex is already a first-class RuFlo worker** (orchestrator/executor split: RuFlo coordinates + tracks + remembers; Codex executes). The pattern we want is therefore already proven — we just extend it to more agents.

**Extension point:** RuFlo ships a plugin SDK (`@claude-flow/plugins`) that lets you create **workers, hooks, providers, and security modules** — including `WorkerFactory` / `WorkerPool` and a `HookBuilder` for events like `PreAgentSpawn`. So the work is a **RuFlo plugin**, *not* a Claude Code plugin. (A Claude Code plugin cannot paint into RuFlo's TUI; RuFlo owns that render loop.)

**Transport note:** workers should boot their CLI over a *supervised* protocol, not a raw shell:
- **ACP (Agent Client Protocol)** — the converging universal standard (JSON-RPC 2.0 over stdio). Spoken by Gemini CLI, OpenCode, Cursor, Qwen Code, Kimi CLI, etc.
- **App Server Protocol** — Codex's native transport (HTTP + SSE).

---

## 3. Possible Problems

1. **[Make-or-break] Lane rendering binding.** Unknown whether a *custom* SDK worker auto-surfaces in RuFlo's lane TUI, or whether lane rendering is wired to specific built-in worker types (`codex`, `coder`, …). If hardcoded, a plugin alone won't show the lane and a TUI patch (fork) is required.
2. **RuFlo churn.** Very large, fast-moving codebase (frequent alpha cycles, 1,400+ releases, Rust engine, WASM, federation). Editing core risks constant merge pain — stay at the plugin layer wherever possible.
3. **"Native subagent" expectation mismatch.** Claude Code's native subagents run the *same Claude model* in-session and share context; they cannot be Codex/Gemini/OpenCode. The realistic equivalent is RuFlo-mediated worker dispatch — same *effect* (Claude decides, dispatches, collects, verifies) + the lane TUI.
4. **Transport fragility.** Raw `shell-out` gives no liveness signal (silent death). Must use ACP (Gemini/OpenCode/Qwen) or App Server Protocol (Codex) so the worker owns a real, observable session.
5. **Auth, usage limits & billing.** Each external agent uses its own auth and counts against its own usage/limits (e.g. routing work to Codex consumes Codex quota). Needs explicit, visible cost accounting.
6. **Resource ceilings.** Spawning multiple heavy agents on constrained hardware (e.g. Mac Mini M4 16GB; local Qwen inference) can thrash. Need worker-pool caps and concurrency limits.
7. **Worktree lifecycle hygiene.** Create → run → merge → clean must be automated; otherwise branch/worktree sprawl and merge conflicts accumulate.
8. **Telemetry contract.** A custom worker must emit *exactly* the lifecycle/token/status events RuFlo's harness expects, or the lane will render blank/stale.
9. **RuFlo execution-model ambiguity.** Across versions RuFlo has ranged from "coordinator only — you/Claude execute" to genuinely spawning worktree workers. The target screenshots show real spawned workers (v3.6), but the exact spawn→execute path must be confirmed for the installed version.

---

## 4. Proposed Solutions

### 4.1 Build form
A **RuFlo plugin** built on `@claude-flow/plugins`, containing:
- **Custom Workers** — one per external agent type: `gemini-worker`, `opencode-worker`, `qwen-worker` (extend/clone the existing `codex-worker` pattern).
- **A routing hook** — a `PreAgentSpawn` hook implementing cost-aware routing (local-first; escalate by task class — e.g. adversarial security → Codex, long-context sweep → Gemini, cheap/bulk → Qwen/OpenCode).
- **(Optional) security module** — reuse RuFlo's input-validation / command-injection protections around the spawned CLIs.

### 4.2 Worker behavior (per agent)
On `agent_spawn --type <agent>-worker`, the worker:
1. Creates/reuses a dedicated **git worktree** (own branch).
2. Boots the target CLI over its **supervised protocol** (ACP, or App Server Protocol for Codex) — never a fire-and-forget shell.
3. Streams the task, captures structured output, and **emits RuFlo's expected telemetry** (status, tokens, trajectory) so it renders as a lane.
4. On completion, returns a clean result/summary to the orchestrator and marks the worktree ready for review.

### 4.3 Verification ("trust-and-verify at the end")
- Claude (orchestrator) gathers worker outputs and runs a **verification gate** — existing test suite and/or a diff review — *before* any worktree is merged.
- Failed or unverifiable lanes are flagged, not merged.

### 4.4 Fallback for Problem 1 (if lanes don't auto-render)
- **Escape hatch A (small fork):** patch RuFlo's TUI lane-list module to recognize the new worker types.
- **Escape hatch B (side dashboard):** run a separate observability panel fed by RuFlo's event stream / AgentDB / memory, leaving RuFlo's TUI untouched.

### 4.5 Phased plan
- **Phase 0 — Verify extension point.** In the local RuFlo install, locate the lane renderer (grep package for the lane/worktree render code and the on-screen control strings) and confirm whether custom workers auto-surface. Confirm v3.6 spawn→execute path. *(Gate for everything else.)*
- **Phase 1 — PoC, one agent.** Implement `opencode-worker` over ACP. Goal: Claude dispatches it via `agent_spawn`, it runs in a worktree, and it appears as a live lane.
- **Phase 2 — Breadth.** Add `gemini-worker` (ACP) and `qwen-worker` (local). Confirm parallel lanes + telemetry.
- **Phase 3 — Routing + verification.** Add the `PreAgentSpawn` cost-aware routing hook and the verify-before-merge gate.
- **Phase 4 — Lifecycle automation.** Automate worktree create → merge → clean; add pool caps and concurrency limits.

---

## 5. Outcome

A single Claude Code session where:

- **Claude autonomously orchestrates** a swarm of heterogeneous external/local agents (Codex, Gemini, OpenCode, local Qwen) as worktree-isolated workers — dispatched, routed, and verified by Claude, not hand-driven.
- **Every worker appears as a lane in RuFlo's existing TUI**, with status, token usage, and live trajectory — inspectable on demand, ignorable by default.
- **Sessions are supervised** (ACP / App Server Protocol), so worker liveness is always known; no silent deaths.
- **Routing is cost-aware** (local-first, escalate by need), and **nothing merges without passing a verification gate.**

Net effect: the control of native subagents + the observability of the RuFlo TUI, applied to *any* CLI agent — delivered as a RuFlo plugin rather than a fork wherever Phase 0 allows.

---

## 6. Open Questions / Phase-0 Checklist

- [ ] Which command launches the lane TUI in the installed build (`ruflo` / `npx claude-flow` harness vs. a plain `claude` session)?
- [ ] Does a custom `@claude-flow/plugins` worker auto-render as a lane, or is the lane list bound to built-in worker types?
- [ ] What is the exact telemetry/lifecycle contract a worker must emit for the lane to populate?
- [ ] In v3.6, does `agent_spawn` create coordination records only, or does it spawn a real executing worker process?
- [ ] What is the worktree lifecycle RuFlo already manages vs. what we must add?
- [ ] Does RuFlo already expose a generic "external CLI worker" base we can subclass (beyond the Codex integration)?

---

## 7. References

- RuFlo (formerly Claude Flow), npm `claude-flow`: https://github.com/ruvnet/ruflo
- RuFlo plugin SDK (`@claude-flow/plugins`): https://github.com/ruvnet/ruflo/blob/main/v3/@claude-flow/plugins/README.md
- RuFlo + Codex orchestrator/executor model: https://github.com/ruvnet/ruflo/blob/main/AGENTS.md
- Agent Client Protocol (ACP): https://agentclientprotocol.com
- Codex App Server Protocol plugin (`codex-plugin-cc`): https://github.com/openai/codex-plugin-cc
- Gemini ACP plugin (`gemini-plugin-cc`): https://github.com/sakibsadmanshajib/gemini-plugin-cc
- Lean worktree-supervisor references (for fallback / patterns): `parallel-code` (https://github.com/johannesjo/parallel-code), Claude Squad
