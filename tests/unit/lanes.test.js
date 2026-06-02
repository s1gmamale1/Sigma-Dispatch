// tests/unit/lanes.test.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  renderLaneSummary, mapAgentStatus, indexStatuses, mergeLaneView,
  readStatusFiles, getAgentRows, LANE_DIR, countByState,
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

  // GAP: empty string fields in status file are falsy — should fall back to live row
  test('empty string fields in status index fall back to live row', () => {
    const rows = [{ sessionId: 'abc', name: 'lane-1', status: 'completed' }];
    const idx = indexStatuses([{ id: 'abc', name: 'lane-1', state: 'done', cli: '', task: '' }]);
    const m = mergeLaneView(rows, idx);
    expect(m[0].cli).toBeNull();   // '' is falsy → falls back to null (no cli on row)
    expect(m[0].task).toBeNull();  // '' is falsy → falls back to null
    expect(m[0].state).toBe('done'); // 'done' is truthy → kept
  });

  // GAP: match by name only when row has no sessionId
  test('matches by name when sessionId is absent', () => {
    const rows = [{ name: 'lane-n', status: 'working' }]; // no sessionId
    const idx = indexStatuses([{ name: 'lane-n', cli: 'codex', state: 'done' }]);
    const m = mergeLaneView(rows, idx);
    expect(m[0].state).toBe('done');
    expect(m[0].cli).toBe('codex');
  });

  // GAP: null/empty agentRows returns empty array without throwing
  test('returns [] for null agentRows', () => {
    expect(mergeLaneView(null, {})).toEqual([]);
    expect(mergeLaneView(undefined, {})).toEqual([]);
    expect(mergeLaneView([], {})).toEqual([]);
  });

  // GAP: null statusIndex falls back entirely to live agent status
  test('null statusIndex uses live agent status for all rows', () => {
    const rows = [{ sessionId: 'x', name: 'lane-x', status: 'completed' }];
    const m = mergeLaneView(rows, null);
    expect(m[0].state).toBe('done');
    expect(m[0].cli).toBeNull();
  });
});

// ── renderLaneSummary — edge cases ────────────────────────────────────────────

describe('renderLaneSummary — edge cases', () => {
  // GAP: unknown state not in ICON map falls back to ∙
  test('unknown state uses fallback ∙ icon', () => {
    const out = renderLaneSummary([{ cli: 'codex', state: 'pending' }]);
    expect(out).toMatch(/∙/);
  });

  // GAP: lane with no cli field defaults to 'cli' group
  test('missing cli field defaults to cli group', () => {
    const out = renderLaneSummary([{ state: 'running' }]);
    expect(out).toMatch(/cli/);
    expect(out).toMatch(/●/);
  });

  // GAP: single item count omits trailing number
  test('single item of a state shows icon without trailing count', () => {
    const out = renderLaneSummary([{ cli: 'codex', state: 'done' }]);
    expect(out).toMatch(/✓/);
    expect(out).not.toMatch(/✓1/); // n>1 check means single item has no number
  });

  // GAP: multiple CLI tools rendered as separate groups with · separator
  test('multiple CLI tools appear as separate groups', () => {
    const out = renderLaneSummary([
      { cli: 'codex', state: 'running' },
      { cli: 'cursor', state: 'done' },
    ]);
    expect(out).toMatch(/codex/);
    expect(out).toMatch(/cursor/);
    expect(out).toMatch(/·/);
  });
});

// ── indexStatuses — edge cases ────────────────────────────────────────────────

describe('indexStatuses — edge cases', () => {
  // GAP: null entries in the array are silently skipped
  test('skips null entries without throwing', () => {
    const idx = indexStatuses([null, { id: 'abc', name: 'n', cli: 'c' }]);
    expect(idx.abc.cli).toBe('c');
  });

  // GAP: entry with no id — indexed only by name
  test('entry without id is indexed only by name', () => {
    const idx = indexStatuses([{ name: 'only-name', cli: 'x' }]);
    expect(idx['only-name'].cli).toBe('x');
    expect(Object.keys(idx)).toHaveLength(1);
  });

  // GAP: entry with no name — indexed only by id
  test('entry without name is indexed only by id', () => {
    const idx = indexStatuses([{ id: 'only-id', cli: 'x' }]);
    expect(idx['only-id'].cli).toBe('x');
    expect(Object.keys(idx)).toHaveLength(1);
  });

  // GAP: undefined input returns empty object
  test('undefined input returns {}', () => {
    expect(indexStatuses(undefined)).toEqual({});
    expect(indexStatuses(null)).toEqual({});
  });
});

// ── readStatusFiles ───────────────────────────────────────────────────────────

describe('readStatusFiles', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // GAP: non-existent lane dir returns [] without throwing
  test('returns [] when lane directory does not exist', () => {
    expect(readStatusFiles(tmpDir)).toEqual([]);
  });

  // GAP: empty lane dir returns []
  test('returns [] when lane directory is empty', () => {
    fs.mkdirSync(path.join(tmpDir, LANE_DIR), { recursive: true });
    expect(readStatusFiles(tmpDir)).toEqual([]);
  });

  // GAP: valid JSON files are parsed and returned
  test('returns parsed objects from .json files', () => {
    const laneDir = path.join(tmpDir, LANE_DIR);
    fs.mkdirSync(laneDir, { recursive: true });
    fs.writeFileSync(path.join(laneDir, 'lane-1.json'), JSON.stringify({ id: '1', state: 'done' }));
    const result = readStatusFiles(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
  });

  // GAP: non-JSON files (e.g. .txt) are skipped
  test('skips non-.json files', () => {
    const laneDir = path.join(tmpDir, LANE_DIR);
    fs.mkdirSync(laneDir, { recursive: true });
    fs.writeFileSync(path.join(laneDir, 'notes.txt'), 'not json');
    expect(readStatusFiles(tmpDir)).toEqual([]);
  });

  // GAP: malformed JSON files are silently skipped
  test('skips malformed JSON files without throwing', () => {
    const laneDir = path.join(tmpDir, LANE_DIR);
    fs.mkdirSync(laneDir, { recursive: true });
    fs.writeFileSync(path.join(laneDir, 'bad.json'), '{{{invalid');
    expect(readStatusFiles(tmpDir)).toEqual([]);
  });

  // GAP: oversized files (>MAX_STATUS_BYTES = 65536) are skipped
  test('skips files exceeding MAX_STATUS_BYTES', () => {
    const laneDir = path.join(tmpDir, LANE_DIR);
    fs.mkdirSync(laneDir, { recursive: true });
    const big = Buffer.alloc(65537, 'x');
    fs.writeFileSync(path.join(laneDir, 'big.json'), big);
    expect(readStatusFiles(tmpDir)).toEqual([]);
  });

  // GAP: mixed valid + invalid files — only valid ones returned
  test('returns only valid files from a mixed directory', () => {
    const laneDir = path.join(tmpDir, LANE_DIR);
    fs.mkdirSync(laneDir, { recursive: true });
    fs.writeFileSync(path.join(laneDir, 'good.json'), JSON.stringify({ id: 'g' }));
    fs.writeFileSync(path.join(laneDir, 'bad.json'), '{{bad');
    fs.writeFileSync(path.join(laneDir, 'skip.txt'), 'text');
    const result = readStatusFiles(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('g');
  });
});

// ── countByState ─────────────────────────────────────────────────────────────

describe('countByState', () => {
  test('counts running lanes', () => {
    expect(countByState([{ state: 'running' }, { state: 'running' }, { state: 'done' }], 'running')).toBe(2);
  });

  test('counts done lanes', () => {
    expect(countByState([{ state: 'done' }, { state: 'running' }, { state: 'done' }], 'done')).toBe(2);
  });

  test('returns 0 when no lanes match the state', () => {
    expect(countByState([{ state: 'running' }, { state: 'done' }], 'error')).toBe(0);
  });

  test('returns 0 for empty array', () => {
    expect(countByState([], 'running')).toBe(0);
  });

  test('returns 0 for null input', () => {
    expect(countByState(null, 'running')).toBe(0);
  });

  test('returns 0 for undefined input', () => {
    expect(countByState(undefined, 'running')).toBe(0);
  });
});

// ── getAgentRows ──────────────────────────────────────────────────────────────

describe('getAgentRows', () => {
  afterEach(() => { jest.dontMock('node:child_process'); });

  // Never throws: returns an array whether `claude` is present or not.
  test('always returns an array (never throws)', () => {
    expect(Array.isArray(getAgentRows())).toBe(true);
  });

  // Non-JSON output → []. NOTE: lanes.cjs imports `node:child_process`, so the
  // mock MUST target that exact specifier (mocking `child_process` no-ops).
  test('returns [] when execFileSync output is non-JSON', () => {
    jest.isolateModules(() => {
      jest.doMock('node:child_process', () => ({ execFileSync: () => 'not json at all' }));
      const { getAgentRows: fresh } = require('../../plugin/lib/lanes.cjs');
      expect(fresh()).toEqual([]);
    });
  });

  // Non-array JSON object → [].
  test('returns [] when claude returns a non-array JSON object', () => {
    jest.isolateModules(() => {
      jest.doMock('node:child_process', () => ({ execFileSync: () => JSON.stringify({ agents: [] }) }));
      const { getAgentRows: fresh } = require('../../plugin/lib/lanes.cjs');
      expect(fresh()).toEqual([]);
    });
  });
});
