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
