# Sigma-Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a standalone Claude Code plugin that dispatches external CLI coding agents (Codex first) as switchable, worktree-isolated Claude Code lanes, with main-Claude in full control and a verify-before-merge gate.

**Architecture:** Each lane is a Haiku Claude Code background session (`claude --bg`) that auto-creates a git worktree and drives one CLI (`codex exec`), verifies the diff, and writes a status file. Claude Code's native Agent View renders the switchable lanes; a composer statusline appends a lane summary to RuFlo's existing bar. RuFlo is untouched. Full design: `docs/cli-lanes-spec.md`.

**Tech Stack:** Claude Code v2.1.160+ (plugins, background agents, worktrees, statusLine), Node.js (CommonJS `.cjs` helpers), Jest (tests, per the repo's `package.json`), git worktrees, the `codex` CLI.

---

## File Structure

```
SigmaSubagents/
├── CLAUDE.md                                  (root — active project config, do NOT move)
├── package.json                               (jest; testMatch **/tests/**/*.test.js)
├── docs/
│   ├── external-agent-workers-design.md       (original seed)
│   ├── cli-lanes-spec.md                       (design — source of truth)
│   └── cli-lanes-plan.md                        (this plan)
├── plugin/
│   ├── .claude-plugin/plugin.json              (manifest)
│   ├── agents/codex-worker.md                  (Haiku thin dispatcher)
│   ├── commands/{codex,lanes,verify,land}.md   (+ fanout.md in Phase 5)
│   ├── lib/lanes.cjs                            (pure helpers + IO — single source of truth)
│   ├── lib/statusline-cli-lanes.cjs            (statusline composer)
│   └── README.md
├── tests/unit/lanes.test.js                    (jest)
└── scripts/phase0-verify.sh                    (the gate)
```

Responsibilities: `lib/lanes.cjs` owns all lane-status reading/merging/rendering (pure functions are unit-tested; IO wrappers are thin). The statusline composer and every command read lane state **only** through `lanes.cjs` — no duplicate parsing. Agent/command markdown files hold prompts only (no logic).

---

## Phase 0 — Validate the lane mechanism (GATE)

**STATUS: ✅ PASSED (2026-06-02) — GO.** Confirmed dispatch = backgrounded `claude -p --worktree <id> --name <id> --agent <worker>`. `codex exec` takes the prompt on stdin (no injection); `CLAUDE_CODE_SESSION_ID` gives a lane its id; `claude agents --json` monitors. Full evidence: `docs/phase0-findings.md`.

> Empirical. No code is written against assumptions until this passes. If a check fails, stop and record it; the fallback is documented Bash dispatch (lean path) instead of slash-command dispatch.

### Task 0.1: Create the Phase-0 verification script

**Files:** Create `scripts/phase0-verify.sh`

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Phase-0 gate for CLI-Lanes. Run inside a throwaway git repo.
set -uo pipefail
echo "== flags =="
claude --help 2>&1 | grep -iE -- '--bg|--agent|--model|--permission-mode|--worktree' || echo "MISSING flag(s)"
claude agents --help 2>&1 | grep -iE -- '--json|--agent|--model' || echo "MISSING agents flag(s)"
echo "== codex prompt-input forms =="
codex exec --help 2>&1 | grep -iE -- 'stdin|--file|-|prompt' | head -20
echo "== self session id env =="
env | grep -iE 'CLAUDE.*SESSION|SESSION_ID' || echo "no obvious session-id env var"
echo "Now run the live checks in Task 0.2 by hand and record results."
```

- [ ] **Step 2: Make it executable and run it**

Run: `chmod +x scripts/phase0-verify.sh && ./scripts/phase0-verify.sh`
Expected: prints the supported flags for `claude --bg/--agent/--model/--permission-mode`, the `claude agents --json` flag, and how `codex exec` accepts a prompt. Record any `MISSING`.

- [ ] **Step 3: Commit**

```bash
git add scripts/phase0-verify.sh && git commit -m "chore: phase-0 lane-mechanism verification script"
```

### Task 0.2: Live dispatch checks (manual, recorded)

**Files:** Create `docs/phase0-findings.md`

- [ ] **Step 1: Dispatch a trivial background lane**

Run (in a throwaway git repo): `claude --bg "Print the current git branch and exit"`
Expected: a session id is printed; no error.

- [ ] **Step 2: Confirm it shows in Agent View JSON**

Run: `claude agents --json`
Expected: a JSON array containing the new session with `sessionId`, `name`, `status`, `cwd`. **Record the exact field names.**

- [ ] **Step 3: Confirm auto-worktree + dispatch with flags**

Run: `claude --bg --model haiku --permission-mode bypassPermissions "Run: git rev-parse --show-toplevel"` then `git worktree list`
Expected: a worktree under `.claude/worktrees/` is created for the session. **Record the path pattern + branch name.**

- [ ] **Step 4: Confirm dispatch-from-slash-command works**

Create a temp command `~/.claude/commands/lane-smoke.md` containing a `!`-bash line `! claude --bg "echo hi from lane"`, run `/lane-smoke`, then `claude agents --json`.
Expected: the lane appears. (If NOT, record it — `/codex` must instead instruct main-Claude to call Bash directly. This is the key fallback decision.)

- [ ] **Step 5: Confirm stop + logs + self-id**

Run: `claude stop <id>` and `claude logs <id>`. Inside a lane, check `env | grep -i session`.
Expected: stop works; logs prints output; record whether a lane can learn its own session id (else status files are keyed by worktree name).

- [ ] **Step 6: Write findings + GO/NO-GO and commit**

Record all answers in `docs/phase0-findings.md` with a final **GO** (slash-command dispatch works) or **GO-LEAN** (fall back to Bash dispatch). Commit: `git add docs/phase0-findings.md && git commit -m "docs: phase-0 findings + go decision"`

---

## Phase 1 — Plugin skeleton + lane-status library

### Task 1.1: Scaffold the plugin manifest

**Files:** Create `plugin/.claude-plugin/plugin.json`

- [ ] **Step 1: Write the manifest**

```json
{
  "name": "sigma-dispatch",
  "version": "0.1.0",
  "description": "Dispatch external CLI coding agents (Codex first) as switchable, worktree-isolated Claude Code lanes with a verify-before-merge gate.",
  "author": { "name": "SIGMA" }
}
```

- [ ] **Step 2: Validate structure**

Use the `plugin-dev:plugin-validator` agent on `plugin/`. Expected: manifest valid; commands/agents directories recognized.

- [ ] **Step 3: Confirm local load**

Run: `claude --plugin-dir ./plugin --help 2>&1 | head -5` (no crash).
Expected: Claude Code loads the plugin dir without error.

- [ ] **Step 4: Commit**

```bash
git add plugin/.claude-plugin/plugin.json && git commit -m "feat: cli-lanes plugin manifest"
```

### Task 1.2: Lane-status library (TDD)

**Files:** Create `plugin/lib/lanes.cjs`, Test `tests/unit/lanes.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/lanes.test.js
const {
  renderLaneSummary, mapAgentStatus, indexStatuses, mergeLaneView,
} = require('../../plugin/lib/lanes.cjs');

describe('renderLaneSummary', () => {
  test('empty for no lanes', () => {
    expect(renderLaneSummary([])).toBe('');
    expect(renderLaneSummary(null)).toBe('');
  });
  test('groups by cli and counts states', () => {
    const out = renderLaneSummary([
      { cli: 'codex', state: 'running' },
      { cli: 'codex', state: 'done' },
      { cli: 'codex', state: 'done' },
    ]);
    expect(out).toMatch(/codex/);
    expect(out).toMatch(/✓2/);
    expect(out).toMatch(/●/);
  });
});

describe('mapAgentStatus', () => {
  test('maps Claude Code states to lane states', () => {
    expect(mapAgentStatus('working')).toBe('running');
    expect(mapAgentStatus('completed')).toBe('done');
    expect(mapAgentStatus('error')).toBe('error');
    expect(mapAgentStatus('whatever')).toBe('idle');
  });
});

describe('indexStatuses', () => {
  test('indexes by both id and name', () => {
    const idx = indexStatuses([{ id: 'abc', name: 'lane-1', cli: 'codex' }]);
    expect(idx.abc.cli).toBe('codex');
    expect(idx['lane-1'].cli).toBe('codex');
  });
});

describe('mergeLaneView', () => {
  test('status file wins over agent row', () => {
    const rows = [{ sessionId: 'abc', name: 'lane-1', status: 'working' }];
    const idx = indexStatuses([{ id: 'abc', name: 'lane-1', cli: 'codex', task: 't', state: 'done', prUrl: 'http://x' }]);
    const m = mergeLaneView(rows, idx);
    expect(m).toHaveLength(1);
    expect(m[0].cli).toBe('codex');
    expect(m[0].state).toBe('done');
    expect(m[0].prUrl).toBe('http://x');
  });
  test('falls back to agent status with no status file', () => {
    const m = mergeLaneView([{ sessionId: 'z', name: 'lane-z', status: 'working' }], {});
    expect(m[0].state).toBe('running');
    expect(m[0].cli).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm install && npx jest tests/unit/lanes.test.js`
Expected: FAIL — `Cannot find module '../../plugin/lib/lanes.cjs'`.

- [ ] **Step 3: Implement the library**

```js
// plugin/lib/lanes.cjs
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LANE_DIR = '.claude/lanes';
const ICON = { running: '●', done: '✓', error: '✗', idle: '∙' };

function mapAgentStatus(status) {
  switch (status) {
    case 'working': return 'running';
    case 'completed': return 'done';
    case 'error': return 'error';
    default: return 'idle';
  }
}

// Pure: compact one-line summary for the statusbar.
function renderLaneSummary(lanes) {
  if (!Array.isArray(lanes) || lanes.length === 0) return '';
  const byCli = {};
  for (const l of lanes) {
    const cli = l.cli || 'cli';
    const state = l.state || 'idle';
    (byCli[cli] = byCli[cli] || {})[state] = (byCli[cli][state] || 0) + 1;
  }
  const parts = Object.entries(byCli).map(([cli, states]) => {
    const segs = Object.entries(states).map(([s, n]) => `${ICON[s] || '∙'}${n > 1 ? n : ''}`);
    return `${cli}${segs.join('')}`;
  });
  return '🛠 ' + parts.join(' · ');
}

// Pure: index status objects by id and name for fast lookup.
function indexStatuses(statuses) {
  const idx = {};
  for (const s of statuses || []) {
    if (s && s.id) idx[s.id] = s;
    if (s && s.name) idx[s.name] = s;
  }
  return idx;
}

// Pure: merge `claude agents --json` rows with our status index.
function mergeLaneView(agentRows, statusIndex) {
  const out = [];
  for (const row of agentRows || []) {
    const s = (statusIndex && (statusIndex[row.sessionId] || statusIndex[row.name])) || {};
    out.push({
      id: row.sessionId || null,
      name: row.name || row.sessionId || null,
      cli: s.cli || null,
      task: s.task || null,
      state: s.state || mapAgentStatus(row.status),
      diffstat: s.diffstat || null,
      prUrl: s.prUrl || null,
      verdict: s.verdict || null,
      error: s.error || null,
    });
  }
  return out;
}

// IO: read all lane status files (returns []; never throws).
function readStatusFiles(cwd = process.cwd()) {
  const dir = path.join(cwd, LANE_DIR);
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { /* skip malformed */ }
  }
  return out;
}

// IO: live lanes via `claude agents --json` (returns []; never throws).
function getAgentRows() {
  try {
    const out = execFileSync('claude', ['agents', '--json'], { timeout: 2000, encoding: 'utf8' });
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

module.exports = {
  LANE_DIR, mapAgentStatus, renderLaneSummary, indexStatuses,
  mergeLaneView, readStatusFiles, getAgentRows,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/unit/lanes.test.js`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Commit**

```bash
git add plugin/lib/lanes.cjs tests/unit/lanes.test.js package.json package-lock.json
git commit -m "feat: lane-status library (render/merge/index) with tests"
```

---

## Phase 2 — Codex worker + `/codex` + status contract (vertical slice)

### Task 2.1: The `codex-worker` agent

**Files:** Create `plugin/agents/codex-worker.md`

- [ ] **Step 1: Write the agent definition** (model/flag specifics confirmed in Phase 0)

```markdown
---
name: codex-worker
description: Thin dispatcher that delegates a coding task to the Codex CLI inside an isolated git worktree, verifies the diff, and reports status. Use for lane-based Codex delegation.
tools: Bash, Read, Write
model: haiku
maxTurns: 30
---

You are a THIN DISPATCHER for the Codex CLI. You do NOT write code yourself — Codex does.

Your prompt names a task file path. Do exactly this, then stop:

1. Confirm isolation: run `pwd` and `git rev-parse --show-toplevel`. You must be inside a worktree under `.claude/worktrees/`. If you are on the main checkout, write an `error` status (step 6) and STOP — never edit main.
2. Read the task from the given file with the Read tool.
3. Set a per-worktree Codex home: `export CODEX_HOME="$(git rev-parse --show-toplevel)/.codex-home"`.
4. Run Codex non-interactively, passing the prompt by the SAFE form pinned in Phase 0 (stdin or a file flag — NEVER `codex exec "$(cat …)"`). Default: `codex exec < <taskfile>` if stdin is supported, else the confirmed file flag.
5. Verify: run `git diff --stat`. If there are NO changes, treat it as FAILURE (this guards the known silent-fail) — write an `error` status and STOP. Otherwise `git add -A && git commit -m "codex: <one-line task summary>"`. If a remote exists, push and `gh pr create --fill` and capture the URL.
6. Write the status file with the Write tool to `.claude/lanes/<worktree-basename>.json` using this exact shape:
   `{ "id": "<your session id or null>", "name": "<worktree basename>", "cli": "codex", "task": "<short>", "state": "done|error", "diffstat": "<from git diff --stat>", "prUrl": "<url or null>", "verdict": "pending", "error": "<message or null>", "updatedAt": "<iso8601>" }`
7. Print a single-line summary (`done` or `error: <why>`) and STOP.

HARD RULES: never merge; never touch the base branch; never retry silently; if Codex errors or produces no diff, report `error` honestly.
```

- [ ] **Step 2: Commit**

```bash
git add plugin/agents/codex-worker.md && git commit -m "feat: codex-worker thin-dispatcher agent"
```

### Task 2.2: The `/codex` command

**Files:** Create `plugin/commands/codex.md`

- [ ] **Step 1: Write the command** (dispatch path per Phase-0 GO vs GO-LEAN)

```markdown
---
description: Dispatch a Codex CLI task as an isolated, switchable lane.
argument-hint: <task description>
allowed-tools: Bash, Write, Read
---

Dispatch a Codex lane for this task: **$ARGUMENTS**

Steps:
1. Enforce the resource cap: run `node plugin/lib/lanes-count.cjs` (or `claude agents --json | …`); if running lanes ≥ 4, tell me and STOP.
2. Generate an id: `id="codex-$(date +%s)"`.
3. Write the task text above to `.claude/lanes/tasks/$id.md` using the Write tool (do NOT echo it through the shell — avoids injection).
4. Dispatch the lane (Phase-0-confirmed mechanism — backgrounded headless worktree session):
   `env -u CLAUDE_CODE_SESSION_ID claude -p --session-id "$(uuidgen)" --worktree "$id" --name "$id" --agent codex-worker --model haiku --permission-mode bypassPermissions --plugin-dir "$CLAUDE_PLUGIN_ROOT" "Run the Codex task in .claude/lanes/tasks/$id.md and report status." &`
5. Report the dispatched lane id and tell me to watch it with `/lanes` (it appears in the native Agent View switcher too).
```

- [ ] **Step 2: Smoke test the vertical slice**

Run in a throwaway git repo with the plugin loaded (`claude --plugin-dir ./plugin`): `/codex add a function add(a,b) returning a+b in math.js with a test`
Expected (observable): a lane appears in `claude agents --json`; a worktree is created; `codex exec` runs; `git -C <worktree> diff --stat` shows changes; `.claude/lanes/<name>.json` exists with `state:done` and a non-empty `diffstat`.

- [ ] **Step 3: Failure-path smoke**

Run: `/codex do nothing at all` (a no-op task).
Expected: status file `state:error` with a clear message; no commit; nothing merged.

- [ ] **Step 4: Commit**

```bash
git add plugin/commands/codex.md && git commit -m "feat: /codex dispatches a codex-worker lane"
```

---

## Phase 3 — Orchestration: `/lanes`, `/verify`, `/land` + resource cap

### Task 3.1: Resource-cap + count helper (TDD)

**Files:** Create `plugin/lib/lanes-count.cjs`, add tests to `tests/unit/lanes.test.js`

- [ ] **Step 1: Add failing test**

```js
// append to tests/unit/lanes.test.js
const { countByState } = require('../../plugin/lib/lanes.cjs');
describe('countByState', () => {
  test('counts running lanes', () => {
    expect(countByState([{ state: 'running' }, { state: 'running' }, { state: 'done' }], 'running')).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx jest tests/unit/lanes.test.js -t countByState`
Expected: FAIL — `countByState is not a function`.

- [ ] **Step 3: Add `countByState` to `lanes.cjs` and export it**

```js
// add to plugin/lib/lanes.cjs before module.exports, and add countByState to exports
function countByState(lanes, state) {
  return (lanes || []).filter((l) => l.state === state).length;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest tests/unit/lanes.test.js -t countByState`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugin/lib/lanes.cjs tests/unit/lanes.test.js && git commit -m "feat: countByState for the lane resource cap"
```

### Task 3.2: `/lanes` status command

**Files:** Create `plugin/commands/lanes.md`

- [ ] **Step 1: Write the command**

```markdown
---
description: Show the status of all CLI-Lanes (live + status files).
allowed-tools: Bash
---

Show all lanes. Run this and present the output as a table (name · cli · state · diffstat · prUrl · verdict):

`node -e "const L=require('./plugin/lib/lanes.cjs');const v=L.mergeLaneView(L.getAgentRows(),L.indexStatuses(L.readStatusFiles()));console.log(JSON.stringify(v,null,2))"`

Flag any lane in state `error` (needs attention) and any `done` lane with `verdict:pending` (ready for `/verify`).
```

- [ ] **Step 2: Smoke**

Run: `/lanes` after Phase 2's slice.
Expected: a readable table including the codex lane with its state + diffstat.

- [ ] **Step 3: Commit**

```bash
git add plugin/commands/lanes.md && git commit -m "feat: /lanes status view"
```

### Task 3.3: `/verify` Opus reviewer gate

**Files:** Create `plugin/commands/verify.md`

- [ ] **Step 1: Write the command**

```markdown
---
description: Run an Opus reviewer gate over a lane's diff before merge.
argument-hint: <lane-name | all>
allowed-tools: Bash, Read, Write, Agent
---

For lane(s) **$ARGUMENTS** (or every `done` lane with `verdict:pending` if `all`):

1. Resolve the worktree path: `.claude/worktrees/<name>` and capture `git -C <path> diff <base>...HEAD`.
2. Dispatch an Opus reviewer with the Agent tool: `subagent_type: reviewer, model: opus`, prompt = "Review this diff for correctness, security, and whether it satisfies the task in .claude/lanes/tasks/<id>.md. Return APPROVE or REQUEST CHANGES with reasons." Pass the diff.
3. Write the verdict back into `.claude/lanes/<name>.json` (`verdict: "approve" | "changes"`), preserving other fields.
4. Report each verdict. For `changes`, summarize what must be fixed (this feeds a re-dispatch into the same worktree).
```

- [ ] **Step 2: Smoke**

Run: `/verify <name>` on the Phase-2 lane.
Expected: an Opus reviewer runs over the real diff; the status file gains `verdict: approve|changes`.

- [ ] **Step 3: Commit**

```bash
git add plugin/commands/verify.md && git commit -m "feat: /verify Opus reviewer gate"
```

### Task 3.4: `/land` merge + cleanup

**Files:** Create `plugin/commands/land.md`

- [ ] **Step 1: Write the command**

```markdown
---
description: Merge an APPROVED lane's worktree branch into the base, then clean up.
argument-hint: <lane-name>
allowed-tools: Bash, Read
---

Land lane **$ARGUMENTS**:

1. Read `.claude/lanes/$ARGUMENTS.json`. If `verdict` is not `approve`, REFUSE and tell me to `/verify` first.
2. Merge: `git checkout <base> && git merge --no-ff worktree-$ARGUMENTS`. If conflicts, abort the merge, report, and STOP (do not force).
3. Clean up: `git worktree remove .claude/worktrees/$ARGUMENTS --force` and `git branch -d worktree-$ARGUMENTS`.
4. Mark the lane landed (update the status file `state:"landed"`), and report.
```

- [ ] **Step 2: Smoke (happy path)**

Approve a lane via `/verify`, then `/land <name>`.
Expected: branch merges, worktree + branch removed, status `landed`. A non-approved lane is REFUSED.

- [ ] **Step 3: Commit**

```bash
git add plugin/commands/land.md && git commit -m "feat: /land merges approved lanes and cleans up"
```

---

## Phase 4 — Lane-aware statusline

### Task 4.1: Statusline composer (TDD for the composition seam)

**Files:** Create `plugin/lib/statusline-cli-lanes.cjs`, Test `tests/unit/statusline.test.js`

- [ ] **Step 1: Write the failing test** (test the pure composition function)

```js
// tests/unit/statusline.test.js
const { compose } = require('../../plugin/lib/statusline-cli-lanes.cjs');
describe('compose', () => {
  test('appends summary to base bar', () => {
    expect(compose('RuFlo V3.6 | main', '🛠 codex●')).toBe('RuFlo V3.6 | main  🛠 codex●');
  });
  test('returns base unchanged when no lanes', () => {
    expect(compose('RuFlo V3.6 | main', '')).toBe('RuFlo V3.6 | main');
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx jest tests/unit/statusline.test.js`
Expected: FAIL — module/`compose` not found.

- [ ] **Step 3: Implement the composer**

```js
#!/usr/bin/env node
'use strict';
// plugin/lib/statusline-cli-lanes.cjs
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getAgentRows, readStatusFiles, indexStatuses, mergeLaneView, renderLaneSummary } = require('./lanes.cjs');

function compose(base, summary) {
  return summary ? `${base}  ${summary}` : base;
}

function baseBar(stdinJson) {
  const ruflo = path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.claude/helpers/statusline.cjs');
  try {
    return execFileSync('node', [ruflo], { input: stdinJson, timeout: 2000, encoding: 'utf8' }).replace(/\n+$/, '');
  } catch {
    try { return ((JSON.parse(stdinJson).model || {}).display_name) || ''; } catch { return ''; }
  }
}

function main() {
  let stdinJson = '';
  try { stdinJson = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  const lanes = mergeLaneView(getAgentRows(), indexStatuses(readStatusFiles()));
  process.stdout.write(compose(baseBar(stdinJson), renderLaneSummary(lanes)));
}

if (require.main === module) main();
module.exports = { compose };
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest tests/unit/statusline.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugin/lib/statusline-cli-lanes.cjs tests/unit/statusline.test.js
git commit -m "feat: lane-aware statusline composer (wraps RuFlo bar)"
```

### Task 4.2: Wire the statusline

**Files:** Modify `.claude/settings.json` (project)

- [ ] **Step 1: Point statusLine at the composer**

Change `statusLine.command` to: `sh -c 'exec node "${CLAUDE_PROJECT_DIR:-.}/plugin/lib/statusline-cli-lanes.cjs"'`

- [ ] **Step 2: Smoke**

Run a session with a couple of active lanes.
Expected: the bar shows RuFlo's content plus a trailing `🛠 codex●…`; with no lanes, the bar is identical to before (graceful).

- [ ] **Step 3: Commit**

```bash
git add .claude/settings.json && git commit -m "chore: wire lane-aware statusline"
```

---

## Phase 5 — Breadth, `/fanout`, hardening, README

### Task 5.1: Additional worker agents

**Files:** Create `plugin/agents/{gemini,opencode,kimi}-worker.md`

- [ ] **Step 1:** Clone `codex-worker.md` per CLI, swapping the invocation and baking in the `orchestrator` skill's proven flags:
  - opencode: `opencode run "<task>" --dangerously-skip-permissions --model opencode/qwen3.6-plus-free` (valid model id; `--print-logs --log-level ERROR` for bg).
  - gemini: `gemini -p --yolo "<task>"` **only with API-key + Flash** (subscription tiers stop 2026-06-18 — add a guard that errors if not API-key auth).
  - kimi: `kimi -w <worktree> "<task>"`.
  Each writes the same status contract with its own `cli` value.
- [ ] **Step 2:** Smoke each (trivial task → diff → status file).
- [ ] **Step 3:** Commit per worker.

### Task 5.2: `/fanout`

**Files:** Create `plugin/commands/fanout.md`

- [ ] **Step 1:** Command that takes a list of tasks (one per line), picks a CLI per task using the `orchestrator` skill's delegation matrix, enforces `maxConcurrentLanes`, and dispatches one lane each.
- [ ] **Step 2:** Smoke with 2 tasks across 2 CLIs.
- [ ] **Step 3:** Commit.

### Task 5.3: README + full test pass

**Files:** Create `plugin/README.md`

- [ ] **Step 1:** Document install (`claude --plugin-dir ./plugin`), the commands, the lifecycle, the security model, and the Agent-View-research-preview caveat + Bash fallback.
- [ ] **Step 2:** Run the suite.

Run: `npm test`
Expected: all unit tests pass.

- [ ] **Step 3:** Commit.

```bash
git add plugin/README.md && git commit -m "docs: cli-lanes README + usage"
```

---

## Self-Review

**Spec coverage:** §3 architecture → Phases 1–4; §4 lifecycle → Phases 2–3 (dispatch/execute/verify/land); §5 components → every task creates one; §6 contracts → status file (Task 2.1), `agents --json` (Phase 0), statusLine (Phase 4); §7 security → file-not-shell task passing (Task 2.2 step 3), worktree isolation (Task 2.1), per-worktree `CODEX_HOME` (Task 2.1), verify gate (Task 3.3/3.4), resource cap (Task 3.1/3.2); §8 Gemini deprecation → Task 5.1; §9 scope → Phases 1–4 = Codex v1, Phase 5 = breadth; §10 risks → Phase 0 fallback + research-preview note in README; §11 Phase-0 gate → Phase 0.

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to". The two empirical unknowns (exact `claude --bg` flags; safe `codex exec` prompt input) are explicit Phase-0 verification steps with recorded outputs, not placeholders.

**Type consistency:** `lanes.cjs` exports used consistently across statusline composer and commands: `getAgentRows`, `readStatusFiles`, `indexStatuses`, `mergeLaneView`, `renderLaneSummary`, `mapAgentStatus`, `countByState`. Status-file shape is identical in the spec (§6.1), the worker (Task 2.1 step 1), and `mergeLaneView`. Lanes are keyed by worktree `name` (with `id` optional) throughout, matching the Phase-0 finding that a lane may not know its own session id.

**Sequencing:** Phase 0 gates everything; `lanes.cjs` (Phase 1) precedes its consumers (`/lanes`, statusline); the vertical slice (Phase 2) is green before orchestration (Phase 3) and polish (Phase 4); breadth (Phase 5) is last.
