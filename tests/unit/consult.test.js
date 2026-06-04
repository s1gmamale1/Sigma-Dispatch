// tests/unit/consult.test.js
// Exercises plugin/lib/consult.sh with FAKE CLI stubs on PATH — no real CLI,
// no quota spent. Validates per-CLI dispatch flags, input/auth guards, and the
// read-only honesty check.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CONSULT = path.join(__dirname, '..', '..', 'plugin', 'lib', 'consult.sh');

let workDir;        // holds stub bin dir + a task file
let stubDir;        // bin dir with all four CLI stubs
let taskFile;

// A stub that echoes its name + args so we can assert on the invocation.
// opencode also answers `opencode models` so the model guard passes.
const GENERIC_STUB = `#!/bin/sh
name=$(basename "$0")
if [ "$name" = "opencode" ] && [ "$1" = "models" ]; then
  printf 'opencode/deepseek-v4-flash-free\\nopencode/other-free\\n'
  exit 0
fi
printf 'STUB %s ARGS: %s\\n' "$name" "$*"
exit 0
`;

function writeStub(dir, name, body) {
  // name is a fixed CLI basename in every call site; validate it anyway so no
  // separator/traversal can reach path.join (boundary validation).
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`unsafe stub name: ${name}`);
  // nosemgrep — name validated above against /^[a-z0-9-]+$/ (no separators/traversal); test-only fixture.
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, { mode: 0o755 });
  fs.chmodSync(p, 0o755);
}

function run(args, { env = {}, cwd, binDir } = {}) {
  const PATH = `${binDir || stubDir}:/usr/bin:/bin`;
  const res = spawnSync('bash', [CONSULT, ...args], {
    encoding: 'utf8',
    cwd: cwd || workDir,
    env: { ...process.env, PATH, ...env },
  });
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    out: (res.stdout || '') + (res.stderr || ''),
  };
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-test-'));
  stubDir = path.join(workDir, 'bin');
  fs.mkdirSync(stubDir);
  for (const cli of ['codex', 'gemini', 'opencode', 'kimi']) {
    writeStub(stubDir, cli, GENERIC_STUB);
  }
  taskFile = path.join(workDir, 'task.md');
  fs.writeFileSync(taskFile, 'review the auth flow');
});

afterAll(() => {
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
});

describe('codex — hard read-only sandbox', () => {
  test('ro uses -s read-only', () => {
    const r = run(['codex', 'ro', taskFile]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/STUB codex/);
    expect(r.out).toMatch(/-s read-only/);
    expect(r.out).not.toMatch(/workspace-write/);
  });
  test('rw uses -s workspace-write', () => {
    const r = run(['codex', 'rw', taskFile]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/-s workspace-write/);
  });
});

describe('gemini — soft read-only + API key guard', () => {
  test('ro omits --yolo and prepends the read-only preamble', () => {
    const r = run(['gemini', 'ro', taskFile], { env: { GEMINI_API_KEY: 'test-key' } });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/STUB gemini/);
    expect(r.out).not.toMatch(/--yolo/);
    expect(r.out).toMatch(/READ-ONLY consultation/);
  });
  test('rw adds --yolo', () => {
    const r = run(['gemini', 'rw', taskFile], { env: { GEMINI_API_KEY: 'test-key' } });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/--yolo/);
  });
  test('missing GEMINI_API_KEY is a guard error', () => {
    const r = run(['gemini', 'ro', taskFile], { env: { GEMINI_API_KEY: '' } });
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/consult-error: GEMINI_API_KEY is not set/);
  });
});

describe('opencode — model availability guard', () => {
  test('ro passes when the model is listed by `opencode models`', () => {
    const r = run(['opencode', 'ro', taskFile]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/STUB opencode/);
    expect(r.out).toMatch(/deepseek-v4-flash-free/);
    expect(r.out).toMatch(/READ-ONLY consultation/);
  });
  test('aborts when the model is not listed', () => {
    const badBin = path.join(workDir, 'bin-badmodel');
    fs.mkdirSync(badBin, { recursive: true });
    writeStub(badBin, 'opencode', `#!/bin/sh
[ "$1" = "models" ] && { echo "opencode/some-other-model"; exit 0; }
echo "STUB opencode $*"
`);
    const r = run(['opencode', 'ro', taskFile], { binDir: badBin });
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/consult-error: opencode model .* not available/);
  });
});

describe('kimi — soft read-only', () => {
  test('ro runs with --afk and the preamble', () => {
    const r = run(['kimi', 'ro', taskFile]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/STUB kimi/);
    expect(r.out).toMatch(/--afk/);
    expect(r.out).toMatch(/READ-ONLY consultation/);
  });
});

describe('input validation at the boundary', () => {
  test('unknown CLI is rejected', () => {
    const r = run(['llama', 'ro', taskFile]);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/unknown CLI/);
  });
  test('bad mode is rejected', () => {
    const r = run(['codex', 'sideways', taskFile]);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/mode must be 'ro' or 'rw'/);
  });
  test('missing task file is rejected', () => {
    const r = run(['codex', 'ro', path.join(workDir, 'does-not-exist.md')]);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/task file not found/);
  });
  test('CLI not on PATH is rejected', () => {
    const onlyCodex = path.join(workDir, 'bin-onlycodex');
    fs.mkdirSync(onlyCodex, { recursive: true });
    writeStub(onlyCodex, 'codex', GENERIC_STUB); // kimi intentionally absent
    const r = run(['kimi', 'ro', taskFile], { binDir: onlyCodex });
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/kimi CLI not found on PATH/);
  });
});

describe('read-only honesty check', () => {
  test('warns when a soft CLI writes during a read-only consult (in git)', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-git-'));
    spawnSync('git', ['init', '-q'], { cwd: repo });
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: repo });
    // A gemini stub that WRITES a file, simulating a soft CLI ignoring read-only.
    const writeBin = path.join(repo, 'bin');
    fs.mkdirSync(writeBin, { recursive: true });
    writeStub(writeBin, 'gemini', `#!/bin/sh
: > "$(pwd)/leaked.txt"
echo "STUB gemini wrote a file"
`);
    const r = run(['gemini', 'ro', taskFile], {
      cwd: repo, binDir: writeBin, env: { GEMINI_API_KEY: 'test-key' },
    });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/consult-warning:/);
    expect(r.out).toMatch(/working tree changed/i);
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch (_) {}
  });
});
