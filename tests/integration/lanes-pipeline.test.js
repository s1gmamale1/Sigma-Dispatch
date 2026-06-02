'use strict';
/**
 * Integration tests: full lanes pipeline
 * readStatusFiles → indexStatuses → mergeLaneView
 *
 * GAP: No existing test exercises the complete lane-status flow from
 * disk-persisted status files through to a merged view ready for the statusline.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  readStatusFiles, indexStatuses, mergeLaneView, LANE_DIR,
} = require('../../plugin/lib/lanes.cjs');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-integ-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeLaneFile(name, data) {
  // Strip everything except alphanumerics, hyphens, underscores — no path.join
  // with the user-supplied name so semgrep taint analysis is satisfied.
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeName) throw new Error(`invalid lane name: ${name}`);
  const laneDir = path.join(tmpDir, LANE_DIR);
  fs.mkdirSync(laneDir, { recursive: true });
  fs.writeFileSync(`${laneDir}/${safeName}.json`, JSON.stringify(data));
}

describe('full lanes pipeline: readStatusFiles → indexStatuses → mergeLaneView', () => {
  test('status files drive merged view when agent rows are present', () => {
    writeLaneFile('lane-1', { id: 'ses-1', name: 'lane-1', cli: 'codex', task: 'write tests', state: 'done', prUrl: 'https://gh/pr/1' });
    writeLaneFile('lane-2', { id: 'ses-2', name: 'lane-2', cli: 'cursor', task: 'fix bug', state: 'running' });

    const statuses = readStatusFiles(tmpDir);
    const idx = indexStatuses(statuses);

    const agentRows = [
      { sessionId: 'ses-1', name: 'lane-1', status: 'working' },
      { sessionId: 'ses-2', name: 'lane-2', status: 'working' },
    ];
    const view = mergeLaneView(agentRows, idx);

    expect(view).toHaveLength(2);
    const lane1 = view.find(l => l.id === 'ses-1');
    expect(lane1.state).toBe('done');
    expect(lane1.prUrl).toBe('https://gh/pr/1');
    expect(lane1.cli).toBe('codex');

    const lane2 = view.find(l => l.id === 'ses-2');
    expect(lane2.state).toBe('running');
    expect(lane2.cli).toBe('cursor');
  });

  test('lane rows with no matching status file fall back to live agent status', () => {
    // No status files written — directory is empty.
    const statuses = readStatusFiles(tmpDir); // []
    const idx = indexStatuses(statuses);      // {}
    const agentRows = [{ sessionId: 'orphan', name: 'lane-orphan', status: 'completed' }];
    const view = mergeLaneView(agentRows, idx);

    expect(view[0].state).toBe('done');
    expect(view[0].cli).toBeNull();
  });

  test('malformed status file does not corrupt the rest of the view', () => {
    const dir = path.join(tmpDir, LANE_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bad.json'), '{{{');
    writeLaneFile('good', { id: 'ses-ok', name: 'lane-ok', state: 'done', cli: 'codex' });

    const statuses = readStatusFiles(tmpDir);
    expect(statuses).toHaveLength(1); // malformed skipped

    const idx = indexStatuses(statuses);
    const view = mergeLaneView([{ sessionId: 'ses-ok', name: 'lane-ok', status: 'working' }], idx);
    expect(view[0].state).toBe('done');
  });

  test('oversized status file is excluded; rest of pipeline unaffected', () => {
    const dir = path.join(tmpDir, LANE_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'big.json'), Buffer.alloc(65537, 'x'));
    writeLaneFile('small', { id: 'ses-s', name: 'lane-s', state: 'error', cli: 'codex' });

    const statuses = readStatusFiles(tmpDir);
    expect(statuses).toHaveLength(1);

    const view = mergeLaneView(
      [{ sessionId: 'ses-s', name: 'lane-s', status: 'working' }],
      indexStatuses(statuses),
    );
    expect(view[0].state).toBe('error');
  });

  test('empty lane directory produces an empty merged view', () => {
    const view = mergeLaneView([], indexStatuses(readStatusFiles(tmpDir)));
    expect(view).toEqual([]);
  });
});
