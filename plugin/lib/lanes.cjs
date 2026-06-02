// plugin/lib/lanes.cjs
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LANE_DIR = '.claude/lanes';
const MAX_STATUS_BYTES = 65536; // skip oversized status files so they can't block the statusline
const ICON = { running: '●', done: '✓', error: '✗', idle: '∙', landed: '⊕' };

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
// Status-file fields win when present; empty/falsy values (e.g. "") are treated
// as absent and fall back to the live agent row — the worker only ever writes
// real values (state is running|done|error, plus landed after /land), so this is intentional.
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
    const fp = path.join(dir, f);
    try {
      if (fs.statSync(fp).size > MAX_STATUS_BYTES) continue;
      out.push(JSON.parse(fs.readFileSync(fp, 'utf8')));
    } catch { /* skip missing/malformed/oversized */ }
  }
  return out;
}

// IO: live lanes via `claude agents --json` (returns []; never throws — including
// when the `claude` binary is absent. The high-frequency statusline must stay quiet,
// so commands like /lanes that need to surface env problems check for `claude` separately).
function getAgentRows() {
  try {
    const out = execFileSync('claude', ['agents', '--json'], { timeout: 2000, encoding: 'utf8' });
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

// Pure: count lanes matching a given state.
function countByState(lanes, state) {
  return (lanes || []).filter((l) => l.state === state).length;
}

module.exports = {
  LANE_DIR, mapAgentStatus, renderLaneSummary, indexStatuses,
  mergeLaneView, readStatusFiles, getAgentRows, countByState,
};
